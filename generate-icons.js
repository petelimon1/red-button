#!/usr/bin/env node
'use strict';
/**
 * Generates apple-touch-icon.png (180×180) and og-image.png (1200×630)
 * using only Node.js built-ins — no npm packages required.
 *
 * Run once:  node generate-icons.js
 */
const zlib = require('zlib');
const fs   = require('fs');
const path = require('path');

/* ── CRC-32 ────────────────────────────────────────────────────────── */
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ── PNG writer ─────────────────────────────────────────────────────── */
function pngChunk(type, data) {
  const tb = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);  crc.writeUInt32BE(crc32(Buffer.concat([tb, data])));
  return Buffer.concat([len, tb, data, crc]);
}

/**
 * writePNG(outPath, w, h, fillFn)
 * fillFn(x, y) → [r, g, b]  (0–255 each, no alpha needed for our images)
 */
function writePNG(outPath, w, h, fillFn) {
  console.log(`Generating ${path.basename(outPath)} (${w}×${h})…`);

  // Raw scanlines: 1 filter byte (0=None) + w*3 RGB bytes per row
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3);
    raw[row] = 0; // filter type None
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fillFn(x, y);
      const p = row + 1 + x * 3;
      raw[p] = r; raw[p+1] = g; raw[p+2] = b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // 8-bit depth
  ihdr[9] = 2;  // colour type: RGB (no alpha)
  // bytes 10-12 are 0 (compression/filter/interlace defaults)

  const idat = zlib.deflateSync(raw, { level: 6 });
  const png  = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(outPath, png);
  console.log(`  ✓ ${(png.length / 1024).toFixed(1)} KB`);
}

/* ── Maths helpers ──────────────────────────────────────────────────── */
const lerp  = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist  = (ax, ay, bx, by) => Math.sqrt((ax-bx)**2 + (ay-by)**2);

/**
 * redButton(x, y, cx, cy, R) → [r, g, b]
 * Renders one pixel of a 3-D red button centered at (cx,cy) with radius R.
 * Returns the background colour if the pixel is outside the button.
 */
function redButton(x, y, cx, cy, R) {
  const d = dist(x, y, cx, cy);
  if (d > R) return null; // outside button

  // Radial gradient from highlight point (top-left of button)
  const hlx = cx - R * 0.15, hly = cy - R * 0.20;
  const t   = clamp(dist(x, y, hlx, hly) / (R * 1.25), 0, 1);

  let r, g, b;
  if (t < 0.45) {
    const u = t / 0.45;
    r = lerp(255, 229, u); g = lerp(107, 57, u); b = lerp(107, 53, u);
  } else {
    const u = (t - 0.45) / 0.55;
    r = lerp(229, 115, u); g = lerp(57,   0, u); b = lerp(53,   0, u);
  }

  // Inner shadow at bottom (depth)
  const sdy = clamp((y - (cy + R * 0.30)) / (R * 0.6), 0, 1);
  const sdx = clamp(1 - dist(x, y, cx, cy + R * 0.30) / R, 0, 1);
  const sh  = sdx * sdy * 0.5;
  r = clamp(r - sh * 255, 0, 255);
  g = clamp(g - sh * 255, 0, 255);
  b = clamp(b - sh * 255, 0, 255);

  // Gloss ellipse (top-left)
  const gx = cx - R * 0.19, gy = cy - R * 0.23;
  const gd = dist(x / (R * 0.60), y / (R * 0.38),
                  gx / (R * 0.60), gy / (R * 0.38));
  const gl = clamp((1 - gd) * 0.26, 0, 0.26);
  r = clamp(r + gl * 255, 0, 255);
  g = clamp(g + gl * 255, 0, 255);
  b = clamp(b + gl * 255, 0, 255);

  return [Math.round(r), Math.round(g), Math.round(b)];
}

/* ── apple-touch-icon.png  180×180 ─────────────────────────────────── */
function makeAppleTouchIcon(outPath) {
  const S = 180, cx = S / 2, cy = S / 2;
  const R = S * 0.43; // button radius
  // Rounded-rect corner radius for background
  const corner = S * 0.22;

  writePNG(outPath, S, S, (x, y) => {
    // Rounded-rect mask (iOS icon shape)
    const inCorner =
      (x < corner && y < corner && dist(x, y, corner, corner) > corner) ||
      (x > S-corner && y < corner && dist(x, y, S-corner, corner) > corner) ||
      (x < corner && y > S-corner && dist(x, y, corner, S-corner) > corner) ||
      (x > S-corner && y > S-corner && dist(x, y, S-corner, S-corner) > corner);
    if (inCorner) return [10, 10, 10]; // transparent → same as bg for PNG

    const btn = redButton(x, y, cx, cy, R);
    if (btn) return btn;

    // Background: very dark #0a0a0a with faint red ambient glow behind button
    const glowT = clamp(1 - dist(x, y, cx, cy) / (S * 0.65), 0, 1);
    const bg = Math.round(10 + glowT * 22);
    return [bg, 10, 10];
  });
}

/* ── og-image.png  1200×630 ─────────────────────────────────────────── */
function makeOGImage(outPath) {
  const W = 1200, H = 630;
  const bcx = 920, bcy = 318, bR = 190;

  // Pre-render button region bounding box for speed
  const bx0 = Math.max(0, Math.floor(bcx - bR - 2));
  const bx1 = Math.min(W - 1, Math.ceil(bcx + bR + 2));
  const by0 = Math.max(0, Math.floor(bcy - bR - 2));
  const by1 = Math.min(H - 1, Math.ceil(bcy + bR + 2));

  writePNG(outPath, W, H, (x, y) => {
    // Background base: #0a0a0a
    let br = 10, bg = 10, bb = 10;

    // Red ambient haze (right side, behind button)
    const hd = clamp(1 - dist(x, y, W * 0.77, H * 0.5) / (W * 0.42), 0, 1);
    br = Math.round(clamp(br + hd * hd * 60, 0, 255));

    if (x < bx0 || x > bx1 || y < by0 || y > by1) {
      return [br, bg, bb];
    }

    // Button
    const btn = redButton(x, y, bcx, bcy, bR);
    if (btn) return btn;

    // Ambient glow rings outside button
    const d = dist(x, y, bcx, bcy);
    const ringT = clamp((d - bR) / (bR * 0.7), 0, 1);
    const ring  = Math.max(0, 1 - ringT) * 0.13;
    br = Math.round(clamp(br + ring * 229, 0, 255));

    return [br, bg, bb];
  });
}

/* ── Run ─────────────────────────────────────────────────────────────── */
const pub = path.join(__dirname, 'public');
makeAppleTouchIcon(path.join(pub, 'apple-touch-icon.png'));
makeOGImage(path.join(pub, 'og-image.png'));
console.log('\nDone! Commit public/apple-touch-icon.png and public/og-image.png');
