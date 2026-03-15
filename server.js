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

/* ── MongoDB ──────────────────────────────────────────────────────────── */
let _db = null;
async function getDb() {
  if (!process.env.MONGODB_URI) return null;
  if (_db) return _db;
  try {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
      socketTimeoutMS: 10000,
      maxIdleTimeMS: 60000,
    });
    await client.connect();
    _db = client.db('red_button');
    console.log('Connected to MongoDB');
  } catch (e) {
    console.error('MongoDB failed, using in-memory fallback:', e.message);
  }
  return _db;
}

/* ── In-memory fallback ───────────────────────────────────────────────── */
let _mem            = [];
let _challenges     = [];
let _mulliganGrants = [];

/* ── Helpers ──────────────────────────────────────────────────────────── */
const wrap = fn => (req, res, next) => fn(req, res, next).catch(next);

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
      const grant = await db.collection('mulligan_grants').findOne({ token: mulliganToken });
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
    ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress,
  };

  const db = await getDb();
  if (db) {
    await db.collection('scores').insertOne(entry);
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
    scores = await db.collection('scores').aggregate([
      { $sort: { timeMs: -1 } },
      { $group: {
        _id: '$name',
        name:          { $first: '$name' },
        timeMs:        { $first: '$timeMs' },
        timeFormatted: { $first: '$timeFormatted' },
        greenClicks:   { $first: '$greenClicks' },
        hasMulligan:   { $max:   '$hasMulligan' },  // true if they EVER bought one
        submittedAt:   { $first: '$submittedAt' },
      }},
      { $sort: { timeMs: -1 } },
      { $limit: 100 },
      { $project: { _id: 0 } },
    ]).toArray();
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
    const used = await db.collection('mulligan_sessions').findOne({ sessionId });
    if (used) return res.json({ granted: false, error: 'Session already used' });
  }

  const session = await stripe.checkout.sessions.retrieve(sessionId);
  if (session.payment_status !== 'paid') {
    return res.json({ granted: false });
  }

  // Mark session as used and generate a mulligan grant token
  const token = makeToken();
  if (db) {
    await db.collection('mulligan_sessions').insertOne({ sessionId, usedAt: new Date() });
    await db.collection('mulligan_grants').insertOne({ token, createdAt: new Date() });
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
    await db.collection('challenges').insertOne(doc);
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
    doc = await db.collection('challenges').findOne(
      { id },
      { projection: { _id: 0, id: 1, name: 1, timeMs: 1, timeFormatted: 1, greenClicks: 1 } }
    );
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
    await db.collection('subscribers').insertOne({
      email: email.trim().slice(0, 200),
      name: name ? String(name).trim().slice(0, 40) : null,
      timeMs: typeof timeMs === 'number' ? timeMs : null,
      createdAt: new Date(),
    });
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
