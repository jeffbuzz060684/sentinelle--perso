#!/usr/bin/env node
// ─── Sentinelle perso — générateur d'icônes PNG (zéro dépendance) ────────────
// Rastérise icon.svg (bouclier + coche) en PNG 192/512 avec suréchantillonnage 2×.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT_DIR = path.join(__dirname, '..', 'icons');

// design (coordonnées viewBox 512)
const BG = [11, 18, 32];        // #0b1220
const BLUE = [77, 163, 255];    // #4da3ff
const GOLD = [245, 196, 81];    // #f5c451

function shieldPathPoints() {
  // contour du bouclier (approximation polyline du path SVG)
  return [[256, 64], [400, 112], [400, 240], [400, 336], [256, 448],
          [112, 336], [112, 240], [112, 112]];
}
function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function distSeg(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}
function pointNearEdge(x, y, poly, maxD) {
  let d = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    d = Math.min(d, distSeg(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]));
    if (d <= maxD) return true;
  }
  return d <= maxD;
}

function pixel(x, y) {
  // fond arrondi (rayon 96)
  const r = 96, R = 12;
  const cx = Math.max(r, Math.min(512 - r, x));
  const cy = Math.max(r, Math.min(512 - r, y));
  const out = Math.hypot(x - cx, y - cy) > r;
  if (out) return [0, 0, 0, 0];
  const shield = shieldPathPoints();
  const inside = pointInPoly(x, y, shield);
  const edge = pointNearEdge(x, y, shield, 12);
  // coche : (184,250)-(240,306) puis (240,306)-(336,198), épaisseur 15
  const check = Math.min(distSeg(x, y, 184, 250, 240, 306), distSeg(x, y, 240, 306, 336, 198)) <= 15;
  if (check) return [GOLD[0], GOLD[1], GOLD[2], 255];
  if (inside && edge) return [BLUE[0], BLUE[1], BLUE[2], 255];
  return [BG[0], BG[1], BG[2], 255];
}

function genPng(size) {
  const ss = 2; // suréchantillonnage
  const w = size, h = size;
  const rgba = Buffer.alloc(w * h * 4);
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      // moyenne des 4 sous-pixels
      const acc = [0, 0, 0, 0];
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const gx = (px + (sx + 0.5) / ss) * 512 / w;
          const gy = (py + (sy + 0.5) / ss) * 512 / h;
          const c = pixel(gx, gy);
          acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
        }
      }
      const i = (py * w + px) * 4;
      const a = acc[3] / (ss * ss);
      rgba[i] = a ? Math.round(acc[0] / a) : 0;
      rgba[i + 1] = a ? Math.round(acc[1] / a) : 0;
      rgba[i + 2] = a ? Math.round(acc[2] / a) : 0;
      rgba[i + 3] = Math.round(a);
    }
  }
  // PNG (filtrage ligne = 0)
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(crcBuf) >>> 0);
    return Buffer.concat([len, t, data, crc]);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
  ]);
  return png;
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
for (const s of [192, 512]) {
  fs.writeFileSync(path.join(OUT_DIR, `icon-${s}.png`), genPng(s));
  console.log(`[gen-icons] icons/icon-${s}.png généré`);
}
