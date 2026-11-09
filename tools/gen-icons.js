var fs = require("fs");
var zlib = require("zlib");

// ---- PNG minimal RGBA (aucun binaire dans le dépôt) ----
var CRC_TABLE = [];
for (var n = 0; n < 256; n++) {
  var c = n;
  for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  var c = 0xffffffff;
  for (var i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  var len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  var t = Buffer.from(type, "ascii");
  var body = Buffer.concat([t, data]);
  var crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function writePNG(path, W, draw) {
  var raw = Buffer.alloc((W * 4 + 1) * W);
  var o = 0;
  for (var y = 0; y < W; y++) {
    raw[o++] = 0;
    for (var x = 0; x < W; x++) {
      var px = draw(x, y);
      raw[o++] = px[0]; raw[o++] = px[1]; raw[o++] = px[2]; raw[o++] = px[3];
    }
  }
  var ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(W, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  var png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
  fs.writeFileSync(path, png);
  console.log(path, png.length, "octets");
}

// ---- dessin : fond arrondi + 4 barres haussières + flèche ----
function hex(h) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }
var BG = hex("#020617");
var BARS = [
  { x: 88, y: 296, h: 128, c: hex("#38bdf8") },
  { x: 184, y: 232, h: 192, c: hex("#34d399") },
  { x: 280, y: 168, h: 256, c: hex("#fbbf24") },
  { x: 376, y: 104, h: 320, c: hex("#fb7185") }
];
var BW = 64, RAD = 104, RBAR = 14;
// flèche : segment du point A(64,392) au point B(400,120), épaisseur 22, pointe en B vers le haut-droite
function distToSeg(x, y, ax, ay, bx, by) {
  var dx = bx - ax, dy = by - ay;
  var t = ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy);
  t = Math.max(0, Math.min(1, t));
  var px = ax + t * dx, py = ay + t * dy;
  return Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
}
function arrowIn(x, y) {
  // tige
  if (distToSeg(x, y, 64, 392, 390, 124) <= 11) return true;
  // pointe : deux segments depuis (402,110)
  if (distToSeg(x, y, 402, 110, 330, 112) <= 11) return true;
  if (distToSeg(x, y, 402, 110, 404, 182) <= 11) return true;
  return false;
}
function roundedIn(x, y, W) {
  if (x < 0 || y < 0 || x >= W || y >= W) return false;
  var r = RAD * W / 512;
  var x0 = r, y0 = r, x1 = W - r, y1 = W - r;
  if (x >= x0 && x < x1) return true;
  if (y >= y0 && y < y1) return true;
  var cx = x < x0 ? x0 : x1;
  var cy = y < y0 ? y0 : y1;
  var dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function barIn(x, y, W) {
  var s = W / 512;
  for (var i = 0; i < BARS.length; i++) {
    var b = BARS[i];
    var bx = b.x * s, bw = BW * s;
    var by = b.y * s, bh = b.h * s, br = RBAR * s;
    if (x < bx || x >= bx + bw || y < by || y >= by + bh) continue;
    var dx = Math.min(x - bx, bx + bw - 1 - x);
    var dy = Math.min(y - by, by + bh - 1 - y);
    if (dx < br && dy < br) {
      var ddx = (x - bx) < (bx + bw - 1 - x) ? (x - (bx + br)) : ((x - (bx + bw - 1 - br)));
      var ddy = (y - by) < (by + bh - 1 - y) ? (y - (by + br)) : ((y - (by + bh - 1 - br)));
      if (ddx < 0 && ddy < 0 && (ddx * ddx + ddy * ddy) > br * br) continue;
    }
    return b.c;
  }
  return null;
}
function draw(W) {
  return function (x, y) {
    var c = barIn(x, y, W);
    if (c) return [c[0], c[1], c[2], 255];
    if (arrowIn(x * 512 / W, y * 512 / W) && roundedIn(x, y, W)) return [226, 232, 240, 255];
    if (roundedIn(x, y, W)) return [BG[0], BG[1], BG[2], 255];
    return [0, 0, 0, 0];
  };
}
writePNG("icon-512.png", 512, draw(512));
writePNG("icon-192.png", 192, draw(192));
