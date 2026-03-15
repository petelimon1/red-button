'use strict';
const express = require('express');
const { MongoClient } = require('mongodb');
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

/* ── MongoDB ──────────────────────────────────────────────────────────── */
let _db = null;
async function getDb() {
  if (!process.env.MONGODB_URI) return null;
  if (_db) return _db;
  try {
    const client = new MongoClient(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
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
let _mem = [];

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

/* ── Routes ───────────────────────────────────────────────────────────── */

// Submit a score
app.post('/api/submit', wrap(async (req, res) => {
  const { name, timeMs, greenClicks } = req.body;
  if (!name || typeof timeMs !== 'number' || timeMs < 0) {
    return res.status(400).json({ error: 'Invalid submission' });
  }
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) return res.status(400).json({ error: 'Name required' });

  const entry = {
    name: trimmed,
    timeMs,
    timeFormatted: formatTime(timeMs),
    greenClicks: typeof greenClicks === 'number' ? Math.max(0, Math.floor(greenClicks)) : 0,
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

// Get leaderboard
app.get('/api/leaderboard', wrap(async (req, res) => {
  const db = await getDb();
  let scores;
  if (db) {
    scores = await db.collection('scores')
      .find({}, { projection: { _id: 0, name: 1, timeMs: 1, timeFormatted: 1, greenClicks: 1, submittedAt: 1 } })
      .sort({ timeMs: -1 })
      .limit(100)
      .toArray();
  } else {
    scores = [..._mem]
      .sort((a, b) => b.timeMs - a.timeMs)
      .slice(0, 100)
      .map(({ name, timeMs, timeFormatted, greenClicks, submittedAt }) => ({ name, timeMs, timeFormatted, greenClicks, submittedAt }));
  }
  res.json({ scores });
}));

// Mulligan step 1 — create a Stripe Checkout session
app.post('/api/mulligan/checkout', wrap(async (req, res) => {
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

// Mulligan step 2 — verify payment and grant the play
app.post('/api/mulligan/verify', wrap(async (req, res) => {
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

  // Mark session as used
  if (db) {
    await db.collection('mulligan_sessions').insertOne({ sessionId, usedAt: new Date() });
  }

  res.json({ granted: true });
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
