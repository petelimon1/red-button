'use strict';
const express  = require('express');
const rateLimit = require('express-rate-limit');
const { MongoClient } = require('mongodb');
const { randomBytes } = require('crypto');
const path = require('path');
const Stripe = require('stripe');

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const app = express();
const PORT = process.env.PORT || 3002;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'redbutton2026';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ── Rate limiting ────────────────────────────────────────────────────── */
// Score submit: max 10 submissions per IP per 10 minutes
const submitLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many submissions. Try again in a few minutes.' },
});

// Leaderboard: max 60 reads per IP per minute (generous — just blocks bots)
const leaderboardLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

// Mulligan / payment: max 5 attempts per IP per 15 minutes
const mulliganLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Try again later.' },
});

// Challenge creation: max 10 per IP per 10 minutes (same as submit)
const challengeLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests.' },
});

/* ── Score validation constants ───────────────────────────────────────── */
const MAX_TIME_MS   = 24 * 60 * 60 * 1000;  // 24 hours — clearly impossible
const MAX_GREEN     = 100_000;               // 100k green clicks — clearly a bot
const MAX_PLAYS     = 3;                     // free plays per day per IP (must match client)

/* ── MongoDB ──────────────────────────────────────────────────────────── */
let _client = null;
let _db     = null;

async function getDb() {
  if (!process.env.MONGODB_URI) return null;
  if (_db) return _db;
  try {
    _client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS:        5000,
      maxIdleTimeMS:           30000, // close idle connections before Atlas drops them
      maxPoolSize:             3,     // free tier: keep connections low
      minPoolSize:             0,     // don't hold connections open when idle
    });
    await _client.connect();
    _db = _client.db('red_button');
    console.log('Connected to MongoDB');
  } catch (e) {
    _client = null;
    console.error('MongoDB failed, using in-memory fallback:', e.message);
  }
  return _db;
}

// Wrap any DB promise with a hard timeout.
// If the operation hangs, we reject after `ms` and reset the connection
// so the next request gets a fresh pool instead of the stale one.
function dbOp(promise, ms = 8000) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => {
        const staleClient = _client;
        _db     = null;   // force reconnect on next request
        _client = null;
        if (staleClient) staleClient.close(true).catch(() => {}); // release connections
        reject(new Error('Database timeout'));
      }, ms)
    ),
  ]);
}

/* ── In-memory fallback ───────────────────────────────────────────────── */
let _mem            = [];
let _challenges     = [];
let _mulliganGrants = [];

/* ── Helpers ──────────────────────────────────────────────────────────── */
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

// Cloudflare sets CF-Connecting-IP to the real client IP.
// Fall back to x-forwarded-for (first entry) or the raw socket address.
function ipOf(req) {
  return (
    req.headers['cf-connecting-ip'] ||
    (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

function adminAuth(req, res, next) {
  const pw = req.body?.password || req.headers['x-admin-password'];
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Wrong password' });
  next();
}

function formatTime(ms) {
  const totalSec = Math.floor(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  const centis = Math.floor((ms % 1000) / 10);
  if (mins > 0) return `${mins}m ${secs}.${String(centis).padStart(2,'0')}s`;
  return `${secs}.${String(centis).padStart(2,'0')}s`;
}

function makeId()    { return randomBytes(5).toString('hex'); }
function makeToken() { return randomBytes(16).toString('hex'); }

/* ── Routes ───────────────────────────────────────────────────────────── */

// GET /api/plays — how many free plays has this IP used today?
app.get('/api/plays', leaderboardLimiter, wrap(async (req, res) => {
  const ip   = ipOf(req);
  const date = new Date().toISOString().slice(0, 10);
  const db   = await getDb();
  if (db) {
    const record = await dbOp(db.collection('daily_plays').findOne({ ip, date }));
    const used   = record?.count || 0;
    res.json({ used, left: Math.max(0, MAX_PLAYS - used) });
  } else {
    res.json({ used: 0, left: MAX_PLAYS }); // no DB: always allow
  }
}));

// POST /api/plays — record a play start; returns { allowed, left }
// Mulligan token bypasses the daily IP limit (paid extra play).
app.post('/api/plays', submitLimiter, wrap(async (req, res) => {
  const ip   = ipOf(req);
  const date = new Date().toISOString().slice(0, 10);
  const { mulliganToken } = req.body || {};
  const db = await getDb();

  if (!db) {
    return res.json({ allowed: true, left: MAX_PLAYS }); // no DB: always allow
  }

  // Valid mulligan token overrides the daily limit
  if (mulliganToken && typeof mulliganToken === 'string') {
    const grant = await dbOp(db.collection('mulligan_grants').findOne({ token: mulliganToken }));
    if (grant) return res.json({ allowed: true, left: 0 });
  }

  const record = await dbOp(db.collection('daily_plays').findOne({ ip, date }));
  const used   = record?.count || 0;

  if (used >= MAX_PLAYS) {
    return res.status(403).json({ allowed: false, left: 0 });
  }

  await dbOp(db.collection('daily_plays').updateOne(
    { ip, date },
    { $inc: { count: 1 } },
    { upsert: true }
  ));

  res.json({ allowed: true, left: MAX_PLAYS - used - 1 });
}));

// Submit a score
app.post('/api/submit', submitLimiter, wrap(async (req, res) => {
  const { name, timeMs, greenClicks, mulliganToken } = req.body;
  if (!name || typeof timeMs !== 'number' || timeMs < 0) {
    return res.status(400).json({ error: 'Invalid submission' });
  }
  if (timeMs > MAX_TIME_MS) {
    return res.status(400).json({ error: 'Invalid time' });
  }
  if (typeof greenClicks === 'number' && greenClicks > MAX_GREEN) {
    return res.status(400).json({ error: 'Invalid submission' });
  }
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return res.status(400).json({ error: 'Name required' });

  // Check if this submission was made possible by a paid mulligan
  let hasMulligan = false;
  if (mulliganToken && typeof mulliganToken === 'string') {
    const db = await getDb();
    if (db) {
      const grant = await dbOp(db.collection('mulligan_grants').findOne({ token: mulliganToken }));
      if (grant) hasMulligan = true;
    } else {
      hasMulligan = _mulliganGrants.some(g => g.token === mulliganToken);
    }
  }

  const entry = {
    name: trimmed,
    timeMs,
    timeFormatted: formatTime(timeMs),
    greenClicks: typeof greenClicks === 'number' ? Math.max(0, Math.floor(greenClicks)) : 0,
    hasMulligan,
    submittedAt: new Date(),
    ip: ipOf(req),
  };

  const db = await getDb();
  if (db) {
    await dbOp(db.collection('scores').insertOne(entry));
  } else {
    _mem.push(entry);
  }
  res.json({ success: true, timeFormatted: entry.timeFormatted });
}));

// Get leaderboard — one entry per name (best time wins)
app.get('/api/leaderboard', leaderboardLimiter, wrap(async (req, res) => {
  const db = await getDb();
  let scores;
  if (db) {
    // Sort first so $first picks the best-time doc for each player
    scores = await dbOp(db.collection('scores').aggregate([
      { $sort: { timeMs: -1 } },
      { $group: {
        _id: '$name',
        name:          { $first: '$name' },
        timeMs:        { $first: '$timeMs' },
        timeFormatted: { $first: '$timeFormatted' },
        greenClicks:   { $first: '$greenClicks' },
        hasMulligan:   { $max:   '$hasMulligan' },
        submittedAt:   { $first: '$submittedAt' },
      }},
      { $sort: { timeMs: -1 } },
      { $limit: 100 },
      { $project: { _id: 0 } },
    ]).toArray());
  } else {
    // In-memory: best time per name
    const best = {};
    for (const s of _mem) {
      if (!best[s.name] || s.timeMs > best[s.name].timeMs) {
        best[s.name] = { ...s };
      }
      // Propagate mulligan flair even from non-best plays
      if (s.hasMulligan) best[s.name].hasMulligan = true;
    }
    scores = Object.values(best)
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, 100)
      .map(({ name, timeMs, timeFormatted, greenClicks, hasMulligan, submittedAt }) =>
        ({ name, timeMs, timeFormatted, greenClicks, hasMulligan, submittedAt }));
  }
  res.json({ scores });
}));

// Mulligan step 1 — create a Stripe Checkout session
app.post('/api/mulligan/checkout', mulliganLimiter, wrap(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const origin = req.headers.origin || `https://${req.get('host')}`;
  const session = await stripe.checkout.sessions.create({
    payment_method_types: ['card'],
    line_items: [{
      price_data: {
        currency: 'usd',
        product_data: {
          name: '+ 1 Play',
          description: "One extra play on Don't Click It",
        },
        unit_amount: 100, // $1.00
      },
      quantity: 1,
    }],
    mode: 'payment',
    success_url: `${origin}/?mulligan={CHECKOUT_SESSION_ID}`,
    cancel_url:  `${origin}/`,
  });

  res.json({ url: session.url });
}));

// Mulligan step 2 — verify payment, prevent replay, grant play + token
app.post('/api/mulligan/verify', mulliganLimiter, wrap(async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Payments not configured' });

  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== 'string') {
    return res.status(400).json({ error: 'Missing sessionId' });
  }

  // Prevent replaying the same session ID
  const db = await getDb();
  if (db) {
    const used = await dbOp(db.collection('mulligan_sessions').findOne({ sessionId }));
    if (used) return res.json({ granted: false, error: 'Session already used' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') {
    return res.json({ granted: false });
  }

  // Mark session as used and generate a mulligan grant token
  const token = makeToken();
  if (db) {
    await dbOp(db.collection('mulligan_sessions').insertOne({ sessionId, usedAt: new Date() }));
    await dbOp(db.collection('mulligan_grants').insertOne({ token, createdAt: new Date() }));
  } else {
    _mulliganGrants.push({ token });
  }

  res.json({ granted: true, token });
}));

// Create a challenge
app.post('/api/challenge', challengeLimiter, wrap(async (req, res) => {
  const { name, timeMs, greenClicks } = req.body;
  if (!name || typeof timeMs !== 'number' || timeMs < 0) {
    return res.status(400).json({ error: 'Invalid challenge' });
  }
  const id  = makeId();
  const doc = {
    id,
    name: String(name).trim().slice(0, 40),
    timeMs,
    timeFormatted: formatTime(timeMs),
    greenClicks: typeof greenClicks === 'number' ? Math.max(0, Math.floor(greenClicks)) : 0,
    createdAt: new Date(),
  };
  const db = await getDb();
  if (db) {
    await dbOp(db.collection('challenges').insertOne(doc));
  } else {
    _challenges.push(doc);
  }
  res.json({ id });
}));

// Get a challenge
app.get('/api/challenge/:id', wrap(async (req, res) => {
  const { id } = req.params;
  const db = await getDb();
  let doc;
  if (db) {
    doc = await dbOp(db.collection('challenges').findOne(
      { id },
      { projection: { _id: 0, id: 1, name: 1, timeMs: 1, timeFormatted: 1, greenClicks: 1 } }
    ));
  } else {
    doc = _challenges.find(c => c.id === id) || null;
    if (doc) doc = { id: doc.id, name: doc.name, timeMs: doc.timeMs, timeFormatted: doc.timeFormatted, greenClicks: doc.greenClicks };
  }
  if (!doc) return res.status(404).json({ error: 'Challenge not found' });
  res.json(doc);
}));

// Subscribe for beat notifications
app.post('/api/subscribe', wrap(async (req, res) => {
  const { email, name, timeMs } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  const db = await getDb();
  if (db) {
    await dbOp(db.collection('subscribers').insertOne({
      email: email.trim().slice(0, 200),
      name: name ? String(name).trim().slice(0, 40) : null,
      timeMs: typeof timeMs === 'number' ? timeMs : null,
      createdAt: new Date(),
    }));
  }
  res.json({ success: true });
}));

// Admin: clear a score by name
app.post('/api/admin/remove', adminAuth, wrap(async (req, res) => {
  const { name } = req.body;
  const db = await getDb();
  if (db) {
    await db.collection('scores').deleteMany({ name });
  } else {
    _mem = _mem.filter(e => e.name !== name);
  }
  res.json({ success: true });
}));

app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🔴  Don't Click It`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Storage: ${process.env.MONGODB_URI ? 'MongoDB' : 'in-memory'}`);
});
