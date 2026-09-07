/**
 * Generates apps/web/public PNG assets (icons + OG image) with zero image
 * dependencies: raw RGBA raster -> zlib -> PNG chunks. Run once; output is
 * committed. `node scripts/gen-images.mjs`
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'apps', 'web', 'public');
mkdirSync(outDir, { recursive: true });

function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const byte of buf) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// --- helpers -----------------------------------------------------------

function lerp(a, b, t) {
  return a + (b - a) * t;
}
function mix(c1, c2, t) {
  return [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];
}

/** Felt-green radial gradient background. */
function background(w, h) {
  return (x, y) => {
    const cx = w / 2;
    const cy = h * 0.42;
    const d = Math.min(1, Math.hypot((x - cx) / (w * 0.72), (y - cy) / (h * 0.72)));
    return mix([44, 90, 53], [18, 38, 24], d);
  };
}

/** A tilted playing card drawn with simple corner-distance shading. */
function addCard(rgba, w, h, cx, cy, cw, ch, angleDeg, back) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x0 = Math.round(cx - (cw + ch));
  const x1 = Math.round(cx + (cw + ch));
  const y0 = Math.round(cy - (cw + ch));
  const y1 = Math.round(cy + (cw + ch));
  const radius = Math.min(cw, ch) * 0.16;
  for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const lx = dx * cos + dy * sin;
      const ly = -dx * sin + dy * cos;
      if (Math.abs(lx) > cw / 2 || Math.abs(ly) > ch / 2) continue;
      // rounded corners
      const ox = Math.abs(lx) - cw / 2 + radius;
      const oy = Math.abs(ly) - ch / 2 + radius;
      if (ox > 0 && oy > 0 && ox * ox + oy * oy > radius * radius) continue;
      let color;
      if (back) {
        color = mix([37, 50, 31], [25, 34, 22], (ly / ch + 0.5));
        // gold star: small diamond
        const sx = Math.abs(lx);
        const sy = Math.abs(ly);
        if (sx + sy < ch * 0.13) color = [255, 216, 138];
        // border
        if (Math.abs(lx) > cw / 2 - 3 || Math.abs(ly) > ch / 2 - 3) color = mix(color, [255, 216, 138], 0.35);
      } else {
        color = mix([250, 245, 234], [226, 219, 204], (ly / ch + 0.5));
        // "C"
        const dx2 = lx;
        const dy2 = ly + ch * 0.06;
        const r = ch * 0.22;
        const dC = Math.hypot(dx2, dy2);
        if (dC < r && dC > r * 0.55 && !(dx2 < 0 && Math.abs(dy2) < r * 0.5)) color = [30, 34, 40];
      }
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(color[0]);
      rgba[i + 1] = Math.round(color[1]);
      rgba[i + 2] = Math.round(color[2]);
      rgba[i + 3] = 255;
    }
  }
}

function render(w, h, draw) {
  const rgba = Buffer.alloc(w * h * 4);
  const bg = background(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = bg(x, y);
      const i = (y * w + x) * 4;
      rgba[i] = Math.round(c[0]);
      rgba[i + 1] = Math.round(c[1]);
      rgba[i + 2] = Math.round(c[2]);
      rgba[i + 3] = 255;
    }
  }
  draw(rgba, w, h);
  return encodePng(w, h, rgba);
}

// Square icon: two cards, face + back.
function icon(size) {
  return render(size, size, (rgba, w, h) => {
    const u = size / 128;
    addCard(rgba, w, h, 56 * u, 64 * u, 34 * u, 48 * u, -8, false);
    addCard(rgba, w, h, 78 * u, 60 * u, 34 * u, 48 * u, 9, true);
  });
}

// OG image: 1200x630, three fanned cards.
function og() {
  return render(1200, 630, (rgba, w, h) => {
    addCard(rgba, w, h, 470, 330, 190, 266, -18, false);
    addCard(rgba, w, h, 610, 316, 190, 266, -4, true);
    addCard(rgba, w, h, 750, 330, 190, 266, 12, false);
  });
}

writeFileSync(join(outDir, 'icon-192.png'), icon(192));
writeFileSync(join(outDir, 'icon-512.png'), icon(512));
writeFileSync(join(outDir, 'og.png'), og());
console.log('generated icon-192.png, icon-512.png, og.png');
