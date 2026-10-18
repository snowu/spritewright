/* spritewright: a small pixel art editor with no dependencies and no build step.
   Drop this one file into any project (or open the bundled index.html through `spritewright serve`), call Spritewright.mount(element, options),
   and it lists the project's PNG sprites, lets you edit them, saves them back, and can propose the change as a GitHub pull request.
   https://developer.mozilla.org/en-US/docs/Web/API/ImageData is the only "API" it leans on, plus fetch and canvas. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; // CommonJS and bundlers that treat this file as CommonJS
  root.Spritewright = api; // always register the global too: <script> tags, and index.mjs read it
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* =====================================================================================================
     Colours are packed little-endian into a Uint32 (0xAABBGGRR), which is exactly how a canvas's RGBA bytes
     read as a Uint32 on every platform browsers run on. Comparing two pixels is then one integer compare.
     ===================================================================================================== */
  const pack = (r, g, b, a = 255) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0);
  const unpack = (c) => [c & 255, (c >>> 8) & 255, (c >>> 16) & 255, c >>> 24];
  const toHex = (c) => '#' + unpack(c).slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => {
    const m = /^#?([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(String(h).trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return pack((n >> 16) & 255, (n >> 8) & 255, n & 255, m[2] ? parseInt(m[2], 16) : 255);
  };
  const isClear = (c) => c >>> 24 === 0;
  /** Parse a palette: Lospec .hex (one rrggbb per line) or any text containing #rrggbb values. Duplicates removed, order kept. */
  function parsePalette(text) {
    const out = [], seen = new Set();
    for (const tok of String(text).split(/[\s,;]+/)) {
      const c = tok ? fromHex(tok) : null;
      if (c != null && !seen.has(c)) { seen.add(c); out.push(c); }
    }
    return out;
  }
  const dist2 = (a, b) => { const p = unpack(a), q = unpack(b); return (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2; };
  /** The palette colour closest to c by RGB distance; the first one wins ties. */
  function nearestColor(c, palette) {
    let best = palette[0], bd = Infinity;
    for (const p of palette) { const d = dist2(c, p); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  /* =====================================================================================================
     Drawing algorithms, pure functions over a Uint32Array so they are easy to test.
     ===================================================================================================== */
  /** Bresenham: every pixel on the line from (x0,y0) to (x1,y1), inclusive. */
  function linePoints(x0, y0, x1, y1) {
    const pts = [], dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let err = dx + dy;
    for (;;) {
      pts.push([x0, y0]);
      if (x0 === x1 && y0 === y1) break;
      const e2 = 2 * err;
      if (e2 >= dy) { err += dy; x0 += sx; }
      if (e2 <= dx) { err += dx; y0 += sy; }
    }
    return pts;
  }
  /** The pixels of a rectangle between two corners, outline only or filled. */
  function rectPoints(x0, y0, x1, y1, filled) {
    const pts = [], ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
    for (let y = ay; y <= by; y++) for (let x = ax; x <= bx; x++) if (filled || x === ax || x === bx || y === ay || y === by) pts.push([x, y]);
    return pts;
  }
  /** Contiguous (4-way) flood fill. Returns the list of indices that were changed. */
  function floodFill(px, w, h, x, y, value) {
    const target = px[y * w + x], changed = [];
    if (target === value) return changed;
    const stack = [y * w + x];
    while (stack.length) {
      const i = stack.pop();
      if (px[i] !== target) continue;
      px[i] = value; changed.push(i);
      const cx = i % w, cy = (i / w) | 0;
      if (cx > 0) stack.push(i - 1);
      if (cx < w - 1) stack.push(i + 1);
      if (cy > 0) stack.push(i - w);
      if (cy < h - 1) stack.push(i + w);
    }
    return changed;
  }
  /** Colours used by an image, most used first. Fully transparent pixels are counted under key 0 and listed last. */
  function colorsOf(px) {
    const m = new Map();
    for (let i = 0; i < px.length; i++) { const c = isClear(px[i]) ? 0 : px[i]; m.set(c, (m.get(c) || 0) + 1); }
    return [...m.entries()].sort((a, b) => (a[0] === 0) - (b[0] === 0) || b[1] - a[1]);
  }
  const flipH = (px, w, h) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = px[y * w + (w - 1 - x)]; return o; };
  const flipV = (px, w, h) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[y * w + x] = px[(h - 1 - y) * w + x]; return o; };
  /** Rotate 90 degrees clockwise. The result is h wide and w tall. */
  const rotateCW = (px, w, h) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[x * h + (h - 1 - y)] = px[y * w + x]; return o; };
  /** Move everything by (dx,dy), wrapping around the edges so nothing is lost. */
  const shiftWrap = (px, w, h, dx, dy) => { const o = new Uint32Array(px.length); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[((y + dy % h + h) % h) * w + ((x + dx % w + w) % w)] = px[y * w + x]; return o; };
  /** Where the old image lands on a new canvas. anchor: tl t tr / l c r / bl b br (the part of the image that stays put). */
  function anchorOffset(w, h, nw, nh, anchor = 'tl') {
    const a = anchor === 'c' ? '' : anchor, ox = a.includes('l') ? 0 : a.includes('r') ? nw - w : Math.floor((nw - w) / 2), oy = a.startsWith('t') ? 0 : a.startsWith('b') ? nh - h : Math.floor((nh - h) / 2);
    return { x: ox, y: oy };
  }
  /** A new canvas size: the image is kept at its anchor, cut off or surrounded by transparent pixels. */
  function resizePx(px, w, h, nw, nh, anchor) {
    const o = new Uint32Array(nw * nh), { x: ox, y: oy } = anchorOffset(w, h, nw, nh, anchor);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x + ox, Y = y + oy; if (X >= 0 && Y >= 0 && X < nw && Y < nh) o[Y * nw + X] = px[y * w + x]; }
    return o;
  }
  /** Scale the image itself to nw x nh, nearest neighbour (pixels are repeated or dropped, never blended). */
  function scalePx(px, w, h, nw, nh) {
    const o = new Uint32Array(nw * nh);
    for (let y = 0; y < nh; y++) { const sy = Math.min(h - 1, Math.floor((y + 0.5) * h / nh)); for (let x = 0; x < nw; x++) o[y * nw + x] = px[sy * w + Math.min(w - 1, Math.floor((x + 0.5) * w / nw))]; }
    return o;
  }
  /** The smallest rectangle holding every visible pixel, or null when the image is empty. */
  function opaqueBounds(px, w, h) {
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (px[y * w + x] >>> 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  /* Pixels that look the same: fully clear counts as one value whatever colour it carries (a PNG's clear pixels often keep
     an RGB, the eraser writes 0), so erasing nothing is not a change. */
  const samePx = (a, b) => a === b || (a >>> 24 === 0 && b >>> 24 === 0);
  const countDiff = (a, b) => { if (a.length !== b.length) return Math.max(a.length, b.length); let n = 0; for (let i = 0; i < a.length; i++) if (!samePx(a[i], b[i])) n++; return n; };

  /** The pixels of an ellipse inside the box between two corners. Filled = every pixel centre inside; outline = the filled
      pixels that touch the outside on a side (a clean 1-pixel, 8-connected ring, symmetric like hand-placed pixel art). */
  function ellipsePoints(x0, y0, x1, y1, filled) {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1), w = bx - ax + 1, h = by - ay + 1;
    const cx = (w - 1) / 2, cy = (h - 1) / 2, rx = w / 2, ry = h / 2, inside = new Uint8Array(w * h), pts = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1.0001) inside[y * w + x] = 1;
    const at = (x, y) => x >= 0 && y >= 0 && x < w && y < h && inside[y * w + x];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (inside[y * w + x] && (filled || !at(x - 1, y) || !at(x + 1, y) || !at(x, y - 1) || !at(x, y + 1))) pts.push([ax + x, ay + y]);
    return pts;
  }
  /** Offsets of a brush tip of the given size: 'square' or 'round'. Size 1 is a single pixel; even sizes lean up-left. */
  function brushOffsets(size, shape) {
    const s = Math.max(1, Math.min(32, size | 0)), lo = 0 - Math.floor((s - 1) / 2) || 0, out = [], c = (s - 1) / 2 + lo, r = s / 2;
    for (let y = lo; y < lo + s; y++) for (let x = lo; x < lo + s; x++) if (shape !== 'round' || s <= 2 || (x - c) ** 2 + (y - c) ** 2 <= r * r - 0.5) out.push([x, y]);
    return out;
  }
  /** A 1-pixel path (a line or a shape outline) drawn with a bigger brush: the tip stamped on every point, each pixel once. */
  function thicken(pts, size, shape) {
    if ((size | 0) <= 1) return pts;
    const tip = brushOffsets(size, shape), seen = new Set(), out = [];
    for (const [x, y] of pts) for (const [ox, oy] of tip) { const k = (x + ox) + ',' + (y + oy); if (!seen.has(k)) { seen.add(k); out.push([x + ox, y + oy]); } }
    return out;
  }
  /** The checkerboard used by the dither pattern: true on the pixels it paints. */
  const ditherOn = (x, y, phase = 0) => ((x + y + phase) & 1) === 0;
  /* Ordered (Bayer 4×4) dither gradient: colour a at (x0,y0) to colour b at (x1,y1), over the given pixel indices of a w-wide
     image. Each pixel is a or b, never a blend: 17 even steps, the pattern pixel artists draw by hand. Rewrites px in place. */
  const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
  function ditherGradient(px, w, indices, x0, y0, x1, y1, a, b) {
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy;
    for (const i of indices) {
      const x = i % w, y = (i / w) | 0, t = len2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0;
      px[i] = t * 16 > BAYER4[(y & 3) * 4 + (x & 3)] + 0.5 ? b : a;
    }
    return px;
  }
  /** Replace every pixel of one colour (fully clear pixels count as one colour). Returns the indices changed. */
  function fillSame(px, x, y, w, value) {
    const t = px[y * w + x], clear = isClear(t), changed = [];
    if (t === value) return changed;
    for (let i = 0; i < px.length; i++) if (clear ? isClear(px[i]) : px[i] === t) { px[i] = value; changed.push(i); }
    return changed;
  }
  /** Outline: every clear pixel next to an opaque one gets the colour. corners = also diagonal neighbours (a thicker, rounder line). */
  function outlinePx(px, w, h, color, corners) {
    const o = px.slice(), solid = (x, y) => x >= 0 && y >= 0 && x < w && y < h && !isClear(px[y * w + x]);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (!isClear(px[y * w + x])) continue;
      if (solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1) || (corners && (solid(x - 1, y - 1) || solid(x + 1, y - 1) || solid(x - 1, y + 1) || solid(x + 1, y + 1)))) o[y * w + x] = color;
    }
    return o;
  }
  /* HSV helpers for ramps and shading. h in degrees, s and v in 0..1. */
  function toHsv(c) {
    const [r, g, b] = unpack(c).map((v) => v / 255), mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [(h * 60 + 360) % 360, mx ? d / mx : 0, mx];
  }
  function fromHsv(h, s, v, a = 255) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); v = Math.max(0, Math.min(1, v));
    const f = (n) => { const k = (n + h / 60) % 6; return Math.round((v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255); };
    return pack(f(5), f(3), f(1), a);
  }
  /** Move hue `amt` degrees toward `target` along the shorter way round the colour wheel. */
  const hueToward = (h, target, amt) => { const d = ((target - h + 540) % 360) - 180; return h + Math.sign(d) * Math.min(Math.abs(d), amt); };
  /** One step lighter (dir > 0) or darker (dir < 0), the pixel-art way: shadows drift toward blue and lose a little
      saturation, highlights drift toward yellow. With a palette, the result snaps to the nearest palette colour that differs. */
  function shadeColor(c, dir, palette) {
    if (isClear(c)) return c;
    let [h, s, v] = toHsv(c), out = c;
    for (let step = 1; step <= 6; step++) {
      const t = 0.1 * step, nh = s < 0.05 ? h : hueToward(h, dir > 0 ? 60 : 240, 12 * step);
      const cand = fromHsv(nh, s < 0.05 ? s : dir > 0 ? s - 0.06 * step : s + 0.04 * step, dir > 0 ? v + t : v - t, c >>> 24);
      out = palette && palette.length ? nearestColor(cand, palette) : cand;
      if (out !== c) return out;
    }
    return out;
  }
  /** Shift a colour's hue (degrees), saturation and brightness (-1..1, relative). keepDark leaves near-black (outlines) alone. */
  function shiftColor(c, dh, ds, dv, keepDark) {
    if (isClear(c)) return c;
    const [h, s, v] = toHsv(c);
    if (keepDark && v < 0.16) return c;
    return fromHsv(h + dh, ds >= 0 ? s + (1 - s) * ds : s * (1 + ds), dv >= 0 ? v + (1 - v) * dv : v * (1 + dv), c >>> 24);
  }
  /** The name of a family member's variant: king_atk.png + "dark" (family "king") → king_dark_atk.png. */
  const variantPath = (path, key, suffix) => { const i = path.lastIndexOf('/') + 1, file = path.slice(i); return path.slice(0, i) + key + '_' + suffix + file.slice(key.length); };
  /** A ramp of n colours around c, darkest first, with hue shifting (cool shadows, warm highlights). */
  function hueRamp(c, n = 5) {
    const [h, s, v] = toHsv(c), mid = (n - 1) / 2, out = [];
    for (let i = 0; i < n; i++) {
      const k = (i - mid) / Math.max(1, mid); // -1 darkest .. 1 lightest
      out.push(i === Math.round(mid) && n % 2 ? c : fromHsv(s < 0.05 ? h : hueToward(h, k > 0 ? 60 : 240, Math.abs(k) * 30), s < 0.05 ? s : s * (1 - 0.25 * k) + (k < 0 ? 0.1 * -k : 0), v + k * (k > 0 ? Math.min(0.35, 1 - v + 0.1) : Math.min(0.45, v - 0.08))));
    }
    return out;
  }
  /** An animated GIF (looping, 1-bit transparency) from frames [{ w, h, px: Uint32Array }]. Frames of different sizes share
      the largest canvas, bottom-centred so feet line up. Up to 255 colours are exact; beyond that the rarest colours map to
      the nearest kept one. delay is in hundredths of a second; scale blows pixels up (nearest neighbour). */
  function encodeGif(frames, { delay = 12, scale = 1 } = {}) {
    const W = Math.max(...frames.map((f) => f.w)) * scale, H = Math.max(...frames.map((f) => f.h)) * scale, count = new Map();
    for (const f of frames) for (const c of f.px) if (c >>> 24 >= 128) { const k = c & 0xffffff; count.set(k, (count.get(k) || 0) + 1); }
    const kept = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 255).map(([k]) => k), index = new Map(kept.map((k, i) => [k, i + 1]));
    const lookup = (k) => { let i = index.get(k); if (i == null) { let best = 1, bd = Infinity; kept.forEach((q, j) => { const d = ((q & 255) - (k & 255)) ** 2 + (((q >> 8) & 255) - ((k >> 8) & 255)) ** 2 + (((q >> 16) & 255) - ((k >> 16) & 255)) ** 2; if (d < bd) { bd = d; best = j + 1; } }); index.set(k, (i = best)); } return i; };
    let bits = 1; while ((1 << bits) < kept.length + 1) bits++;
    const out = [], u16 = (v) => out.push(v & 255, (v >> 8) & 255), str = (t) => { for (const ch of t) out.push(ch.charCodeAt(0)); };
    str('GIF89a'); u16(W); u16(H); out.push(0x80 | 0x70 | (bits - 1), 0, 0);
    for (let i = 0; i < 1 << bits; i++) { const k = i ? kept[i - 1] || 0 : 0; out.push(k & 255, (k >> 8) & 255, (k >> 16) & 255); }
    out.push(0x21, 0xff, 11); str('NETSCAPE2.0'); out.push(3, 1, 0, 0, 0); // loop forever
    const min = Math.max(2, bits);
    for (const f of frames) {
      const ox = Math.floor((W / scale - f.w) / 2), oy = H / scale - f.h, idx = new Uint8Array(W * H);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const sx = Math.floor(x / scale) - ox, sy = Math.floor(y / scale) - oy; if (sx < 0 || sy < 0 || sx >= f.w || sy >= f.h) continue; const c = f.px[sy * f.w + sx]; if (c >>> 24 >= 128) idx[y * W + x] = lookup(c & 0xffffff); }
      out.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(f.delay || delay); out.push(0, 0); // restore to background, index 0 is transparent; a frame may hold longer
      out.push(0x2c); u16(0); u16(0); u16(W); u16(H); out.push(0, min);
      const data = gifLzw(idx, min); for (let i = 0; i < data.length; i += 255) { const n = Math.min(255, data.length - i); out.push(n); for (let j = 0; j < n; j++) out.push(data[i + j]); }
      out.push(0);
    }
    out.push(0x3b);
    return new Uint8Array(out);
  }
  function gifLzw(indices, min) {
    const clear = 1 << min, eoi = clear + 1, out = [], dict = new Map();
    let size = min + 1, next = eoi + 1, acc = 0, nbits = 0;
    const emit = (code) => { acc |= code << nbits; nbits += size; while (nbits >= 8) { out.push(acc & 255); acc >>>= 8; nbits -= 8; } };
    emit(clear);
    let cur = indices[0];
    for (let i = 1; i < indices.length; i++) {
      const k = indices[i], key = (cur << 8) | k, hit = dict.get(key);
      if (hit !== undefined) { cur = hit; continue; }
      emit(cur);
      if (next === 4096) { emit(clear); dict.clear(); next = eoi + 1; size = min + 1; }
      else { if (next >= 1 << size) size++; dict.set(key, next++); }
      cur = k;
    }
    emit(cur); emit(eoi); if (nbits) out.push(acc & 255);
    return out;
  }
  /** Copy a rectangle {x,y,w,h} out of an image; parts outside the image come back clear. */
  function copyRect(px, w, h, r) {
    const o = new Uint32Array(r.w * r.h);
    for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const X = r.x + x, Y = r.y + y; if (X >= 0 && Y >= 0 && X < w && Y < h) o[y * r.w + x] = px[Y * w + X]; }
    return o;
  }
  /** Paste src (sw x sh) at (x,y). Clear source pixels leave what is underneath (like placing a sprite), unless opaque is true. */
  function pasteRect(px, w, h, src, sw, sh, x, y, opaque) {
    for (let j = 0; j < sh; j++) for (let i = 0; i < sw; i++) { const X = x + i, Y = y + j, v = src[j * sw + i]; if (X >= 0 && Y >= 0 && X < w && Y < h && (opaque || !isClear(v))) px[Y * w + X] = v; }
    return px;
  }
  /* Selection masks. A selection is a rectangle { x, y, w, h } plus, for lasso, wand and combined selections, mask: a
     Uint8Array(w*h) of the pixels inside it. These work on whole-image masks (Uint8Array(W*H)) and convert back. */
  function selMask(sel, W, H) {
    const m = new Uint8Array(W * H); if (!sel) return m;
    for (let y = 0; y < sel.h; y++) for (let x = 0; x < sel.w; x++) { const X = sel.x + x, Y = sel.y + y; if (X >= 0 && Y >= 0 && X < W && Y < H && (!sel.mask || sel.mask[y * sel.w + x])) m[Y * W + X] = 1; }
    return m;
  }
  /** The selection a whole-image mask describes: its bounding box, with a mask unless it fills that box. Null when empty. */
  function maskSel(m, W, H) {
    let x0 = W, y0 = H, x1 = -1, y1 = -1, n = 0;
    for (let i = 0; i < m.length; i++) if (m[i]) { const x = i % W, y = (i / W) | 0; n++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    if (!n) return null;
    const w = x1 - x0 + 1, h = y1 - y0 + 1, sel = { x: x0, y: y0, w, h };
    if (n === w * h) return sel;
    sel.mask = new Uint8Array(w * h); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) sel.mask[y * w + x] = m[(y0 + y) * W + x0 + x];
    return sel;
  }
  /** A lasso: the pixels whose centres fall inside the polygon through pts ([x, y] cells), and the cells on its outline. */
  function lassoMask(pts, W, H) {
    const m = new Uint8Array(W * H), n = pts.length, put = (x, y) => { if (x >= 0 && y >= 0 && x < W && y < H) m[y * W + x] = 1; };
    for (let i = 0; i < n; i++) { const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n]; for (const [x, y] of linePoints(ax, ay, bx, by)) put(x, y); }
    if (n >= 3) for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let inside = false; const px = x + 0.5, py = y + 0.5;
      for (let i = 0, j = n - 1; i < n; j = i++) { const [xi, yi] = [pts[i][0] + 0.5, pts[i][1] + 0.5], [xj, yj] = [pts[j][0] + 0.5, pts[j][1] + 0.5]; if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside; }
      if (inside) m[y * W + x] = 1;
    }
    return m;
  }
  /** Combine whole-image masks: 'add', 'sub' (a without b), or replace. */
  const combineMasks = (a, b, op) => (op === 'add' ? a.map((v, i) => v | b[i]) : op === 'sub' ? a.map((v, i) => (v && !b[i] ? 1 : 0)) : b);
  /* Pixel lint: the mistakes pixel-art critique points out first, found mechanically and kept conservative (a false alarm
     teaches people to ignore the overlay).
       stray   dust: an opaque pixel alone on a clear background, or a hole: a clear pixel with all 8 neighbours one colour.
               Specks of one colour inside another are left alone (texture grain, highlights)
       double  the extra corner of a one-pixel line: of its four direct neighbours exactly two share its colour, one beside and one above or below,
               so the line would still join diagonally without it (what "clean lines" removes while drawing). Only inside a thin
               1:1 staircase (an arm turns back the other way), when neither arm runs on straight, and when none of the three
               is part of a solid 2x2 of that colour, so box corners, shading regions and thick lines are left alone
       near    two colours so close they are probably one colour by accident; the rarer one's pixels are marked */
  function lintPixels(px, w, h) {
    const stray = [], doubles = [], at = (x, y) => (x >= 0 && y >= 0 && x < w && y < h ? px[y * w + x] : undefined);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const v = px[y * w + x], counts = new Map(); let same = 0, n = 0;
      const sameAt = (dx, dy) => { const u = at(x + dx, y + dy); return u !== undefined && samePxL(u, v); };
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue; const u = at(x + dx, y + dy) ?? 0; n++; // past the edge counts as clear, like the sprite's surroundings
        if (samePxL(u, v)) same++; else { const k = isClear(u) ? 0 : u; counts.set(k, (counts.get(k) || 0) + 1); }
      }
      // dust (an opaque pixel alone on clear) or a hole (a clear pixel inside one colour); specks of one colour inside another
      // are left alone, they are usually texture or a highlight on purpose
      if (!same && Math.max(0, ...counts.values()) === 8 && (isClear(v) || counts.has(0))) { stray.push(y * w + x); continue; }
      if (!isClear(v) && sameAt(-1, 0) + sameAt(1, 0) + sameAt(0, -1) + sameAt(0, 1) === 2) {
        const hx = sameAt(-1, 0) ? -1 : sameAt(1, 0) ? 1 : 0, vy = sameAt(0, -1) ? -1 : sameAt(0, 1) ? 1 : 0;
        // a corner that runs on straight both ways is a real 90° corner (a box outline); a step in a jagged line is not
        // part of a solid 2x2 of its colour = a region, not a line
        const block = (bx, by) => [[0, 0], [1, 0], [0, 1], [1, 1]].some(([ox, oy]) => [[0, 0], [1, 0], [0, 1], [1, 1]].every(([qx, qy]) => { const u = at(bx - ox + qx, by - oy + qy); return u !== undefined && samePxL(u, v); }));
        const thin = same <= 4 && !block(x, y) && !block(x + hx, y) && !block(x, y + vy), stair = sameAt(hx, -vy) || sameAt(-hx, vy), straight = sameAt(2 * hx, 0) || sameAt(0, 2 * vy);
        if (hx && vy && !sameAt(hx, vy) && thin && stair && !straight) doubles.push(y * w + x);
      }
    }
    const tally = new Map(); for (const v of px) if (!isClear(v)) tally.set(v, (tally.get(v) || 0) + 1);
    const near = [], nearPx = [];
    if (tally.size <= 256) {
      const cols = [...tally.keys()];
      for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) {
        const a = unpack(cols[i]), b = unpack(cols[j]), dist = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2], a[3] - b[3]);
        if (dist <= 10) { const [keep, odd] = tally.get(cols[i]) >= tally.get(cols[j]) ? [cols[i], cols[j]] : [cols[j], cols[i]]; near.push({ keep, odd, n: tally.get(odd) }); }
      }
      const odd = new Set(near.map((x) => x.odd)); px.forEach((v, i) => { if (odd.has(v)) nearPx.push(i); });
    }
    return { stray, doubles, near, nearPx };
  }
  const samePxL = (a, b) => a === b || (isClear(a) && isClear(b));
  /** Scale2x (EPX): twice the size, rounding stair-steps instead of making 2x2 blocks. Edges repeat the edge pixel. */
  function scale2x(px, w, h) {
    const o = new Uint32Array(w * h * 4), W = w * 2, at = (x, y) => px[Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const P = px[y * w + x], A = at(x, y - 1), B = at(x + 1, y), C = at(x - 1, y), D = at(x, y + 1), i = y * 2 * W + x * 2;
      o[i] = C === A && C !== D && A !== B ? A : P; o[i + 1] = A === B && A !== C && B !== D ? B : P;
      o[i + W] = D === C && D !== B && C !== A ? C : P; o[i + W + 1] = B === D && B !== A && D !== C ? D : P;
    }
    return { px: o, w: W, h: h * 2 };
  }
  /** RotSprite: rotate by any angle without the scattered pixels a plain nearest-neighbour rotation leaves. The image is
      enlarged 8x with Scale2x (which keeps lines and curves smooth), rotated, and sampled back at the original scale.
      The result is outW x outH (default: big enough for the whole rotated image), centred. */
  function rotSprite(px, w, h, deg, outW, outH) {
    const t = (deg * Math.PI) / 180, cos = Math.cos(t), sin = Math.sin(t);
    if (outW == null) { outW = Math.max(1, Math.round(Math.abs(w * cos) + Math.abs(h * sin))); outH = Math.max(1, Math.round(Math.abs(w * sin) + Math.abs(h * cos))); }
    let big = { px, w, h }; for (let k = 0; k < 3; k++) big = scale2x(big.px, big.w, big.h);
    const o = new Uint32Array(outW * outH), cx = outW / 2, cy = outH / 2;
    for (let y = 0; y < outH; y++) for (let x = 0; x < outW; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy, sx = dx * cos + dy * sin + w / 2, sy = -dx * sin + dy * cos + h / 2; // back to the source
      const bx = Math.floor(sx * 8), by = Math.floor(sy * 8);
      if (bx >= 0 && by >= 0 && bx < big.w && by < big.h) o[y * outW + x] = big.px[by * big.w + bx];
    }
    return { px: o, w: outW, h: outH };
  }
  /* Sprite sheets: frames of fw x fh in rows, left to right. These cut a sheet into frames and put it back together, so frames
     can be reordered, copied and removed; a one-row sheet grows or shrinks in width, a grid keeps its columns. */
  function sheetCut(px, w, h, fw, fh) {
    const cols = Math.max(1, Math.floor(w / fw)), rows = Math.max(1, Math.floor(h / fh)), out = [];
    for (let k = 0; k < cols * rows; k++) out.push(copyRect(px, w, h, { x: (k % cols) * fw, y: Math.floor(k / cols) * fh, w: fw, h: fh }));
    return { frames: out, cols, rows };
  }
  function sheetJoin(frames, fw, fh, cols) {
    const n = Math.max(1, frames.length), c = Math.max(1, Math.min(cols, n)), rows = Math.ceil(n / c), w = c * fw, h = rows * fh, px = new Uint32Array(w * h);
    frames.forEach((f, k) => pasteRect(px, w, h, f, fw, fh, (k % c) * fw, Math.floor(k / c) * fh, true));
    return { px, w, h };
  }
  /** 'swap' frames k and j, 'dup' frame k (the copy right after it), or 'del' frame k. A one-row sheet changes width. */
  function sheetEdit(px, w, h, fw, fh, op, k, j) {
    const { frames, cols, rows } = sheetCut(px, w, h, fw, fh);
    if (op === 'swap') [frames[k], frames[j]] = [frames[j], frames[k]];
    else if (op === 'dup') frames.splice(k + 1, 0, frames[k].slice());
    else if (op === 'del' && frames.length > 1) frames.splice(k, 1);
    return sheetJoin(frames, fw, fh, rows === 1 ? frames.length : cols);
  }
  /** Frames of any sizes side by side in one row, bottom-aligned like a game draws them, with where each one landed. */
  function packSheet(frames) {
    const w = frames.reduce((a, f) => a + f.w, 0), h = Math.max(...frames.map((f) => f.h)), px = new Uint32Array(w * h), rects = []; let x = 0;
    for (const f of frames) { pasteRect(px, w, h, f.px, f.w, f.h, x, h - f.h, true); rects.push({ x, y: h - f.h, w: f.w, h: f.h }); x += f.w; }
    return { px, w, h, rects };
  }
  /** The frames as Aseprite's "json-array" export, which most engines and tools read (Phaser, Godot importers, Unity, ...). */
  function sheetJson(image, w, h, rects, durations, names) {
    return { frames: rects.map((r, i) => ({ filename: names ? names[i] : String(i), frame: { x: r.x, y: r.y, w: r.w, h: r.h }, rotated: false, trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: r.w, h: r.h }, sourceSize: { w: r.w, h: r.h }, duration: durations[i] })),
    meta: { app: 'spritewright', version: '1', image, format: 'RGBA8888', size: { w, h }, scale: '1', frameTags: [] } };
  }
  /** Which frame plays at tick t when frame i lasts holds[i] ticks. */
  const holdFrame = (t, holds, n) => { const hs = Array.from({ length: n }, (_, i) => Math.max(1, (holds && holds[i]) | 0 || 1)), total = hs.reduce((a, b) => a + b, 0); let r = t % total; for (let i = 0; i < n; i++) { if (r < hs[i]) return i; r -= hs[i]; } return 0; };
  /** Carry an edit (before → after) over to another frame of the same size, keeping what the edit did not touch.
      1. Recolours: an old colour every pixel of which became one new colour is swapped everywhere in the target, exactly.
      2. The rest, pixel by pixel: where does the window of `before` around it sit in the target, within ±reach? Each pixel
         takes the shift its changed neighbours agree on (ties go to the shift of the whole frame), so a helm that bobs a pixel
         follows the bob and a weapon that stays put stays put.
      3. Neighbouring pixels on the same shift form a region, applied all or nothing: a region whose surroundings do not match
         well enough (a leg in another pose) is skipped whole, never half-applied, and comes back in `todo` to redraw by hand.
      4. A region whose surroundings match `after` at least as well as `before` is already there (an earlier apply, or drawn by
         hand): it is left alone, so applying the same edit twice changes nothing.
      Clear pixels agreeing with clear pixels are no evidence (empty space matches anywhere). */
  function portEdit(before, after, target, w, h, opts) {
    const r = portLayers({ w, h, before, after, target, src: [{ before, after }], dst: [{ px: target }], map: [0] }, opts);
    return { px: r.layers[0], recolours: r.recolours[0], regions: r.regions, todo: r.todo, shift: r.shift };
  }
  /** The same, layer by layer. Where things go is worked out on the flattened images (before, after, target: the most to match
      against); what is written comes from each source layer that changed there, into the target layer `map` gives it:
        src  [{ before, after }]  the source's layers, each as it was and as it is
        dst  [{ px, visible }]     the target's layers (left untouched: the result is in `layers`)
        map  src index → dst index (-1: no such layer, its pixels are left out and reported in `lost`), or 'shown' for a one-layer
             source: each pixel goes into the target layer that shows it there (the top visible one), else into dst[active].
      Recolours are found per layer, so one colour recoloured in the cape layer leaves the same colour in another layer alone. */
  function portLayers({ w, h, before, after, target, src, dst, map, active = 0 }, { reach = 4, radius = 3, pool = 3, min = 0.8 } = {}) {
    const n = w * h, out = dst.map((l) => l.px), own = new Set(), write = (t) => { if (!own.has(t)) { own.add(t); out[t] = out[t].slice(); } return out[t]; };
    const shown = map === 'shown', into = (k) => (shown ? -2 : map[k] == null ? -1 : map[k]), todo = [], lost = new Set(), regions = [];
    // 1. per source layer: what changed, and which of it is a recolour
    const recolours = [], rest = src.map((l, k) => {
      const changed = []; for (let i = 0; i < n; i++) if (!samePx(l.before[i], l.after[i])) changed.push(i);
      const count = new Map(), to = new Map();
      for (const c of l.before) if (!isClear(c)) count.set(c, (count.get(c) || 0) + 1);
      for (const i of changed) { const c = l.before[i]; if (isClear(c)) continue; const m = to.get(c); if (!m) to.set(c, { c: l.after[i], n: 1 }); else if (m.c !== l.after[i]) m.c = null; else m.n++; }
      const rc = new Map([...to].filter(([c, m]) => m.c !== null && !isClear(m.c) && m.n === count.get(c) && m.n >= 2).map(([c, m]) => [c, m.c])); recolours.push(rc);
      if (rc.size) { const ts = shown ? dst.map((_, t) => t).filter((t) => dst[t].visible !== false) : into(k) >= 0 ? [into(k)] : [];
        if (!ts.length) lost.add(k); for (const t of ts) { const px = out[t]; let hit = false; for (let i = 0; i < n; i++) if (rc.has(px[i])) { hit = true; break; } if (hit) { const o = write(t); for (let i = 0; i < n; i++) if (rc.has(o[i])) o[i] = rc.get(o[i]); } } }
      return new Set(changed.filter((i) => !rc.has(l.before[i])));
    });
    const all = [...new Set(rest.flatMap((x) => [...x]))].sort((a, b) => a - b);
    if (!all.length) return { layers: out, recolours, regions, todo, lost, shift: { x: 0, y: 0 } };
    // 2-4. where each changed pixel goes, on the flattened images
    const at = (px, x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : px[y * w + x]), offs = [];
    for (let y = -reach; y <= reach; y++) for (let x = -reach; x <= reach; x++) offs.push([x, y]);
    let shift = null; // the whole frame's best shift
    for (const [ox, oy] of offs) { let a = 0, c = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = before[y * w + x], q = at(target, x + ox, y + oy); if (isClear(p) && isClear(q)) continue; c++; if (samePx(p, q)) a++; } const s = c ? a / c : 0; if (!shift || s > shift.s) shift = { x: ox, y: oy, s }; }
    const near = (k) => Math.abs(offs[k][0] - shift.x) + Math.abs(offs[k][1] - shift.y), K = offs.length;
    const windows = (img) => { const a = new Float32Array(all.length * K), c = new Float32Array(all.length * K);
      all.forEach((i, r) => { const x = i % w, y = (i / w) | 0;
        offs.forEach(([ox, oy], k) => { let m = 0, v = 0;
          for (let dy = -radius; dy <= radius; dy++) for (let dx = -radius; dx <= radius; dx++) { const p = at(img, x + dx, y + dy), q = at(target, x + dx + ox, y + dy + oy); if (isClear(p) && isClear(q)) continue; v++; if (samePx(p, q)) m++; }
          a[r * K + k] = m; c[r * K + k] = v; }); });
      return [a, c]; };
    const [agree, seen] = windows(before), [agreeAfter, seenAfter] = windows(after), idx = new Map(all.map((i, r) => [i, r]));
    const pick = new Int32Array(all.length), score = new Float32Array(all.length), A = new Float32Array(K), N = new Float32Array(K);
    all.forEach((i, r) => { const x = i % w, y = (i / w) | 0; A.fill(0); N.fill(0);
      for (let dy = -pool; dy <= pool; dy++) for (let dx = -pool; dx <= pool; dx++) { const j = x + dx < 0 || x + dx >= w ? undefined : idx.get((y + dy) * w + x + dx); if (j !== undefined) for (let k = 0; k < K; k++) { A[k] += agree[j * K + k]; N[k] += seen[j * K + k]; } }
      let b = 0, bs = -1; for (let k = 0; k < K; k++) { const s = N[k] ? A[k] / N[k] : 0; if (s > bs + 1e-6 || (s > bs - 1e-6 && near(k) < near(b))) { b = k; bs = s; } }
      pick[r] = b; score[r] = seen[r * K + b] ? agree[r * K + b] / seen[r * K + b] : 0; });
    // the layer a pixel goes into: its source layer's match, or (one-layer source) the target layer that shows it there
    const shownAt = (d) => { for (let t = dst.length - 1; t >= 0; t--) if (dst[t].visible !== false && !isClear(dst[t].px[d])) return t; return Math.max(0, Math.min(dst.length - 1, active)); };
    const already = (pixels, dest) => pixels.every((p, q) => dest[q] < 0 || src.every((l, k) => !rest[k].has(p) || (() => { const t = shown ? shownAt(dest[q]) : into(k); return t >= 0 && samePx(out[t][dest[q]], l.after[p]); })()));
    const visible = (pixels) => pixels.some((p) => !samePx(before[p], after[p]));
    const taken = new Uint8Array(all.length);
    for (let r0 = 0; r0 < all.length; r0++) {
      if (taken[r0]) continue; const reg = [r0]; taken[r0] = 1;
      for (let t = 0; t < reg.length; t++) { const i = all[reg[t]], x = i % w, y = (i / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = x + dx < 0 || x + dx >= w ? undefined : idx.get((y + dy) * w + x + dx); if (j !== undefined && !taken[j] && pick[j] === pick[r0]) { taken[j] = 1; reg.push(j); } } }
      const [ox, oy] = offs[pick[r0]], pixels = reg.map((j) => all[j]), dest = pixels.map((i) => { const x = i % w + ox, y = ((i / w) | 0) + oy; return x < 0 || y < 0 || x >= w || y >= h ? -1 : y * w + x; });
      const R = { pixels, x: ox, y: oy, score: reg.reduce((t, j) => t + score[j], 0) / reg.length }; R.applied = R.score >= min; regions.push(R);
      let done = 0; for (let k = 0; k < K; k++) { let a = 0, c = 0; for (const j of reg) { a += agreeAfter[j * K + k]; c += seenAfter[j * K + k]; } if (c) done = Math.max(done, a / c); }
      const matched = reg.reduce((t, j) => t + agree[j * K + pick[j]], 0) / Math.max(1, reg.reduce((t, j) => t + seen[j * K + pick[j]], 0));
      // already there: its surroundings look edited (a change that shows), or every layer already holds the edited pixels
      if ((visible(pixels) && done >= min && done >= matched) || (R.applied && already(pixels, dest))) { R.applied = false; R.done = true; continue; }
      pixels.forEach((p, q) => {
        const d = dest[q]; if (d < 0) return; if (!R.applied) { todo.push(d); return; }
        let missing = false;
        src.forEach((l, k) => {
          if (!rest[k].has(p)) return;
          if (shown && isClear(l.after[p])) { dst.forEach((L, t) => { if (L.visible !== false && !isClear(out[t][d])) write(t)[d] = 0; }); return; } // an erased pixel: gone from every layer showing it
          const t = shown ? shownAt(d) : into(k); if (t < 0) { lost.add(k); missing = true; return; }
          write(t)[d] = l.after[p];
        });
        if (missing) todo.push(d);
      });
    }
    return { layers: out, recolours, regions, todo, lost, shift: { x: shift.x, y: shift.y } };
  }
  /** Which target layer each source layer goes into: the one with its name, else (same number of layers) the one in its place. */
  function layerMap(from, to) {
    const used = new Set(), m = from.map((name) => { const t = to.indexOf(name); if (t >= 0 && !used.has(t)) { used.add(t); return t; } return -1; });
    return from.length === to.length ? m.map((t, k) => (t >= 0 ? t : used.has(k) ? -1 : (used.add(k), k))) : m;
  }
  /** Normalise a drag between two cells into a rectangle clipped to the image (null when it misses the image). */
  function rectBetween(a, b, w, h) {
    const x0 = Math.max(0, Math.min(a.x, b.x)), y0 = Math.max(0, Math.min(a.y, b.y)), x1 = Math.min(w - 1, Math.max(a.x, b.x)), y1 = Math.min(h - 1, Math.max(a.y, b.y));
    return x1 < x0 || y1 < y0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }
  /** Shift-constrain the second corner so the box is square (shapes) or the line snaps to 0/45/90 degrees. */
  function constrain(a, b, mode) {
    const dx = b.x - a.x, dy = b.y - a.y, m = Math.max(Math.abs(dx), Math.abs(dy));
    if (mode === 'line') { const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4); return { x: a.x + Math.round(Math.cos(ang) * m), y: a.y + Math.round(Math.sin(ang) * m) }; }
    return { x: a.x + Math.sign(dx || 1) * m, y: a.y + Math.sign(dy || 1) * m };
  }

  /* =====================================================================================================
     Layers. A sprite can be drawn in layers (line art, colour, shading); the game only ever sees them flattened, in the
     sprite's own PNG. The layers go next to it in name.layers.png: the layers stacked top to bottom (the first is the bottom
     layer) and their names, visibility and opacity in a tEXt chunk, so they travel with the PNG through git and pull requests.
     A linked layer (link: { id, x, y }) is one drawing shared by the frames of an animation: every frame keeps its own copy, at
     its own offset (x, y), and an edit to it in one frame is made in the others, moved by the difference of their offsets.
     ===================================================================================================== */
  const LAYERS_KEY = 'spritewright-layers';
  const layersPath = (path) => path.replace(/(\.png)?$/i, '.layers.png');
  const isLayersFile = (path) => /\.layers\.png$/i.test(path);
  const linkOf = (k) => (k && typeof k.id === 'string' && k.id ? { id: k.id, x: Math.round(+k.x || 0), y: Math.round(+k.y || 0) } : null);
  const layerOf = (l) => { const o = { name: l.name, visible: l.visible !== false, opacity: l.opacity == null ? 100 : Math.max(0, Math.min(100, Math.round(l.opacity))), px: l.px }, k = linkOf(l.link); if (k) o.link = k; return o; };
  /** The layers drawn bottom to top (hidden ones skipped, opacity applied) into one image: straight-alpha "normal" blending. */
  function flattenLayers(layers, n) {
    const out = new Uint32Array(n);
    for (const l of layers) {
      if (l.visible === false || l.opacity === 0) continue;
      const op = (l.opacity == null ? 100 : l.opacity) / 100, src = l.px;
      for (let i = 0; i < n; i++) {
        const s = src[i], sa = ((s >>> 24) * op) / 255; if (!sa) continue;
        const d = out[i], da = (d >>> 24) / 255;
        if (sa === 1 || !da) { out[i] = sa === 1 ? s : ((Math.round(sa * 255) << 24) | (s & 0xffffff)) >>> 0; continue; }
        const a = sa + da * (1 - sa), mix = (k) => Math.round((((s >>> k) & 255) * sa + ((d >>> k) & 255) * da * (1 - sa)) / a);
        out[i] = ((Math.round(a * 255) << 24) | (mix(16) << 16) | (mix(8) << 8) | mix(0)) >>> 0;
      }
    }
    return out;
  }
  /** Layers to the sidecar image: one w×h band per layer, bottom layer first, and what the bands are in the text. */
  function packLayers(layers, w, h) {
    const px = new Uint32Array(w * h * layers.length); layers.forEach((l, k) => px.set(l.px, k * w * h));
    const meta = { version: 1, layers: layers.map((l) => ({ name: l.name, ...(l.visible === false ? { visible: false } : {}), ...(l.opacity != null && l.opacity !== 100 ? { opacity: l.opacity } : {}), ...(linkOf(l.link) ? { link: linkOf(l.link) } : {}) })) };
    return { w, h: h * layers.length, px, text: { [LAYERS_KEY]: JSON.stringify(meta).replace(/[\u0080-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')) } };
  }
  /** The sidecar image back to layers of w×h, or null when it is not one (no text, or bands that do not fit). */
  function unpackLayers(img, w, h) {
    let meta; try { meta = JSON.parse((img.text || {})[LAYERS_KEY]); } catch { return null; }
    const list = meta && Array.isArray(meta.layers) ? meta.layers : null;
    if (!list || !list.length || img.w !== w || img.h !== h * list.length) return null;
    return list.map((l, k) => layerOf({ name: String(l.name || 'Layer ' + (k + 1)), visible: l.visible, opacity: l.opacity, link: l.link, px: img.px.slice(k * w * h, (k + 1) * w * h) }));
  }
  /** A short fingerprint of layers (names, visibility, opacity and pixels), to tell whether they changed. */
  function layersSig(layers) {
    if (layers.length < 2) return '';
    let hsh = 0x811c9dc5; const mixIn = (v) => { hsh = Math.imul(hsh ^ v, 0x01000193) >>> 0; };
    for (const l of layers) { for (const c of l.name) mixIn(c.charCodeAt(0)); mixIn(l.visible === false ? 1 : 2); mixIn(l.opacity == null ? 100 : l.opacity); if (l.link) { for (const c of l.link.id) mixIn(c.charCodeAt(0)); mixIn(l.link.x + 1e4); mixIn(l.link.y + 1e4); } for (let i = 0; i < l.px.length; i++) mixIn(l.px[i]); }
    return layers.length + ':' + hsh.toString(36);
  }
  const copyLayers = (layers) => layers.map((l) => ({ ...l, px: l.px.slice() }));
  /** An edit to a linked layer carried to another frame's copy: the pixels that changed (before → after), moved by (dx, dy).
      Only those pixels are written, so what the other copy has beyond this frame's edges is kept. Returns how many changed. */
  function linkCarry(before, after, target, w, h, dx, dy) {
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      if (before[i] === after[i]) continue; const x = (i % w) + dx, y = ((i / w) | 0) + dy;
      if (x < 0 || y < 0 || x >= w || y >= h || target[y * w + x] === after[i]) continue; target[y * w + x] = after[i]; n++;
    }
    return n;
  }
  /** Where a drawing sits in another image, within ±reach: the shift at which its opaque pixels agree with `img` most. */
  function findShift(px, img, w, h, reach = 4) {
    let best = { x: 0, y: 0, s: -1 };
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
      let a = 0, n = 0;
      for (let i = 0; i < w * h; i++) { if (isClear(px[i])) continue; n++; const x = (i % w) + dx, y = ((i / w) | 0) + dy; if (x >= 0 && y >= 0 && x < w && y < h && samePx(px[i], img[y * w + x])) a++; }
      const s = n ? a / n : 0; if (s > best.s + 1e-9 || (Math.abs(s - best.s) <= 1e-9 && Math.abs(dx) + Math.abs(dy) < Math.abs(best.x) + Math.abs(best.y))) best = { x: dx, y: dy, s };
    }
    return best;
  }

  /* =====================================================================================================
     A document is one image being edited, with undo history.
     base    = the pixels when this session loaded it (what a pull request is measured against)
     saved   = the pixels at the last save (what "unsaved changes" is measured against)
     ported  = the state at the last "apply edit" to other frames, layers included (what the next one is measured against); undo and redo forget it
     ===================================================================================================== */
  /* layers  = bottom first; px is the current layer's pixels (what every tool draws on), flat() what the file holds.
     A sprite with one plain layer is exactly its PNG: flat() is px itself. */
  class Doc {
    constructor(path, w, h, px, extra = {}) {
      this.path = path; this.w = w; this.h = h; this.layers = [layerOf({ name: 'Layer 1', px })]; this.active = 0;
      this.base = { w, h, px: px.slice(), sig: '' }; this.saved = { w, h, px: px.slice(), sig: '' };
      this.undo = []; this.redo = []; this.local = !!extra.local; this.frames = extra.frames || null; this.isNew = !!extra.isNew;
      if (this.isNew) this.base = { w, h, px: new Uint32Array(w * h), sig: '' }; // a new file: every pixel counts as a change
    }
    get px() { return this.layers[this.active].px; }
    set px(v) { this.layers[this.active].px = v; }
    get layered() { return this.layers.length > 1; }
    get layer() { return this.layers[this.active]; }
    flat() { const ls = this.layers; return ls.length === 1 && ls[0].visible && ls[0].opacity === 100 ? ls[0].px : flattenLayers(ls, this.w * this.h); }
    sig() { return layersSig(this.layers); }
    /** Replace every layer by one image (a version from history, the original). */
    setFlat(w, h, px) { this.w = w; this.h = h; this.layers = [layerOf({ name: 'Layer 1', px })]; this.active = 0; }
    setLayers(layers, active = layers.length - 1) { this.layers = layers.map(layerOf); this.active = Math.max(0, Math.min(this.layers.length - 1, active)); }
    /** Run an edit of the whole image (resize, flip, rotate…) on every layer: fn(doc) changes px, w and h as for one image. */
    allLayers(fn) {
      const a = this.active, w = this.w, h = this.h; let W = w, H = h;
      for (let k = 0; k < this.layers.length; k++) { this.active = k; this.w = w; this.h = h; fn(this); W = this.w; H = this.h; }
      this.active = a; this.w = W; this.h = H;
    }
    state() { const layers = copyLayers(this.layers); return { w: this.w, h: this.h, active: this.active, layers, px: layers[this.active].px }; }
    restore(s) { this.w = s.w; this.h = s.h; this.layers = s.layers; this.active = s.active; }
    snapshot() { this.undo.push(this.state()); if (this.undo.length > 100) this.undo.shift(); this.redo.length = 0; }
    swap(from, to) { this.ported = null; to.push(this.state()); this.restore(from.pop()); }
    undoOnce() { if (!this.undo.length) return false; this.swap(this.undo, this.redo); return true; }
    redoOnce() { if (!this.redo.length) return false; this.swap(this.redo, this.undo); return true; }
    same(ref) { return ref.w === this.w && ref.h === this.h && countDiff(ref.px, this.flat()) === 0 && (ref.sig || '') === this.sig(); }
    get unsaved() { return !this.same(this.saved); }
    get changed() { return !this.same(this.base); }
    /** The state to compare against later (base, saved): the flat pixels, and the layers when there are several. */
    mark() { return { w: this.w, h: this.h, px: this.flat().slice(), sig: this.sig(), ...(this.layered ? { layers: copyLayers(this.layers) } : {}) }; }
    markSaved() { this.saved = this.mark(); }
    changedPixels() { return this.base.w === this.w && this.base.h === this.h ? countDiff(this.base.px, this.flat()) : this.w * this.h; }
    imageData() { return new ImageData(new Uint8ClampedArray(this.flat().buffer.slice(0)), this.w, this.h); }
  }

  /* =====================================================================================================
     Pull requests through the GitHub REST API, straight from the browser. No server is involved: the token the
     artist pastes in is only ever sent to api.github.com (or the apiBase you configure).
       - If the token can push to the repo, the branch goes there.
       - If not (an outside contributor), the repo is forked first and the pull request is opened from the fork.
     files: [{ path, blob }]  where path is relative to the repository root and blob is the PNG as a Blob/Uint8Array.
     ===================================================================================================== */
  /** A plain-language reason for a GitHub API failure, with the raw message kept at the end for support. */
  function explainGithubError(status, message, what, repo) {
    const m = String(message || ''), raw = ` [${what}: ${status} ${m}]`;
    if (status === 401) return 'GitHub rejected the sign-in or token (it expired or was revoked). Sign in again or paste a new token.' + raw;
    if (status === 403 && /SAML|SSO/i.test(m)) return 'This organisation requires single sign-on: authorise the token or app for it on GitHub, then try again.' + raw;
    if (status === 403 && /rate limit/i.test(m)) return 'GitHub rate limit reached. Sign in (or add a token) to raise it, or wait a few minutes.' + raw;
    if (status === 403 && /not accessible|forbidden|permission/i.test(m)) return `You are signed in, but not allowed to do that${repo ? ' on ' + repo : ''}. It needs write access to Contents and Pull requests on this repository (for the GitHub App: install the app on it and accept the permissions).` + raw;
    if (status === 404) return `GitHub says not found${repo ? ' for ' + repo : ''}. Check the name and branch, and for a private repository sign in or use a token with access to it.` + raw;
    if (status === 422 && /already exists/i.test(m)) return 'A branch or pull request with that name already exists. Change the title and try again.' + raw;
    return `GitHub ${what} failed: ${status} ${m}`;
  }
  const refPath = (b) => String(b).split('/').map(encodeURIComponent).join('/'); // keep the slashes in branch names like release/1.0
  async function createPullRequest(o) {
    const api = (o.apiBase || 'https://api.github.com').replace(/\/$/, ''), doFetch = o.fetch || fetch.bind(globalThis), log = o.onProgress || (() => {});
    const call = async (method, url, body) => {
      const res = await doFetch(api + url, { method, headers: { Authorization: 'Bearer ' + o.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) { const e = new Error(explainGithubError(res.status, (json && json.message) || text.slice(0, 120), `${method} ${url}`, o.repo)); e.status = res.status; throw e; }
      return json;
    };
    if (!o.token) throw new Error('A GitHub token is required.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    if (!o.files || !o.files.length) throw new Error('There are no changed sprites to propose.');

    log('Checking the token…');
    const me = (await call('GET', '/user')).login;
    log('Reading the repository…');
    const repo = await call('GET', '/repos/' + o.repo);
    const base = o.base || repo.default_branch;
    let headRepo = o.repo, headOwner = null;
    if (!(repo.permissions && repo.permissions.push)) {
      log('No write access, forking to ' + me + '…');
      const fork = await call('POST', '/repos/' + o.repo + '/forks', {});
      headRepo = fork.full_name || me + '/' + repo.name; headOwner = me;
      for (let i = 0; i < (o.forkRetries ?? 30); i++) {
        try { await call('GET', '/repos/' + headRepo); break; } catch (e) { if (e.status !== 404 || i === (o.forkRetries ?? 30) - 1) throw e; await new Promise((r) => setTimeout(r, o.forkDelay ?? 1000)); }
      }
      try { await call('POST', '/repos/' + headRepo + '/merge-upstream', { branch: base }); } catch { /* already up to date, or not allowed: carry on */ }
    }
    log('Reading ' + base + '…');
    const baseRef = await call('GET', '/repos/' + o.repo + '/git/ref/heads/' + refPath(base));
    const baseSha = baseRef.object.sha;
    const baseCommit = await call('GET', '/repos/' + o.repo + '/git/commits/' + baseSha);
    const upload = async (data) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return (await call('POST', '/repos/' + headRepo + '/git/blobs', { content: btoa(bin), encoding: 'base64' })).sha;
    };
    const tree = [];
    for (const f of o.files) {
      log((f.delete ? 'Removing ' : 'Uploading ') + f.path + '…');
      tree.push({ path: (o.prefix || '') + f.path, mode: '100644', type: 'blob', sha: f.delete ? null : await upload(f.blob) }); // sha null deletes the file
    }
    const branch = o.branch || 'art/update-' + Date.now().toString(36);
    /* Upscaled previews for the description (GitHub smooths small images it scales up; these need no scaling).
       Preferred: a commit on no branch kept alive by a hidden ref, so they never touch the pull request at all.
       If the token may not create that ref (some GitHub App setups), they go in a commit under the change instead, which the
       change itself deletes again: the pull request's files are still only the sprites. */
    let previewSha = null, previewDir = '', parent = baseSha;
    if (o.previews && o.previews.length) {
      try {
        log('Uploading previews…');
        const ptree = [];
        for (const [i, p] of o.previews.entries()) for (const side of ['before', 'after']) if (p[side]) ptree.push({ name: `${i}-${side}.png`, sha: await upload(p[side]) });
        const entry = (dir) => ptree.map((t) => ({ path: dir + t.name, mode: '100644', type: 'blob', sha: t.sha }));
        try {
          const pt = await call('POST', '/repos/' + headRepo + '/git/trees', { tree: entry('') });
          const pc = await call('POST', '/repos/' + headRepo + '/git/commits', { message: 'spritewright: previews for the pull request description (on no branch)', tree: pt.sha, parents: [] });
          await call('POST', '/repos/' + headRepo + '/git/refs', { ref: 'refs/spritewright/previews/' + branch, sha: pc.sha });
          previewSha = pc.sha;
        } catch {
          previewDir = '.spritewright-previews/';
          const pt = await call('POST', '/repos/' + headRepo + '/git/trees', { base_tree: baseCommit.tree.sha, tree: entry(previewDir) });
          const pc = await call('POST', '/repos/' + headRepo + '/git/commits', { message: 'spritewright: previews for the pull request description (removed by the next commit)', tree: pt.sha, parents: [baseSha] });
          previewSha = pc.sha; parent = pc.sha;
        }
      } catch (e) { previewSha = null; previewDir = ''; parent = baseSha; log('Previews skipped (' + e.message + '); the description links the files instead.'); }
    }
    log('Creating the commit…');
    const newTree = await call('POST', '/repos/' + headRepo + '/git/trees', { base_tree: baseCommit.tree.sha, tree });
    const commit = await call('POST', '/repos/' + headRepo + '/git/commits', { message: o.message || o.title, tree: newTree.sha, parents: [parent] });
    await call('POST', '/repos/' + headRepo + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });
    log('Opening the pull request…');
    const pr = await call('POST', '/repos/' + o.repo + '/pulls', { title: o.title, body: typeof o.body === 'function' ? o.body({ baseSha, commit: commit.sha, headRepo, previewSha, previewDir }) : (o.body || ''), head: headOwner ? headOwner + ':' + branch : branch, base, maintainer_can_modify: true });
    return { url: pr.html_url, number: pr.number, branch, forked: !!headOwner, commit: commit.sha, headRepo, previewSha, previewDir };
  }
  /** The GitHub REST calls the commit, branch and pull-request flows share. `fetch` is injectable so tests can mock the API. */
  function ghApi(o) {
    const api = (o.apiBase || 'https://api.github.com').replace(/\/$/, ''), doFetch = o.fetch || fetch.bind(globalThis);
    const call = async (method, url, body) => {
      const res = await doFetch(api + url, { method, headers: { Authorization: 'Bearer ' + o.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) { const e = new Error(explainGithubError(res.status, (json && json.message) || text.slice(0, 120), `${method} ${url}`, o.repo)); e.status = res.status; throw e; }
      return json;
    };
    return { call };
  }
  /** Branch names on a repository. */
  async function listBranches(o) {
    const { call } = ghApi(o);
    if (!o.token) throw new Error('A GitHub token is required.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    return ((await call('GET', '/repos/' + o.repo + '/branches?per_page=100')) || []).map((b) => b.name);
  }
  /** Open pull requests with this head branch, newest first. `head` is `owner:branch`; the owner defaults to the repository's. */
  async function openPulls(o) {
    const { call } = ghApi(o);
    if (!o.token) throw new Error('A GitHub token is required.');
    const owner = o.owner || (o.repo || '').split('/')[0];
    const pulls = await call('GET', '/repos/' + o.repo + '/pulls?state=open&head=' + encodeURIComponent(owner + ':' + o.branch) + '&per_page=10&sort=created&direction=desc');
    return (pulls || []).map((p) => ({ number: p.number, url: p.html_url, title: p.title }));
  }
  /** Open a pull request for a branch that already has the changes. */
  async function openPull(o) {
    const { call } = ghApi(o), log = o.onProgress || (() => {});
    if (!o.token) throw new Error('A GitHub token is required.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    if (!o.branch) throw new Error('There is no branch to propose yet.');
    log('Opening the pull request…');
    const pr = await call('POST', '/repos/' + o.repo + '/pulls', { title: o.title || 'Update sprites', body: o.body || '', head: o.headOwner ? o.headOwner + ':' + o.branch : o.branch, base: o.base, maintainer_can_modify: true });
    return { url: pr.html_url, number: pr.number };
  }
  /** Push PNG files as one commit: to `branch` when it exists, or to a new branch from `base` when it does not
      (forking first without write access, like createPullRequest). One chunk of a bigger piece of work: later
      chunks push again, and the pull request — opened now or later — carries every commit on the branch. */
  async function pushSprites(o) {
    const { call } = ghApi(o), log = o.onProgress || (() => {});
    if (!o.token) throw new Error('A GitHub token is required.');
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    if (!o.files || !o.files.length) throw new Error('There are no changed sprites to commit.');
    log('Checking the token…');
    const me = (await call('GET', '/user')).login;
    log('Reading the repository…');
    const repo = await call('GET', '/repos/' + o.repo);
    const base = o.base || repo.default_branch;
    let headRepo = o.repo, headOwner = null;
    if (!(repo.permissions && repo.permissions.push)) {
      log('No write access, forking to ' + me + '…');
      const fork = await call('POST', '/repos/' + o.repo + '/forks', {});
      headRepo = fork.full_name || me + '/' + repo.name; headOwner = me;
      for (let i = 0; i < (o.forkRetries ?? 30); i++) {
        try { await call('GET', '/repos/' + headRepo); break; } catch (e) { if (e.status !== 404 || i === (o.forkRetries ?? 30) - 1) throw e; await new Promise((r) => setTimeout(r, o.forkDelay ?? 1000)); }
      }
      try { await call('POST', '/repos/' + headRepo + '/merge-upstream', { branch: base }); } catch { /* already up to date, or not allowed: carry on */ }
    }
    const branch = o.branch || 'art/update-' + Date.now().toString(36);
    let parent = null, baseTree = null, baseSha = null, created = true;
    try {
      const ref = await call('GET', '/repos/' + headRepo + '/git/ref/heads/' + refPath(branch));
      const tip = await call('GET', '/repos/' + headRepo + '/git/commits/' + ref.object.sha);
      parent = ref.object.sha; baseTree = tip.tree.sha; created = false;
    } catch (e) {
      if (e.status !== 404) throw e;
      log('Reading ' + base + '…');
      const baseRef = await call('GET', '/repos/' + o.repo + '/git/ref/heads/' + refPath(base));
      baseSha = baseRef.object.sha;
      const baseCommit = await call('GET', '/repos/' + o.repo + '/git/commits/' + baseSha);
      parent = baseSha; baseTree = baseCommit.tree.sha;
    }
    const upload = async (data) => {
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(await data.arrayBuffer());
      let bin = ''; for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return (await call('POST', '/repos/' + headRepo + '/git/blobs', { content: btoa(bin), encoding: 'base64' })).sha;
    };
    const tree = [];
    for (const f of o.files) {
      log((f.delete ? 'Removing ' : 'Uploading ') + f.path + '…');
      tree.push({ path: (o.prefix || '') + f.path, mode: '100644', type: 'blob', sha: f.delete ? null : await upload(f.blob) }); // sha null deletes the file
    }
    log('Creating the commit…');
    const newTree = await call('POST', '/repos/' + headRepo + '/git/trees', { base_tree: baseTree, tree });
    const commit = await call('POST', '/repos/' + headRepo + '/git/commits', { message: o.message || 'Update sprites', tree: newTree.sha, parents: [parent] });
    if (created) await call('POST', '/repos/' + headRepo + '/git/refs', { ref: 'refs/heads/' + branch, sha: commit.sha });
    else await call('PATCH', '/repos/' + headRepo + '/git/refs/heads/' + refPath(branch), { sha: commit.sha });
    return { branch, headRepo, headOwner, forked: !!headOwner, commit: commit.sha, base, baseSha, created };
  }
  /** How much to blow a sprite up for the pull request description: about 256 px on the long side, 1× to 16×. */
  const previewScale = (w, h) => Math.max(1, Math.min(16, Math.floor(256 / Math.max(w, h, 1))));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'art';

  /** Markdown for the pull request body: what changed and how much, with before/after links when the repo is public. */
  function prBody(o) {
    const rows = o.files.map((f) => `| \`${f.path}\` | ${f.w}×${f.h} | ${f.pixels} |`).join('\n');
    const raw = (repo, sha, file) => `https://raw.githubusercontent.com/${repo}/${sha}/${file}`;
    const imgs = o.files.map((f, i) => {
      if (o.previewSha) { // pre-scaled, nearest-neighbour copies shown at their real size, so GitHub never smooths them
        const sc = f.scale || 1, wpx = f.w * sc, bw = (f.baseW || f.w) * sc, prev = (side) => raw(o.headRepo || o.repo, o.previewSha, `${o.previewDir || ''}${i}-${side}.png`);
        return `**${f.path}** (shown ${sc}×)\n\nBefore | After\n--- | ---\n${f.isNew ? '_new file_' : `<img src="${prev('before')}" width="${bw}">`} | <img src="${prev('after')}" width="${wpx}">`;
      }
      return o.repo && o.baseSha && o.commit ? `**${f.path}**\n\nBefore | After\n--- | ---\n<img src="${raw(o.repo, o.baseSha, (o.prefix || '') + f.path)}" width="128"> | <img src="${raw(o.headRepo || o.repo, o.commit, (o.prefix || '') + f.path)}" width="128">` : '';
    }).filter(Boolean).join('\n\n');
    // review notes pinned to pixels: [{ path, items: [{ x, y, text }] }]
    const notes = (o.notes || []).filter((n) => n.items && n.items.some((it) => String(it.text || '').trim()));
    const notesMd = notes.length ? '\n### Notes\n\n' + notes.map((n) => `**${n.path}**\n\n` + n.items.filter((it) => String(it.text || '').trim()).map((it, i) => `${i + 1}. (${it.x}, ${it.y}) ${String(it.text).trim().replace(/\n+/g, ' ')}`).join('\n')).join('\n\n') + '\n' : '';
    return `${o.description ? o.description + '\n\n' : ''}| Sprite | Size | Pixels changed |\n| --- | --- | --- |\n${rows}\n${imgs ? '\n' + imgs + '\n' : ''}${notesMd}\n_Proposed with spritewright. GitHub shows PNG changes in the "Files changed" tab with 2-up, swipe and onion-skin views._`;
  }


  /* =====================================================================================================
     Lossless PNG reading and writing. Browsers decode images through a canvas, which stores premultiplied alpha, so a pixel
     such as (229, 120, 7, alpha 250) comes back as (230, ...): silently changing colours that a game may match exactly.
     Reading and writing the PNG bytes ourselves keeps every channel of every pixel intact. Uses the browsers' built-in
     DecompressionStream/CompressionStream ("deflate" is the zlib format PNG uses); older browsers fall back to the canvas.
     ===================================================================================================== */
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (u8, start, end) => { let c = 0xffffffff; for (let i = start; i < end; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const pipe = async (bytes, stream) => new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
  const inflate = (b) => pipe(b, new DecompressionStream('deflate'));
  const deflate = (b) => pipe(b, new CompressionStream('deflate'));
  const hasStreams = () => typeof DecompressionStream !== 'undefined' && typeof CompressionStream !== 'undefined';

  /** PNG bytes to { w, h, px } (px is straight-alpha 0xAABBGGRR). Throws for interlaced files and other unsupported variants. */
  async function decodePngBytes(u8) {
    if (u8.length < 33 || PNG_SIG.some((v, i) => u8[i] !== v)) throw new Error('not a PNG file');
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 8, ihdr = null, plte = null, trns = null; const idat = [], text = {};
    while (off + 12 <= u8.length) {
      const len = dv.getUint32(off), type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]), data = u8.subarray(off + 8, off + 8 + len);
      if (type === 'IHDR') ihdr = { w: dv.getUint32(off + 8), h: dv.getUint32(off + 12), depth: data[8], ct: data[9], interlace: data[12] };
      else if (type === 'PLTE') plte = data; else if (type === 'tRNS') trns = data; else if (type === 'IDAT') idat.push(data); else if (type === 'tEXt') { const z = data.indexOf(0); if (z > 0) { const l1 = new TextDecoder('latin1'); text[l1.decode(data.subarray(0, z))] = l1.decode(data.subarray(z + 1)); } } else if (type === 'IEND') break;
      off += 12 + len;
    }
    if (!ihdr || !idat.length) throw new Error('damaged PNG');
    const { w, h, depth, ct } = ihdr;
    if (ihdr.interlace) throw new Error('interlaced PNG');
    const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ct];
    if (!chans || ![1, 2, 4, 8, 16].includes(depth) || (depth < 8 && ct !== 0 && ct !== 3) || (ct === 3 && depth === 16)) throw new Error('unsupported PNG variant');
    const total = idat.reduce((n, c) => n + c.length, 0), z = new Uint8Array(total); let o = 0; for (const c of idat) { z.set(c, o); o += c.length; }
    const raw = await inflate(z), bits = chans * depth, stride = Math.ceil((w * bits) / 8), bpp = Math.max(1, bits >> 3);
    if (raw.length < (stride + 1) * h) throw new Error('damaged PNG data');
    const img = new Uint8Array(stride * h);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride, up = dst - stride;
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? img[dst + i - bpp] : 0, b = y ? img[up + i] : 0, c = y && i >= bpp ? img[up + i - bpp] : 0; let v = raw[src + i];
        if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
        else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; } else if (f !== 0) throw new Error('bad PNG filter');
        img[dst + i] = v & 255;
      }
    }
    const rgba = new Uint8Array(w * h * 4), sample = (y, x, k) => { // k-th sample of pixel (x,y), scaled to 8 bits
      if (depth === 8) return img[y * stride + x * chans + k]; if (depth === 16) return img[y * stride + (x * chans + k) * 2];
      const bit = (x * depth), byte = img[y * stride + (bit >> 3)]; return (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1);
    };
    const key = trns && (ct === 0 || ct === 2) ? [(trns[0] << 8) | trns[1], (trns[2] << 8) | trns[3], (trns[4] << 8) | trns[5]] : null;
    const full = (v) => (depth < 8 ? Math.round((v * 255) / ((1 << depth) - 1)) : v);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let r, g, b, a = 255; const i = (y * w + x) * 4;
      if (ct === 3) { const k = sample(y, x, 0); if (!plte || k * 3 + 2 >= plte.length) throw new Error('missing palette'); r = plte[k * 3]; g = plte[k * 3 + 1]; b = plte[k * 3 + 2]; if (trns && k < trns.length) a = trns[k]; }
      else if (ct === 0) { const v = sample(y, x, 0); r = g = b = full(v); const raw = depth === 16 ? (img[y * stride + x * 2] << 8) | img[y * stride + x * 2 + 1] : v; if (key && raw === key[0]) a = 0; }
      else if (ct === 4) { r = g = b = sample(y, x, 0); a = sample(y, x, 1); }
      else { r = sample(y, x, 0); g = sample(y, x, 1); b = sample(y, x, 2); if (ct === 6) a = sample(y, x, 3); else if (key && depth === 8 && r === key[0] && g === key[1] && b === key[2]) a = 0; }
      rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
    }
    return { w, h, px: new Uint32Array(rgba.buffer), text };
  }

  /** { w, h, px } to PNG bytes: 8-bit RGBA. scale > 1 repeats each pixel (nearest neighbour). text: { keyword: Latin-1 string } as tEXt chunks. */
  async function encodePngBytes(w, h, px, scale = 1, text = null) {
    if (scale > 1) { const W = w * scale, H = h * scale, out = new Uint32Array(W * H); for (let y = 0; y < H; y++) { const sy = ((y / scale) | 0) * w; for (let x = 0; x < W; x++) out[y * W + x] = px[sy + ((x / scale) | 0)]; } px = out; w = W; h = H; }
    const rgba = new Uint8Array(px.buffer, px.byteOffset, px.length * 4), row = w * 4, raw = new Uint8Array((row + 1) * h);
    for (let y = 0; y < h; y++) raw.set(rgba.subarray(y * row, (y + 1) * row), y * (row + 1) + 1);
    const z = await deflate(raw), out = new Uint8Array(8 + 25 + 12 + z.length + 12), dv = new DataView(out.buffer);
    out.set(PNG_SIG, 0);
    const chunk = (at, type, len) => { dv.setUint32(at, len); for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i); };
    chunk(8, 'IHDR', 13); dv.setUint32(16, w); dv.setUint32(20, h); out[24] = 8; out[25] = 6; out[26] = out[27] = out[28] = 0; dv.setUint32(29, crc32(out, 12, 29));
    chunk(33, 'IDAT', z.length); out.set(z, 41); dv.setUint32(41 + z.length, crc32(out, 37, 41 + z.length));
    const e = 45 + z.length; chunk(e, 'IEND', 0); dv.setUint32(e + 8, crc32(out, e + 4, e + 8));
    if (!text) return out;
    const parts = Object.entries(text).map(([k, v]) => { const b = Uint8Array.from(k + '\0' + v, (c) => c.charCodeAt(0) & 255), t = new Uint8Array(12 + b.length), tv = new DataView(t.buffer); tv.setUint32(0, b.length); t.set([116, 69, 88, 116], 4); t.set(b, 8); tv.setUint32(8 + b.length, crc32(t, 4, 8 + b.length)); return t; });
    const all = new Uint8Array(out.length + parts.reduce((n, t) => n + t.length, 0)); all.set(out.subarray(0, e)); let at = e; for (const t of parts) { all.set(t, at); at += t.length; } all.set(out.subarray(e), at);
    return all;
  }

  /** A .zip of files ({ name, bytes }), stored without compression (PNGs are compressed already). Folders in names are kept. */
  function zipFiles(files) {
    const enc = new TextEncoder(), parts = [], central = []; let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), b = f.bytes, crc = crc32(b, 0, b.length), head = new Uint8Array(30 + name.length), dv = new DataView(head.buffer);
      dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(6, 0x800, true); dv.setUint16(10, 0, true); dv.setUint16(12, 0x21, true); // utf-8 names, 1980-01-01
      dv.setUint32(14, crc, true); dv.setUint32(18, b.length, true); dv.setUint32(22, b.length, true); dv.setUint16(26, name.length, true); head.set(name, 30);
      const c = new Uint8Array(46 + name.length), cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true); cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true); cv.setUint32(20, b.length, true); cv.setUint32(24, b.length, true); cv.setUint16(28, name.length, true); cv.setUint32(42, off, true); c.set(name, 46);
      parts.push(head, b); central.push(c); off += head.length + b.length;
    }
    const size = central.reduce((n, c) => n + c.length, 0), end = new Uint8Array(22), ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, size, true); ev.setUint32(16, off, true);
    const out = new Uint8Array(off + size + 22); let p = 0; for (const x of [...parts, ...central, end]) { out.set(x, p); p += x.length; }
    return out;
  }


  /* =====================================================================================================
     Sources: where sprites come from and how they are read and written. The editor itself does not care.
       { kind, note, sprites: [{ path, w?, h?, bytes?, frames? }], read(path) -> Uint8Array, write?(path, Uint8Array),
         repo?: { slug, base, prefix }, palette?: ['#rrggbb'], thumbs: boolean }
     Built in: a list of files served over HTTP (static), the local `spritewright serve` server, a GitHub repository (read through the
     API, changes go back as a pull request) and a folder on your disk (browser File System Access API, saves in place).
     ===================================================================================================== */
  const IGNORE = ['node_modules', '.git', '.godot', '.import', '.zig-cache', 'zig-cache', 'zig-out', 'dist', 'build', 'target', '.venv', '__pycache__', '.next', 'coverage'];
  const globRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$');
  const slugFromRemote = (url) => { const m = /github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(String(url).trim()); return m ? m[1] + '/' + m[2] : null; };
  const b64ToBytes = (b64) => { const bin = atob(String(b64).replace(/\s/g, '')), u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); return u8; };
  const pngSize = (u8) => (u8.length >= 24 && PNG_SIG.every((v, i) => u8[i] === v) && String.fromCharCode(u8[12], u8[13], u8[14], u8[15]) === 'IHDR' ? { w: new DataView(u8.buffer, u8.byteOffset).getUint32(16), h: new DataView(u8.buffer, u8.byteOffset).getUint32(20) } : null);
  const palFromText = (t) => parsePalette(t).map(toHex);
  /** Keep the paths a project config wants (dirs, exclude, ignore) and attach frame sizes. */
  function applyConfig(items, cfg = {}) {
    if (!cfg.dirs && !cfg.exclude && !cfg.keepDocs) items = skipNonArt(items);
    const dirs = (cfg.dirs && cfg.dirs.length ? cfg.dirs : ['']).map((d) => (d === '.' ? '' : d.replace(/\/+$/, '')));
    const ign = new Set([...IGNORE, ...(cfg.ignore || [])]), exc = (cfg.exclude || []).map(globRe);
    return items.filter((it) => {
      const parts = it.path.split('/');
      if (parts.slice(0, -1).some((x) => ign.has(x))) return false;
      if (!dirs.some((d) => !d || it.path === d || it.path.startsWith(d + '/'))) return false;
      return !exc.some((r) => r.test(it.path));
    }).map((it) => { const fr = cfg.frames && (cfg.frames[it.path] || Object.entries(cfg.frames).find(([k]) => k.includes('*') && globRe(k).test(it.path))?.[1]); return fr ? { ...it, frames: fr } : it; });
  }

  /* =====================================================================================================
     Families: games name related images alike (archer_0, archer_atk, archer_block; flame_0, flame_1, flame_2;
     floor_crypt, floor_crypt_grave). Grouping by the longest shared name prefix (cut at _ or -) folds a folder of hundreds
     of files into a short list, and a family with numbered members is an animation.
     ===================================================================================================== */
  const NON_ART = /^(docs?|documentation|screenshots?|previews?|tests?|e2e|coverage|examples?|samples?|marketing|promo|store)$/i;
  const stem = (p) => p.split('/').pop().replace(/\.png$/i, '');
  /** Group sprite paths: [{ dir, families: [{ key, members: [path], animated }] }], folders and families in name order. */
  function groupSprites(paths) {
    const byDir = new Map();
    for (const p of paths) { const d = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''; if (!byDir.has(d)) byDir.set(d, []); byDir.get(d).push(p); }
    const out = [];
    for (const [dir, list] of [...byDir.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const names = list.map(stem), fam = new Map();
      list.forEach((p, i) => {
        const n = names[i], cuts = [n]; for (let k = n.length - 1; k > 0; k--) if (n[k] === '_' || n[k] === '-') cuts.push(n.slice(0, k));
        // a real family has a base image (floor_crypt.png next to floor_crypt_grave.png) or numbered members (archer_0, flame_1);
        // a shared prefix alone (ic_gem, ic_ring) is just a naming category, not a family
        const key = cuts.find((c) => { const m = names.filter((x) => x === c || x.startsWith(c + '_') || x.startsWith(c + '-')); return m.length >= 2 && (names.includes(c) || m.some((x) => /^[_-]\d+$/.test(x.slice(c.length)))); }) || n;
        if (!fam.has(key)) fam.set(key, []); fam.get(key).push(p);
      });
      const rank = (key, p) => { const rest = stem(p).slice(key.length).replace(/^[_-]/, ''); return rest === '' ? [0, 0, ''] : /^\d+$/.test(rest) ? [1, +rest, ''] : [2, 0, rest]; };
      const families = [...fam.entries()].map(([key, members]) => {
        members.sort((a, b) => { const x = rank(key, a), y = rank(key, b); return x[0] - y[0] || x[1] - y[1] || x[2].localeCompare(y[2]); });
        // an animation is a run of numbered frames: 0,1,2 or 1,2,3 (icon-192 / icon-512 are sizes, not frames)
        const nums = members.map((p) => rank(key, p)).filter((r) => r[0] === 1).map((r) => r[1]);
        return { key, members, animated: nums.length >= 2 && nums[0] <= 1 && nums.every((v, i) => !i || v === nums[i - 1] + 1) };
      }).sort((a, b) => a.key.localeCompare(b.key));
      out.push({ dir, families });
    }
    return out;
  }
  /** With no project config, leave out folders that are clearly not game art (docs, screenshots, previews, tests...). */
  const skipNonArt = (items) => items.filter((it) => !it.path.split('/').slice(0, -1).some((seg) => NON_ART.test(seg)));
  /** The project's alpha rule from the config, { clear, solid, keep: [..] }, or null. Values are clamped to 0-255. */
  function normAlpha(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const n = (v, d) => (Number.isFinite(+v) ? Math.max(0, Math.min(255, Math.round(+v))) : d);
    return { clear: n(raw.clear, 0), solid: n(raw.solid, 255), keep: (Array.isArray(raw.keep) ? raw.keep : []).map((v) => n(v, -1)).filter((v) => v > 0 && v < 255) };
  }
  /* Stray alpha: what a soft brush or an eraser leaves behind, near-clear specks (1..clear) and near-opaque values
     (solid..254) that are not one the project keeps on purpose (say 250 for "glows"). Specks become clear (colour too);
     near-opaque pixels become solid, or the kept value when the original image (`base`) had that value at that pixel and
     this one is within 5 of it. Rewrites px in place and returns how many pixels changed. */
  function snapAlpha(px, rule, base = null) {
    if (!rule) return 0;
    let n = 0;
    for (let i = 0; i < px.length; i++) {
      const v = px[i], a = v >>> 24;
      if (a === 0 || a === 255 || rule.keep.includes(a)) continue;
      let to = -1;
      if (a <= rule.clear) to = 0;
      else if (a >= rule.solid) { const b = base ? base[i] >>> 24 : -1; to = rule.keep.includes(b) && Math.abs(a - b) <= 5 ? b : 255; }
      if (to < 0) continue;
      px[i] = to === 0 ? 0 : ((v & 0xffffff) | (to << 24)) >>> 0; n++;
    }
    return n;
  }
  /** Context groups from the config: { name: [paths] | { sprites: [paths], background? } } -> [{ name, sprites, background }].
      Order is kept: a sprite's first group is the one Context opens on. Anything malformed is dropped, never thrown. */
  function normGroups(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    return Object.entries(raw).map(([name, g]) => {
      const list = Array.isArray(g) ? g : g && Array.isArray(g.sprites) ? g.sprites : [];
      const background = g && !Array.isArray(g) && typeof g.background === 'string' && /^#[0-9a-f]{6}$/i.test(g.background) ? g.background.toLowerCase() : null;
      return { name: String(name), sprites: list.filter((x) => typeof x === 'string'), background };
    }).filter((g) => g.sprites.length);
  }
  /** The folders a repository's PNGs live in, for "which folders hold your art?": grouped two levels deep (public/art, assets),
      files at the root as '', with a count, and art: false for docs, screenshots, previews and test folders. */
  function artFolders(paths) {
    const by = new Map();
    for (const p of paths) {
      const segs = p.split('/').slice(0, -1); if (segs.some((x) => IGNORE.includes(x))) continue;
      const dir = segs.slice(0, 2).join('/'); by.set(dir, (by.get(dir) || 0) + 1);
    }
    return [...by.entries()].map(([dir, count]) => ({ dir, count, art: !dir.split('/').some((x) => NON_ART.test(x)) })).sort((a, b) => a.dir.localeCompare(b.dir));
  }
  /** A config for the folders picked out of artFolders: `dirs` when the root is left out, otherwise `exclude` for what was not
      picked. Docs or screenshot folders nested deeper inside a picked folder stay out too, as they do with no config. */
  function folderConfig(paths, picked) {
    const pick = new Set(picked), all = artFolders(paths), cfg = {}, exclude = new Set();
    if (pick.has('')) { for (const f of all) if (!pick.has(f.dir)) exclude.add(f.dir ? f.dir + '/**' : '*.png'); }
    else cfg.dirs = all.filter((f) => pick.has(f.dir)).map((f) => f.dir);
    for (const p of paths) {
      const segs = p.split('/').slice(0, -1), top = segs.slice(0, 2).join('/'); if (!pick.has(top)) continue;
      const i = segs.findIndex((x, k) => k >= 2 && NON_ART.test(x)); if (i >= 0) exclude.add(segs.slice(0, i + 1).join('/') + '/**');
    }
    cfg.exclude = [...exclude].sort(); // set even when empty: a config with dirs or exclude turns the docs/screenshots guess off
    return cfg;
  }
  /** What applyConfig left out only because of that default, so the editor can offer "show N hidden images". */
  const hiddenBy = (items, cfg, kept) => { const k = new Set(kept.map((x) => x.path)); return applyConfig(items, { ...cfg, keepDocs: true }).filter((x) => !k.has(x.path)); };

  /** Sprites listed in a manifest and fetched over HTTP relative to baseUrl. Read-only (Save downloads). */
  function staticSource(mf, baseUrl) {
    const base = baseUrl == null ? '' : baseUrl && !baseUrl.endsWith('/') ? baseUrl + '/' : baseUrl;
    return { kind: 'static', thumbs: true, note: 'Static mode: edits are kept in this browser; Download takes them out. Connect a folder to save in place.', sprites: (mf.sprites || []).map((x) => ({ ...x })), hidden: mf.hidden || [], background: mf.background || null, groups: mf.groups || null, alpha: mf.alpha || null, tileGrid: mf.tileGrid || null, indexed: !!mf.indexed, maxColors: mf.maxColors || null, repo: mf.repo || null, palette: mf.palette || null,
      async read(path) { const r = await fetch(base + path.split('/').map(encodeURIComponent).join('/')); if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return new Uint8Array(await r.arrayBuffer()); } };
  }
  /** The local `spritewright serve` server: reads and writes the project folder. */
  function serverSource(mf, token) {
    const url = (path) => 'project/' + path.split('/').map(encodeURIComponent).join('/');
    const history = async (path) => { const r = await fetch('api/history?path=' + encodeURIComponent(path)); return r.ok ? r.json() : []; };
    const readAt = async (path, sha) => { const r = await fetch(`api/file-at?path=${encodeURIComponent(path)}&sha=${sha}`); if (!r.ok) throw new Error('not in that commit'); return new Uint8Array(await r.arrayBuffer()); };
    /** The file as committed on the checked-out branch: { status: 'ok', bytes } | { status: 'new' } (not committed yet) | { status: 'none' } (no git). */
    const branchVersion = async (path) => { const r = await fetch(`api/file-at?path=${encodeURIComponent(path)}&sha=HEAD`); return r.ok ? { status: 'ok', bytes: new Uint8Array(await r.arrayBuffer()) } : { status: r.status === 404 ? 'new' : 'none' }; };
    return { kind: 'server', thumbs: true, history, readAt, branchVersion, note: 'Saving writes straight to the project folder.', sprites: (mf.sprites || []).map((x) => ({ ...x })), hidden: mf.hidden || [], background: mf.background || null, groups: mf.groups || null, alpha: mf.alpha || null, tileGrid: mf.tileGrid || null, indexed: !!mf.indexed, maxColors: mf.maxColors || null, repo: mf.repo || null, palette: mf.palette || null,
      async read(path) { const r = await fetch(url(path)); if (!r.ok) throw new Error(r.status + ' ' + r.statusText); return new Uint8Array(await r.arrayBuffer()); },
      async write(path, bytes) { const r = await fetch(url(path), { method: 'PUT', headers: { 'x-spritewright': token || '', 'content-type': 'image/png' }, body: bytes }); if (!r.ok) throw new Error('server said ' + r.status + ' ' + (await r.text()).slice(0, 80)); },
      async remove(path) { const r = await fetch(url(path), { method: 'DELETE', headers: { 'x-spritewright': token || '' } }); if (!r.ok && r.status !== 404) throw new Error('server said ' + r.status + ' ' + (await r.text()).slice(0, 80)); } };
  }

  /** A GitHub repository, read through the REST API (a token is only needed for private repos and for pull requests). */
  async function githubSource(o) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(o.repo || '')) throw new Error('Repository must look like owner/name.');
    const api = (o.apiBase || 'https://api.github.com').replace(/\/$/, ''), doFetch = o.fetch || fetch.bind(globalThis), maxBytes = o.maxBytes || 262144;
    const call = async (path) => {
      const res = await doFetch(api + path, { headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', ...(o.token ? { Authorization: 'Bearer ' + o.token } : {}) } });
      const text = await res.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
      if (!res.ok) {
        const left = res.headers && res.headers.get && res.headers.get('x-ratelimit-remaining');
        throw new Error(explainGithubError(left === '0' && res.status === 403 ? 403 : res.status, left === '0' && res.status === 403 ? 'API rate limit exceeded' : (json && json.message) || text.slice(0, 100), 'GET ' + path.split('?')[0], o.repo));
      }
      return json;
    };
    const log = o.onProgress || (() => {});
    log('Reading the repository…');
    const info = await call('/repos/' + o.repo), branch = o.branch || info.default_branch;
    const ref = await call('/repos/' + o.repo + '/git/ref/heads/' + refPath(branch));
    const commit = await call('/repos/' + o.repo + '/git/commits/' + ref.object.sha);
    log('Listing its files…');
    const tree = await call('/repos/' + o.repo + '/git/trees/' + commit.tree.sha + '?recursive=1');
    const entries = new Map((tree.tree || []).filter((e) => e.type === 'blob').map((e) => [e.path, e]));
    const apiBlob = async (path) => { const e = entries.get(path); if (!e) throw new Error('not in the repository: ' + path); const b = await call('/repos/' + o.repo + '/git/blobs/' + e.sha); return b.encoding === 'base64' ? b64ToBytes(b.content) : new TextEncoder().encode(b.content); };
    /* Public repositories: read files from GitHub's file CDN at this exact commit. Same bytes, and it does not use up the API
       rate limit (60 calls an hour without sign-in), so every thumbnail can load. Private ones (or a failure) go through the API. */
    const rawBase = o.rawBase || (o.apiBase ? null : 'https://raw.githubusercontent.com');
    const rawUrl = info.private === false && rawBase ? (path) => `${rawBase.replace(/\/$/, '')}/${o.repo}/${ref.object.sha}/${path.split('/').map(encodeURIComponent).join('/')}` : null;
    const blob = async (path) => {
      if (!entries.has(path)) throw new Error('not in the repository: ' + path);
      if (rawUrl) { try { const r = await doFetch(rawUrl(path)); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch { /* fall back to the API */ } }
      return apiBlob(path);
    };
    let cfg = {}, palette = null;
    log('Reading the project setup…');
    if (entries.has('spritewright.config.json')) { try { cfg = JSON.parse(new TextDecoder().decode(await blob('spritewright.config.json'))); } catch { /* ignore a broken config */ } }
    if (cfg.palette && entries.has(cfg.palette)) { try { palette = palFromText(new TextDecoder().decode(await blob(cfg.palette))); } catch { /* none */ } }
    let groups = typeof cfg.groups === 'object' ? cfg.groups : null;
    if (typeof cfg.groups === 'string' && entries.has(cfg.groups)) { try { groups = JSON.parse(new TextDecoder().decode(await blob(cfg.groups))); } catch { /* none */ } }
    const png = [...entries.values()].filter((e) => /\.png$/i.test(e.path) && e.size <= (cfg.maxBytes || maxBytes)).map((e) => ({ path: e.path, bytes: e.size }));
    const sprites = applyConfig(png, cfg), hidden = hiddenBy(png, cfg, sprites);
    const history = async (path) => (await call(`/repos/${o.repo}/commits?path=${encodeURIComponent(path)}&sha=${encodeURIComponent(branch)}&per_page=30`)).map((c) => ({ sha: c.sha, date: c.commit.author.date, author: (c.author && c.author.login) || c.commit.author.name, message: c.commit.message.split('\n')[0] }));
    const readAt = async (path, sha) => {
      if (rawUrl) { try { const r = await doFetch(`${rawBase.replace(/\/$/, '')}/${o.repo}/${sha}/${path.split('/').map(encodeURIComponent).join('/')}`); if (r.ok) return new Uint8Array(await r.arrayBuffer()); } catch { /* use the API */ } }
      const f = await call(`/repos/${o.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${sha}`); return b64ToBytes(f.content.replace(/\n/g, ''));
    };
    return { kind: 'github', tileGrid: cfg.tileGrid || null, indexed: !!cfg.indexed, maxColors: cfg.maxColors || null, public: info.private === false, thumbs: true, history, readAt, sprites, hidden, all: png, dirs: [...new Set((tree.tree || []).filter((e) => e.type === 'tree' && !e.path.split('/').some((x) => IGNORE.includes(x) || x.startsWith('.')) && e.path.split('/').length <= 2).map((e) => e.path))].sort(), config: cfg, hasConfig: entries.has('spritewright.config.json'), palette, groups, alpha: cfg.alpha || null, branch, background: cfg.background || null,
      note: 'GitHub ' + o.repo + ' @ ' + branch + (tree.truncated ? ' (very large repository: the list is incomplete)' : '') + '. Edits are kept in this browser; Propose PR sends them back.',
      repo: { slug: o.repo, base: branch, defaultBranch: info.default_branch || null, prefix: '', canPush: !!(info.permissions && info.permissions.push) }, read: blob };
  }

  /** A folder on disk through the File System Access API (Chromium browsers): lists, reads and saves in place. */
  async function folderSource(root, o = {}) {
    const maxSize = o.maxSize || 1024, files = new Map();
    const readText = async (dir, ...names) => { try { let d = dir; for (const n of names.slice(0, -1)) d = await d.getDirectoryHandle(n); return await (await (await d.getFileHandle(names.at(-1))).getFile()).text(); } catch { return null; } };
    let cfg = {}; const cfgText = await readText(root, 'spritewright.config.json'); if (cfgText) { try { cfg = JSON.parse(cfgText); } catch { /* ignore */ } }
    const ign = new Set([...IGNORE, ...(cfg.ignore || [])]), found = [];
    const walk = async (dir, prefix) => {
      for await (const [name, h] of dir.entries()) {
        if (h.kind === 'directory') { if (!ign.has(name) && !name.startsWith('.')) await walk(h, prefix + name + '/'); continue; }
        if (!/\.png$/i.test(name)) continue;
        const f = await h.getFile(), head = pngSize(new Uint8Array(await f.slice(0, 24).arrayBuffer())), lim = cfg.maxSize || maxSize;
        if (!head || head.w > lim || head.h > lim) continue;
        files.set(prefix + name, h); found.push({ path: prefix + name, w: head.w, h: head.h, bytes: f.size });
      }
    };
    await walk(root, ''); found.sort((a, b) => a.path.localeCompare(b.path));
    let palette = null; if (cfg.palette) { const t = await readText(root, ...cfg.palette.split('/')); if (t) palette = palFromText(t); }
    let groups = typeof cfg.groups === 'object' ? cfg.groups : null;
    if (typeof cfg.groups === 'string') { const t = await readText(root, ...cfg.groups.split('/')); if (t) try { groups = JSON.parse(t); } catch { /* none */ } }
    const gitCfg = await readText(root, '.git', 'config'), m = gitCfg && /\[remote "origin"\][^[]*?url\s*=\s*(.+)/.exec(gitCfg), slug = (m && slugFromRemote(m[1])) || (cfg.repo && cfg.repo.slug) || null;
    const sprites = applyConfig(found, cfg);
    return { kind: 'folder', thumbs: true, sprites, hidden: hiddenBy(found, cfg, sprites), palette, groups, alpha: cfg.alpha || null, tileGrid: cfg.tileGrid || null, indexed: !!cfg.indexed, maxColors: cfg.maxColors || null, background: cfg.background || null, name: root.name, note: 'Folder "' + root.name + '": Save writes the PNG in place.', repo: { slug, base: (cfg.repo && cfg.repo.base) || null, prefix: (cfg.repo && cfg.repo.prefix) || '' },
      async read(path) { const h = files.get(path); if (!h) throw new Error('not found: ' + path); return new Uint8Array(await (await h.getFile()).arrayBuffer()); },
      async write(path, bytes) {
        const parts = path.split('/'); let dir = root; for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const h = await dir.getFileHandle(parts.at(-1), { create: true }), w = await h.createWritable(); await w.write(bytes); await w.close(); files.set(path, h);
      },
      async remove(path) { // only ever a layers file, after its sprite went back to one layer
        if (!isLayersFile(path)) throw new Error('only layers files are removed'); const parts = path.split('/'); let dir = root; for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
        await dir.removeEntry(parts.at(-1)); files.delete(path);
      } };
  }


  /* =====================================================================================================
     Sign in with GitHub. The page opens a small popup on an auth service (see worker/), the user signs in on
     github.com (their normal login, SSO and 2FA included), and the service posts an access token back to this page.
     The service only exists because GitHub's token exchange needs a client secret and has no CORS; it never stores tokens.
     ===================================================================================================== */
  function githubSignIn(authBase, { win = window, timeoutMs = 300000 } = {}) {
    if (!authBase) return Promise.reject(new Error('Sign-in is not set up on this page.'));
    const origin = new URL(authBase, win.location.href).origin, nonce = Array.from(win.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    const popup = win.open(`${authBase.replace(/\/$/, '')}/login?origin=${encodeURIComponent(win.location.origin)}&nonce=${nonce}`, 'pf-auth', 'width=520,height=700');
    if (!popup) return Promise.reject(new Error('The sign-in window was blocked. Allow pop-ups for this site and try again.'));
    return new Promise((resolve, reject) => {
      const done = (fn, v) => { win.removeEventListener('message', onMsg); clearInterval(poll); clearTimeout(to); try { popup.close(); } catch { /* already closed */ } fn(v); };
      const onMsg = (e) => { const d = e.data; if (e.origin !== origin || !d || d.type !== 'pf-auth' || d.nonce !== nonce) return; d.error ? done(reject, new Error(d.error)) : d.token ? done(resolve, { token: d.token, expiresIn: d.expires_in || null, refreshToken: d.refresh_token || null, refreshExpiresIn: d.refresh_token_expires_in || null }) : done(reject, new Error('The sign-in service returned no token.')); };
      win.addEventListener('message', onMsg);
      const poll = setInterval(() => { if (popup.closed) done(reject, new Error('The sign-in window was closed before finishing.')); }, 500);
      const to = setTimeout(() => done(reject, new Error('Sign-in timed out.')), timeoutMs);
    });
  }
  /** Swap a refresh token for a new access token through the auth service (GitHub App user tokens expire after 8 hours). */
  async function githubRefresh(authBase, refreshToken, o = {}) {
    const res = await (o.fetch || fetch.bind(globalThis))(authBase.replace(/\/$/, '') + '/refresh', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ refresh_token: refreshToken }) });
    let j = {}; try { j = JSON.parse(await res.text()); } catch { /* not JSON */ }
    if (!res.ok || !j.token) { const e = new Error(j.error || 'Could not renew the GitHub sign-in (' + res.status + ').'); e.status = res.status; throw e; }
    return { token: j.token, expiresIn: j.expires_in || null, refreshToken: j.refresh_token || null, refreshExpiresIn: j.refresh_token_expires_in || null };
  }
  /** Who the token belongs to. */
  async function githubUser(token, o = {}) {
    const res = await (o.fetch || fetch.bind(globalThis))((o.apiBase || 'https://api.github.com') + '/user', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(explainGithubError(res.status, '', 'GET /user'));
    const j = JSON.parse(await res.text()); return { login: j.login, name: j.name || j.login };
  }
  /** Repositories this token can reach: through the GitHub App installations when it is an app token, else the user's recent repos.
      Names by default; with { details: true } objects { name, private, push, branch } (push = the user may write, so pull requests go straight to it). */
  async function listRepos(token, o = {}) {
    const api = (o.apiBase || 'https://api.github.com'), doFetch = o.fetch || fetch.bind(globalThis), get = async (u) => { const r = await doFetch(api + u, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github+json' } }); return r.ok ? JSON.parse(await r.text()) : null; };
    const out = [], inst = await get('/user/installations?per_page=30');
    if (inst && inst.installations) for (const i of inst.installations.slice(0, 10)) { const r = await get(`/user/installations/${i.id}/repositories?per_page=100`); if (r && r.repositories) out.push(...r.repositories); }
    if (!out.length) { const r = await get('/user/repos?sort=updated&per_page=50'); if (r) out.push(...r); }
    const seen = new Set(), uniq = out.filter((x) => x && x.full_name && !seen.has(x.full_name) && seen.add(x.full_name));
    return o.details ? uniq.map((x) => ({ name: x.full_name, private: !!x.private, push: !!(x.permissions && x.permissions.push), branch: x.default_branch || null })) : uniq.map((x) => x.full_name);
  }
  const PAT_URL = 'https://github.com/settings/personal-access-tokens/new?name=spritewright&description=Edit+sprites+and+open+pull+requests&expires_in=30&contents=write&pull_requests=write';

  /* =====================================================================================================
     The editor UI
     ===================================================================================================== */
  const CSS = `
.pf{--pf-bg:#07040d;--pf-panel:#0e0918;--pf-panel2:#150e24;--pf-line:#2a1b45;--pf-line2:#443070;--pf-ink:#e6dcf7;--pf-muted:#9a86c4;--pf-faint:#6a5890;--pf-accent:#b98cff;--pf-accent2:#e08cff;--pf-on:#12081f;--pf-bad:#ff5470;--pf-good:#7dffb2;--pf-warn:#ffb000;
  --pf-ck1:#3a3150;--pf-ck2:#29223a;--pf-ckbg:repeating-conic-gradient(var(--pf-ck1) 0 25%,var(--pf-ck2) 0 50%) 0 0/8px 8px;
  --pf-mono:'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  position:relative;display:grid;grid-template-columns:var(--pf-cl,220px) minmax(0,1fr) var(--pf-cr,248px);grid-template-rows:minmax(0,1fr);height:100%;min-height:440px;background:var(--pf-bg);color:var(--pf-ink);font:12.5px/1.45 var(--pf-mono);border:1px solid var(--pf-line);box-sizing:border-box;font-variant-ligatures:none}
.pf *{box-sizing:border-box;border-radius:0}
.pf [hidden]{display:none!important}
.pf ::selection{background:var(--pf-accent);color:var(--pf-on)}
.pf button,.pf select,.pf input{font:inherit;color:inherit}
.pf button{background:var(--pf-panel2);border:1px solid var(--pf-line);padding:4px 9px;cursor:pointer;min-height:30px;display:inline-flex;align-items:center;justify-content:center;gap:6px;transition:border-color .12s,color .12s,box-shadow .12s}
.pf button:hover:not(:disabled){border-color:var(--pf-accent);color:var(--pf-accent);box-shadow:0 0 0 1px rgba(185,140,255,.12),0 0 14px rgba(185,140,255,.12)}
.pf button:focus-visible{outline:1px solid var(--pf-accent);outline-offset:1px}
.pf button:disabled{opacity:.35;cursor:default}
.pf button.on,.pf button.primary{background:var(--pf-accent);border-color:var(--pf-accent);color:var(--pf-on)}.pf button.primary{font-weight:700}
.pf button.on:hover:not(:disabled),.pf button.primary:hover:not(:disabled){color:var(--pf-on);background:#cba8ff}
.pf input[type=text],.pf input[type=number],.pf input[type=password],.pf select,.pf textarea{background:#05030a;border:1px solid var(--pf-line);padding:5px 7px;min-height:30px;width:100%;color:var(--pf-ink)}
.pf input:focus,.pf textarea:focus{outline:none;border-color:var(--pf-accent)}
.pf input[type=number]{width:64px}
.pf input[type=range]{accent-color:var(--pf-accent);width:92px}
.pf input[type=checkbox]{accent-color:var(--pf-accent)}
.pf label{display:flex;gap:6px;align-items:center;color:var(--pf-muted)}
.pf kbd{font:inherit;font-size:11.5px;background:var(--pf-panel2);border:1px solid var(--pf-line2);padding:1px 6px;color:var(--pf-accent);white-space:nowrap}
.pf h4{margin:0 0 8px;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--pf-accent);font-weight:700}
.pf h4::before{content:"// ";color:var(--pf-faint)}
.pf-ic{width:16px;height:16px;flex:none;display:block}
.pf-side,.pf-right{background:var(--pf-panel);overflow:auto;padding:10px;display:flex;flex-direction:column;gap:10px;min-width:0}
.pf-side{border-right:1px solid var(--pf-line)}.pf-right{border-left:1px solid var(--pf-line);gap:0;padding:0}
.pf-panel{padding:12px 12px 14px;border-bottom:1px solid var(--pf-line);display:flex;flex-direction:column;gap:8px}
.pf-list{display:flex;flex-direction:column;gap:2px;overflow:auto;flex:1;min-height:80px}
/* Thin scrollbars in the line colour on a transparent track, everywhere in the app. */
.pf,.pf *{scrollbar-width:thin;scrollbar-color:var(--pf-line2) transparent}
.pf ::-webkit-scrollbar{width:8px;height:8px}
.pf ::-webkit-scrollbar-thumb{background:var(--pf-line2)}
.pf ::-webkit-scrollbar-track{background:transparent}
.pf-item{position:relative;display:flex;gap:8px;align-items:center;padding:4px;border:1px solid transparent;cursor:pointer;background:none;text-align:left;width:100%;min-height:44px;justify-content:flex-start}
.pf .pf-item{background:none;border-color:transparent}.pf .pf-item:hover:not(:disabled){box-shadow:none;background:var(--pf-panel2)}
.pf .pf-item.on,.pf .pf-item.on:hover:not(:disabled){border-color:var(--pf-accent);background:var(--pf-panel2);color:var(--pf-ink);font-weight:400;box-shadow:inset 3px 0 0 var(--pf-accent)}
.pf-item canvas{width:36px;height:36px;image-rendering:pixelated;background:var(--pf-ckbg);flex:none}
.pf-item .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}.pf-item small{display:block;color:var(--pf-muted);overflow:hidden;text-overflow:ellipsis}
.pf-item .dot{width:8px;height:8px;background:var(--pf-accent);flex:none}.pf-item .dot.base{background:var(--pf-warn)}.pf-item .dot,.pf-openrow .dot{transition:background-color .25s ease,opacity .25s ease}.pf-item .dot.none,.pf-openrow .dot.none{opacity:0}
.pf-list:not(.pf-flat){display:block}
.pf .pf-dir{display:flex;width:100%;justify-content:flex-start;gap:6px;background:none;border:0;border-bottom:1px solid var(--pf-line);padding:7px 2px 5px;min-height:0;margin-top:6px;color:var(--pf-muted);font-size:11.5px;letter-spacing:.04em;position:sticky;top:0;z-index:1;background:var(--pf-panel)}
.pf .pf-dir:hover:not(:disabled){box-shadow:none;color:var(--pf-accent)}
.pf-caret{width:10px;color:var(--pf-accent)}.pf-dirname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}.pf-dircount{color:var(--pf-faint);font-size:11.5px}.pf-dirchg{color:var(--pf-accent);font-size:11.5px;flex:none}
.pf-side-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.pf-side-head h4{margin:0}
/* No spritewright.config.json in the open repository: say so where the sprites are, with the one button that sets it up. */
.pf-setup{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px dashed var(--pf-line2);color:var(--pf-muted);font-size:12px;line-height:1.4}.pf-setup b{color:var(--pf-ink);font-weight:400}
.pf .pf-setup button{align-self:flex-start;min-height:26px;padding:2px 9px;font-size:12px}.pf-setup{position:relative;padding-right:28px}
.pf .pf-setup .pf-setup-x{position:absolute;top:3px;right:3px;min-height:22px;width:22px;padding:0;border-color:transparent;background:none;color:var(--pf-muted)}.pf .pf-setup .pf-setup-x:hover:not(:disabled){color:var(--pf-ink);border-color:var(--pf-line2);box-shadow:none}
.pf-foldmini{display:flex;gap:2px;flex:none}
.pf-foldmini button{min-height:0;padding:1px 6px;font-size:11px;color:var(--pf-muted);background:none;border-color:transparent}
.pf .pf-openrow{display:flex;width:100%;align-items:center;gap:8px;background:none;border:1px solid var(--pf-line2);border-top:0;padding:4px 6px;min-height:0;color:var(--pf-ink);font-size:11.5px}
.pf-openrow canvas{width:24px;height:24px;image-rendering:pixelated;background:var(--pf-ckbg);flex:none}
.pf-openrow .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left}
.pf-openrow .dot{width:8px;height:8px;background:var(--pf-accent);flex:none}.pf-openrow .dot.base{background:var(--pf-warn)}
.pf-commit{border:1px solid var(--pf-line);background:var(--pf-panel2);padding:8px}
.pf-commit summary{cursor:pointer;list-style:none}
.pf-commit summary::-webkit-details-marker{display:none}
.pf-commit summary h4{margin:0}
.pf-commit-list{display:flex;flex-direction:column;gap:2px;margin:8px 0;max-height:220px;overflow:auto}
.pf-commit label{display:flex;flex-direction:column;align-items:stretch;gap:4px;margin:6px 0;font-size:11.5px;color:var(--pf-muted)}
.pf-commit-list label{flex-direction:row;align-items:center;margin:0;color:var(--pf-ink);cursor:pointer}
.pf-commit-list input{flex:none}
.pf-commit-list .n{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-commit-list small{color:var(--pf-muted)}
.pf-branchrow{display:flex;gap:6px}
.pf-branchrow select{flex:1;min-width:0}
.pf-branchrow input{flex:1;min-width:0}
/* Naming a new branch: the picker shrinks to its + New label, so the name field gets the room. */
.pf-branchrow:has(.pf-commit-branch:not([hidden])) .pf-commit-branches{flex:none;width:72px;box-sizing:border-box}
.pf-commit .pf-row{margin-top:8px}
.pf-commit-note{margin-top:6px}
.pf-commit-note:empty{display:none}
.pf-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(60px,1fr));gap:4px;padding:6px 0 4px}
.pf .pf-cell{flex-direction:column;gap:3px;padding:5px 3px 4px;min-height:0;position:relative;justify-content:flex-start;border:1px solid transparent}
.pf .pf-cell canvas{width:44px;height:44px;object-fit:contain}
.pf .pf-cell .n{width:100%;text-align:center;font-size:11.5px;line-height:1.25}.pf .pf-cell small{font-size:10.5px;text-align:center;color:var(--pf-faint)}
.pf .pf-cell.on,.pf .pf-cell.on:hover:not(:disabled){box-shadow:inset 0 0 0 1px var(--pf-accent),0 0 12px rgba(185,140,255,.18)}
.pf-fam{display:flex;flex-direction:column;gap:6px}.pf-fam-h{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.pf-fam-h b{color:var(--pf-ink)}
.pf-fam-strip{display:flex;gap:4px;overflow-x:auto;padding-bottom:2px}
.pf .pf-fam-m{flex-direction:column;gap:2px;padding:3px;min-height:0;flex:none;font-size:10.5px;color:var(--pf-muted);background:var(--pf-bg)}
.pf .pf-fam-m canvas{width:40px;height:40px;image-rendering:pixelated;object-fit:contain;background:var(--pf-ckbg)}
.pf .pf-fam-m.on{border-color:var(--pf-accent);color:var(--pf-accent);background:var(--pf-panel2);font-weight:400}.pf .pf-fam-m.playing{box-shadow:0 0 0 1px var(--pf-accent2)}
.pf .pf-hidden-toggle{width:100%;justify-content:flex-start;text-align:left;white-space:normal;margin:8px 0 4px;font-size:11.5px;color:var(--pf-muted);border-style:dashed}
.pf-bg-sw{width:14px;height:14px;border:1px solid var(--pf-line2);background:var(--pf-ckbg);flex:none}
.pf-bgmenu{position:absolute;z-index:20;background:var(--pf-panel);border:1px solid var(--pf-line2);box-shadow:0 12px 40px rgba(0,0,0,.55);padding:6px;display:flex;flex-direction:column;gap:2px;min-width:210px}
.pf .pf-bgmenu button{justify-content:flex-start;background:none;border-color:transparent;min-height:30px;width:100%}
.pf .pf-bgmenu button.on{background:var(--pf-panel2);color:var(--pf-accent);border-color:var(--pf-line2);font-weight:400}
.pf-bgmenu .pf-bg-sw{width:16px;height:16px}.pf-bgmenu label{padding:4px 8px;font-size:11.5px}.pf-bgmenu input[type=color]{width:34px;height:24px;padding:0;border:1px solid var(--pf-line2);background:none}
.pf-s-peek{color:var(--pf-accent2);cursor:pointer;user-select:none;-webkit-user-select:none;touch-action:none}.pf-arrow{color:var(--pf-faint);font-style:normal}
.pf-ctx{border-top:1px solid var(--pf-line);background:var(--pf-panel);display:flex;flex-direction:column;flex:none}
.pf-ctx-bar{display:flex;gap:10px;align-items:center;padding:5px 10px;border-bottom:1px solid var(--pf-line)}.pf .pf-ctx-bar .pf-seg button{min-height:24px;padding:1px 8px}.pf .pf-ctx-bar .pf-ctx-group{width:auto;max-width:260px;min-height:24px;padding:1px 6px;flex:0 1 auto;min-width:0;text-overflow:ellipsis}.pf-ctx-note{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.pf-ctx-cv{display:block;width:100%;height:150px;image-rendering:pixelated}
.pf-fam-m .pf-hold{position:absolute;right:1px;top:1px;font-size:10px;line-height:1;padding:1px 3px;background:var(--pf-panel2);border:1px solid var(--pf-line2);color:var(--pf-muted);cursor:pointer}.pf-fam-m .pf-hold.x{color:var(--pf-on);background:var(--pf-accent);border-color:var(--pf-accent)}.pf .pf-fam-m{position:relative}
.pf-fam-tools{margin-left:auto;display:inline-flex;flex-wrap:wrap;justify-content:flex-end;gap:3px}.pf .pf-fam-tools button{min-height:24px;padding:1px 7px;font-size:11.5px;white-space:nowrap}
.pf-lint-tag{position:absolute;right:14px;top:12px;display:flex;gap:10px;font-size:11px;padding:3px 8px;background:rgba(14,9,24,.88);border:1px solid var(--pf-line2);color:var(--pf-ink);pointer-events:none}.pf-lint-tag i{display:inline-block;width:9px;height:9px;margin-right:5px;border:2px solid currentColor;vertical-align:-1px}.pf-lint-tag .ok{color:var(--pf-good)}
.pf-vision-tag{position:absolute;left:14px;top:12px;font-size:10.5px;letter-spacing:.12em;text-transform:uppercase;padding:3px 8px;background:var(--pf-accent2);color:var(--pf-on);font-weight:700;pointer-events:none}
.pf[data-vision="grey"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:grayscale(1)}
.pf[data-vision="protan"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:url(#pf-vision-protan)}
.pf[data-vision="deutan"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:url(#pf-vision-deutan)}
.pf[data-vision="tritan"] :is(.pf-view,.pf-ctx-cv,.pf-prev canvas,.pf-fam-m canvas){filter:url(#pf-vision-tritan)}
.pf .pf-ref-sprite{width:auto;flex:1;min-width:0}.pf-ref-on{display:flex;flex-direction:column;gap:6px}.pf .pf-refpanel .pf-seg button{min-height:26px;padding:2px 8px}
.pf-v-shift{display:flex;flex-direction:column;gap:4px}.pf-v-shift input[type=range]{flex:1;width:auto}.pf-v-shift b{min-width:3.2em;text-align:right;color:var(--pf-accent)}
.pf-v-cols{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:6px}.pf-v-col{display:flex;align-items:center;gap:4px;font-size:11.5px}.pf-v-col i{width:20px;height:20px;border:1px solid var(--pf-line2);flex:none}.pf-v-col input[type=color]{width:30px;height:22px;padding:0;border:1px solid var(--pf-line2);background:none}
.pf-port-list{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:8px}.pf-port-f{display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid var(--pf-line);font-size:11.5px}.pf-port-f canvas{image-rendering:pixelated;width:100%;height:auto;background:var(--pf-ckbg)}.pf-port-key{color:var(--pf-warn)}
.pf-v-preview{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border:1px solid var(--pf-line);background:var(--pf-ckbg)}.pf-v-preview canvas{image-rendering:pixelated;height:72px}
.pf-hist summary{list-style:none;cursor:pointer}.pf-hist summary::-webkit-details-marker{display:none}
/* Right column: every section folds away by its title (remembered), with a chevron at the right. */
.pf-right{scroll-behavior:smooth;scrollbar-width:thin;scrollbar-color:var(--pf-line2) transparent}
.pf-right>.pf-panel>h4,.pf-hist summary h4{display:flex;align-items:baseline;white-space:nowrap;gap:0;cursor:pointer;user-select:none;-webkit-user-select:none;margin:0}
.pf-right>.pf-panel>h4::before,.pf-hist summary h4::before{white-space:pre}.pf-right>.pf-panel>h4>span{overflow:hidden;text-overflow:ellipsis}
.pf-right>.pf-panel>h4::after,.pf-hist summary h4::after{content:"";margin-left:auto;align-self:center;flex:none;width:6px;height:6px;border-right:1.5px solid var(--pf-faint);border-bottom:1.5px solid var(--pf-faint);transform:translateY(-2px) rotate(45deg);transition:transform .15s ease}
.pf-right>.pf-panel.pf-shut>h4::after,.pf-hist:not([open]) summary h4::after{transform:rotate(-45deg)}
.pf-right>.pf-panel>h4:hover::after,.pf-hist summary h4:hover::after{border-color:var(--pf-ink)}
.pf-right>.pf-panel>h4:focus-visible{outline:1px dashed var(--pf-accent);outline-offset:3px}
.pf-right>.pf-panel.pf-shut>:not(h4){display:none!important}
.pf .pf-right .pf-quiet{gap:2px}.pf .pf-right .pf-quiet button:not(:disabled){border-color:transparent;color:var(--pf-muted);padding:2px 6px!important}.pf .pf-right .pf-quiet button:hover:not(:disabled){color:var(--pf-ink)}
.pf-prev .pf-p2{margin:0 auto}.pf-prev .pf-p1{max-height:120px;width:auto}.pf-anim-row input[type=number]{width:46px}
.pf-hist-list{display:flex;flex-direction:column;gap:3px;max-height:260px;overflow:auto;margin-top:6px}
.pf .pf-hist-e{display:grid;grid-template-columns:36px 1fr;gap:2px 8px;text-align:left;justify-content:stretch;align-items:center;background:none;border-color:transparent;padding:4px;min-height:0}
.pf .pf-hist-e canvas{grid-row:span 2;width:36px;height:36px;image-rendering:pixelated;object-fit:contain;background:var(--pf-ckbg)}
.pf-hist-e b{font-weight:400;color:var(--pf-ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12.5px}.pf-hist-e small{color:var(--pf-muted);font-size:11.5px}
.pf .pf-hist-e.on{border-color:var(--pf-accent);background:var(--pf-panel2);font-weight:400}
.pf-badge{position:absolute;top:2px;right:2px;font-style:normal;font-size:10.5px;line-height:1;padding:2px 3px;background:var(--pf-panel2);border:1px solid var(--pf-line2);color:var(--pf-muted)}
.pf-badge.anim{color:var(--pf-on);background:var(--pf-accent);border-color:var(--pf-accent);font-weight:700}
.pf .pf-cell .dot{position:absolute;top:4px;left:4px}
.pf-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.pf-bar,.pf-opts{display:flex;flex-wrap:nowrap;gap:0 14px;padding:0 8px;border-bottom:1px solid var(--pf-line);background:var(--pf-panel);align-items:center;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}
.pf-bar::-webkit-scrollbar,.pf-opts::-webkit-scrollbar{display:none}
.pf-bar{min-height:40px;flex-wrap:wrap;row-gap:2px;padding:4px 8px}
.pf-opts{background:var(--pf-bg);height:36px}.pf-opt{flex-wrap:nowrap;white-space:nowrap;flex:none}
.pf-grp,.pf-opt{display:inline-flex;gap:2px;align-items:center;flex-wrap:nowrap;flex:none}.pf-opt[hidden]{display:none}
/* The toolbars are quiet: borderless icon buttons, groups split by a hairline, labels in the tooltips. A toggle that is on is
   tinted, not filled; solid accent is kept for the one thing to press (Save) and the current tool. */
.pf-bar .pf-grp+.pf-grp{margin-left:8px;padding-left:8px;border-left:1px solid var(--pf-line)}.pf-bar .pf-grp.pf-grp-end{margin-left:auto}
.pf .pf-bar button,.pf .pf-opts button{min-height:28px;padding:3px 7px;background:transparent;border-color:transparent;color:var(--pf-muted)}
.pf .pf-bar button:hover:not(:disabled),.pf .pf-opts button:hover:not(:disabled){background:var(--pf-panel2);border-color:var(--pf-line2);color:var(--pf-ink);box-shadow:none}
.pf .pf-bar button.on,.pf .pf-opts button.on,.pf .pf-seg button.on{background:rgba(185,140,255,.14);border-color:rgba(185,140,255,.38);color:var(--pf-accent)}
.pf .pf-bar button.on:hover:not(:disabled),.pf .pf-opts button.on:hover:not(:disabled),.pf .pf-seg button.on:hover:not(:disabled){background:rgba(185,140,255,.22);color:var(--pf-accent)}
.pf .pf-opts button:not(.pf-seg button){border-color:var(--pf-line)}
.pf .pf-bar button.primary{background:var(--pf-accent);border-color:var(--pf-accent);color:var(--pf-on);padding:3px 12px}
.pf .pf-bar button.primary:hover:not(:disabled){background:#cba8ff;color:var(--pf-on)}
.pf .pf-bar .pf-prbtn:not(:disabled){border-color:var(--pf-line2);color:var(--pf-ink)}
.pf .pf-bar .pf-grid-more{padding:3px 3px;margin-left:-2px;font-size:10px}
.pf-bar button>span:not(.pf-bg-sw),.pf-opt-end button>span{display:none}
.pf .pf-bar .pf-ic{width:17px;height:17px}
.pf-grp-end,.pf-opt-end{margin-left:auto}
.pf-ol{color:var(--pf-faint);text-transform:uppercase;letter-spacing:.1em;font-size:10.5px;margin-right:2px}
.pf-sizev{min-width:1.5em;color:var(--pf-accent)}
.pf-zl{min-width:3.2em;text-align:center;color:var(--pf-ink);font-variant-numeric:tabular-nums}
.pf .pf-opts input[type=range]{width:80px}
.pf-seg{display:inline-flex;border:1px solid var(--pf-line);gap:0}
.pf .pf-seg button{border:0;border-right:1px solid var(--pf-line);min-height:24px;padding:2px 8px;background:transparent}
.pf .pf-seg button:last-child{border-right:0}.pf .pf-seg button.on{border-color:var(--pf-line)}
.pf-work{flex:1;display:flex;min-height:0}
.pf-rail{display:flex;flex-direction:column;gap:4px;padding:8px 6px;border-right:1px solid var(--pf-line);background:var(--pf-panel);align-items:center;overflow:auto}
.pf-tools{display:flex;flex-direction:column;gap:4px}
.pf .pf-tools button{width:38px;height:38px;padding:0;background:transparent;border-color:transparent}
.pf .pf-tools button .pf-ic{width:21px;height:21px}
.pf .pf-tools button.on{background:var(--pf-accent);border-color:var(--pf-accent);color:var(--pf-on);box-shadow:0 0 16px rgba(185,140,255,.35)}
.pf-swatch{position:relative;width:40px;height:44px;margin-top:10px;flex:none}
.pf-cpop{position:fixed;z-index:40;width:250px;max-width:calc(100vw - 16px);display:flex;flex-direction:column;gap:8px;padding:12px;background:var(--pf-panel);border:1px solid var(--pf-line2);box-shadow:0 12px 32px rgba(0,0,0,.45)}
.pf .pf-cpop button:not(.primary){background:transparent;min-height:28px;padding:2px 9px;font-size:12px}.pf .pf-cpop button:not(.primary):hover:not(:disabled){background:var(--pf-panel2)}
.pf .pf-cpop .pf-cur input[type=color]{width:56px;height:40px}.pf .pf-cpop .pf-cur input[type=text]{flex:1;min-width:0}
.pf .pf-prim.open{outline:2px solid var(--pf-accent);outline-offset:2px}
@media (pointer:coarse){.pf-cpop-tip{display:none}}
/* Quick palette at the cursor (Tab): the project palette and the image's colours where the mouse is, so colours are picked without travelling to the side panel. */
.pf-qpal{position:fixed;z-index:50;max-width:min(320px,calc(100vw - 16px));display:flex;flex-direction:column;gap:6px;padding:10px;background:var(--pf-panel);border:1px solid var(--pf-accent);box-shadow:0 12px 40px rgba(0,0,0,.6)}
.pf-qpal .pf-sub{margin-top:0}.pf-qpal .pf-sub:first-child{margin-top:0}
.pf-qpal .pf-sw{max-height:132px;overflow:auto}
.pf-qpal .pf-note{font-size:11px}
.pf .pf-prim,.pf .pf-sec{position:absolute;width:26px;height:26px;min-height:0;padding:0;border:2px solid var(--pf-ink);background:var(--pf-c,#000)}
.pf .pf-prim{left:0;top:0;z-index:1}.pf .pf-sec{right:0;bottom:0;border-color:var(--pf-faint)}
.pf .pf-prim.clear,.pf .pf-sec.clear{background:repeating-conic-gradient(#3a2d55 0 25%,#1c1530 0 50%) 0 0/8px 8px}
.pf .pf-swap{position:absolute;right:-3px;top:-4px;min-height:0;width:16px;height:16px;padding:0;font-size:10px;background:none;border:0;color:var(--pf-muted)}
.pf-stage{position:relative;flex:1;min-height:200px;overflow:hidden;touch-action:none;background-color:#05030a;
  background-image:radial-gradient(ellipse 80% 60% at 50% 0%,rgba(185,140,255,.10),transparent 70%),linear-gradient(rgba(185,140,255,.045) 1px,transparent 1px),linear-gradient(90deg,rgba(185,140,255,.045) 1px,transparent 1px);background-size:auto,32px 32px,32px 32px}
.pf-stage::after{content:"";position:absolute;inset:6px;pointer-events:none;background-repeat:no-repeat;background-image:
  linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),
  linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent)),linear-gradient(var(--pf-accent),var(--pf-accent));
  background-size:12px 1px,1px 12px,12px 1px,1px 12px,12px 1px,1px 12px,12px 1px,1px 12px;
  background-position:0 0,0 0,100% 0,100% 0,0 100%,0 100%,100% 100%,100% 100%;opacity:.55}
.pf-stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;cursor:crosshair}
.pf-status{display:flex;flex-wrap:nowrap;align-items:center;gap:18px;height:30px;box-sizing:border-box;padding:0 10px;white-space:nowrap;overflow:hidden;border-top:1px solid var(--pf-line);background:var(--pf-panel);color:var(--pf-muted);font-size:11.5px}
.pf-status b{color:var(--pf-ink)}.pf-status>span{flex:none}.pf .pf-status .pf-s-name,.pf .pf-status .pf-s-note{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}.pf .pf-status .pf-s-note{flex:1 1 0;text-align:right}.pf-s-pos{min-width:21ch;font-variant-numeric:tabular-nums}.pf-s-sel{color:var(--pf-accent)}
.pf-sw{display:flex;flex-wrap:wrap;gap:4px}
.pf .pf-sw button{width:24px;height:24px;min-height:0;padding:0;border:1px solid rgba(0,0,0,.6);box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.pf .pf-sw button:hover:not(:disabled){box-shadow:0 0 0 1px var(--pf-accent)}
.pf .pf-sw button.on{outline:2px solid var(--pf-accent);outline-offset:1px;border-color:var(--pf-on)}
.pf .pf-sw button.sec{outline:1px dashed var(--pf-muted);outline-offset:1px}
.pf-cur{display:flex;gap:8px;align-items:center}.pf-cur input[type=color]{width:44px;height:32px;padding:0;border:1px solid var(--pf-line2);background:none;flex:none;cursor:pointer}
.pf-ramp{display:flex;flex-direction:column;gap:6px}.pf-ramp[hidden]{display:none}.pf .pf-ramp .pf-sw button{width:34px;height:24px}
.pf-row{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.pf-sub{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--pf-muted);margin-top:2px}
.pf-ccount{font-weight:400;letter-spacing:0;text-transform:none;color:var(--pf-muted);margin-left:4px}.pf-ccount.over{color:var(--pf-bad)}
.pf-ly-list{display:flex;flex-direction:column;gap:2px}.pf-ly{display:flex;gap:6px;align-items:center;padding:2px;border:1px solid transparent;cursor:pointer}.pf-ly.on{border-color:var(--pf-accent);background:rgba(224,140,255,.10)}
.pf .pf-ly canvas{flex:none;width:28px;height:28px;image-rendering:pixelated;background:repeating-conic-gradient(#3a2d55 0 25%,#1c1530 0 50%) 0 0/8px 8px}.pf .pf-ly input{flex:1;min-width:0;min-height:26px;padding:3px 6px}.pf .pf-ly .pf-ly-eye{min-height:26px;width:28px;padding:0;flex:none}.pf .pf-ly.off canvas,.pf .pf-ly.off input{opacity:.45}
.pf-ly-tip[hidden],.pf-ly-oprow[hidden],.pf-ly-linkrow[hidden]{display:none}
.pf .pf-ly .pf-ly-link{min-height:26px;width:28px;padding:0;flex:none;justify-content:center;color:var(--pf-faint)}.pf .pf-ly .pf-ly-link.on{color:var(--pf-accent);border-color:var(--pf-accent)}.pf .pf-ly .pf-ly-link .pf-ic{width:15px;height:15px}
.pf-ly-linkrow{align-items:center}.pf-ly-nudge{display:inline-flex;gap:2px;margin-left:auto}.pf .pf-ly-nudge button{min-height:24px;padding:1px 7px}
.pf-notes-n{font-weight:400;letter-spacing:0;text-transform:none;color:var(--pf-muted);margin-left:4px}
.pf-note-list{display:flex;flex-direction:column;gap:4px}.pf-note-item{display:flex;gap:6px;align-items:center}.pf-note-item b{flex:none;min-width:20px;height:20px;display:inline-flex;align-items:center;justify-content:center;background:var(--pf-accent2);color:var(--pf-on);font-size:11px}
.pf .pf-note-item input{flex:1;min-width:0;min-height:26px;padding:3px 6px}.pf .pf-note-item button{min-height:26px;padding:0 7px}.pf-note-add.on{background:rgba(224,140,255,.18)!important;color:var(--pf-accent2)!important}
/* Loading a project: a pixel spinner in the sprite list, eight squares round a ring lighting up in turn (steps, no smoothing). */
.pf-loading{display:flex;flex-direction:column;align-items:center;gap:14px;padding:36px 12px;text-align:center;color:var(--pf-muted)}.pf-loading b{color:var(--pf-ink);font-weight:400;word-break:break-all}
.pf-spin{display:grid;grid-template-columns:repeat(3,9px);grid-template-rows:repeat(3,9px);gap:2px}
.pf-spin i{background:var(--pf-line);animation:pf-spin .8s steps(1) infinite}
.pf-spin i:nth-child(1){grid-area:1/1}.pf-spin i:nth-child(2){grid-area:1/2;animation-delay:.1s}.pf-spin i:nth-child(3){grid-area:1/3;animation-delay:.2s}.pf-spin i:nth-child(4){grid-area:2/3;animation-delay:.3s}
.pf-spin i:nth-child(5){grid-area:3/3;animation-delay:.4s}.pf-spin i:nth-child(6){grid-area:3/2;animation-delay:.5s}.pf-spin i:nth-child(7){grid-area:3/1;animation-delay:.6s}.pf-spin i:nth-child(8){grid-area:2/1;animation-delay:.7s}
@keyframes pf-spin{0%{background:var(--pf-accent)}12.5%{background:var(--pf-line2)}25%{background:var(--pf-line)}}
@media (prefers-reduced-motion:reduce){.pf-spin i{animation-duration:2.4s}}
.pf .pf-right button:not(.primary):not(.on):not(.pf-fam-m),.pf .pf-side>.pf-row button:not(.primary){background:transparent;min-height:26px;padding:2px 9px;font-size:12px}
.pf .pf-right button:not(.primary):not(.on):not(.pf-fam-m):hover:not(:disabled),.pf .pf-side>.pf-row button:not(.primary):hover:not(:disabled){background:var(--pf-panel2);box-shadow:none}
.pf-prev canvas{image-rendering:pixelated;background:var(--pf-ckbg);max-width:100%;display:block;border:1px solid var(--pf-line)}
.pf-note{color:var(--pf-muted);font-size:11.5px}.pf-bad{color:var(--pf-bad)}.pf-ok{color:var(--pf-good)}
.pf .pf-s-size{min-height:0;padding:0 5px;font:inherit;background:none;border:1px dashed var(--pf-line2);color:inherit;cursor:pointer}.pf .pf-s-size:hover{border-color:var(--pf-accent);color:var(--pf-accent)}
.pf-sz-body{display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap}.pf-sz-fields{display:flex;flex-direction:column;gap:8px;min-width:250px}
.pf-sz-anchorrow{display:flex;gap:10px;align-items:center}.pf-sz-anchor{display:grid;grid-template-columns:repeat(3,26px);gap:3px}
.pf .pf-sz-anchor button{width:26px;height:26px;min-height:0;padding:0;background:var(--pf-panel2)}.pf .pf-sz-anchor button.on{background:var(--pf-accent);border-color:var(--pf-accent)}
.pf-sz-prev{display:flex;flex-direction:column;gap:6px;align-items:center;justify-content:center;min-width:170px;min-height:170px;padding:8px;border:1px solid var(--pf-line);background:var(--pf-ckbg)}.pf-sz-cv{image-rendering:pixelated;outline:1px dashed var(--pf-accent)}
.pf-sz-mode{align-self:flex-start}
.pf-n-line{display:flex;gap:8px;align-items:center}.pf-n-or{color:var(--pf-muted)}.pf .pf-n-line .pf-nw,.pf .pf-n-line .pf-nh{width:64px}.pf .pf-n-line .pf-nn{flex:1;min-width:0}.pf-sz-info{text-align:center}.pf .pf-sz-quick button{min-width:34px}
.pf-pal-empty[hidden]{display:none}
.pf-box{border:1px solid var(--pf-line);padding:10px;display:flex;flex-direction:column;gap:8px;background:var(--pf-bg)}
.pf .pf-c-pick.on{border-color:var(--pf-accent)}
.pf dialog.pf-dlg-connect{width:min(640px,94vw)}
.pf-dlg-head{display:flex;justify-content:space-between;align-items:center}.pf-dlg-head h4{margin:0}
.pf .pf-x{min-height:0;width:30px;height:30px;padding:0;background:none;border-color:transparent;color:var(--pf-muted);font-size:14px}
.pf-c-sec{border:1px solid var(--pf-line);background:var(--pf-bg);padding:14px;display:flex;flex-direction:column;gap:10px}
.pf-c-sechead{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;min-height:30px}
.pf-c-title{font-weight:700;color:var(--pf-ink)}
.pf-c-other{display:grid;grid-template-columns:minmax(0,1fr) 140px auto;gap:6px}
.pf-c-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.pf-c-tile{border:1px solid var(--pf-line);background:var(--pf-bg);padding:12px 14px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}
.pf-c-tile .pf-note{min-height:2.6em}
.pf-imgtools{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:4px}.pf .pf-imgtools button{padding:0;min-height:0;height:34px;justify-content:center}.pf .pf-imgtools .pf-ic{width:18px;height:18px}.pf .pf-imgtools .pf-delete:hover{color:var(--pf-bad);border-color:var(--pf-bad)}
.pf-imgtip{min-height:2.6em;margin-top:6px;line-height:1.3}
.pf-c-locals{display:flex;flex-direction:column;gap:4px;width:100%;max-height:150px;overflow:auto}.pf-c-lp{display:flex;gap:4px}.pf .pf-c-lp .pf-c-lopen{flex:1;justify-content:flex-start;align-items:center;gap:8px;line-height:1.2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.pf .pf-c-lp.on .pf-c-lopen{border-color:var(--pf-accent)}.pf .pf-c-lp button{min-height:34px}.pf .pf-c-lopen .pf-note{line-height:1.2;min-height:0}.pf .pf-c-lren,.pf .pf-c-ldel{min-width:34px;padding:0;color:var(--pf-muted)}.pf .pf-c-ldel:hover,.pf .pf-delete:hover{color:var(--pf-bad)}
.pf-c-foot{text-align:center}.pf-auth-help:empty,.pf-c-addrepo:empty{display:none}
.pf-auth-row[hidden]{display:none}
.pf-acct{display:inline-flex;gap:8px;align-items:center;font:12.5px var(--pf-mono,'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);color:#9a86c4}.pf-acct .pf-who{color:#9a86c4}
.pf-acct button{font:inherit;background:#150e24;color:#e6dcf7;border:1px solid #2a1b45;padding:2px 8px;cursor:pointer}.pf-acct button:hover{border-color:var(--pf-accent,#b98cff);color:var(--pf-accent,#b98cff)}
.pf-side-auth{justify-content:space-between;flex-wrap:nowrap}.pf-side-auth .pf-who{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.pf-side-auth .pf-who:empty{display:none}.pf-side-auth .pf-signin{width:100%}
.pf .pf-source{width:100%;text-align:left;border-color:var(--pf-line2);display:block;overflow:hidden}
.pf-source .pf-repo{display:block;font-size:11px;color:var(--pf-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-source .pf-branch{display:block;font-size:14.5px;color:var(--pf-accent);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-brmenu{min-width:210px;max-width:290px}
.pf-brmenu .pf-note{white-space:normal}
.pf-c-mine{display:flex;flex-direction:column;gap:6px}.pf-c-mine[hidden]{display:none}.pf-c-repolist{display:flex;flex-direction:column;gap:4px;max-height:220px;overflow:auto}
.pf-c-start{display:flex;flex-direction:column;gap:8px;align-items:flex-start;padding:10px;border:1px dashed var(--pf-line2)}.pf-c-start b{color:var(--pf-ink)}
.pf a.pf-c-install{display:inline-flex;align-items:center;min-height:30px;padding:4px 10px;border:1px solid var(--pf-accent);background:var(--pf-accent);color:var(--pf-on);font-weight:700;text-decoration:none}.pf a.pf-c-install:hover{background:#cba8ff}.pf a.pf-c-install:focus-visible{outline:1px solid var(--pf-accent);outline-offset:1px}
.pf-af-list{display:flex;flex-direction:column;gap:2px;max-height:46vh;overflow:auto;border:1px solid var(--pf-line);padding:6px}.pf-af-list label{display:flex;gap:8px;align-items:center;padding:3px 2px;cursor:pointer}.pf-af-list label .pf-note{margin-left:auto}.pf-af-list code{font:inherit;color:var(--pf-ink)}
.pf .pf-c-pick{display:flex;justify-content:space-between;gap:8px;text-align:left;width:100%}.pf-c-pick b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pf-tokenbox summary{cursor:pointer;color:var(--pf-muted);font-size:12.5px}.pf-tokenbox>label,.pf-tokenbox>.pf-note{display:block;margin-top:8px}.pf-tokenbox[hidden]{display:none}
.pf dialog{background:var(--pf-panel);color:var(--pf-ink);border:1px solid var(--pf-line2);box-shadow:0 0 0 1px rgba(185,140,255,.15),0 20px 60px rgba(0,0,0,.6),0 0 40px rgba(185,140,255,.10);padding:18px;width:min(560px,94vw);max-height:92vh;overflow:auto}
.pf dialog::backdrop{background:rgba(7,4,13,.78);backdrop-filter:blur(2px)}
.pf-form{display:flex;flex-direction:column;gap:10px}.pf-log:empty{display:none}.pf-log{white-space:pre-wrap;color:var(--pf-muted);max-height:140px;overflow:auto;border:1px solid var(--pf-line);padding:6px;min-height:34px;background:#05030a}
.pf-chg{display:flex;gap:8px;align-items:center;padding:4px 0;border-bottom:1px solid var(--pf-line)}.pf-chg canvas{width:40px;height:40px;image-rendering:pixelated;background:var(--pf-ckbg)}
.pf a.pf-btn{display:inline-flex;align-items:center;justify-content:center;min-height:30px;padding:4px 9px;border:1px solid var(--pf-accent);background:var(--pf-accent);color:var(--pf-on);font-weight:700;text-decoration:none;cursor:pointer}.pf a.pf-btn:hover{background:#cba8ff}.pf a.pf-btn:focus-visible{outline:1px solid var(--pf-accent);outline-offset:1px}
.pf-fb-shot img{display:block;width:100%;max-height:30vh;object-fit:contain;background:#05030a;border:1px solid var(--pf-line)}
.pf .pf-fb-text{width:100%;box-sizing:border-box;resize:vertical}
.pf-fb-more{max-height:24vh;overflow:auto}.pf-fb-more summary{cursor:pointer}
.pf-fb-facts{border-collapse:collapse;margin:4px 0;font-size:12px}.pf-fb-facts th{text-align:left;font-weight:normal;color:var(--pf-muted);padding:1px 12px 1px 0;white-space:nowrap;vertical-align:top}.pf-fb-facts td{padding:1px 0;word-break:break-word}
.pf-keys{display:grid;grid-template-columns:1fr;gap:6px}.pf-key{display:grid;grid-template-columns:minmax(150px,auto) 1fr;gap:12px;align-items:baseline;padding:3px 0;border-bottom:1px dashed var(--pf-line)}.pf-key span{color:var(--pf-muted)}.pf-key kbd{justify-self:start}
@media (max-width:1100px){.pf{--pf-cl:200px;--pf-cr:220px}}
@media (max-width:1300px){.pf-opts .pf-opt>.pf-note{display:none}}
@media (max-width:900px){
  .pf-c-grid{grid-template-columns:1fr}.pf-c-other{grid-template-columns:1fr}
  .pf{grid-template-columns:1fr;grid-template-rows:auto minmax(420px,1fr) auto;height:auto}
  .pf-side{flex-direction:column;border-right:0;border-bottom:1px solid var(--pf-line);max-height:none}.pf-list.pf-flat{flex-direction:row;overflow-x:auto;overflow-y:hidden;flex:none;min-height:0}.pf-flat .pf-item{width:150px;flex:none}.pf-list:not(.pf-flat){max-height:300px;flex:none}.pf-tiles{grid-template-columns:repeat(auto-fill,minmax(64px,1fr))}
  .pf-right{border-left:0;border-top:1px solid var(--pf-line)}
  .pf-work{flex-direction:column}
  .pf-rail{flex-direction:row;border-right:0;border-bottom:1px solid var(--pf-line);overflow-x:auto;padding:6px}
  .pf-tools{flex-direction:row}
  .pf-swatch{margin:0 0 0 8px}
  .pf-stage{min-height:340px}
  .pf-grp-end,.pf-opt-end{margin-left:0}
  .pf button,.pf .pf-bar button,.pf .pf-opts button,.pf .pf-seg button,.pf .pf-right button:not(.primary):not(.on):not(.pf-fam-m){min-height:38px}.pf-bar,.pf-opts{height:auto;flex-wrap:wrap;padding:4px 8px;gap:4px 8px}.pf-bar .pf-grp+.pf-grp{margin-left:0;padding-left:0;border-left:0}.pf input[type=text],.pf input[type=password],.pf input[type=number],.pf select,.pf textarea{font-size:16px;min-height:38px}
  .pf-key{grid-template-columns:1fr}
}
/* Fullscreen (touch and narrow screens): the canvas and the tool rail fill the screen; the sprite list slides in from the
   left and the colour panel (with the toolbar and tool options) from the right, on the › ‹ handles at the canvas edges. */
.pf-fsbar,.pf .pf-fs-h,.pf-fs-scrim,.pf-grp-fs{display:none}
/* Wide screens: the same handles fold the sprite list and the colour panel away, giving their column to the canvas. */
@media (min-width:901px){
  .pf:not(.pf-fs) .pf-fs-h{display:flex;align-items:center;justify-content:center;position:absolute;top:50%;width:18px;height:56px;margin-top:-28px;z-index:4;padding:0;min-height:0;font-size:18px;line-height:1;background:rgba(21,14,36,.88);border:1px solid var(--pf-line2);color:var(--pf-muted)}
  .pf:not(.pf-fs) .pf-fs-hl{left:calc(var(--pf-cl,220px) + var(--pf-rail-w,52px));border-left:0;border-radius:0 7px 7px 0}
  .pf:not(.pf-fs) .pf-fs-hr{right:var(--pf-cr,248px);border-right:0;border-radius:7px 0 0 7px}
  .pf.pf-lhide:not(.pf-fs){--pf-cl:0px}.pf.pf-rhide:not(.pf-fs){--pf-cr:0px}
  .pf.pf-lhide:not(.pf-fs) .pf-side,.pf.pf-rhide:not(.pf-fs) .pf-right{visibility:hidden;overflow:hidden;border:0;padding:0}
}
@media (pointer:coarse),(max-width:900px){.pf-grp-fs{display:inline-flex}}
.pf.pf-fs{position:fixed;inset:0;z-index:2147483000;display:block;width:100vw;height:100vh;height:100dvh;max-height:none;overflow:hidden;background:var(--pf-bg)}
.pf.pf-fs .pf-main{position:absolute;inset:0 env(safe-area-inset-right,0px) 0 env(safe-area-inset-left,0px);display:flex;flex-direction:column}
.pf.pf-fs .pf-status,.pf.pf-fs .pf-ctx,.pf.pf-fs .pf-grp-fs{display:none}
.pf.pf-fs .pf-work{flex-direction:row;flex:1;min-height:0}
.pf.pf-fs .pf-rail{flex-direction:column;flex-wrap:wrap;align-content:flex-start;align-items:center;border-right:1px solid var(--pf-line);border-bottom:0;overflow:hidden;padding:6px 4px;gap:4px;max-height:100%}
.pf.pf-fs .pf-tools{display:contents}
.pf.pf-fs .pf-swatch{margin:4px 0 0}
.pf.pf-fs .pf-stage{min-height:0;flex:1}
.pf.pf-fs .pf-fsbar{display:flex;position:absolute;top:8px;right:34px;gap:4px;z-index:3}
.pf.pf-fs .pf-fsbar button{min-width:40px;min-height:40px;padding:0 8px;background:rgba(14,9,24,.82);border:1px solid var(--pf-line2);display:inline-flex;align-items:center;justify-content:center}
.pf.pf-fs .pf-side,.pf.pf-fs .pf-right{display:flex;flex-direction:column;position:absolute;top:0;bottom:0;width:min(340px,86vw);z-index:6;overflow:auto;overscroll-behavior:contain;transition:transform .22s ease;background:var(--pf-panel);border:0;max-height:none;box-shadow:0 0 28px rgba(0,0,0,.55)}
.pf.pf-fs .pf-side{left:0;transform:translateX(-102%);padding-left:env(safe-area-inset-left,0px)}
.pf.pf-fs .pf-right{right:0;transform:translateX(102%);padding-right:env(safe-area-inset-right,0px)}
.pf.pf-fs.pf-fs-lopen .pf-side,.pf.pf-fs.pf-fs-ropen .pf-right{transform:none}
.pf.pf-fs .pf-list:not(.pf-flat){max-height:none;flex:1}
.pf.pf-fs .pf-right .pf-bar,.pf.pf-fs .pf-right .pf-opts{flex-wrap:wrap;height:auto;overflow:visible;gap:6px;padding:8px;border-bottom:1px solid var(--pf-line)}
.pf.pf-fs .pf-fs-scrim{display:block;position:absolute;inset:0;z-index:5;background:rgba(5,3,10,.5);opacity:0;pointer-events:none;transition:opacity .22s ease}
.pf.pf-fs.pf-fs-lopen .pf-fs-scrim,.pf.pf-fs.pf-fs-ropen .pf-fs-scrim{opacity:1;pointer-events:auto}
.pf.pf-fs .pf-fs-h{display:flex;align-items:center;justify-content:center;position:absolute;top:50%;width:28px;height:76px;margin-top:-38px;z-index:7;padding:0;min-height:0;font-size:24px;line-height:1;background:rgba(21,14,36,.88);border:1px solid var(--pf-line2);color:var(--pf-ink);transition:left .22s ease,right .22s ease,opacity .15s}
.pf.pf-fs .pf-fs-hl{left:calc(var(--pf-rail-w,52px) + env(safe-area-inset-left,0px));border-left:0;border-radius:0 9px 9px 0}
.pf.pf-fs .pf-fs-hr{right:env(safe-area-inset-right,0px);border-right:0;border-radius:9px 0 0 9px}
.pf.pf-fs.pf-fs-lopen .pf-fs-hl{left:min(340px,86vw)}
.pf.pf-fs.pf-fs-ropen .pf-fs-hr{right:min(340px,86vw)}
.pf.pf-fs.pf-fs-lopen .pf-fs-hr,.pf.pf-fs.pf-fs-ropen .pf-fs-hl{opacity:0;pointer-events:none}
.pf-ctx-cv.pf-ctx-hit{cursor:pointer}`;

  const el = (html) => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  /* Interface icons: simple 24-unit line drawings (currentColor, so they follow the theme). */
  const ICONS = {
    link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
    feedback: '<path d="M4 5h16v11h-9l-4.5 3.5V16H4z"/><path d="M8 9h8"/><path d="M8 12h5"/>',
    pen: '<path d="M4 20l1.2-4.2L16.4 4.6a2.1 2.1 0 0 1 3 3L8.2 18.8z"/><path d="M14.4 6.6l3 3"/>',
    erase: '<path d="M9 20h11"/><path d="M5.7 15.3l8.8-8.8a2 2 0 0 1 2.8 0l2.2 2.2a2 2 0 0 1 0 2.8L12 19H8.4l-2.7-2.7a1 1 0 0 1 0-1z"/><path d="M9.6 11.4l5 5"/>',
    fill: '<path d="M10.5 3.5l8.4 8.4-6.7 6.7a2 2 0 0 1-2.8 0l-5.6-5.6a2 2 0 0 1 0-2.8z"/><path d="M4.2 11.9H17"/><path d="M20 15.2s1.9 2.3 1.9 3.6a1.9 1.9 0 0 1-3.8 0c0-1.3 1.9-3.6 1.9-3.6z"/>',
    pick: '<circle cx="17.4" cy="6.6" r="3" fill="currentColor" stroke="none"/><path d="M13 7.6l3.4 3.4"/><path d="M14.6 9.4L6 18l-1.5 2.5 2.5-1.5 8.6-8.6"/>',
    line: '<path d="M6 18L18 6"/><circle cx="5.2" cy="18.8" r="1.7" fill="currentColor" stroke="none"/><circle cx="18.8" cy="5.2" r="1.7" fill="currentColor" stroke="none"/>',
    rect: '<rect x="4.5" y="5.5" width="15" height="13"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.2" ry="6.6"/>',
    select: '<path d="M4.5 8V4.5H8M11 4.5h2M16 4.5h3.5V8M19.5 11v2M19.5 16v3.5H16M13 19.5h-2M8 19.5H4.5V16M4.5 13v-2"/>',
    shade: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/>',
    gradient: '<rect x="4" y="4" width="16" height="16"/><path d="M12 4h4v4h-4zM16 8h4v4h-4zM12 12h4v4h-4zM16 16h4v4h-4zM8 8h4v4H8zM8 16h4v4H8z" fill="currentColor" stroke="none"/>',
    fullscreen: '<path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15"/>',
    exitfull: '<path d="M9 4.5V9H4.5M19.5 9H15V4.5M15 19.5V15h4.5M4.5 15H9v4.5"/>',
    undo: '<path d="M9 13.5L4.5 9 9 4.5"/><path d="M4.5 9H15a5 5 0 0 1 0 10h-3.5"/>',
    redo: '<path d="M15 13.5L19.5 9 15 4.5"/><path d="M19.5 9H9a5 5 0 0 0 0 10h3.5"/>',
    grid: '<rect x="4" y="4" width="16" height="16"/><path d="M4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
    tilegrid: '<rect x="4" y="4" width="16" height="16"/><path d="M12 4v16M4 12h16" stroke-width="2.6"/><path d="M8 4v16M16 4v16M4 8h16M4 16h16" stroke-width=".9" opacity=".6"/>',
    tile: '<rect x="4" y="4" width="7" height="7"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/><rect x="13" y="13" width="7" height="7"/>',
    changes: '<rect x="3.5" y="3.5" width="17" height="17"/><path d="M12 3.5v17"/><path d="M5.5 9.5h4M7.5 7.5v4"/><path d="M14.5 9.5h4"/><path d="M14.5 15.5h4" stroke-dasharray="1 1.6"/>',
    context: '<rect x="3.5" y="13.5" width="5" height="6"/><rect x="9.5" y="7.5" width="5" height="12" fill="currentColor"/><rect x="15.5" y="11.5" width="5" height="8"/><path d="M2 20.5h20"/>',
    lint: '<path d="M4 6h4v4H4z" fill="currentColor" stroke="none"/><path d="M12 7h8M12 15h8M4 15l2 2 3-4"/>',
    vision: '<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M12 9v6" />',
    onion: '<rect x="3.5" y="8.5" width="10" height="11" stroke-dasharray="2 2"/><rect x="10.5" y="4.5" width="10" height="11"/>',
    mx: '<path d="M12 3v18" stroke-dasharray="1.5 2.5"/><path d="M9 7.5L4.5 12 9 16.5z"/><path d="M15 7.5l4.5 4.5-4.5 4.5z"/>',
    my: '<path d="M3 12h18" stroke-dasharray="1.5 2.5"/><path d="M7.5 9L12 4.5 16.5 9z"/><path d="M7.5 15l4.5 4.5 4.5-4.5z"/>',
    sq: '<rect x="6.5" y="6.5" width="11" height="11" fill="currentColor"/>',
    circ: '<circle cx="12" cy="12" r="6" fill="currentColor"/>',
    fliph: '<path d="M12 3.5v17"/><path d="M9 7.5L4.5 12 9 16.5z" fill="currentColor"/><path d="M15 7.5l4.5 4.5-4.5 4.5z"/>',
    flipv: '<path d="M3.5 12h17"/><path d="M7.5 9L12 4.5 16.5 9z" fill="currentColor"/><path d="M7.5 15l4.5 4.5 4.5-4.5z"/>',
    rotate: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.5 4v4.5H15"/>',
    rotfree: '<path d="M4 20h16"/><path d="M4 20 16 8"/><path d="M11 20a7 7 0 0 0-2-5"/>',
    x2: '<rect x="3.5" y="9.5" width="7" height="7"/><path d="M14 6h6v6M20 6l-6 6"/>',
    outline4: '<rect x="8.5" y="8.5" width="7" height="7" fill="currentColor"/><path d="M8.5 5h7M8.5 19h7M5 8.5v7M19 8.5v7"/>',
    outline8: '<rect x="8.5" y="8.5" width="7" height="7" fill="currentColor"/><rect x="5" y="5" width="14" height="14"/>',
    variant: '<rect x="3.5" y="3.5" width="10" height="10"/><rect x="10.5" y="10.5" width="10" height="10" fill="currentColor"/>',
    left: '<path d="M19.5 12h-15"/><path d="M9.5 7L4.5 12l5 5"/>', right: '<path d="M4.5 12h15"/><path d="M14.5 7l5 5-5 5"/>',
    up: '<path d="M12 19.5v-15"/><path d="M7 9.5l5-5 5 5"/>', down: '<path d="M12 4.5v15"/><path d="M7 14.5l5 5 5-5"/>',
    canvas: '<rect x="3.5" y="3.5" width="17" height="17" stroke-dasharray="2.2 2"/><rect x="7.5" y="7.5" width="9" height="9"/>',
    trim: '<path d="M7 3v14h14"/><path d="M3 7h14v14"/>',
    clear: '<rect x="4.5" y="4.5" width="15" height="15"/><path d="M9 9l6 6M15 9l-6 6"/>',
    revert: '<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 3.5v4h4"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
    trash: '<path d="M4.5 7h15"/><path d="M9.5 7V4.5h5V7"/><path d="M6.5 7l1 13h9l1-13"/><path d="M10 11v5M14 11v5"/>',
    download: '<path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4.5 17.5v2h15v-2"/>',
  };
  /* The Image panel: one grid of icon buttons, named in a line below on hover. [class, icon, name, what it does, extra attributes] */
  const IMAGE_TOOLS = [
    ['pf-fliph', 'fliph', 'Flip left-right', 'the image, or the selection'], ['pf-flipv', 'flipv', 'Flip up-down', 'the image, or the selection'], ['pf-rot', 'rotate', 'Rotate 90°', 'clockwise; the image, or the selection'], ['pf-rotfree', 'rotfree', 'Rotate…', 'by any angle, with RotSprite so lines stay clean; the image, or the selection'],
    ['pf-x2', 'x2', 'Smooth ×2', 'twice the size with Scale2x: diagonals and curves stay smooth instead of turning into 2×2 blocks; the image, or the selection'],
    ['pf-outline', 'outline4', 'Outline', '1 pixel in the primary colour around everything opaque, sides only'], ['pf-outline8', 'outline8', 'Outline with corners', 'like Outline, diagonals included'], ['pf-variant', 'variant', 'Make variant…', 'a recoloured copy as new files, with its whole family (every pose and frame), e.g. king → king_dark'],
    ['pf-sh', 'left', 'Shift left', 'by 1 pixel; what falls off comes back on the other side', ' data-d="-1,0"'], ['pf-sh', 'up', 'Shift up', 'by 1 pixel, wrapping around', ' data-d="0,-1"'], ['pf-sh', 'down', 'Shift down', 'by 1 pixel, wrapping around', ' data-d="0,1"'], ['pf-sh', 'right', 'Shift right', 'by 1 pixel, wrapping around', ' data-d="1,0"'],
    ['pf-resize', 'canvas', 'Canvas size…', 'grow or cut the canvas, or scale the image (Ctrl+Alt+C, or click the size in the status bar)'], ['pf-trim', 'trim', 'Trim', 'cut away the empty border'],
    ['pf-clear', 'clear', 'Clear', 'erase every pixel (undo brings them back)'], ['pf-revert', 'revert', 'Revert to original', 'throw away every change to this sprite (undo brings them back)'], ['pf-delete', 'trash', 'Delete sprite', 'it only exists in this browser, never saved into the project', ' hidden'],
  ];
  const icon = (name) => `<svg class="pf-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  // [id, name, key, rail icon or the rail tool it belongs to]
  // [id, name, key, rail icon or the rail tool it belongs to]. The most-used drawing keys sit on the left hand (A Z X
  // together: pick, pencil/eraser, swap) so the right hand stays on the mouse or stylus. I still picks, for muscle memory.
  const TOOLS = [['pen', 'Pencil', 'B'], ['erase', 'Eraser', 'E'], ['fill', 'Fill', 'G'], ['pick', 'Colour picker', 'A'], ['line', 'Line', 'L'], ['rect', 'Rectangle', 'R'], ['rectf', 'Filled rectangle', 'F', 'rect'], ['ellipse', 'Ellipse', 'O'], ['ellipsef', 'Filled ellipse', 'U', 'ellipse'], ['select', 'Select and move', 'S'], ['lasso', 'Lasso select', 'Q', 'select'], ['wand', 'Magic wand: select by colour', 'W', 'select'], ['shade', 'Shade: lighter, right click darker', 'D'], ['gradient', 'Dither gradient: drag from the primary to the secondary colour', 'J']];
  const railOf = (t) => { const x = TOOLS.find((k) => k[0] === t); return (x && x[3]) || t; };
  const KEYS = [['B E G A', 'pencil · eraser · fill · colour picker (I also picks)'], ['L R F O U', 'line · rectangle · filled rect · ellipse · filled ellipse'], ['S Q W', 'select a rectangle · lasso · magic wand (Shift adds, Alt subtracts; drag inside to move)'], ['D J', 'shade · dither gradient'], ['Tab', 'palette at the cursor: pick without leaving the canvas (click: primary · Shift+click / right click: secondary · Tab / Esc closes)'], ['[ ]', 'brush size (pencil, eraser, shade, and the line / outline shapes)'], ['Z', 'switch between pencil and eraser'], ['X', 'swap primary / secondary colour'], ['Alt+click', 'pick a colour with any tool'], ['right click', 'paint with the secondary colour (clear = erase)'], ['Shift', 'square / circle / 45° lines; with the pencil, click to draw a line from the last point'],
    ['M', 'mirror left-right'], ['V', 'context: the sprite at game scale next to others from its folder'], ['H', 'show / hide the reference image'], ['P', 'pixel check: stray pixels, doubled corners, near-duplicate colours'], ['Y', 'vision check: values (greyscale), protanopia, deuteranopia, tritanopia'], ['C · hold \\ · Shift+\\', 'changes against the branch (dims the rest) · show the branch version while held · the last save while held'], ['T · N · # · K', 'tile preview · onion skin · grid · background (dark / light checker, black, white, custom, the project\'s)'], ['Ctrl+C X V', 'copy · cut · paste (images from other apps too)'], ['Ctrl+A · Del · Esc · Enter', 'select all · delete · drop · apply selection'], ['arrows', 'nudge the selection (Shift: 8 px)'], ['Ctrl+Z · Ctrl+Y', 'undo · redo'], ['Ctrl+S', 'save (to the project folder when it can be written; edits are kept in this browser either way)'], ['Ctrl+Shift+S', 'download this sprite as a PNG'], ['Ctrl+Alt+C', 'canvas size'], ['wheel · + − 0', 'zoom · fit'], ['space+drag · middle mouse', 'pan'], ['?', 'this list']];
  /* What shows behind transparent pixels. No single background suits all art (dark details vanish on the dark checker, pale
     ones on the light one), so like Aseprite, Pixelorama and Piskel the editor offers a few and remembers the choice.
     "project" is the game's own background colour from spritewright.config.json ("background": "#1a1426"). */
  const BACKGROUNDS = [['project', 'Project background'], ['dark', 'Dark checker'], ['light', 'Light checker'], ['black', 'Black'], ['white', 'White'], ['custom', 'Custom colour']];
  const luma = (hex) => { const c = fromHex(hex); if (c == null) return 0; const [r, g, b] = unpack(c); return (0.299 * r + 0.587 * g + 0.114 * b) / 255; };
  const toBlob = (canvas) => new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode the PNG'))), 'image/png'));
  const drawPx = (canvas, doc, scale = 1) => { // blit a doc's pixels to a canvas at scale (nearest neighbour)
    const t = document.createElement('canvas'); t.width = doc.w; t.height = doc.h; t.getContext('2d').putImageData(doc.imageData(), 0, 0);
    canvas.width = doc.w * scale; canvas.height = doc.h * scale; const g = canvas.getContext('2d'); g.imageSmoothingEnabled = false; g.clearRect(0, 0, canvas.width, canvas.height); g.drawImage(t, 0, 0, canvas.width, canvas.height);
  };
  async function decodePng(blob) {
    if (hasStreams()) { try { return await decodePngBytes(new Uint8Array(await blob.arrayBuffer())); } catch (e) { if (!/interlaced|unsupported/.test(e.message)) throw e; /* rare variants: let the browser decode (may round semi-transparent pixels) */ } }
    const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0);
    const d = g.getImageData(0, 0, bmp.width, bmp.height);
    return { w: d.width, h: d.height, px: new Uint32Array(d.data.buffer.slice(0)) };
  }

  function $$dialogs(root) { root.querySelectorAll('dialog form').forEach((f) => f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') e.preventDefault(); })); }

  /* =====================================================================================================
     Edits kept in this browser (IndexedDB), so a reload, a crash or a closed tab loses nothing. One record per project + file:
       { path, w, h, px, base, saved, local, isNew, onDisk, frames, at }   (px arrays are Uint32Array, stored as they are)
     The editor writes a record whenever a sprite differs from what it can get back from its project, and deletes it once it
     does not (saved to disk, proposed in a pull request, or reverted). Pass { drafts: false } to mount() to turn this off.
     ===================================================================================================== */
  function browserDrafts(name = 'spritewright') {
    let dbp = null;
    const open = () => dbp || (dbp = new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('this browser has no IndexedDB'));
      const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('drafts');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('storage blocked')); r.onblocked = () => rej(new Error('storage blocked'));
    }).catch((e) => { dbp = null; throw e; }));
    const run = async (mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('drafts', mode), r = fn(t.objectStore('drafts')); t.oncomplete = () => res(r.result); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('storage aborted')); }); };
    const all = (project) => IDBKeyRange.bound([project], [project, []]); // every [project, path] key
    return {
      list: (project) => run('readonly', (s) => s.getAll(all(project))),
      put: (project, rec) => run('readwrite', (s) => s.put({ ...rec, project }, [project, rec.path])),
      remove: (project, path) => run('readwrite', (s) => s.delete([project, path])),
      clear: (project) => run('readwrite', (s) => s.delete(all(project))),
    };
  }
  /** No project: sprites uploaded or drawn from scratch, living only in this browser until they are downloaded. */
  const browserSource = (id = '', name = '') => ({ kind: 'browser', id, name: name || (id ? 'Untitled' : 'Sketches'), thumbs: false, sprites: [], hidden: [], note: 'A project in this browser: nothing is linked, the sprites are kept here (they survive reloads). Download them when done.', async read(path) { throw new Error(path + ' only exists in this browser'); } });

  /* ---------- feedback ----------
     Signed in with GitHub, the dialog sends it to the sign-in service, which opens the issue as the reporter (worker/index.js).
     Signed out, it opens a prefilled GitHub issue form (.github/ISSUE_TEMPLATE/feedback.yml): no token and no server, the person
     reads exactly what will be posted and submits it themselves. A link cannot carry an image, so the editor copies its screenshot
     to the clipboard for a paste into the form (and offers it as a download). */
  const FEEDBACK_REPO = 'snowu/spritewright', FEEDBACK_TEMPLATE = 'feedback.yml', FEEDBACK_MAX_URL = 7500; // GitHub answers 414 a little past 8k characters
  const FEEDBACK_KINDS = { bug: 'Bug', idea: 'Idea', other: 'Feedback' };
  /** A starting title: the kind, then the first ten words (capped in characters too: a pasted run with no spaces is one word). */
  function feedbackTitle(text, kind = 'bug', n = 10, max = 100) {
    const words = String(text).trim().split(/\s+/).filter(Boolean), head = (FEEDBACK_KINDS[kind] || FEEDBACK_KINDS.other) + ': ';
    if (!words.length) return '';
    const t = head + (words.length > n ? words.slice(0, n).join(' ') + '…' : words.join(' '));
    return t.length > max ? t.slice(0, max - 1) + '…' : t;
  }
  /** [label, value] rows as a markdown table, for the issue's details. */
  const feedbackDetails = (rows) => ['| | |', '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`)].join('\n');
  /** The prefilled "new issue" link. The description is trimmed (with a note) only if it alone would push the link past GitHub's
      limit; the details stay whole, they are the part nobody can retype later. */
  function feedbackUrl({ what = '', details = '', kind = 'bug', repo = FEEDBACK_REPO } = {}) {
    what = String(what).trim(); const title = feedbackTitle(what, kind);
    const build = (text, withBody) => {
      const q = new URLSearchParams({ template: FEEDBACK_TEMPLATE });
      if (title) q.set('title', title);
      q.set('what', text); q.set('details', details);
      // The same text as a plain body too: GitHub fills the form when the template exists on the default branch and ignores body;
      // when it does not (a fork, a renamed file) it opens a blank issue with the body in it, so the report never arrives empty.
      if (withBody) q.set('body', ['### What happened?', '', text, '', '### Screenshot', '', '_Paste it here (Ctrl+V)._', '', '### Details', '', details].join('\n'));
      return `https://github.com/${repo}/issues/new?${q}`;
    };
    for (const withBody of [true, false]) {
      let keep = what.length, url = build(what, withBody);
      while (keep > 0 && url.length > FEEDBACK_MAX_URL) { keep = Math.floor(keep * 0.8); url = build(what.slice(0, keep) + '\n\n[…trimmed to fit the link; please paste the rest]', withBody); }
      if (url.length <= FEEDBACK_MAX_URL || !withBody) return url;
    }
  }

  /* ---------- screenshot of the editor, for feedback ----------
     Browsers have no way to photograph their own page without a permission prompt, so the DOM is redrawn: cloned with every
     element's computed style inlined (only what differs from both the browser default and the parent, to keep it small), each
     canvas swapped for a picture of itself, form values and scroll positions carried over, then drawn through an SVG
     foreignObject. Two steps: capture() is synchronous, so the picture is of the moment it is called (before a dialog opens);
     the returned function rasterises it to a PNG blob, or null if the browser refuses (some taint the canvas). */
  const UA_STYLE = new Map(); let uaFrame = null;
  function uaStyle(el) {
    const key = el.namespaceURI + ' ' + el.localName;
    if (!UA_STYLE.has(key)) {
      if (!uaFrame) { uaFrame = document.createElement('iframe'); uaFrame.setAttribute('aria-hidden', 'true'); uaFrame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden'; document.body.appendChild(uaFrame); }
      const d = uaFrame.contentDocument, e = d.createElementNS(el.namespaceURI, el.localName); (el.namespaceURI === 'http://www.w3.org/2000/svg' ? d.body.appendChild(d.createElementNS(e.namespaceURI, 'svg')) : d.body).appendChild(e);
      const cs = uaFrame.contentWindow.getComputedStyle(e), o = {}; for (let i = 0; i < cs.length; i++) o[cs[i]] = cs.getPropertyValue(cs[i]);
      UA_STYLE.set(key, o); e.remove();
    }
    return UA_STYLE.get(key);
  }
  function captureDom(rootEl) {
    // What is on screen: on a phone the editor is taller than the window, and the part scrolled away is not what was seen.
    const full = rootEl.getBoundingClientRect(), pr = Math.min(2, window.devicePixelRatio || 1);
    const box = { left: Math.max(full.left, 0), top: Math.max(full.top, 0), right: Math.min(full.right, innerWidth), bottom: Math.min(full.bottom, innerHeight) };
    if (box.right - box.left < 1 || box.bottom - box.top < 1) return null;
    const seen = (r) => (!r.width && !r.height) || (r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom); // no box (display: contents): its children decide
    const copy = (src, parentCs, shift) => {
      if (src.nodeType === 3) return document.createTextNode(src.data);
      if (src.nodeType !== 1 || src.localName === 'script' || src.localName === 'style' || src.localName === 'dialog') return null;
      const cs = getComputedStyle(src); if (cs.display === 'none') return null;
      const rect = src.getBoundingClientRect(), shown = seen(rect);
      let out;
      if (src.localName === 'canvas') { out = document.createElement('img'); try { if (shown && src.width && src.height) out.setAttribute('src', src.toDataURL()); } catch { /* tainted: leave it blank */ } }
      else if (src.localName === 'img' && src.complete && src.naturalWidth) { out = document.createElement('img'); try { const c = document.createElement('canvas'); c.width = src.naturalWidth; c.height = src.naturalHeight; c.getContext('2d').drawImage(src, 0, 0); out.setAttribute('src', c.toDataURL()); } catch { /* cross-origin */ } }
      else out = src.cloneNode(false);
      for (const a of ['id', 'class', 'title', 'aria-label', 'data-tip']) if (out.removeAttribute) out.removeAttribute(a); // nothing in the picture refers to them
      if (src.localName === 'input' && src.type !== 'file') { if (src.type === 'checkbox' || src.type === 'radio') { if (src.checked) out.setAttribute('checked', ''); } else out.setAttribute('value', src.value); }
      if (src.localName === 'option' && src.selected) out.setAttribute('selected', '');
      const inline = (st, ua, parent) => { const css = []; for (let i = 0; i < st.length; i++) { const p = st[i], v = st.getPropertyValue(p); if (v !== ua[p] || (parent && v !== parent.getPropertyValue(p))) css.push(`${p}:${v}`); } return css; };
      const css = inline(cs, uaStyle(src), parentCs);
      // Computed sizes are rounded to 3 decimals (179.40625px reads 179.406px): a hair too narrow, and text that just fitted
      // wraps. The layout box has the exact size, so use that where it maps straight onto width and height.
      if (src.namespaceURI === 'http://www.w3.org/1999/xhtml' && cs.display !== 'inline' && cs.transform === 'none' && /px$/.test(cs.width)) {
        const n = (v) => parseFloat(v) || 0, bb = cs.boxSizing === 'border-box';
        const w = rect.width - (bb ? 0 : n(cs.paddingLeft) + n(cs.paddingRight) + n(cs.borderLeftWidth) + n(cs.borderRightWidth)), h = rect.height - (bb ? 0 : n(cs.paddingTop) + n(cs.paddingBottom) + n(cs.borderTopWidth) + n(cs.borderBottomWidth));
        css.push(`box-sizing:${cs.boxSizing}`, `width:${w}px`, `height:${h}px`); // box-sizing too: the picture's document has its own defaults for form controls
      }
      if (shift) css.push(`translate:${-shift.x}px ${-shift.y}px`); // the parent was scrolled: an SVG picture cannot scroll, so move its children instead
      if (src === rootEl) css.push('margin:0');
      out.setAttribute('style', css.join(';'));
      if (src.localName === 'textarea') out.textContent = src.value;
      else if (src.localName !== 'canvas' && src.localName !== 'img' && (shown || src.namespaceURI === 'http://www.w3.org/2000/svg')) {
        const sc = src.scrollTop || src.scrollLeft ? { x: src.scrollLeft, y: src.scrollTop } : null;
        for (const ch of src.childNodes) { const c = copy(ch, cs, sc && ch.nodeType === 1 ? sc : null); if (c) out.appendChild(c); }
        for (const at of src.namespaceURI === 'http://www.w3.org/1999/xhtml' ? ['::before', '::after'] : []) { // generated content such as the "//" before panel titles
          const ps = getComputedStyle(src, at); if (!ps.content || ps.content === 'none' || ps.content === 'normal') continue;
          const span = document.createElement('span'), m = /^"((?:[^"\\]|\\.)*)"$/.exec(ps.content); span.textContent = m ? m[1].replace(/\\(.)/g, '$1') : '';
          span.setAttribute('style', inline(ps, uaStyle(span), cs).filter((d) => !d.startsWith('content:')).join(';')); at === '::before' ? out.prepend(span) : out.appendChild(span);
        }
      }
      return out;
    };
    let tree;
    try { tree = copy(rootEl, rootEl.parentElement ? getComputedStyle(rootEl.parentElement) : null, null); } catch (err) { console.warn('spritewright: screenshot failed', err); return null; }
    if (!tree) return null;
    tree.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const noBars = document.createElement('style'); noBars.textContent = '*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}'; tree.prepend(noBars); // the picture cannot scroll anyway
    const w = Math.round(box.right - box.left), h = Math.round(box.bottom - box.top), bg = getComputedStyle(document.body).backgroundColor;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="${box.left - full.left} ${box.top - full.top} ${w} ${h}"><foreignObject x="0" y="0" width="${full.width}" height="${full.height}">${new XMLSerializer().serializeToString(tree)}</foreignObject></svg>`;
    return async () => {
      try {
        const img = new Image(); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); await img.decode();
        const c = document.createElement('canvas'); c.width = Math.round(w * pr); c.height = Math.round(h * pr);
        const k = c.getContext('2d'); k.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#07040d'; k.fillRect(0, 0, c.width, c.height); k.drawImage(img, 0, 0, c.width, c.height);
        return await new Promise((res) => { try { c.toBlob(res, 'image/png'); } catch { res(null); } });
      } catch (err) { console.warn('spritewright: screenshot failed', err); return null; }
    };
  }

  function mount(host, options = {}) {
    if (!document.getElementById('pf-vision-defs')) { // colour-blind simulations (Machado, Oliveira & Fernandes 2009, full severity), used by CSS filters
      const m = { protan: '0.152286 1.052583 -0.204868 0 0 0.114503 0.786281 0.099216 0 0 -0.003882 -0.048116 1.051998 0 0', deutan: '0.367322 0.860646 -0.227968 0 0 0.280085 0.672501 0.047413 0 0 -0.011820 0.042940 0.968881 0 0', tritan: '1.255528 -0.076749 -0.178779 0 0 -0.078411 0.930809 0.147602 0 0 0.004733 0.691367 0.303900 0 0' };
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.id = 'pf-vision-defs'; svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden');
      svg.innerHTML = Object.entries(m).map(([k, v]) => `<filter id="pf-vision-${k}"><feColorMatrix type="matrix" values="${v} 0 0 0 1 0"/></filter>`).join(''); document.body.appendChild(svg);
    }
    if (!document.getElementById('pf-css')) { const st = document.createElement('style'); st.id = 'pf-css'; st.textContent = CSS; document.head.appendChild(st); }
    const O = Object.assign({ manifestUrl: null, baseUrl: '', save: null, github: null, palette: null, accent: null, pr: true }, options);
    const root = el(`<div class="pf" tabindex="-1">
      <aside class="pf-side"><button class="pf-source" title="Switch to another GitHub repository or a folder on this computer">Open project…</button>
        <div class="pf-row pf-auth-row pf-side-auth"><button type="button" class="pf-signin">Sign in with GitHub</button><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button></div><div><div class="pf-side-head"><h4>Sprites</h4><span class="pf-foldmini"><button type="button" class="pf-fold-all" title="Fold every folder">▸ all</button><button type="button" class="pf-unfold-all" title="Unfold every folder">▾ all</button></span></div><input type="text" class="pf-q" placeholder="filter…" aria-label="Filter sprites"></div>
        <div class="pf-setup" hidden></div>
        <div class="pf-list" role="listbox" aria-label="Sprites"></div>
        <details class="pf-commit" hidden><summary><h4>Changes <span class="pf-commit-n"></span></h4></summary>
          <div class="pf-commit-list"></div>
          <label>Message <input type="text" class="pf-commit-msg" placeholder="What changed" aria-label="Commit message"></label>
          <label>Branch <span class="pf-branchrow"><select class="pf-commit-branches" aria-label="Branch: pick one, or create a new one"></select><input type="text" class="pf-commit-branch" placeholder="new-branch-name" autocomplete="off" aria-label="New branch name" hidden></span></label>
          <div class="pf-row"><button type="button" class="pf-commit-go primary">Commit</button></div>
          <div class="pf-note pf-commit-note" aria-live="polite"></div></details>
        <div class="pf-row"><button class="pf-open">Open PNG…</button><button class="pf-new">New</button></div>
        <input type="file" class="pf-file" accept="image/png,image/*" multiple hidden></aside>
      <section class="pf-main">
        <div class="pf-bar">
          <span class="pf-grp"><button class="pf-undo" title="Undo (Ctrl+Z)">${icon('undo')}<span>Undo</span></button><button class="pf-redo" title="Redo (Ctrl+Y)">${icon('redo')}<span>Redo</span></button></span>
          <span class="pf-grp"><button class="pf-zout" title="Zoom out (-)">−</button><span class="pf-zl" title="Zoom">1×</span><button class="pf-zin" title="Zoom in (+)">+</button><button class="pf-fit" title="Fit to window (0)">Fit</button></span>
          <span class="pf-grp pf-grp-fs"><button class="pf-fs-go" title="Fullscreen: canvas and tools only, menus slide in from the sides">${icon('fullscreen')}<span>Fullscreen</span></button></span>
          <span class="pf-grp pf-grp-view"><button class="pf-grid on" title="Pixel grid (#)">${icon('grid')}<span>Grid</span></button><button class="pf-tgrid" title="Tile grid: a stronger line every 8, 16, 32 or 64 pixels (the ▾ picks the size)">${icon('tilegrid')}<span>Tiles</span></button><button class="pf-grid-more" title="Tile grid size" aria-haspopup="menu" aria-label="Tile grid size">▾</button><button class="pf-tile" title="Tile preview: see the sprite repeated, and draw across the edges (T)">${icon('tile')}<span>Tile</span></button><button class="pf-bg" title="Background behind transparent pixels (K cycles)" aria-haspopup="menu"><span class="pf-bg-sw"></span><span>Background</span></button><button class="pf-context" title="Context: the sprite at game scale on the project background, next to others from its folder, live as you draw (V)">${icon('context')}<span>Context</span></button><button class="pf-changes" title="Changes: dim what you have not touched and outline the pixels that differ from the original (C). Hold \\ to see the original.">${icon('changes')}<span>Changes</span></button><button class="pf-lint" title="Pixel check: marks stray pixels, doubled corners in lines and near-duplicate colours (P)">${icon('lint')}<span>Check</span></button><button class="pf-vision" title="Vision check: values (greyscale) and colour-blind simulations (Y)">${icon('vision')}<span>Vision</span></button><button class="pf-onion" title="Onion skin: show the previous animation frame faintly under the current one (N)">${icon('onion')}<span>Onion</span></button></span>
          <span class="pf-grp pf-grp-end"><button class="pf-feedback" title="Send feedback or report a bug, with a screenshot of the editor, as a GitHub issue">${icon('feedback')}<span>Feedback</span></button><button class="pf-help" title="Keyboard shortcuts (?)">?</button><button class="pf-save primary" title="Save (Ctrl+S)">Save</button><button class="pf-download" title="Download this sprite as a PNG (scaled up if you like), or every changed sprite as a .zip" aria-haspopup="menu">${icon('download')}<span>Download</span></button><button class="pf-prbtn" title="Open a GitHub pull request with the changed sprites">Propose PR</button></span>
        </div>
        <div class="pf-opts">
          <span class="pf-opt" data-for="pen erase shade line rect ellipse"><span class="pf-ol">size</span><input type="range" class="pf-size" min="1" max="16" value="1" aria-label="Brush size"><b class="pf-sizev">1</b>
            <span class="pf-seg pf-shape"><button data-shape="square" class="on" title="Square tip">${icon('sq')}</button><button data-shape="round" title="Round tip">${icon('circ')}</button></span></span>
          <span class="pf-opt" data-for="pen fill rect rectf ellipse ellipsef line"><span class="pf-ol">pattern</span><span class="pf-seg pf-pattern"><button data-pattern="solid" class="on" title="Solid">solid</button><button data-pattern="dither" title="Checkerboard dither: the primary colour on every other pixel (fills put the secondary colour in between)">dither</button></span></span>
          <span class="pf-opt" data-for="gradient"><span class="pf-note">drag from the primary colour to the secondary · fills the selection, or the area you start in</span></span>
          <span class="pf-opt" data-for="fill gradient wand"><span class="pf-ol">fill</span><span class="pf-seg pf-fillmode"><button data-fill="area" class="on" title="Only the connected area">area</button><button data-fill="same" title="Every pixel of that colour in the image">same colour</button></span></span>
          <span class="pf-opt" data-for="rect rectf ellipse ellipsef"><span class="pf-seg pf-filled"><button data-filled="0" class="on" title="Outline (R / O)">outline</button><button data-filled="1" title="Filled (F / U)">filled</button></span><span class="pf-note">Shift: square / circle</span></span>
          <span class="pf-opt" data-for="line"><span class="pf-note">Shift snaps to 45°</span></span>
          <span class="pf-opt" data-for="pen"><button class="pf-pp" title="Pixel-perfect pencil: removes the corner doubles that make 1-pixel lines lumpy. Best for single lines; leave it off to fill areas by dragging.">clean lines</button><span class="pf-note">Shift+click: line from the last point</span></span>
          <span class="pf-opt" data-for="shade"><span class="pf-note">click lightens · right click darkens · steps through the palette when one is loaded</span></span>
          <span class="pf-opt" data-for="select lasso wand"><span class="pf-seg pf-selmode"><button data-t="select" title="Rectangle (S)">rect</button><button data-t="lasso" title="Lasso: draw round what you want (Q)">lasso</button><button data-t="wand" title="Magic wand: click a colour (W)">wand</button></span></span>
          <span class="pf-opt" data-for="select lasso wand"><button class="pf-sel-copy" title="Copy (Ctrl+C)">copy</button><button class="pf-sel-cut" title="Cut (Ctrl+X)">cut</button><button class="pf-sel-paste" title="Paste (Ctrl+V; images from other apps too)">paste</button><button class="pf-sel-del" title="Delete (Del)">delete</button><button class="pf-sel-all" title="Select all (Ctrl+A)">all</button><button class="pf-sel-crop" title="Crop the canvas to the selection">crop</button><button class="pf-sel-none" title="Drop the selection (Esc)">deselect</button><span class="pf-note">Shift adds · Alt subtracts · drag inside to move · arrows nudge</span></span>
          <span class="pf-opt pf-opt-end" data-for="*"><button class="pf-mx" title="Mirror left-right (M)">${icon('mx')}<span>mirror X</span></button><button class="pf-my" title="Mirror up-down">${icon('my')}<span>mirror Y</span></button></span>
        </div>
        <div class="pf-work">
          <nav class="pf-rail" aria-label="Tools"><span class="pf-tools"></span>
            <span class="pf-swatch" title="Primary (left click) and secondary (right click) colours. X swaps them."><button class="pf-prim" aria-label="Primary colour"></button><button class="pf-sec" aria-label="Secondary colour"></button><button class="pf-swap" title="Swap colours (X)">⇄</button></span></nav>
          <div class="pf-stage"><canvas class="pf-view" aria-label="Sprite canvas"></canvas><span class="pf-vision-tag" hidden></span><span class="pf-lint-tag" hidden></span></div>
        </div>
        <div class="pf-ctx" hidden><div class="pf-ctx-bar"><span class="pf-ol">in context</span><select class="pf-ctx-group" title="What to compare against: a group from the project's config, or the sprites in the same folder"></select><span class="pf-seg pf-ctx-scale">${[1, 2, 3, 4].map((n) => `<button data-scale="${n}"${n === 2 ? ' class="on"' : ''}>${n}×</button>`).join('')}</span><span class="pf-note pf-ctx-note"></span></div><canvas class="pf-ctx-cv" aria-label="The sprite in context"></canvas></div>
        <div class="pf-fsbar" aria-label="Fullscreen controls"><button class="pf-fs-undo" title="Undo">${icon('undo')}</button><button class="pf-fs-redo" title="Redo">${icon('redo')}</button><button class="pf-fs-fit" title="Fit to screen">Fit</button><button class="pf-fs-exit" title="Leave fullscreen">${icon('exitfull')}</button></div>
        <div class="pf-status"><span class="pf-s-name"></span><span class="pf-s-pos"></span><span class="pf-s-sel"></span><span class="pf-s-note"></span><span class="pf-s-info"></span></div>
      </section>
      <aside class="pf-right">
        <div class="pf-panel pf-layers"><h4>Layers <span class="pf-notes-n pf-ly-n"></span></h4><div class="pf-ly-list" role="listbox" aria-label="Layers, top first"></div>
          <div class="pf-row"><button class="pf-ly-add" title="A new empty layer above this one">+ layer</button><button class="pf-ly-dup" title="A copy of this layer, above it">Copy</button><button class="pf-ly-up" title="Move this layer up">▲</button><button class="pf-ly-down" title="Move this layer down">▼</button><button class="pf-ly-merge" title="Merge this layer into the one below">Merge ↓</button><button class="pf-ly-del" title="Delete this layer">✕</button></div>
          <div class="pf-row pf-ly-oprow" hidden><label>opacity <input type="range" class="pf-ly-op" min="0" max="100" value="100" aria-label="Layer opacity"></label><span class="pf-note pf-ly-opv"></span></div>
          <div class="pf-row pf-ly-linkrow" hidden><span class="pf-note">linked · here at <b class="pf-ly-linkat"></b></span><span class="pf-ly-nudge"><button type="button" data-nudge="-1,0" title="Move this frame's copy left (the other frames stay)">◀</button><button type="button" data-nudge="0,-1" title="Move this frame's copy up">▲</button><button type="button" data-nudge="0,1" title="Move this frame's copy down">▼</button><button type="button" data-nudge="1,0" title="Move this frame's copy right">▶</button></span></div>
          <div class="pf-note pf-ly-tip">Saved flat, with the layers in <code class="pf-ly-file"></code>.</div></div>
        <div class="pf-panel"><h4>Palette</h4><div class="pf-pal-wrap"><div class="pf-sw pf-pal-colors"></div><div class="pf-note pf-pal-empty">No palette yet: load one, or add colours.</div></div>
          <div class="pf-sub">In this image<span class="pf-ccount"></span></div><div class="pf-sw pf-img-colors"></div><div class="pf-note pf-off"></div>
          <div class="pf-row"><button class="pf-pal-lock" title="Indexed: every colour you pick snaps to the palette, and double-clicking a palette colour changes it everywhere it is used in this image">Indexed</button><button class="pf-pal-add" title="Add the primary colour to the palette">+ colour</button><input type="color" class="pf-slot-in" aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none"><button class="pf-snap" title="Move every pixel to its nearest palette colour">Snap</button></div>
          <div class="pf-row pf-quiet"><button class="pf-palload" title="Load a palette file (.hex, one colour per line)">Load…</button><button class="pf-lospec-btn" title="Load a palette from lospec.com by its name, e.g. endesga-32">Lospec…</button><button class="pf-palsave" title="Download this palette as a .hex file">Save .hex</button><input type="file" class="pf-palfile" accept=".hex,.txt,text/plain" hidden></div>
          <form class="pf-row pf-lospec" hidden><input type="text" class="pf-lospec-name" placeholder="endesga-32, or a lospec.com link" aria-label="Lospec palette name" autocomplete="off" style="flex:1;min-width:0"><button type="submit" class="primary">Load</button></form></div>
        <div class="pf-panel pf-prev"><h4>Animation</h4>
          <div class="pf-fam" hidden><div class="pf-fam-h"><b class="pf-fam-name"></b><span class="pf-note pf-fam-kind"></span><span class="pf-fam-tools"><button type="button" class="pf-fam-left" title="Move this frame earlier (swaps it with the one before)">◀</button><button type="button" class="pf-fam-right" title="Move this frame later">▶</button><button type="button" class="pf-fam-add" title="New frame: a copy of this one, numbered after the last">+ frame</button><button type="button" class="pf-fam-port" title="Apply this edit to the other frames: what stays still in them gets it, parts that moved are left for you to redraw">apply edit…</button></span></div><div class="pf-fam-strip" role="listbox" aria-label="Frames and poses"></div><div class="pf-note pf-fam-hint"><kbd>,</kbd> <kbd>.</kbd> previous / next</div></div>
          <div class="pf-fam pf-sheet" hidden><div class="pf-fam-h"><b>sheet</b><span class="pf-note pf-sheet-kind"></span><span class="pf-fam-tools"><button type="button" class="pf-sh-left" title="Move this frame earlier">◀</button><button type="button" class="pf-sh-right" title="Move this frame later">▶</button><button type="button" class="pf-sh-add" title="New frame: a copy of this one, right after it">+ frame</button><button type="button" class="pf-sh-del" title="Delete this frame">✕</button><button type="button" class="pf-sh-port" title="Apply this edit to the other frames: what stays still in them gets it, parts that moved are left for you to redraw">apply edit…</button></span></div><div class="pf-fam-strip pf-sheet-strip" role="listbox" aria-label="Frames of the sheet"></div><div class="pf-note">the ×n badge: how long a frame holds</div></div>
          <canvas class="pf-p2"></canvas>
          <canvas class="pf-p1" title="The whole sheet"></canvas>
          <div class="pf-row pf-anim-row"><label class="pf-sheet-row" title="Frame size: smaller than the image makes it a sprite sheet">frame <input type="number" class="pf-fw" min="1" value="16">×<input type="number" class="pf-fh" min="1" value="16"></label><label class="pf-fps-l">fps <input type="number" class="pf-fps" min="1" max="60" value="8"></label><button class="pf-play">Play</button></div>
          <div class="pf-row"><button class="pf-gif" title="Download the animation (or this image) as a looping GIF, to share in chat or a pull request">GIF…</button><button class="pf-sheet-out" title="Download the animation as one sprite sheet PNG with a JSON of its frames and timings (Aseprite json-array format, read by most engines)">Sheet + JSON</button></div></div>
        <div class="pf-panel pf-imgpanel"><h4>Image</h4><div class="pf-imgtools">${IMAGE_TOOLS.map(([cls, ic, name, tip, extra]) => `<button class="${cls}" aria-label="${name}" data-tip="${esc(name + ': ' + tip)}" title="${esc(name)}"${extra || ''}>${icon(ic)}</button>`).join('')}</div>
          <div class="pf-note pf-imgtip" aria-live="polite">Point at a button to see what it does</div></div>
        <div class="pf-panel pf-notes"><h4>Notes <span class="pf-notes-n"></span></h4><div class="pf-note-list"></div>
          <div class="pf-row"><button class="pf-note-add" title="Pin a note to a pixel: click here, then on the canvas">+ note</button></div>
          <div class="pf-note pf-notes-tip">Pinned to a pixel; they go in your next pull request.</div></div>
        <div class="pf-panel pf-refpanel"><h4>Reference</h4>
          <div class="pf-row"><button class="pf-ref-load" title="Any image: concept art, a photo, a screenshot of the game">Image…</button><select class="pf-ref-sprite" aria-label="Or a sprite from this project"><option value="">or a sprite…</option></select><input type="file" class="pf-ref-file" accept="image/*" hidden></div>
          <div class="pf-ref-on" hidden><div class="pf-note pf-ref-name"></div>
            <div class="pf-row"><label>opacity <input type="range" class="pf-ref-op" min="5" max="100" value="40"></label></div>
            <div class="pf-row"><span class="pf-seg pf-ref-place"><button data-place="under" class="on" title="Behind your pixels">under</button><button data-place="over" title="On top of your pixels">over</button></span><span class="pf-seg pf-ref-fit"><button data-fit="pixels" class="on" title="One image pixel per sprite pixel, from the top-left">1:1</button><button data-fit="fit" title="Scaled to fit the canvas">fit</button></span></div>
            <div class="pf-row"><button class="pf-ref-toggle" title="Show or hide the reference (H)">hide</button><button class="pf-ref-clear">remove</button></div></div></div>
        <details class="pf-panel pf-hist" hidden><summary><h4>History</h4></summary><div class="pf-hist-list"></div><div class="pf-row pf-hist-act" hidden><button class="primary pf-hist-restore">Restore this version</button><span class="pf-note pf-hist-sel"></span></div></details>
      </aside>
      <div class="pf-cpop" role="dialog" aria-label="Colour" hidden><div class="pf-cur"><input type="color" class="pf-cpick" aria-label="Current colour"><input type="text" class="pf-chex" maxlength="9" aria-label="Hex colour"></div>
          <div class="pf-row"><button class="pf-ramp-btn" title="A 5-colour ramp around this colour: cool, darker shadows and warm highlights">Hue ramp</button><button class="pf-recolor" title="Change this colour everywhere in the image">Recolour…</button><input type="color" class="pf-recolor-in" aria-hidden="true" tabindex="-1" style="position:absolute;opacity:0;width:1px;height:1px;pointer-events:none"></div>
          <div class="pf-ramp" hidden><div class="pf-sw pf-ramp-colors"></div><button class="pf-ramp-add" title="Add these colours to the palette">+ add to palette</button></div>
        <div class="pf-note pf-cpop-tip">Right click paints the secondary colour · X swaps them · Z pencil / eraser · A picks · Tab palette at cursor · Alt+click picks from the canvas</div></div>
      <div class="pf-qpal" role="dialog" aria-label="Quick palette" hidden><div class="pf-sub">Palette</div><div class="pf-sw pf-qpal-colors"></div><div class="pf-sub">In this image</div><div class="pf-sw pf-qpal-img"></div><div class="pf-note">click: paint colour · Shift+click / right click: secondary · Tab / Esc closes</div></div>
      <div class="pf-fs-scrim"></div><button class="pf-fs-h pf-fs-hl" aria-label="Sprites" aria-expanded="false">›</button><button class="pf-fs-h pf-fs-hr" aria-label="Colours, options and actions" aria-expanded="false">‹</button>
      <dialog class="pf-dlg-pr"><form method="dialog" class="pf-form"><h4>Propose changes as a pull request</h4><div class="pf-chg-list"></div>
        <label>Repository <input type="text" class="pf-pr-repo" list="pf-repos" placeholder="owner/name"></label>
        <label>Base branch <input type="text" class="pf-pr-base" placeholder="default branch"></label>
        <label>Title <input type="text" class="pf-pr-title" placeholder="Update player sprite"></label>
        <label>Description <textarea class="pf-pr-desc" rows="3" style="width:100%" placeholder="What changed and why"></textarea></label>
        <div class="pf-row pf-auth-row"><button type="button" class="primary pf-signin">Sign in with GitHub</button><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button></div><div class="pf-note pf-auth-help"></div>
        <details class="pf-tokenbox"><summary>Use a token instead</summary>
          <label>GitHub token <input type="password" class="pf-pr-token" autocomplete="off" placeholder="fine-grained token with Contents + Pull requests write"></label>
          <label><input type="checkbox" class="pf-pr-remember"> remember the token in this browser</label>
          <div class="pf-note">The token is only sent to GitHub. Without write access to the repository your fork is used automatically.</div></details>
        <div class="pf-log" aria-live="polite"></div>
        <div class="pf-row"><button type="button" class="primary pf-pr-go">Create pull request</button><button value="cancel">Close</button></div></form></dialog>
      <dialog class="pf-dlg-connect"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>Open a project</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <section class="pf-c-sec pf-gh-box">
          <div class="pf-c-sechead"><span class="pf-c-title">GitHub repository</span>
            <span class="pf-row pf-auth-row"><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button><button type="button" class="primary pf-signin">Sign in with GitHub</button></span></div>
          <div class="pf-note pf-auth-help"></div>
          <div class="pf-c-mine" hidden><div class="pf-c-repolist"></div><div class="pf-note pf-c-addrepo"></div></div>
          <div class="pf-c-other"><input type="text" class="pf-c-repo" list="pf-repos" placeholder="owner/name" autocomplete="off" aria-label="Repository (owner/name)"><datalist id="pf-repos"></datalist><input type="text" class="pf-c-branch" list="pf-c-branchlist" placeholder="branch" autocomplete="off" aria-label="Branch: pick one, or type a new name"><datalist id="pf-c-branchlist"></datalist><button type="button" class="pf-c-gh">Open</button></div>
          <details class="pf-tokenbox"><summary>Use a token instead</summary>
            <label>Token <input type="password" class="pf-c-token" autocomplete="off" placeholder="optional for public repos; needed for private repos and pull requests"></label>
            <label><input type="checkbox" class="pf-c-remember"> remember the token in this browser</label></details>
        </section>
        <div class="pf-c-grid">
          <section class="pf-c-tile pf-c-folderbox"><span class="pf-c-title">Folder on this computer</span><span class="pf-note pf-c-foldernote"></span><button type="button" class="pf-c-folder">Choose folder…</button></section>
          <section class="pf-c-tile pf-c-local"><span class="pf-c-title">Just draw, in this browser</span><span class="pf-note">Nothing to link or sign in to. Kept in this browser, even after a reload; Download when done.</span><span class="pf-row"><button type="button" class="pf-c-blank" title="A new empty project that lives only in this browser">New blank project</button><button type="button" class="pf-c-upload" title="Start a project in this browser from PNG files">Upload PNG…</button></span><div class="pf-c-locals" hidden></div></section>
        </div>
        <div class="pf-log pf-c-msg" aria-live="polite"></div>
        <div class="pf-note pf-c-foot">Tip: drop PNG files onto the canvas at any time.</div></form></dialog>
      <dialog class="pf-dlg-rot"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>Rotate</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <div class="pf-row"><input type="range" class="pf-rot-a" min="-180" max="180" step="1" value="15" aria-label="Angle" style="flex:1;width:auto"><input type="number" class="pf-rot-n" min="-180" max="180" value="15" aria-label="Angle in degrees"><span class="pf-note">°</span></div>
        <span class="pf-seg pf-rot-quick">${[-45, -30, -15, 15, 30, 45].map((a) => `<button type="button" data-a="${a}">${a > 0 ? '+' : ''}${a}°</button>`).join('')}</span>
        <canvas class="pf-rot-prev" style="image-rendering:pixelated;background:var(--pf-ckbg);align-self:center;max-width:100%"></canvas>
        <div class="pf-note pf-rot-what"></div>
        <div class="pf-row"><button type="button" class="primary pf-rot-go">Rotate</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-size"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>Canvas size</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <span class="pf-seg pf-sz-mode"><button type="button" data-mode="canvas" class="on" title="Add or cut away space around the image; the pixels stay the same size">resize canvas</button><button type="button" data-mode="scale" title="Stretch or shrink the image itself (nearest neighbour: pixels repeat or drop, never blur)">scale image</button></span>
        <div class="pf-sz-body"><div class="pf-sz-fields">
          <div class="pf-row"><label>width <input type="number" class="pf-sz-w" min="1" max="1024"></label><label>height <input type="number" class="pf-sz-h" min="1" max="1024"></label></div>
          <div class="pf-row pf-sz-quick"><button type="button" data-q="half" title="Half the size">½</button><button type="button" data-q="double" title="Twice the size">×2</button><button type="button" data-q="pow2" title="Round up to a power of two (16, 32, 64…)">2ⁿ</button><button type="button" data-q="square" title="Make it square (the bigger side)">square</button><label class="pf-note pf-sz-lockrow"><input type="checkbox" class="pf-sz-lock" checked> keep proportions</label></div>
          <div class="pf-sz-anchorrow"><span class="pf-ol">anchor</span><div class="pf-sz-anchor" role="radiogroup" aria-label="Where the image stays">${['tl', 't', 'tr', 'l', 'c', 'r', 'bl', 'b', 'br'].map((a) => `<button type="button" data-a="${a}" role="radio" title="Keep the ${{ tl: 'top-left corner', t: 'top edge', tr: 'top-right corner', l: 'left edge', c: 'centre', r: 'right edge', bl: 'bottom-left corner', b: 'bottom edge', br: 'bottom-right corner' }[a]} in place"></button>`).join('')}</div></div>
          <label class="pf-note pf-sz-famrow" hidden><input type="checkbox" class="pf-sz-fam" checked> <span class="pf-sz-famtext"></span></label></div>
          <div class="pf-sz-prev"><canvas class="pf-sz-cv"></canvas><div class="pf-note pf-sz-info"></div></div></div>
        <div class="pf-row"><button type="button" class="primary pf-sz-ok">Apply</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-variant"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>New variant</h4><button value="cancel" class="pf-x" aria-label="Close">✕</button></div>
        <div class="pf-note pf-v-what"></div>
        <label>name <input type="text" class="pf-v-suffix" value="variant" maxlength="32" aria-label="Variant name"></label>
        <div class="pf-note pf-v-names"></div>
        <span class="pf-seg pf-v-mode"><button type="button" data-mode="shift" class="on">shift colours</button><button type="button" data-mode="swap">swap colours</button></span>
        <div class="pf-v-shift"><label>hue <input type="range" class="pf-v-h" min="-180" max="180" value="0"><b class="pf-v-hv">0°</b></label><label>saturation <input type="range" class="pf-v-s" min="-100" max="100" value="0"><b class="pf-v-sv">0</b></label><label>brightness <input type="range" class="pf-v-l" min="-100" max="100" value="0"><b class="pf-v-lv">0</b></label><label><input type="checkbox" class="pf-v-keep" checked> keep outlines (near-black) as they are</label></div>
        <div class="pf-v-swap" hidden><div class="pf-v-cols"></div></div>
        <div class="pf-v-preview"></div>
        <div class="pf-row"><button type="button" class="primary pf-v-go">Create</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-feedback"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>Send feedback</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <span class="pf-seg pf-fb-kind" role="group" aria-label="What kind of feedback">${Object.entries(FEEDBACK_KINDS).map(([k, n], i) => `<button type="button" data-kind="${k}"${i ? '' : ' class="on"'}>${n === 'Feedback' ? 'other' : n.toLowerCase()}</button>`).join('')}</span>
        <div class="pf-fb-shot"><span class="pf-note">Taking a screenshot…</span></div>
        <textarea class="pf-fb-text" rows="5" maxlength="4000" aria-label="Your feedback"></textarea>
        <details class="pf-fb-more"><summary class="pf-note">Details that will be attached</summary><table class="pf-fb-facts"></table></details>
        <div class="pf-row pf-auth-row"><button type="button" class="primary pf-signin">Sign in with GitHub</button><span class="pf-who pf-note"></span><button type="button" class="pf-signout" hidden>Sign out</button></div>
        <div class="pf-row"><button type="button" class="primary pf-fb-send" disabled>Send feedback</button></div>
        <div class="pf-row pf-fb-link"><a class="pf-btn primary pf-fb-go" target="_blank" rel="noopener">Open on GitHub</a><button type="button" class="pf-fb-copy" disabled>Copy screenshot</button><button type="button" class="pf-fb-save" disabled>Save screenshot</button></div>
        <div class="pf-note pf-fb-note" aria-live="polite"></div></form></dialog>
      <dialog class="pf-dlg-folders"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4 class="pf-af-title">Which folders hold your art?</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <div class="pf-note pf-af-intro">Only these show up in the list. Docs, screenshots and test folders start unticked.</div>
        <div class="pf-af-list"></div>
        <div class="pf-note pf-af-save"></div>
        <div class="pf-row"><button type="button" class="primary pf-af-go">Use these folders</button><button type="button" class="pf-af-all">Show everything</button></div></form></dialog>
      <dialog class="pf-dlg-port"><form method="dialog" class="pf-form">
        <div class="pf-dlg-head"><h4>Apply this edit to the other frames</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <div class="pf-note pf-port-what"></div>
        <label class="pf-note pf-port-allrow" hidden><input type="checkbox" class="pf-port-all"> every change since the original, not only those since the last apply</label>
        <div class="pf-port-list"></div>
        <div class="pf-note">Recolours reach every frame. Other changes go where the frame still looks like it did before the edit, following it if it bobs a few pixels; parts in another pose (legs in a walk) are left as they are and outlined in <b class="pf-port-key">orange</b>, to redraw with Onion skin (N).</div>
        <div class="pf-row"><button type="button" class="primary pf-port-go">Apply</button><button value="cancel">Cancel</button></div></form></dialog>
      <dialog class="pf-dlg-keys"><form method="dialog" class="pf-form"><h4>Keyboard shortcuts</h4><div class="pf-keys"></div><div class="pf-row"><button value="cancel" class="primary">Close</button></div></form></dialog>
      <dialog class="pf-dlg-new"><form method="dialog" class="pf-form"><div class="pf-dlg-head"><h4>New sprite</h4><button value="cancel" class="pf-x" aria-label="Close" title="Close (Esc)">✕</button></div>
        <div class="pf-n-line"><span class="pf-seg pf-n-quick" role="group" aria-label="Common sizes"></span><span class="pf-n-or">or</span><input type="number" class="pf-nw" min="1" max="1024" value="16" aria-label="Width" title="Width"><span class="pf-n-or">×</span><input type="number" class="pf-nh" min="1" max="1024" value="16" aria-label="Height" title="Height"></div>
        <div class="pf-n-line"><input type="text" class="pf-nn" value="new-sprite.png" placeholder="art/hero.png" aria-label="File name (a path inside the project)" title="File name: a path inside the project, e.g. art/hero.png"><button type="button" class="primary pf-new-ok">Create</button></div></form></dialog>
    </div>`);
    $$dialogs(root);
    if (O.accent) root.style.setProperty('--pf-accent', O.accent);
    host.innerHTML = ''; host.appendChild(root);
    const $ = (s) => root.querySelector(s), $$ = (s) => [...root.querySelectorAll(s)];
    // accountEl: put "Signed in as … / Sign out" in the host page (e.g. its header) instead of the sidebar
    const account = root.querySelector('.pf-side-auth'), accountEl = typeof O.accountEl === 'string' ? document.querySelector(O.accountEl) : O.accountEl;
    if (accountEl) { account.classList.replace('pf-side-auth', 'pf-acct'); accountEl.appendChild(account); }
    const authRows = (sel) => [...$$('.pf-auth-row'), ...(accountEl ? [account] : [])].map((r) => (sel ? r.querySelector(sel) : r));

    /* ---------- state ---------- */
    const S = { sprites: [], docs: new Map(), cur: null, tool: 'pen', color: pack(185, 140, 255), mx: false, my: false, pp: false, grid: true, zoom: 8, ox: 0, oy: 0,
      color2: 0, ref: null, vision: 'normal', ctx: false, ctxScale: 2, changes: false, peek: false, bg: 'auto', bgCustom: '#3a5a40', size: 1, shape: 'square', pattern: 'solid', fillMode: 'area', tile: false, onion: false, sel: null, float: null, clip: null, hover: null, lastPt: null,
      groups: [], ctxGroup: null, alpha: null, palette: O.palette ? O.palette.map((c) => (typeof c === 'string' ? fromHex(c) : c)).filter((c) => c != null) : [], src: null, meta: {}, auth: { token: '', login: '' }, anim: { timer: 0, t: 0 }, notice: '' };
    const doc = () => S.docs.get(S.cur);
    const view = $('.pf-view'), stage = $('.pf-stage'), g = view.getContext('2d');
    const offscreen = document.createElement('canvas'), diffCanvas = document.createElement('canvas');
    let overlay = null; // preview pixels while dragging a shape: { pts, value }
    const note = (t) => { S.notice = t; status(); };
    /** Opening a project: the sprite list becomes a pixel spinner with the current step, until useSource lists the new sprites. */
    const loaderHtml = () => `<div class="pf-loading" role="status" aria-live="polite"><span class="pf-spin" aria-hidden="true">${'<i></i>'.repeat(8)}</span><b>${esc(S.loading.label)}</b><span class="pf-loading-step">${esc(S.loading.step)}</span></div>`;
    let loadSeq = 0;
    function showLoading(label) { S.loading = { label, step: 'Connecting…' }; $('.pf-list').innerHTML = loaderHtml(); renderSetup(); }
    function loadingStep(t) { if (!S.loading) return; S.loading.step = t; const el = $('.pf-loading-step'); if (el) el.textContent = t; else $('.pf-list').innerHTML = loaderHtml(); }
    function hideLoading() { if (!S.loading) return; S.loading = null; renderList(); }

    /* ---------- sign in ----------
       One sign-in per device: the session (access token + refresh token) is kept in localStorage and the access token is renewed
       through the auth service when it is about to expire, so people do not see the GitHub popup again until they sign out. */
    const authBase = O.authBase || (typeof window !== 'undefined' && window.PF_AUTH_BASE) || '';
    const AUTH_KEY = 'pf:gh', emptyAuth = () => ({ token: '', exp: 0, refresh: '', rexp: 0, login: '' });
    const loadAuth = () => { try { const a = JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); if (a && a.token && (!a.rexp || a.rexp > Date.now() || (a.exp && a.exp > Date.now()))) return { ...emptyAuth(), ...a }; } catch { /* storage blocked */ } return emptyAuth(); };
    const saveAuth = () => { try { if (S.auth.token) localStorage.setItem(AUTH_KEY, JSON.stringify(S.auth)); else localStorage.removeItem(AUTH_KEY); } catch { /* storage blocked */ } };
    const fromGrant = (r, login) => ({ token: r.token, exp: r.expiresIn ? Date.now() + r.expiresIn * 1000 : 0, refresh: r.refreshToken || '', rexp: r.refreshExpiresIn ? Date.now() + r.refreshExpiresIn * 1000 : 0, login: login || '' });
    S.auth = authBase ? loadAuth() : emptyAuth();
    let renewing = null;
    /** A usable access token for the signed-in user ('' when signed out), renewed first when it expires within two minutes. */
    function authToken() {
      const a = S.auth; if (!a.token) return Promise.resolve('');
      if (!a.exp || a.exp - Date.now() > 120000 || !a.refresh || !authBase) return Promise.resolve(a.token);
      if (renewing) return renewing;
      const run = async () => {
        const cur = loadAuth(); // another tab may have renewed it already (refresh tokens are single use)
        if (cur.token && cur.token !== a.token && (!cur.exp || cur.exp - Date.now() > 120000)) { S.auth = cur; return cur.token; }
        try { S.auth = fromGrant(await githubRefresh(authBase, cur.refresh || a.refresh), a.login); saveAuth(); return S.auth.token; }
        catch (e) { if (e.status === 401 || e.status === 400) { signOut(); throw new Error('Your GitHub sign-in has expired. Sign in again.'); } throw e; }
      };
      renewing = (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('pf-auth-renew', run) : run()).finally(() => { renewing = null; });
      return renewing;
    }
    function renderAuth() {
      const on = !!S.auth.token;
      authRows().forEach((r) => { r.hidden = !on && !authBase; r.querySelector('.pf-signin').hidden = on || !authBase; r.querySelector('.pf-signout').hidden = !on; r.querySelector('.pf-who').textContent = on ? 'Signed in as ' + (S.auth.login || 'GitHub user') : ''; });
      $$('.pf-auth-help').forEach((h) => { h.innerHTML = authBase ? (on ? '' : 'Sign in to list your repositories. Edits go back as a pull request.') : `Sign-in is not set up on this page. Paste a token instead: <a href="${PAT_URL}" target="_blank" rel="noopener" style="color:var(--pf-accent)">create one with the right permissions</a> (Contents and Pull requests: read and write, only for your repository).`; });
      $$('.pf-tokenbox').forEach((d) => { d.open = !authBase; d.hidden = on; });
      $('.pf-c-mine').hidden = !on; $('.pf-dlg-connect .pf-form').classList.toggle('pf-signed-in', on);
      fbSync();
      if (!on) { S.repos = null; $('#pf-repos').innerHTML = ''; }
    }
    const installUrl = () => (O.githubApp ? `https://github.com/apps/${encodeURIComponent(O.githubApp)}/installations/select_target` : '');
    const NEW_REPO_URL = 'https://github.com/new?name=pixel-art&description=Sprites+edited+with+spritewright';
    function renderRepos() {
      const list = $('.pf-c-repolist'), add = $('.pf-c-addrepo'), repos = S.repos || [], link = installUrl();
      // First visit: nothing installed yet. Say what to do next, not just that the list is empty.
      const start = link ? `<div class="pf-c-start"><b>Choose which repositories spritewright may open.</b><span class="pf-note">GitHub asks you to pick them once (all of them, or just your game). Only those can be opened here, and private ones stay private. Come back to this tab when done: the list fills in by itself.</span><a class="pf-c-install" href="${esc(link)}" target="_blank" rel="noopener">Pick repositories on GitHub</a><span class="pf-note">No repository for your art yet? <a href="${NEW_REPO_URL}" target="_blank" rel="noopener" style="color:var(--pf-accent)">Create one on GitHub</a>, then pick it.</span></div>` : '<div class="pf-note">No repositories yet.</div>';
      list.innerHTML = S.repos == null ? '<div class="pf-note">Loading your repositories…</div>' : repos.length
        ? repos.map((r) => `<button type="button" class="pf-c-pick${S.src && S.src.kind === 'github' && S.src.repo.slug === r.name ? ' on' : ''}" data-repo="${esc(r.name)}" data-branch="${esc(r.branch || '')}"><b>${esc(r.name)}</b><span class="pf-note">${S.src && S.src.kind === 'github' && S.src.repo.slug === r.name ? 'open now · ' : ''}${r.private ? 'private · ' : ''}${r.push ? 'pull requests' : 'read only'}</span></button>`).join('')
        : start;
      $('#pf-repos').innerHTML = repos.map((r) => `<option value="${esc(r.name)}">`).join('');
      add.innerHTML = link && repos.length ? `Missing a repository? <a href="${esc(link)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">Add it on GitHub</a>: the list updates when you come back.` : '';
    }
    /** quiet: refresh in place (coming back from GitHub), without flashing "Loading…" over the list. */
    let reposLoading = false;
    async function loadRepos(quiet) {
      if (!S.auth.token || (quiet && reposLoading)) return; reposLoading = true; if (!quiet) { S.repos = null; renderRepos(); }
      try { S.repos = await listRepos(await authToken(), { apiBase: O.apiBase, details: true }); } catch { if (!quiet) S.repos = []; }
      reposLoading = false; renderRepos();
    }
    // Back from github.com (picking repositories for the app happens in another tab): show what was just added.
    const reposOnReturn = () => { if (S.auth.token && $('.pf-dlg-connect').open) loadRepos(true); };
    window.addEventListener('focus', reposOnReturn);
    async function doSignIn(msgEl) {
      const say = (t) => (msgEl ? (msgEl.textContent = t) : note(t));
      try {
        say('Waiting for GitHub…');
        const r = await githubSignIn(authBase);
        let login = ''; try { login = (await githubUser(r.token, { apiBase: O.apiBase })).login; } catch { /* name is cosmetic */ }
        S.auth = fromGrant(r, login); saveAuth();
        say('Signed in' + (login ? ' as ' + login : '') + '.');
        renderAuth(); await loadRepos();
      } catch (e) { say(e.message); }
    }
    function signOut() { S.auth = emptyAuth(); saveAuth(); try { ['pf:authtoken', 'pf:authuser'].forEach((k) => sessionStorage.removeItem(k)); } catch { /* ignore */ } renderAuth(); }

    /* ---------- loading ---------- */
    const storedToken = () => { try { return sessionStorage.getItem('pf:token') || localStorage.getItem('pf:token') || ''; } catch { return ''; } };
    async function fetchJson(u) { const r = await fetch(u); if (!r.ok) throw new Error(u + ': ' + r.status); return r.json(); }
    /** Make `src` the project being edited. Returns false if the user chose to keep their unsaved session. */
    /* ---------- art folders: for a GitHub repository without spritewright.config.json ----------
       Asked once when it opens with PNGs in more than one place. The choice applies at once, is remembered in this browser, and
       goes into the next pull request (or commit) as spritewright.config.json, so everyone opening the repository gets it. */
    const CONFIG_PATH = 'spritewright.config.json';
    const foldersKey = (src) => 'pf:folders:' + src.repo.slug + '@' + src.branch;
    const readFolders = (src) => { try { return JSON.parse(localStorage.getItem(foldersKey(src)) || 'null'); } catch { return null; } };
    const writeFolders = (src, v) => { try { if (v) localStorage.setItem(foldersKey(src), JSON.stringify(v)); else localStorage.removeItem(foldersKey(src)); } catch { /* applies for this visit only */ } };
    /** Narrow the open repository to the picked folders, in place. */
    function applyFolders(src, picked) {
      const cfg = { ...(src.config || {}) }; delete cfg.dirs; delete cfg.exclude; // the pick replaces the folders, keeps everything else
      if (!src.all.length) cfg.dirs = picked.filter(Boolean).map((d) => d.replace(/^\/+|\/+$/g, '')); // nothing to list yet: the folder art will go in
      else Object.assign(cfg, folderConfig(src.all.map((x) => x.path), picked));
      if (cfg.exclude && !cfg.exclude.length && cfg.dirs) delete cfg.exclude;
      if (!cfg.dirs) delete cfg.dirs;
      src.sprites = applyConfig(src.all, cfg); src.hidden = [];
      return cfg;
    }
    /** The config file still to send, if the folders were picked here and have not gone out in a pull request or commit yet. */
    function pendingConfig() {
      const src = S.src; if (!src || src.kind !== 'github') return null;
      const f = readFolders(src); return f && !f.sent && f.cfg ? f : null;
    }
    const configFile = (f) => ({ path: CONFIG_PATH, blob: new TextEncoder().encode(JSON.stringify(f.cfg, null, 2) + '\n') });
    const configNote = (f) => `Also adds \`${CONFIG_PATH}\`, so the editor lists ${f.cfg.dirs ? 'only ' + f.cfg.dirs.map((d) => '`' + d + '/`').join(', ') : 'the whole repository'}${f.cfg.exclude && f.cfg.exclude.length ? ' (leaving out ' + f.cfg.exclude.map((d) => '`' + d + '`').join(', ') + ')' : ''} for everyone who opens it.`;
    function openFolders() {
      const src = S.src; if (!src || src.kind !== 'github' || !src.all) return;
      const folders = artFolders(src.all.map((x) => x.path)), now = new Set(S.sprites.map((x) => x.path.split('/').slice(0, -1).slice(0, 2).join('/')));
      const first = !src.hasConfig && !readFolders(src);
      $('.pf-af-all').hidden = $('.pf-af-intro').hidden = !folders.length;
      $('.pf-af-title').textContent = folders.length ? 'Which folders hold your art?' : 'Where does the art go?'; $('.pf-af-go').textContent = folders.length ? 'Use these folders' : 'Use this folder';
      if (!folders.length) { // a repository with no art yet: say where it will go
        const was = (readFolders(src) || {}).picked || (src.config && src.config.dirs) || [];
        $('.pf-af-list').innerHTML = `<div class="pf-note">No PNG files in this repository yet. Which folder should its art go in? New sprites start there.</div><input type="text" class="pf-af-dir" list="pf-af-dirs" value="${esc(was[0] || 'art')}" aria-label="Art folder" autocomplete="off"><datalist id="pf-af-dirs">${(src.dirs || []).map((d) => `<option value="${esc(d)}">`).join('')}</datalist>`;
      } else $('.pf-af-list').innerHTML = folders.map((f) => `<label><input type="checkbox" value="${esc(f.dir)}"${(first ? f.art : now.has(f.dir)) ? ' checked' : ''}><code>${f.dir ? esc(f.dir) + '/' : '(top level)'}</code><span class="pf-note">${f.count} PNG${f.count === 1 ? '' : 's'}</span></label>`).join('');
      $('.pf-af-save').textContent = src.hasConfig ? `This repository has a ${CONFIG_PATH}: your pick updates its folders in your next pull request.` : `Your pick is saved as ${CONFIG_PATH} in your next pull request, so everyone who opens this repository gets the same list.`;
      $('.pf-dlg-folders').showModal();
    }
    async function pickFolders(picked) {
      const src = S.src; $('.pf-dlg-folders').close(); if (!src || src.kind !== 'github') return;
      const cfg = applyFolders(src, picked); writeFolders(src, { picked, cfg, sent: false });
      S.sprites = spriteList(src); thumbs.clear();
      renderList(); if (!S.sprites.some((x) => x.path === S.cur) && S.sprites.length) await openSprite(S.sprites[0].path);
      note(src.all.length ? `${S.sprites.length} sprite${S.sprites.length === 1 ? '' : 's'} in the folders you picked. ${CONFIG_PATH} goes with your next pull request.` : `New sprites go in ${cfg.dirs[0]}/. ${CONFIG_PATH} goes with your first pull request.`);
      renderSetup();
    }
    $('.pf-af-go').onclick = () => { const dir = $('.pf-af-dir'); pickFolders(dir ? [dir.value.trim()].filter(Boolean) : $$('.pf-af-list input:checked').map((i) => i.value)); };
    $('.pf-af-all').onclick = () => pickFolders(artFolders(S.src.all.map((x) => x.path)).map((f) => f.dir));
    /** On opening a GitHub repository: reapply a pick made earlier in this browser, or say whether to ask. */
    function foldersOnOpen(src) {
      if (src.kind !== 'github' || !src.all) return false;
      const f = readFolders(src); if (f && f.picked) { applyFolders(src, f.picked); return false; }
      return !src.hasConfig && artFolders(src.all.map((x) => x.path)).length > 1;
    }
    async function useSource(src, how = {}) {
      commitFloat(); await flushDrafts(); // this project's edits stay in the browser: they come back when it is opened again

      if (!keeping() && [...S.docs.values()].some((d) => d.changed) && !confirm('Switching source discards this session\'s changes. Save or propose them first to keep them. Switch anyway?')) return false;
      const askFolders = foldersOnOpen(src);
      S.loading = null;
      play(false); S.float = null; S.sel = null; S.docs.clear(); S.cur = null; S.src = src; folded = null; S.sprites = spriteList(src); thumbs.clear();
      S.anim.t = 0; drawPreview(); renderFamily(); renderColors(); resetHistory(); // the side panels drop the old project's sprite right away
      S.meta = { repo: Object.assign({}, src.repo || {}, Object.fromEntries(Object.entries(O.github || {}).filter(([, v]) => v != null && v !== ''))) };
      loadWork(); // the branch this repository was being committed to, if any
      if (!O.palette) S.palette = (src.palette || []).map((h) => (typeof h === 'string' ? fromHex(h) : h)).filter((c) => c != null);
      S.groups = normGroups(src.groups); S.alpha = normAlpha(O.alpha || src.alpha); loadTileGrid(); loadIndexed();
      $('.pf-pr-repo').value = ''; $('.pf-pr-base').value = ''; $('.pf-pr-title').value = ''; // the next pull request goes to the new project
      const restored = await restoreDrafts(); if (how.remember !== false) rememberProject(src); sourceButton();
      renderList(); renderPalette(); applyBg();
      if (restored.length) { await openSprite(restored[0].path); note(`${restored.length} sprite${restored.length > 1 ? 's' : ''} with changes restored from this browser`); }
      else if (S.sprites.length) await openSprite(S.sprites[0].path); else { status(); render(); }
      if (askFolders) openFolders();
      return true;
    }
    async function init() {
      try {
        if (O.source) return void (await useSource(O.source));
        if (O.sprites) return void (await useSource(staticSource({ sprites: O.sprites, palette: O.paletteList || null, repo: O.github || null }, O.baseUrl)));
        if (O.manifestUrl) { const mf = await fetchJson(O.manifestUrl); return void (await useSource(staticSource(mf, O.baseUrl != null ? O.baseUrl : (mf.base || '')))); }
        if (O.connect === 'github' && O.github && O.github.slug) {
          showLoading(O.github.slug);
          try { return void (await useSource(await githubSource({ repo: O.github.slug, branch: O.github.base, token: storedToken() || await authToken().catch(() => ''), apiBase: O.apiBase, onProgress: loadingStep }))); } catch (e) { hideLoading(); return openConnect(e.message); }
        }
        try { const mf = await fetchJson('api/manifest'), m = document.querySelector('meta[name="pf-token"]'); return void (await useSource(serverSource(mf, m ? m.content : ''))); } catch { /* no local server here */ }
        try { const mf = await fetchJson('pixel-art.json'); return void (await useSource(staticSource(mf, O.baseUrl != null ? O.baseUrl : (mf.base || '')))); } catch { /* no manifest here */ }
        status(); render();
        /* no project given: reopen the last GitHub repository, or carry on with what was drawn in this browser */
        const last = O.blank ? null : lastProject(); let why = '';
        if (last && last.kind === 'github' && O.connect !== false) {
          showLoading(last.slug);
          try { return void (await useSource(await githubSource({ repo: last.slug, branch: last.branch, token: storedToken() || await authToken().catch(() => ''), apiBase: O.apiBase, onProgress: loadingStep }))); } catch (e) { hideLoading(); why = 'Could not reopen ' + last.slug + ': ' + e.message; }
        }
        await useSource(last && last.kind === 'browser' ? browserSource(last.id, localName(last.id)) : browserSource(), { remember: !last || last.kind === 'browser' });
        if (O.blank && !S.docs.size) await addLocal(O.blank.name || 'sprite.png', O.blank.w || 16, O.blank.h || 16, new Uint32Array((O.blank.w || 16) * (O.blank.h || 16)), false);
        else if (!S.docs.size && O.connect !== false) openConnect(why || (last && last.kind === 'folder' ? `Choose the folder "${last.name}" again to pick up where you left off (your unsaved edits are kept in this browser).` : ''));
      } catch (e) { note('Could not start: ' + e.message); }
    }
    /** A source's sprites, without the layers files (name.layers.png): those are noted in S.layerFiles and open with their sprite. */
    function spriteList(src) {
      S.layerFiles = new Set([...(src.sprites || []), ...(src.hidden || []), ...(src.all || [])].map((x) => x.path).filter(isLayersFile));
      return (src.sprites || []).filter((x) => !isLayersFile(x.path)).map((x) => ({ ...x }));
    }
    /** The document for a sprite, loading it if needed (without opening it). Null if it cannot be read. */
    async function loadDoc(path) {
      if (S.docs.has(path)) return S.docs.get(path);
      const meta = S.sprites.find((s) => s.path === path);
      try {
        const img = await decodePng(new Blob([await S.src.read(path)], { type: 'image/png' }));
        const d = new Doc(path, img.w, img.h, img.px, { frames: meta && meta.frames });
        S.docs.set(path, d);
        if (S.layerFiles && S.layerFiles.has(layersPath(path))) await loadLayers(d);
        return d;
      } catch (e) { note('Could not open ' + path + ': ' + e.message); return null; }
    }
    /* The layers next to a sprite. They only count while they still flatten to the PNG: a PNG changed somewhere else (another
       editor, a merge) wins, the sprite opens flat and the old layers file is left as it is. */
    async function loadLayers(d) {
      const lp = layersPath(d.path), name = lp.split('/').pop();
      try {
        const ls = unpackLayers(await decodePng(new Blob([await S.src.read(lp)], { type: 'image/png' })), d.w, d.h);
        if (!ls) return note(`${name} does not hold layers for ${fileName(d)} (a different size?): opened without layers`);
        const flat = flattenLayers(ls, d.w * d.h); if (S.alpha) snapAlpha(flat, S.alpha, null);
        if (countDiff(flat, d.px) !== 0) return note(`${fileName(d)} was changed without its layers (${name} is older): opened without layers`);
        d.setLayers(ls); d.hadLayers = true; d.base = d.mark(); d.saved = d.mark();
      } catch (e) { note('Could not read the layers of ' + fileName(d) + ': ' + e.message); }
    }
    /** The layers file for a sprite (PNG bytes). */
    async function layersPng(d) {
      if (!hasStreams()) throw new Error('this browser cannot write the layers file');
      const p = packLayers(d.layers, d.w, d.h); return encodePngBytes(p.w, p.h, p.px, 1, p.text);
    }
    /** What a sprite's layers need from a commit: write them, delete the file (merged back to one layer), or nothing. */
    async function layerFile(d) {
      const lp = layersPath(d.path);
      if (d.layered) return { path: lp, blob: await layersPng(d) };
      if (d.hadLayers && S.layerFiles && S.layerFiles.has(lp)) return { path: lp, delete: true };
      return null;
    }
    function layersSent(d, f) { if (!f) return; if (f.delete) { S.layerFiles.delete(f.path); d.hadLayers = false; } else { S.layerFiles.add(f.path); d.hadLayers = true; } }
    /* "Original" (hold \, the changes view, Revert) is the sprite as committed on the branch: what a commit or pull request
       compares against. GitHub projects load that version anyway; the local server is asked for it each time a sprite is opened,
       so it follows new commits and survives reloads. A folder in the browser cannot read git: its original is the file as loaded. */
    async function branchBase(d) {
      if (d.local || !S.src || !S.src.branchVersion) return;
      const src = S.src; let v; try { v = await src.branchVersion(d.path); } catch { return; }
      if (S.src !== src || v.status === 'none') return;
      let img = null; if (v.status === 'ok') { try { img = await decodePng(new Blob([v.bytes], { type: 'image/png' })); } catch { return; } }
      const was = d.base, now = img || { w: d.w, h: d.h, px: new Uint32Array(d.w * d.h) }; // not committed yet: every pixel is new
      if (!(img && was.w === now.w && was.h === now.h && countDiff(was.px, now.px) === 0)) d.base = { w: now.w, h: now.h, px: now.px, sig: '' };
      d.baseFrom = img ? 'branch' : 'new';
      if (d === doc()) { status(); render(); keepSoon(); }
    }
    async function openSprite(path) {
      if (path !== S.cur) { commitFloat(); S.sel = null; S.lastPt = null; S.sheetK = 0; }
      if (!(await loadDoc(path))) return;
      S.cur = path; S.touched = false; const d = doc(); loadFrames(d); fit(); branchBase(d); linkBase(d);
      // Opening a sprite reveals its folder, so navigating back to it never
      // leaves you looking at a shut door. An explicit fold still hides it.
      const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
      if (folded && folded.has(dir)) { folded.delete(dir); saveFolded(); }
      S.placingNote = false; renderList(); renderColors(); status(); render(); drawPreview(); renderFamily(); resetHistory(); renderNotes(); renderLayers();
    }
    /** Add an image that is not in the project list. inProject = Save should write it to that path (needs a source that can write). */
    function addLocal(name, w, h, px, inProject, isNew) {
      let path = name, n = 1; while (S.docs.has(path) || S.sprites.some((x) => x.path === path)) path = name.replace(/(\.png)?$/i, '') + '-' + (++n) + '.png';
      S.docs.set(path, new Doc(path, w, h, px, { local: !inProject, isNew })); S.sprites.push({ path, w, h, local: !inProject }); keepSoon(); sourceButton(); return openSprite(path);
    }
    const canWrite = () => !!(S.src && S.src.write);
    /** The project button names what is open: a repository, a folder, or a project in this browser (once it has sprites). */
    function sourceButton() {
      const src = S.src || {}, btn = $('.pf-source');
      if (src.kind === 'github' && src.repo.slug) {
        // A zsh prompt, stacked: the repo stays put on top, the branch gets the box.
        btn.innerHTML = `<span class="pf-repo">${esc(src.repo.slug)}</span><span class="pf-branch">⎇ ${esc(src.branch)}</span>`;
        btn.title = `${src.repo.slug} @ ${src.branch}: switch branch, or open another project`;
      } else {
        const label = src.kind === 'folder' ? src.name : src.kind === 'browser' && (src.id || S.sprites.length) ? src.name : '';
        btn.textContent = label || 'Open project…';
        btn.title = (label ? label + (src.kind === 'browser' ? ' (in this browser)' : '') + ': ' : '') + 'switch project: a GitHub repository, a folder on this computer, or a project in this browser';
      }
    }
    /** Switch to another branch of the open GitHub repository. Drafts are kept per branch, so nothing follows you. */
    function closeBrMenu() { const m = root.querySelector('.pf-brmenu'); if (m) m.remove(); }
    async function switchBranch(branch) {
      const src = S.src;
      if (!src || src.kind !== 'github' || branch === src.branch) return;
      try {
        await useSource(await githubSource({ repo: src.repo.slug, branch, token: await commitToken(), apiBase: O.apiBase }));
        // The panel follows: it commits to the branch now open, and anything remembered
        // about the old one (its pull request, its last push) stays behind with it.
        S.work = { branch, base: S.meta.repo.defaultBranch || null, headRepo: null, headOwner: null, pr: null };
        S.lastPush = null;
        saveWork();
        setCommitBranch(branch);
      } catch (e) { note(e.message); }
    }
    /** A link that opens this repository and branch in the editor, to send to someone. The hosted editor when this page is local. */
    function projectLink() {
      const src = S.src, here = location.protocol.startsWith('http') && !/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
      const u = new URL(O.shareBase || (here ? location.origin + location.pathname : 'https://snowu.github.io/spritewright/'));
      u.search = ''; u.hash = ''; u.searchParams.set('repo', src.repo.slug);
      if (src.branch && src.branch !== (S.meta.repo && S.meta.repo.defaultBranch)) u.searchParams.set('branch', src.branch);
      return u.toString();
    }
    async function copyProjectLink() {
      const link = projectLink();
      try { await navigator.clipboard.writeText(link); note('Link copied: it opens ' + S.src.repo.slug + ' in spritewright. ' + link); }
      catch { note('Copy this link to share the project: ' + link); }
    }
    async function openBranchMenu() {
      closeBrMenu();
      const gh = S.meta.repo || {}, cur = S.src && S.src.branch;
      const menu = el(`<div class="pf-bgmenu pf-brmenu" role="menu"><div class="pf-note" style="padding:4px 9px">Loading branches…</div></div>`);
      root.appendChild(menu);
      const b = $('.pf-source').getBoundingClientRect(), r = root.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(b.left - r.left, r.width - menu.offsetWidth - 4)) + 'px'; menu.style.top = (b.bottom - r.top + 4) + 'px';
      menu.onclick = async (e) => {
        const other = e.target.closest('.pf-br-other');
        if (other) { closeBrMenu(); return openConnect(); }
        if (e.target.closest('.pf-br-share')) { closeBrMenu(); return copyProjectLink(); }
        if (e.target.closest('.pf-br-folders')) { closeBrMenu(); return openFolders(); }
        const t = e.target.closest('[data-branch]');
        if (!t || t.disabled) return;
        closeBrMenu(); switchBranch(t.dataset.branch);
      };
      try {
        const token = await commitToken();
        const names = token ? await listBranches({ token, repo: gh.slug, apiBase: O.apiBase }) : [];
        const all = names.includes(cur) ? names : [cur, ...names];
        menu.innerHTML = all.map((n) => `<button role="menuitemradio" data-branch="${esc(n)}"${n === cur ? ' class="on" disabled aria-checked="true"' : ''}>⎇ ${esc(n)}</button>`).join('') +
          `<button type="button" class="pf-br-folders" title="Choose which folders of this repository hold your art">Art folders…</button><button type="button" class="pf-br-share" title="A link that opens this repository in spritewright, to send to someone">Copy link to this project</button><button type="button" class="pf-br-other">Open another project…</button>` +
          (token ? '' : '<div class="pf-note" style="padding:4px 9px">Sign in to list every branch.</div>');
      } catch {
        menu.innerHTML = `<button role="menuitemradio" data-branch="${esc(cur)}" class="on" disabled>⎇ ${esc(cur)}</button><button type="button" class="pf-br-folders" title="Choose which folders of this repository hold your art">Art folders…</button><button type="button" class="pf-br-share" title="A link that opens this repository in spritewright, to send to someone">Copy link to this project</button><button type="button" class="pf-br-other">Open another project…</button>`;
      }
    }
    const brOutside = (e) => { const m = root.querySelector('.pf-brmenu'); if (m && !m.contains(e.target) && !e.target.closest('.pf-source')) closeBrMenu(); };
    document.addEventListener('pointerdown', brOutside);

    /* ---------- projects in this browser: nothing linked, sprites kept in IndexedDB; the list of them lives in localStorage ---------- */
    const LOCAL_KEY = 'pf:local-projects';
    const localProjects = () => { try { const l = JSON.parse(localStorage.getItem(LOCAL_KEY) || '[]'); return Array.isArray(l) ? l : []; } catch { return []; } };
    const saveLocalProjects = (l) => { try { localStorage.setItem(LOCAL_KEY, JSON.stringify(l)); } catch { /* the projects still work, only the list is not remembered */ } };
    const localName = (id) => (localProjects().find((x) => x.id === id) || {}).name || (id ? 'Untitled' : 'Sketches');
    const localKey = (id) => 'browser:' + location.pathname + (id ? '#' + id : '');
    async function newLocalProject(how = {}) {
      const list = localProjects(), names = new Set(list.map((x) => x.name)); let n = 1; while (names.has('Untitled ' + n)) n++;
      const proj = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: 'Untitled ' + n, at: Date.now() };
      saveLocalProjects([proj, ...list]);
      if (!(await useSource(browserSource(proj.id, proj.name)))) return false;
      $('.pf-dlg-connect').close(); if (how.sprite !== false) openNew(); return true;
    }
    async function renderLocals() {
      const box = $('.pf-c-locals'); if (!keeping()) { box.hidden = true; return; }
      const list = localProjects(); if (!list.some((x) => !x.id)) list.push({ id: '', name: 'Sketches' }); // the default one, from before projects had names
      const rows = [];
      for (const x of list) { let c = 0; try { c = (await drafts.list(localKey(x.id))).length; } catch { /* unknown */ } if (x.id || c) rows.push({ ...x, c }); }
      const cur = S.src && S.src.kind === 'browser' ? S.src.id || '' : null;
      box.innerHTML = rows.map((x) => `<div class="pf-c-lp${x.id === cur ? ' on' : ''}"><button type="button" class="pf-c-lopen" data-id="${esc(x.id)}" title="Open this project">${esc(x.name)} <span class="pf-note">${x.c} sprite${x.c === 1 ? '' : 's'}${x.id === cur ? ' · open' : ''}</span></button><button type="button" class="pf-c-lren" data-id="${esc(x.id)}" title="Rename">✎</button><button type="button" class="pf-c-ldel" data-id="${esc(x.id)}" title="Delete this project and its sprites from this browser">✕</button></div>`).join('');
      box.hidden = !rows.length;
    }
    async function deleteLocalProject(id) {
      const name = localName(id); let c = 0; try { c = (await drafts.list(localKey(id))).length; } catch { /* unknown */ }
      if (!confirm(`Delete "${name}"${c ? ` and its ${c} sprite${c > 1 ? 's' : ''}` : ''} from this browser? This cannot be undone: download anything you want to keep first.`)) return;
      const open = S.src && S.src.kind === 'browser' && (S.src.id || '') === id;
      if (open) { S.docs.clear(); S.sprites = []; S.cur = null; } // nothing left to keep for it
      try { await drafts.clear(localKey(id)); } catch { /* already gone */ }
      saveLocalProjects(localProjects().filter((x) => x.id !== id));
      if (open) { await useSource(browserSource()); sourceButton(); renderList(); status(); render(); }
      note(`deleted "${name}"`); renderLocals();
    }
    /** A sprite that exists only here (made or uploaded in this session or kept in this browser, never written to the project) can be deleted. */
    const deletable = (d) => !!d && (d.local || d.isNew) && !d.onDisk;
    async function deleteSprite() {
      const d = doc(); if (!deletable(d)) return;
      if (d.flat().some((v) => v >>> 24) && !confirm(`Delete ${fileName(d)}? It only exists in this browser, so this cannot be undone.`)) return;
      commitFloat(); S.sel = null; S.float = null;
      // carry on next door: the frame before it in its family (the next one for a first frame), else a sprite of the same folder
      const fam = famOf.get(d.path), m = fam ? fam.members.filter((p) => p !== d.path) : [], at = fam ? fam.members.indexOf(d.path) : -1;
      const dirOf = (p) => p.slice(0, p.lastIndexOf('/') + 1), i = S.sprites.findIndex((x) => x.path === d.path);
      const sib = [S.sprites[i - 1], S.sprites[i + 1]].find((x) => x && dirOf(x.path) === dirOf(d.path)), near = m[Math.max(0, at - 1)] || (sib && sib.path);
      S.docs.delete(d.path); S.sprites = S.sprites.filter((x) => x.path !== d.path); thumbs.delete(d.path);
      if (drafts && d.kept) try { await drafts.remove(projectKey(), d.path); } catch { /* gone anyway on the next flush */ }
      const next = S.sprites.find((x) => x.path === near) || S.sprites.find((x) => S.docs.has(x.path)) || S.sprites[0];
      if (next) await openSprite(next.path); else { S.cur = null; renderList(); renderFamily(); drawPreview(); status(); render(); }
      sourceButton(); note('deleted ' + fileName(d));
    }
    /** Save sends this sprite somewhere outside the browser (the project folder, or the page's own save hook). */
    const savesOut = (d) => !!O.save || (canWrite() && !d.local);

    /* ---------- kept in this browser (see browserDrafts) ---------- */
    const drafts = O.drafts === false ? null : O.drafts || browserDrafts();
    let draftsOk = !!drafts, draftTimer = 0, flushing = Promise.resolve();
    const keeping = () => !!drafts && draftsOk;
    const projectKey = () => {
      const s = S.src; if (O.draftsKey) return O.draftsKey;
      if (!s || s.kind === 'browser') return 'browser:' + location.pathname + (s && s.id ? '#' + s.id : '');
      if (s.kind === 'github') return 'github:' + s.repo.slug + '@' + s.branch;
      if (s.kind === 'folder') return 'folder:' + s.name;
      return (s.kind || 'custom') + ':' + location.origin + location.pathname + (O.manifestUrl ? '#' + O.manifestUrl : '');
    };
    /** Does this sprite hold work that only exists here? Then it needs a browser copy. */
    const needsKeep = (d) => (savesOut(d) ? d.unsaved || (d.isNew && !d.onDisk) : d.changed || d.local || d.isNew);
    const pixelsNow = (d) => { if (d !== doc() || !S.float) return d.px; const px = d.px.slice(), f = S.float; pasteRect(px, d.w, d.h, f.px, f.w, f.h, f.x, f.y, false); return px; }; // the current layer, with a lifted selection put down
    const layersNow = (d) => { if (!d.layered) return null; const ls = copyLayers(d.layers); ls[d.active].px = pixelsNow(d).slice(); return ls; };
    /* The kept copy is fresh only while the pixels still match: a push replaces the base under it
       (markPushed), so the next flush stores the new base instead of skipping on matching pixels. */
    const isKept = (d) => !!d.kept && d.kept.w === d.w && d.kept.h === d.h && d.kept.base === d.base && d.kept.active === d.active && d.kept.sig === d.sig() && countDiff(d.kept.px, pixelsNow(d)) === 0;
    /** Work that would be lost if the tab closed now. */
    const atRisk = (d) => (keeping() ? needsKeep(d) && !isKept(d) : savesOut(d) ? d.unsaved : d.changed || d.local);
    const keepSoon = () => { if (!drafts) return; clearTimeout(draftTimer); draftTimer = setTimeout(flushDrafts, 250); };
    function flushDrafts() {
      clearTimeout(draftTimer); if (!keeping()) return flushing;
      const key = projectKey(), list = [...S.docs.values()];
      flushing = flushing.then(async () => {
        let touched = false;
        try {
          for (const d of list) {
            if (needsKeep(d)) {
              if (isKept(d)) continue;
              const px = pixelsNow(d).slice(), layers = layersNow(d);
              await drafts.put(key, { path: d.path, w: d.w, h: d.h, px, layers, active: d.active, base: d.base, saved: d.saved, local: d.local, isNew: d.isNew, onDisk: !!d.onDisk, frames: d.frames, at: Date.now() });
              d.kept = { w: d.w, h: d.h, px, base: d.base, active: d.active, sig: d.sig() }; touched = true;
            } else if (d.kept) { await drafts.remove(key, d.path); d.kept = null; touched = true; }
          }
        } catch (e) { draftsOk = false; note('This browser cannot keep your edits (' + e.message + '): use Save, Download or Propose PR before closing the tab.'); }
        if (touched && S.docs.size) { status(); renderListSoon(); }
      });
      return flushing;
    }
    /** Bring back what this project had kept in the browser. Newest first. */
    async function restoreDrafts() {
      if (!keeping()) return [];
      let recs = []; try { recs = await drafts.list(projectKey()); } catch { draftsOk = false; return []; }
      recs.sort((a, b) => (b.at || 0) - (a.at || 0));
      for (const r of recs) {
        const d = new Doc(r.path, r.w, r.h, r.px, { local: r.local, isNew: r.isNew, frames: r.frames });
        if (r.layers && r.layers.length > 1) d.setLayers(r.layers, r.active);
        d.base = r.base; d.saved = r.saved || { w: r.w, h: r.h, px: r.px.slice() }; d.onDisk = !!r.onDisk; d.kept = { w: r.w, h: r.h, px: d.px.slice(), base: d.base, active: d.active, sig: d.sig() };
        S.docs.set(r.path, d);
        const meta = S.sprites.find((x) => x.path === r.path); if (meta) { meta.w = r.w; meta.h = r.h; } else S.sprites.push({ path: r.path, w: r.w, h: r.h, local: !!r.local });
      }
      return recs;
    }
    const LAST_KEY = 'pf:last';
    const lastProject = () => { try { return JSON.parse(localStorage.getItem(LAST_KEY) || 'null'); } catch { return null; } };
    function rememberProject(src) { // only projects picked on this page; ones given by the page's own options always load anyway
      const v = src.kind === 'github' ? { kind: 'github', slug: src.repo.slug, branch: src.branch } : src.kind === 'folder' ? { kind: 'folder', name: src.name } : src.kind === 'browser' ? { kind: 'browser', id: src.id || '' } : null;
      if (v && !(O.source || O.sprites || O.manifestUrl)) try { localStorage.setItem(LAST_KEY, JSON.stringify(v)); } catch { /* not remembered */ }
    }

    /* ---------- list ---------- */
    const thumbs = new Map();
    const io = typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { io.unobserve(e.target); paintThumb(e.target, e.target.__s); } }), { root: $('.pf-list') }) : null;
    /* The sprite list: folders you can fold, one tile per family (archer_0 + archer_atk + archer_block), animations marked ▶.
       Typing in the filter shows a flat list of matching files instead. Fold all / Unfold all fold the lot,
       including the folder the open sprite is in; opening a sprite reveals its folder again. */
    const famOf = new Map(); // path -> { key, dir, members, animated }
    const collapsedKey = () => 'pf:folded:' + ((S.meta.repo && S.meta.repo.slug) || (S.src && S.src.name) || location.pathname);
    let folded = null;
    const loadFolded = () => { try { folded = new Set(JSON.parse(localStorage.getItem(collapsedKey()) || '[]')); } catch { folded = new Set(); } };
    const saveFolded = () => { try { localStorage.setItem(collapsedKey(), JSON.stringify([...folded])); } catch { /* ignore */ } };
    function regroup() {
      famOf.clear(); const groups = groupSprites(S.sprites.map((s) => s.path));
      for (const g of groups) for (const f of g.families) { const fam = { ...f, dir: g.dir }; for (const m of f.members) famOf.set(m, fam); }
      return groups;
    }
    const spriteOf = (path) => S.sprites.find((x) => x.path === path);
    /* The change marker is always there, only its state differs, so a row going "not saved" → "kept" → clean changes a
       class (and fades) instead of being rebuilt. */
    const marker = (dirty, changed, d) => dirty ? '<i class="dot" title="not saved yet"></i>'
      : changed ? `<i class="dot base" title="${keeping() && !(d && savesOut(d)) ? 'changed: kept in this browser, not in a pull request yet' : 'saved, not yet proposed'}"></i>` : '<i class="dot none"></i>';
    function tileHtml(s, label, fam, flat) {
      const d = S.docs.get(s.path), members = fam ? fam.members : [s.path], dirty = members.some((p) => { const x = S.docs.get(p); return x && (savesOut(x) ? x.unsaved : atRisk(x)); }), changed = members.some((p) => { const x = S.docs.get(p); return x && (x.changed || x.local || x.isNew); });
      const size = d ? d.w + '×' + d.h : (s.w || '?') + '×' + (s.h || '?'), dir = s.path.split('/').slice(0, -1).join('/') || '.';
      const badge = fam && fam.members.length > 1 ? `<i class="pf-badge${fam.animated ? ' anim' : ''}" title="${fam.animated ? 'animation: ' + fam.members.length + ' frames' : fam.members.length + ' images in this family'}">${fam.animated ? '▶' : ''}${fam.members.length}</i>` : '';
      const on = members.includes(S.cur);
      return `<button class="pf-item${flat ? '' : ' pf-cell'}${on ? ' on' : ''}" role="option" data-path="${esc(s.path)}" title="${esc(s.path)}"><canvas width="${s.w || 16}" height="${s.h || 16}"></canvas><span class="n">${esc(label)}<small>${flat ? esc(dir) + ' · ' : ''}${size}</small></span>${badge}${marker(dirty, changed, d)}</button>`;
    }
    /** The setup callout: a GitHub repository without spritewright.config.json, until the pick has gone out in a pull request. */
    function renderSetup() {
      const box = $('.pf-setup'), src = S.src, f = src && src.kind === 'github' && src.all && !src.hasConfig ? readFolders(src) : null;
      // closed with ✕: stays closed for this repository and branch until the note would say something new (a pick after "no setup")
      const state = f && f.picked ? 'picked' : 'unset', hideKey = src && src.repo ? 'pf:setup-hide:' + src.repo.slug + '@' + src.branch : '';
      let closed = false; try { closed = !!hideKey && localStorage.getItem(hideKey) === state; } catch { /* show it */ }
      const show = !!(src && src.kind === 'github' && src.all && !src.hasConfig && !(f && f.sent)) && !S.loading && !closed;
      box.hidden = !show; if (!show) return;
      box.innerHTML = f && f.picked
        ? `<span><b>Art folders picked.</b> ${CONFIG_PATH} goes with your next pull request, so everyone gets this list.</span><button type="button" class="pf-setup-go">Change folders…</button>`
        : src.all.length ? `<span><b>No project setup yet.</b> Choose the folders that hold your art; it is saved as ${CONFIG_PATH} in your next pull request.</span><button type="button" class="primary pf-setup-go">Choose art folders…</button>`
        : `<span><b>No sprites here yet.</b> Choose the folder your art goes in, then draw the first one with New.</span><button type="button" class="primary pf-setup-go">Choose art folder…</button>`;
      box.insertAdjacentHTML('afterbegin', '<button type="button" class="pf-setup-x" aria-label="Close" title="Close (Art folders… in the project menu changes them later)">✕</button>');
      box.querySelector('.pf-setup-go').onclick = openFolders;
      box.querySelector('.pf-setup-x').onclick = () => { try { localStorage.setItem(hideKey, state); } catch { /* this visit */ } box.hidden = true; };
    }
    function renderList() {
      renderSetup();
      if (S.loading) { if (!$('.pf-loading')) $('.pf-list').innerHTML = loaderHtml(); return; }
      const q = $('.pf-q').value.toLowerCase(), list = $('.pf-list'), groups = regroup();
      // Rows whose markup is unchanged keep their DOM nodes — and with them their painted thumbnails —
      // so drawing does not flash the whole explorer. Only the open sprite rebuilds (a live thumbnail).
      const old = new Map();
      for (const b of list.querySelectorAll('.pf-item,.pf-dir,.pf-openrow')) {
        const k = b.classList.contains('pf-dir') ? 'd:' + b.dataset.dir : b.classList.contains('pf-openrow') ? 'o:' + b.dataset.dir : 'i:' + b.dataset.path;
        if (!old.has(k)) old.set(k, b);
      }
      list.innerHTML = '';
      if (!folded) loadFolded();
      // An existing row is moved over and updated in place (see morph): its thumbnail keeps its pixels, so nothing blinks.
      // The open sprite's thumbnail is repainted right away from the document; new rows paint as they scroll into view.
      const place = (parent, html, key, s) => {
        const b = el(html), live = !!s && s.path === S.cur, o = old.get(key);
        if (o) old.delete(key);
        const row = o || b;
        if (o && o.outerHTML !== b.outerHTML) morph(o, b);
        parent.appendChild(row);
        const cv = row.querySelector('canvas');
        if (cv && s && (live || !o)) { cv.__s = s; if (live || !io) paintThumb(cv, s); else io.observe(cv); }
        return row;
      };
      const add = (html, s) => place(list, html, 'i:' + s.path, s);
      list.classList.toggle('pf-flat', !!q);
      if (q) { for (const s of S.sprites.filter((x) => x.path.toLowerCase().includes(q))) add(tileHtml(s, s.path.split('/').pop(), famOf.get(s.path), true), s); renderCommit(); return; }
      const hid = (S.src && S.src.hidden) || []; let hidNote = null;
      if (hid.length) { // the default skip of docs/screenshots/... folders, made visible and reversible
        const shown = S.sprites.some((x) => x.hiddenByDefault);
        const note = hidNote = el(`<button class="pf-hidden-toggle" title="${shown ? 'Hide' : 'Show'} the images in folders like docs, screenshots and previews, which are usually not game art">${shown ? 'Hide' : 'Show'} ${hid.length} image${hid.length > 1 ? 's' : ''} from docs / screenshots / previews folders</button>`);
      }
      for (const g of groups) {
        const n = g.families.reduce((k, f) => k + f.members.length, 0), shut = folded.has(g.dir);
        const chg = g.families.reduce((k, f) => k + f.members.filter((m) => { const x = S.docs.get(m); return x && x.changed; }).length, 0);
        if (groups.length > 1 || g.dir) place(list, `<button class="pf-dir${shut ? ' shut' : ''}" data-dir="${esc(g.dir)}" aria-expanded="${!shut}"><span class="pf-caret">${shut ? '▸' : '▾'}</span><span class="pf-dirname">${esc(g.dir || '.')}</span>${chg ? `<span class="pf-dirchg" title="${chg} changed sprite${chg > 1 ? 's' : ''} in this folder, not in a pull request yet">${chg} changed</span>` : ''}<span class="pf-dircount">${n}</span></button>`, 'd:' + g.dir, null);
        if (shut) {
          // A shut folder still shows the sprite being edited, so the list never loses your place. Clicking it unfolds.
          const open = S.cur && g.families.some((f) => f.members.includes(S.cur)) ? spriteOf(S.cur) : null;
          if (open) {
            const dd = S.docs.get(S.cur), label = S.cur.split('/').pop();
            const dirty = dd && (savesOut(dd) ? dd.unsaved : atRisk(dd)), changed = dd && (dd.changed || dd.local || dd.isNew);
            place(list, `<button class="pf-openrow" data-dir="${esc(g.dir)}" title="${esc(S.cur)} — unfold this folder"><canvas width="${open.w || 16}" height="${open.h || 16}"></canvas><span class="n">${esc(label)}</span>${dirty ? '<i class="dot" title="not saved yet"></i>' : changed ? '<i class="dot base" title="changed, not in a pull request yet"></i>' : '<i class="dot none"></i>'}</button>`, 'o:' + g.dir, open);
          }
          continue;
        }
        const grid = el('<div class="pf-tiles"></div>'); list.appendChild(grid);
        for (const f of g.families) {
          const shown = f.members.includes(S.cur) ? S.cur : f.members[0], s = spriteOf(shown);
          place(grid, tileHtml(s, f.members.length > 1 ? f.key : shown.split('/').pop(), famOf.get(shown), false), 'i:' + s.path, s);
        }
      }
      if (hidNote) list.appendChild(hidNote); // after the folders
      renderCommit();
    }
    /** Make row `o` look like `b` without replacing its canvas: attributes, then children (leaves are updated, the rest swapped). */
    function morph(o, b) {
      const attrs = (x, y) => { for (const a of [...x.attributes]) if (!y.hasAttribute(a.name)) x.removeAttribute(a.name); for (const a of [...y.attributes]) if (x.getAttribute(a.name) !== a.value) x.setAttribute(a.name, a.value); };
      attrs(o, b);
      const oc = [...o.children], bc = [...b.children];
      if (oc.length !== bc.length || oc.some((c, i) => c.tagName !== bc[i].tagName)) {
        const cv = o.querySelector(':scope > canvas'), nc = b.querySelector(':scope > canvas');
        if (cv && nc) nc.replaceWith(cv);
        o.replaceChildren(...b.childNodes); return;
      }
      oc.forEach((c, i) => {
        const n = bc[i]; if (c.tagName === 'CANVAS' || c.outerHTML === n.outerHTML) return;
        if (!c.children.length && !n.children.length) { attrs(c, n); if (c.textContent !== n.textContent) c.textContent = n.textContent; } else c.replaceWith(n);
      });
    }
    function toggleDir(dir) { if (!folded) loadFolded(); folded.has(dir) ? folded.delete(dir) : folded.add(dir); saveFolded(); renderList(); }
    function setAllFolded(shut) { if (!folded) loadFolded(); if (shut) { for (const g of regroup()) folded.add(g.dir); } else folded.clear(); saveFolded(); renderList(); }
    /* Thumbnails load as their rows come into view, a few at a time, so a big project starts drawing at once without flooding the network. */
    let thumbBusy = 0; const thumbQueue = [];
    const thumbSlot = () => new Promise((res) => { if (thumbBusy < 6) { thumbBusy++; res(); } else thumbQueue.push(res); });
    const thumbDone = () => { const next = thumbQueue.shift(); if (next) next(); else thumbBusy--; };
    /** The list learns a sprite's size from whatever draws it first (its thumbnail, or the sprite itself once open). */
    function sizeKnown(canvas, s, w, h) { if (s.w && s.h) return; s.w = w; s.h = h; const small = canvas.parentElement && canvas.parentElement.querySelector('small'); if (small) small.textContent = small.textContent.replace(/\?×\?$/, w + '×' + h); }
    async function paintThumb(canvas, s) {
      const d = S.docs.get(s.path);
      if (d) { drawPx(canvas, d); return sizeKnown(canvas, s, d.w, d.h); }
      if (!S.src || !S.src.thumbs) return;
      const src = S.src;
      try {
        let bm = thumbs.get(s.path);
        if (!bm) { await thumbSlot(); try { if (S.src !== src) return; bm = await createImageBitmap(new Blob([await src.read(s.path)], { type: 'image/png' })); thumbs.set(s.path, bm); } finally { thumbDone(); } }
        canvas.width = bm.width; canvas.height = bm.height; const c = canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(bm, 0, 0);
        sizeKnown(canvas, s, bm.width, bm.height);
      } catch { /* leave blank */ }
    }

    /* ---------- palette / colours ---------- */
    function renderColors() {
      const d = doc(); if (!d) { $('.pf-img-colors').innerHTML = '<span class="pf-note">no image open</span>'; return; }
      const all = colorsOf(d.flat()).filter(([c]) => !isClear(c)), cols = all.slice(0, 64), max = S.maxColors; swatches();
      const cc = $('.pf-ccount'); cc.textContent = `· ${all.length}${max ? ' / ' + max : ''}`; cc.title = `${all.length} colour${all.length === 1 ? '' : 's'}${max ? ', of a budget of ' + max : ''}`; cc.classList.toggle('over', !!max && all.length > max);
      cc.title = max ? (all.length > max ? `Over the project's limit of ${max} colours` : `The project allows ${max} colours ("maxColors" in spritewright.config.json)`) : '';
      $('.pf-img-colors').innerHTML = cols.map(([c, n]) => `<button data-c="${c}" title="${toHex(c)} · ${n}px" class="${c === S.color ? 'on' : ''}" style="background:${toHex(c)}"></button>`).join('') || '<span class="pf-note">transparent</span>';
      $('.pf-cpick').value = toHex(S.color); if (document.activeElement !== $('.pf-chex')) $('.pf-chex').value = toHex(S.color);
      $$('.pf-sw button').forEach((b) => { b.classList.toggle('on', +b.dataset.c === S.color); b.classList.toggle('sec', !isClear(S.color2) && +b.dataset.c === S.color2); });
      if (S.palette.length) {
        const set = new Set(S.palette), off = cols.filter(([c]) => !set.has(c)).length;
        $('.pf-off').innerHTML = off ? `<span class="pf-bad">${off} colour${off > 1 ? 's' : ''} outside the palette</span>` : 'All colours are in the palette.';
      }
    }
    function swatches() {
      for (const [sel, c] of [['.pf-prim', S.color], ['.pf-sec', S.color2]]) { const b = $(sel); b.classList.toggle('clear', isClear(c)); b.style.setProperty('--pf-c', toHex(c)); b.title = (sel === '.pf-prim' ? 'Primary ' : 'Secondary ') + (isClear(c) ? 'clear (erases)' : toHex(c)); }
    }
    function renderPalette() {
      $('.pf-pal-empty').hidden = !!S.palette.length; if (!S.palette.length) $('.pf-off').textContent = '';
      $('.pf-pal-lock').classList.toggle('on', !!S.indexed); $('.pf-pal-lock').disabled = !S.palette.length && !S.indexed;
      $('.pf-pal-colors').innerHTML = S.palette.map((c) => `<button data-c="${c}" title="${toHex(c)}" style="background:${toHex(c)}"></button>`).join('');
    }
    /** Indexed: a colour from anywhere (picker, hex, the image) becomes its nearest palette colour. */
    const inPal = (c) => (S.indexed && S.palette.length && c != null && !isClear(c) ? nearestColor(c, S.palette) : c);
    function setColor(c) { S.color = inPal(c); if (S.tool === 'erase' || S.tool === 'pick') setTool('pen'); renderColors(); swatches(); }
    function setColor2(c) { S.color2 = inPal(c); renderColors(); swatches(); }

    /* ---------- viewport ---------- */
    function resizeView() {
      const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      view.width = Math.max(1, Math.round(r.width * dpr)); view.height = Math.max(1, Math.round(r.height * dpr)); render();
    }
    function fit() {
      const d = doc(); if (!d) return; const r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
      const z = Math.max(1, Math.floor(Math.min((r.width * dpr - 40) / d.w, (r.height * dpr - 40) / d.h)));
      S.zoom = Math.min(64, z); S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2);
    }
    function zoomAt(f, cx, cy) {
      const z = Math.max(1, Math.min(64, Math.round(S.zoom * f) === S.zoom ? S.zoom + (f > 1 ? 1 : -1) : Math.round(S.zoom * f)));
      const px = (cx - S.ox) / S.zoom, py = (cy - S.oy) / S.zoom; S.zoom = z; S.ox = Math.round(cx - px * z); S.oy = Math.round(cy - py * z); S.touched = true; render();
    }
    const toCell = (e) => { const r = view.getBoundingClientRect(), dpr = view.width / r.width, X = (e.clientX - r.left) * dpr, Y = (e.clientY - r.top) * dpr; return { x: Math.floor((X - S.ox) / S.zoom), y: Math.floor((Y - S.oy) / S.zoom), X, Y }; };

    function render() {
      const d = doc(); g.clearRect(0, 0, view.width, view.height); g.imageSmoothingEnabled = false;
      if (!d) { const cv = $('.pf-ctx-cv'); cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); ctxHits = []; $('.pf-ctx-note').textContent = ''; return; } // nothing open: no context left over from the last project
      // holding \ shows the image as it was when this session opened it (what a pull request compares against)
      const ref = S.peek === 'saved' ? d.saved : d.base, shown = S.peek ? { w: ref.w, h: ref.h, img: new ImageData(new Uint8ClampedArray(ref.px.buffer.slice(0)), ref.w, ref.h) } : { w: d.w, h: d.h, img: d.imageData() };
      const z = S.zoom, W = shown.w * z, H = shown.h * z;
      offscreen.width = shown.w; offscreen.height = shown.h; offscreen.getContext('2d').putImageData(shown.img, 0, 0);
      if (S.tile) { /* the eight neighbours, dimmed, so seams show */
        g.globalAlpha = 0.45; for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) if (i || j) g.drawImage(offscreen, S.ox + i * W, S.oy + j * H, W, H); g.globalAlpha = 1;
      }
      /* checkerboard behind transparent pixels, one square per 2 art pixels at low zoom */
      const cs = Math.max(8, z * 2 > 16 ? z : 16), ck = bgColors(), lightBg = luma(ck[0]) > 0.55;
      g.save(); g.beginPath(); g.rect(S.ox, S.oy, W, H); g.clip();
      for (let y = 0; y * cs < H; y++) for (let x = 0; x * cs < W; x++) { g.fillStyle = (x + y) % 2 ? ck[0] : ck[1]; g.fillRect(S.ox + x * cs, S.oy + y * cs, cs, cs); }
      const f = frameSize(d), multi = f && (f.w < d.w || f.h < d.h);
      if (S.onion && multi) { /* each frame shows the one before it, faintly, underneath */
        const cols = Math.floor(d.w / f.w), rows = Math.floor(d.h / f.h); g.globalAlpha = 0.28;
        for (let k = 1; k < cols * rows; k++) { const sx = ((k - 1) % cols) * f.w, sy = Math.floor((k - 1) / cols) * f.h, dx = (k % cols) * f.w, dy = Math.floor(k / cols) * f.h; g.drawImage(offscreen, sx, sy, f.w, f.h, S.ox + dx * z, S.oy + dy * z, f.w * z, f.h * z); }
        g.globalAlpha = 1;
      }
      const fam = !multi && S.onion ? famFor(d) : null, fi = fam ? fam.members.indexOf(d.path) : -1;
      if (fi > 0) { const prev = memberImage(fam.members[fi - 1]); if (prev) { g.globalAlpha = 0.28; g.drawImage(prev, S.ox, S.oy, prev.width * z, prev.height * z); g.globalAlpha = 1; offscreen.width = shown.w; offscreen.height = shown.h; offscreen.getContext('2d').putImageData(shown.img, 0, 0); } }
      if (S.ref && S.ref.visible && !S.ref.over) drawRef(W, H);
      g.drawImage(offscreen, S.ox, S.oy, W, H);
      if (S.ref && S.ref.visible && S.ref.over) drawRef(W, H);
      g.restore();
      if (S.changes && !S.peek && d.base.w === d.w && d.base.h === d.h) { /* dim what is untouched, outline what changed */
        const base = d.base.px, mask = new Uint32Array(d.w * d.h), dim = pack(7, 4, 13, 175), cells = [];
        const now = d.flat(); for (let i = 0; i < mask.length; i++) if (samePx(now[i], base[i])) mask[i] = dim; else cells.push(i);
        diffCanvas.width = d.w; diffCanvas.height = d.h; diffCanvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(mask.buffer), d.w, d.h), 0, 0);
        g.drawImage(diffCanvas, S.ox, S.oy, W, H);
        if (z >= 3 && cells.length < 20000) { g.strokeStyle = '#e08cff'; g.lineWidth = Math.max(1, Math.floor(z / 8)); for (const i of cells) g.strokeRect(S.ox + (i % d.w) * z + 0.5, S.oy + ((i / d.w) | 0) * z + 0.5, z - 1, z - 1); g.lineWidth = 1; }
      }
      if (d.todo && d.todo.layers === d.layers && !S.peek && z >= 3) { /* left to redraw after Apply edit, until drawn over */
        g.strokeStyle = '#ffb000'; g.lineWidth = Math.max(1, Math.floor(z / 8)); g.setLineDash([Math.max(2, z / 4), Math.max(2, z / 4)]); const flat = d.flat();
        for (const [i, v] of d.todo.cells) if (flat[i] === v) g.strokeRect(S.ox + (i % d.w) * z + 0.5, S.oy + ((i / d.w) | 0) * z + 0.5, z - 1, z - 1);
        g.setLineDash([]); g.lineWidth = 1;
      }
      if (S.ctx) drawContext(d);
      if (S.peek) { g.fillStyle = 'rgba(224,140,255,.9)'; g.font = `${Math.round(12 * (window.devicePixelRatio || 1))}px ${getComputedStyle(root).getPropertyValue('--pf-mono') || 'monospace'}`; g.fillText(peekLabel(d), S.ox, S.oy - 8); }
      const fl = S.float;
      if (fl) { const t = document.createElement('canvas'); t.width = fl.w; t.height = fl.h; t.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(fl.px.buffer.slice(0)), fl.w, fl.h), 0, 0); g.drawImage(t, S.ox + fl.x * z, S.oy + fl.y * z, fl.w * z, fl.h * z); }
      if (overlay) { g.globalAlpha = 0.9; for (const [x, y] of overlay.pts) { g.fillStyle = isClear(overlay.value) ? 'rgba(255,255,255,.35)' : toHex(overlay.value); g.fillRect(S.ox + x * z, S.oy + y * z, z, z); } g.globalAlpha = 1; }
      if (S.grid && z >= 6) {
        g.strokeStyle = lightBg ? 'rgba(20,10,40,.16)' : 'rgba(230,220,247,.09)'; g.lineWidth = 1; g.beginPath();
        for (let x = 0; x <= d.w; x++) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); }
        for (let y = 0; y <= d.h; y++) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); }
        g.stroke();
      }
      const tg = tileGridSize();
      if (tg && (d.w > tg || d.h > tg) && z * tg >= 6) { // every tg pixels: tiles, or a size budget inside a bigger image
        g.strokeStyle = lightBg ? 'rgba(20,10,40,.4)' : 'rgba(185,140,255,.38)'; g.lineWidth = 1; g.beginPath();
        for (let x = tg; x < d.w; x += tg) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); }
        for (let y = tg; y < d.h; y += tg) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); }
        g.stroke();
      }
      if (multi) { g.strokeStyle = 'rgba(255,176,0,.6)'; g.beginPath(); for (let x = f.w; x < d.w; x += f.w) { g.moveTo(S.ox + x * z + .5, S.oy); g.lineTo(S.ox + x * z + .5, S.oy + H); } for (let y = f.h; y < d.h; y += f.h) { g.moveTo(S.ox, S.oy + y * z + .5); g.lineTo(S.ox + W, S.oy + y * z + .5); } g.stroke(); }
      g.strokeStyle = 'rgba(185,140,255,.55)'; g.lineWidth = 1; g.strokeRect(S.ox - .5, S.oy - .5, W + 1, H + 1);
      g.strokeStyle = 'rgba(224,140,255,.75)';
      if (S.mx) { g.beginPath(); g.moveTo(S.ox + W / 2, S.oy); g.lineTo(S.ox + W / 2, S.oy + H); g.stroke(); }
      if (S.my) { g.beginPath(); g.moveTo(S.ox, S.oy + H / 2); g.lineTo(S.ox + W, S.oy + H / 2); g.stroke(); }
      if (S.lint) { // pixel check: a coloured box round each finding (filled when the pixels are too small to box)
        const L = lintCache(d), kinds = [['stray', L.stray, '#ffb000'], ['doubles', L.doubles, '#ff5ac8'], ['near', L.nearPx, '#4fd8ff']];
        for (const [, list, col] of kinds) { g.strokeStyle = col; g.fillStyle = col; g.lineWidth = Math.max(1, Math.floor(z / 6)); for (const i of list.slice(0, 4000)) { const x = S.ox + (i % d.w) * z, y = S.oy + ((i / d.w) | 0) * z; if (z >= 5) g.strokeRect(x + g.lineWidth / 2, y + g.lineWidth / 2, z - g.lineWidth, z - g.lineWidth); else g.fillRect(x, y, z, z); } }
        g.lineWidth = 1; const tag = $('.pf-lint-tag'), parts = [[L.stray.length, 'stray', '#ffb000'], [L.doubles.length, 'doubled corner', '#ff5ac8'], [L.near.length, 'near-duplicate colour', '#4fd8ff']].filter((p) => p[0]);
        tag.innerHTML = parts.length ? parts.map(([n, what, col]) => `<span style="color:${col}"><i></i>${n} ${what}${n > 1 ? 's' : ''}</span>`).join('') : '<span class="ok">no stray pixels, doubled corners or near-duplicate colours</span>';
      }
      const pins = notesOf(d);
      if (pins.length) { // numbered pins, centred on their pixel
        const r = Math.max(7, Math.min(12, z * 0.45)); g.font = `700 ${Math.round(r * 1.1)}px ${getComputedStyle(root).getPropertyValue('--pf-mono') || 'monospace'}`; g.textAlign = 'center'; g.textBaseline = 'middle';
        pins.forEach((n, i) => { const cx = S.ox + (n.x + .5) * z, cy = S.oy + (n.y + .5) * z; g.fillStyle = '#e08cff'; g.strokeStyle = '#12081f'; g.lineWidth = 2; g.beginPath(); g.rect(cx - r, cy - r, r * 2, r * 2); g.fill(); g.stroke(); g.fillStyle = '#12081f'; g.fillText(String(i + 1), cx, cy + 1); });
        g.textAlign = 'start'; g.textBaseline = 'alphabetic'; g.lineWidth = 1;
      }
      if (S.sel) { /* marching ants, without the marching: round the rectangle, or along the edges of a masked selection */
        const r = S.sel; g.beginPath();
        if (!r.mask) g.rect(S.ox + r.x * z + .5, S.oy + r.y * z + .5, r.w * z - 1, r.h * z - 1);
        else {
          const on = (x, y) => x >= 0 && y >= 0 && x < r.w && y < r.h && r.mask[y * r.w + x], X = (x) => S.ox + (r.x + x) * z + .5, Y = (y) => S.oy + (r.y + y) * z + .5;
          for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (on(x, y)) {
            if (!on(x, y - 1)) { g.moveTo(X(x), Y(y)); g.lineTo(X(x + 1), Y(y)); } if (!on(x, y + 1)) { g.moveTo(X(x), Y(y + 1)); g.lineTo(X(x + 1), Y(y + 1)); }
            if (!on(x - 1, y)) { g.moveTo(X(x), Y(y)); g.lineTo(X(x), Y(y + 1)); } if (!on(x + 1, y)) { g.moveTo(X(x + 1), Y(y)); g.lineTo(X(x + 1), Y(y + 1)); }
          }
        }
        g.setLineDash([4, 4]); g.strokeStyle = '#000'; g.stroke(); g.lineDashOffset = 4; g.strokeStyle = '#fff'; g.stroke(); g.setLineDash([]); g.lineDashOffset = 0;
      }
      if (drag && drag.tool === 'lasso') { g.beginPath(); drag.pts.forEach(([x, y], i) => g[i ? 'lineTo' : 'moveTo'](S.ox + (x + .5) * z, S.oy + (y + .5) * z)); g.setLineDash([4, 4]); g.strokeStyle = '#fff'; g.stroke(); g.setLineDash([]); }
      const hv = S.hover;
      if (hv && !drag && sized(S.tool) && z >= 3) { /* brush footprint */
        g.strokeStyle = 'rgba(255,255,255,.7)'; g.lineWidth = 1;
        for (const [ox, oy] of brushOffsets(S.size, S.shape)) { const c = cell(d, hv.x + ox, hv.y + oy); if (c) g.strokeRect(S.ox + c[0] * z + .5, S.oy + c[1] * z + .5, z - 1, z - 1); }
      }
    }
    /* In context: the sprite at game scale on the project's background, standing next to the sprites it is seen with, so size,
       silhouette and contrast are judged as a player sees them. Live while drawing. The neighbours come from a group in the
       project's config (`groups`: the enemies of one floor, the weapons of one class...) when one holds the sprite or its family,
       in the group's order and on its background; otherwise from the same folder, one per family, nearest by name. */
    const ctxGroupsOf = (d) => { const fam = famOf.get(d.path), mine = new Set(fam ? fam.members : [d.path]); return S.groups.filter((g) => g.sprites.some((p) => mine.has(p))); };
    function ctxGroup(d) {
      const mine = ctxGroupsOf(d);
      if (S.ctxGroup === '') return null; // "same folder", chosen on purpose
      return mine.find((g) => g.name === S.ctxGroup) || mine[0] || null;
    }
    let ctxHits = []; // where each neighbour sits in the strip, in canvas pixels: a click opens it
    function drawContext(d) {
      ctxHits = [];
      const cv = $('.pf-ctx-cv'), dpr = window.devicePixelRatio || 1, W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
      const k = cv.getContext('2d'), px1 = Math.max(1, Math.round(dpr)), ground = H - Math.round(14 * dpr), gap = Math.round(12 * dpr);
      const grp = ctxGroup(d), groups = ctxGroupsOf(d), bgc = (grp && grp.background) || projectBg() || bgColors()[0];
      setHtml($('.pf-ctx-group'), groups.map((g) => `<option value="${esc(g.name)}"${g === grp ? ' selected' : ''}>${esc(g.name)}</option>`).join('') + `<option value=""${grp ? '' : ' selected'}>Same folder</option>`);
      $('.pf-ctx-group').value = grp ? grp.name : ''; $('.pf-ctx-group').hidden = !groups.length;
      k.imageSmoothingEnabled = false; k.fillStyle = bgc; k.fillRect(0, 0, W, H);
      k.fillStyle = luma(bgc) > 0.55 ? 'rgba(20,10,40,.25)' : 'rgba(230,220,247,.18)'; k.fillRect(0, ground, W, Math.max(1, Math.round(dpr)));
      const cur = document.createElement('canvas'); cur.width = d.w; cur.height = d.h; cur.getContext('2d').putImageData(d.imageData(), 0, 0);
      const fam = famOf.get(d.path), dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
      const sameDir = [...new Set(S.sprites.map((x) => x.path).filter((p) => p !== d.path && (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '') === dir && (!fam || !fam.members.includes(p))).map((p) => { const f = famOf.get(p); return f ? f.members[0] : p; }))];
      sameDir.sort((a, b) => a.localeCompare(b)); const at = sameDir.findIndex((p) => p.localeCompare(d.path) > 0);
      // a group shows the sprites it names (the first it names of each family); the folder view shows each family's first member
      const seenFam = new Set(), ordered = grp ? grp.sprites.filter((p) => { if (p === d.path || (fam && fam.members.includes(p))) return false; const k = famOf.get(p) || p; if (seenFam.has(k)) return false; seenFam.add(k); return true; })
        : at < 0 ? sameDir.slice().reverse() : [...sameDir.slice(at), ...sameDir.slice(0, at).reverse()];
      // Game scale, unless the tallest sprite in view would not fit the strip: then the largest scale that fits, said in the note.
      const room = ground - Math.round(6 * dpr), tallest = Math.max(d.h, ...ordered.slice(0, 8).map((p) => { const im = memberImage(p); return im ? im.height : 0; }));
      const fitScale = Math.max(1, Math.min(S.ctxScale, Math.floor(room / (tallest * px1)))), sc = fitScale * px1;
      const items = [{ img: cur, me: true }]; let used = d.w * sc + gap * 2, shown = 0;
      for (const p of ordered) { const img = memberImage(p); if (!img) continue; if (used + img.width * sc + gap > W) break; used += img.width * sc + gap; items.push({ img, path: p }); shown++; if (shown >= 8) break; }
      // the edited sprite in the middle, neighbours alternating left and right of it
      const row = [items[0]]; items.slice(1).forEach((it, i) => (i % 2 ? row.unshift(it) : row.push(it)));
      let x = Math.round((W - row.reduce((a, it) => a + it.img.width * sc, 0) - gap * (row.length - 1)) / 2);
      for (const it of row) {
        const w = it.img.width * sc, h = it.img.height * sc;
        k.drawImage(it.img, x, ground - h, w, h); if (it.path) ctxHits.push({ x, y: ground - h, w, h, path: it.path });
        if (it.me) { k.fillStyle = '#e08cff'; k.fillRect(x, ground + Math.round(4 * dpr), w, Math.max(1, Math.round(2 * dpr))); }
        x += w + gap;
      }
      $('.pf-ctx-note').textContent = `${fitScale < S.ctxScale ? fitScale + '× to fit' : S.ctxScale + '×'} · ${shown ? shown + ' neighbour' + (shown > 1 ? 's' : '') + ' from ' + (grp ? grp.name : dir || 'the project root') : grp ? 'nothing else in this group' : 'no other sprites in this folder'} · ${grp && grp.background ? 'group background' : projectBg() ? 'project background' : 'background ' + bgColors()[0]}`;
    }
    /* reference image: traced over or compared against, never saved */
    function drawRef(W, H) {
      const r = S.ref, z = S.zoom; g.save(); g.globalAlpha = r.opacity;
      if (r.fit === 'fit') { const k = Math.min(W / r.img.width, H / r.img.height), w = r.img.width * k, h = r.img.height * k; g.imageSmoothingEnabled = !r.pixel; g.drawImage(r.img, S.ox + (W - w) / 2, S.oy + (H - h) / 2, w, h); }
      else { g.imageSmoothingEnabled = false; g.drawImage(r.img, S.ox, S.oy, r.img.width * z, r.img.height * z); }
      g.restore();
    }
    const setHtml = (e, h) => { if (e.__h !== h) { e.__h = h; e.innerHTML = h; } }; // rewrite only on change: the status bar holds buttons people press and hold
    function status() {
      const d = doc();
      const where = !d ? '' : savesOut(d) ? (d.unsaved ? ' · <span class="pf-bad">unsaved</span>' + (keeping() && isKept(d) ? ' (kept in this browser meanwhile)' : '') : d.changed ? ' · saved, not yet in a PR' : '')
        : needsKeep(d) ? (!keeping() ? ' · <span class="pf-bad">not kept: download it before closing</span>' : isKept(d) ? ' · <span class="pf-ok">kept in this browser</span>' + (d.changed && S.src && S.src.kind === 'github' ? ', not in a PR yet' : '') : ' · saving…') : '';
      setHtml($('.pf-s-name'), d ? `<b>${esc(d.path)}</b>${where}${d.changed ? ` · <span class="pf-s-peek" title="Press and hold (or hold \\) to see it as it is on the branch; Shift+\\ shows the last save">${d.changedPixels()} px changed · hold \\ for before</span>` : ''}` : 'No sprite open');
      setHtml($('.pf-s-info'), d ? `<button type="button" class="pf-s-size" title="Canvas size (Ctrl+Alt+C)">${d.w}×${d.h}</button> · zoom ${S.zoom}×` : '');
      const nt = $('.pf-s-note'); if (nt.textContent !== (S.notice || '')) { nt.textContent = S.notice || ''; nt.title = S.notice || ''; }
      $('.pf-zl').textContent = S.zoom + '×'; $('.pf-s-sel').textContent = S.sel ? `selection ${S.sel.w}×${S.sel.h}${S.float ? ' · floating' : ''}` : '';
      $('.pf-undo').disabled = $('.pf-fs-undo').disabled = !d || !d.undo.length; $('.pf-redo').disabled = $('.pf-fs-redo').disabled = !d || !d.redo.length; $('.pf-save').disabled = !d; $('.pf-download').disabled = !d; $('.pf-revert').disabled = !d || !d.changed; $('.pf-delete').hidden = !deletable(d); $('.pf-revert').hidden = !!d && (d.local || d.isNew) && !d.changed;
      const out = d && savesOut(d), pend = d && !out && needsKeep(d) && !isKept(d);
      $('.pf-save').textContent = !d || out || pend || !keeping() ? 'Save' : 'Saved'; $('.pf-save').classList.toggle('primary', !d || !!out || !!pend || !keeping());
      $('.pf-save').title = out ? 'Save to the project (Ctrl+S). Until then your edits are kept in this browser.' : keeping() ? 'Your edits are kept in this browser as you draw and survive reloads (Ctrl+S keeps them right away). Download or Propose PR to take them out.' : 'This browser cannot keep edits: use Download.';
      $('.pf-prbtn').hidden = !O.pr; $('.pf-prbtn').disabled = ![...S.docs.values()].some((x) => x.changed);
    }

    /* ---------- editing ---------- */
    function setTool(t) {
      if (t !== S.tool && S.float) commitFloat();
      S.tool = t; const rail = railOf(t);
      $$('.pf-tools button').forEach((b) => b.classList.toggle('on', b.dataset.t === rail));
      $$('.pf-opt').forEach((o) => { const f = o.dataset.for.split(' '); o.hidden = !(f.includes('*') || f.includes(t)); });
      $$('.pf-filled button').forEach((b) => b.classList.toggle('on', (b.dataset.filled === '1') === (t === 'rectf' || t === 'ellipsef')));
      $$('.pf-selmode button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
      view.style.cursor = t === 'select' ? 'default' : 'crosshair'; render();
    }
    $('.pf-tools').innerHTML = TOOLS.filter((x) => !x[3]).map(([k, n, key]) => `<button data-t="${k}" title="${n} (${key})" aria-label="${n}">${icon(k)}</button>`).join('');
    $('.pf-keys').innerHTML = KEYS.map(([k, v]) => `<div class="pf-key"><kbd>${esc(k)}</kbd><span>${esc(v)}</span></div>`).join('');
    const changedUi = () => { keepSoon(); renderColors(); status(); renderListSoon(); drawPreview(); render(); renderFamilySoon(); renderLayersSoon(); syncLinksSoon(); };
    let lyTimer = 0; const renderLayersSoon = () => { clearTimeout(lyTimer); lyTimer = setTimeout(renderLayers, 120); };
    let famTimer = 0; const renderFamilySoon = () => { clearTimeout(famTimer); famTimer = setTimeout(renderFamily, 150); };
    let listTimer = 0; const renderListSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(renderList, 120); };
    /** Where a pixel lands: wrapped around the edges in tile mode, else null when outside the image. */
    const cell = (d, x, y) => { if (S.tile) return [((x % d.w) + d.w) % d.w, ((y % d.h) + d.h) % d.h]; return x >= 0 && y >= 0 && x < d.w && y < d.h ? [x, y] : null; };
    /** A position plus its mirror images. */
    const mirrored = (d, x, y) => { const out = [[x, y]]; if (S.mx) out.push([d.w - 1 - x, y]); if (S.my) out.push([x, d.h - 1 - y]); if (S.mx && S.my) out.push([d.w - 1 - x, d.h - 1 - y]); return out; };
    const mirrorPts = (d, pts) => pts.flatMap(([x, y]) => mirrored(d, x, y));
    /** Set one pixel (with mirrors and tile wrap), remembering the old value once per stroke. */
    function put(d, x, y, v, rec) {
      for (const [mx, my] of mirrored(d, x, y)) { const c = cell(d, mx, my); if (!c) continue; const i = c[1] * d.w + c[0]; if (rec && !rec.has(i)) rec.set(i, d.px[i]); d.px[i] = v; }
    }
    /** One brush dab at (x,y): size, tip shape, dither pattern and the shade tool all go through here. */
    function dab(d, x, y, drag) {
      for (const [ox, oy] of brushOffsets(sized(drag.tool) ? S.size : 1, S.shape)) {
        const X = x + ox, Y = y + oy;
        if (drag.tool === 'shade') {
          for (const [mx, my] of mirrored(d, X, Y)) { const c = cell(d, mx, my); if (!c) continue; const i = c[1] * d.w + c[0]; if (drag.rec.has(i)) continue; drag.rec.set(i, d.px[i]); d.px[i] = shadeColor(d.px[i], drag.dir, S.palette); }
        } else if (drag.tool === 'pen' && S.pattern === 'dither') { const c = cell(d, X, Y); if (c && ditherOn(c[0], c[1])) put(d, X, Y, drag.value, drag.rec); }
        else put(d, X, Y, drag.value, drag.rec);
      }
    }
    const shapePts = (tool, a, b) => thicken(tool === 'line' ? linePoints(a.x, a.y, b.x, b.y) : tool === 'rect' || tool === 'rectf' ? rectPoints(a.x, a.y, b.x, b.y, tool === 'rectf') : ellipsePoints(a.x, a.y, b.x, b.y, tool === 'ellipsef'), sized(tool) ? S.size : 1, S.shape);
    /** Tools the brush size applies to (filled shapes have no stroke to thicken). */
    function sized(t) { return t === 'pen' || t === 'erase' || t === 'shade' || t === 'line' || t === 'rect' || t === 'ellipse'; }
    const isShape = (t) => t === 'line' || t === 'rect' || t === 'rectf' || t === 'ellipse' || t === 'ellipsef';
    function fillAt(d, x, y, value, other) {
      const tmp = d.px.slice(), seeds = mirrored(d, x, y).map(([a, b]) => cell(d, a, b)).filter(Boolean), region = new Set();
      for (const [sx, sy] of seeds) { const probe = d.px.slice(), mark = (probe[sy * d.w + sx] ^ 0x5a5a5a5a) >>> 0; for (const i of S.fillMode === 'same' ? fillSame(probe, sx, sy, d.w, mark) : floodFill(probe, d.w, d.h, sx, sy, mark)) region.add(i); }
      for (const i of region) { const on = S.pattern !== 'dither' || ditherOn(i % d.w, (i / d.w) | 0); if (on) tmp[i] = value; else if (other != null && !isClear(other)) tmp[i] = other; }
      if (countDiff(tmp, d.px) === 0) return false; d.px = tmp; return true;
    }
    function pickAt(d, c, secondary) {
      const p = cell(d, c.x, c.y); if (!p) return; const v = d.flat()[p[1] * d.w + p[0]]; // what you see, whichever layer it is on
      if (secondary) { S.color2 = isClear(v) ? 0 : v; renderColors(); return; }
      if (isClear(v)) setTool('erase'); else { setColor(v); setTool('pen'); }
    }

    /* selection: S.sel is the selected rectangle; S.float holds lifted or pasted pixels that move with it until they are applied */
    function liftSelection() {
      const d = doc(); if (!d || !S.sel || S.float) return;
      d.snapshot(); const px = copySelPx(d); clearSel(d.px, d.w);
      S.float = { px, w: S.sel.w, h: S.sel.h, x: S.sel.x, y: S.sel.y, mask: S.sel.mask || null };
    }
    function commitFloat() {
      const d = doc(), f = S.float; if (!f) return; S.float = null;
      if (d) {
        pasteRect(d.px, d.w, d.h, f.px, f.w, f.h, f.x, f.y, false);
        const inside = f.x >= 0 && f.y >= 0 && f.x + f.w <= d.w && f.y + f.h <= d.h; // a masked selection stays its shape while it fits
        S.sel = f.mask && inside ? { x: f.x, y: f.y, w: f.w, h: f.h, mask: f.mask } : rectBetween({ x: f.x, y: f.y }, { x: f.x + f.w - 1, y: f.y + f.h - 1 }, d.w, d.h); changedUi();
      }
    }
    function dropSelection() { commitFloat(); S.sel = null; render(); status(); }
    function selectAll() { const d = doc(); if (!d) return; commitFloat(); S.sel = { x: 0, y: 0, w: d.w, h: d.h }; if (!isSelTool(S.tool)) setTool('select'); render(); status(); }
    function copySel(cut) {
      const d = doc(); if (!d || !S.sel && !S.float) return false;
      S.clip = S.float ? { px: S.float.px.slice(), w: S.float.w, h: S.float.h } : { px: copySelPx(d), w: S.sel.w, h: S.sel.h };
      if (cut) { if (S.float) { S.float = null; S.sel = null; changedUi(); } else { d.snapshot(); clearSel(d.px, d.w); S.sel = null; changedUi(); } }
      note((cut ? 'cut ' : 'copied ') + S.clip.w + '×' + S.clip.h); return true;
    }
    function pastePx(px, w, h) {
      const d = doc(); if (!d) return; commitFloat(); d.snapshot();
      const x = S.sel ? S.sel.x : 0, y = S.sel ? S.sel.y : 0;
      S.float = { px: px.slice(), w, h, x, y }; S.sel = { x, y, w, h }; if (!isSelTool(S.tool)) setTool('select'); changedUi(); note('pasted ' + w + '×' + h + ': drag to place, Enter to apply');
    }
    function deleteSel() { const d = doc(); if (!d) return; if (S.float) { S.float = null; S.sel = null; changedUi(); return; } if (!S.sel) return; edit((dd) => clearSel(dd.px, dd.w)); }
    function nudge(dx, dy) { if (!S.sel) return false; liftSelection(); S.float.x += dx; S.float.y += dy; S.sel = { ...S.sel, x: S.float.x, y: S.float.y }; render(); status(); return true; }
    /** Flip or rotate the selection instead of the whole image when there is one. */
    function transformSel(fn) { if (!S.sel) return false; liftSelection(); const f = S.float, r = fn(f.px, f.w, f.h); f.px = r.px; f.w = r.w; f.h = r.h; f.mask = null; S.sel = { x: f.x, y: f.y, w: f.w, h: f.h }; changedUi(); return true; } // the shape stays: what was outside the mask is clear and pastes as nothing
    const selHas = (x, y) => { const r = S.sel; if (!r || x < r.x || y < r.y || x >= r.x + r.w || y >= r.y + r.h) return false; return !r.mask || !!r.mask[(y - r.y) * r.w + x - r.x]; };
    const inSel = (c) => selHas(c.x, c.y);
    const isSelTool = (t) => t === 'select' || t === 'lasso' || t === 'wand';
    /** Clear the selected pixels of px (w wide), mask and all. */
    const clearSel = (px, w) => { const r = S.sel; for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) if (!r.mask || r.mask[y * r.w + x]) px[(r.y + y) * w + r.x + x] = 0; };
    /** The selected pixels as a rectangle, with what is outside the mask left clear. */
    const copySelPx = (d) => { const r = S.sel, o = copyRect(d.px, d.w, d.h, r); if (r.mask) for (let i = 0; i < o.length; i++) if (!r.mask[i]) o[i] = 0; return o; };
    /** A new selection from a whole-image mask, added to (Shift) or taken from (Alt) the current one. */
    function setSelMask(d, m, op) { S.sel = maskSel(op ? combineMasks(selMask(S.sel, d.w, d.h), m, op) : m, d.w, d.h); }

    let drag = null, pan = null, space = false; const pointers = new Map(); let pinch = null;
    /* On a touch screen the first finger of a pinch lands a moment before the second, and would draw (or fill, or pick a colour).
       touchEdit remembers what it changed, so a second finger arriving soon after puts it all back: pinching never draws. */
    let touchEdit = null; const TOUCH_GRACE = 400;
    const capture = (id) => { try { view.setPointerCapture(id); } catch { /* not an active pointer (synthetic events): carry on without */ } };
    function undoTouch() {
      const t = touchEdit; touchEdit = null; if (!t || performance.now() - t.at > TOUCH_GRACE) return;
      const d = t.d, i = t.snap ? d.undo.lastIndexOf(t.snap) : -1;
      if (i >= 0) { d.restore(t.snap); d.undo.length = i; }
      S.color = t.color; S.color2 = t.color2; if (!S.float) S.sel = t.sel; overlay = null;
      changedUi(); renderColors();
    }
    view.addEventListener('contextmenu', (e) => e.preventDefault());
    view.addEventListener('pointerdown', (e) => {
      const d = doc(); if (!d) return;
      /* A stylus on the screen: from then on fingers only pan and zoom, and a palm resting while the pen draws is ignored. */
      if (e.pointerType === 'pen') S.penSeen = true;
      if (e.pointerType === 'touch' && S.penSeen) {
        if ([...pointers.values()].some((p) => p.pointerType === 'pen')) return; // the palm, while the pen is down
        capture(e.pointerId); pointers.set(e.pointerId, e);
        if (pointers.size === 1) { pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy }; return; }
      } else { capture(e.pointerId); pointers.set(e.pointerId, e); }
      touchEdit = e.pointerType === 'touch' && pointers.size === 1 ? { d, at: performance.now(), snap: null, color: S.color, color2: S.color2, sel: S.sel } : touchEdit;
      if (pointers.size === 2) { pan = null; drag = null; undoTouch(); overlay = null; const [a, b] = [...pointers.values()]; pinch = { dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), zoom: S.zoom, cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 }; return; }
      if (e.button === 1 || space || (e.button === 0 && e.shiftKey && e.altKey)) { pan = { x: e.clientX, y: e.clientY, ox: S.ox, oy: S.oy }; return; }
      const c = toCell(e), right = e.button === 2, inb = !!cell(d, c.x, c.y);
      let tool = S.tool;
      if (S.placingNote) { if (inb) addNote(d, c.x, c.y); return; } // + note: this click pins it here, and draws nothing
      if (e.altKey && !isSelTool(tool)) tool = 'pick';
      if (tool === 'pick') { pickAt(d, c, right); return; }
      if (isSelTool(tool)) {
        const op = e.shiftKey ? 'add' : e.altKey ? 'sub' : null; // Shift adds to the selection, Alt takes away
        if (!op && inSel(c)) { liftSelection(); drag = { tool: 'select', move: true, start: c, fx: S.float.x, fy: S.float.y }; status(); return; }
        commitFloat(); const prev = op ? S.sel : null;
        if (tool === 'wand') { // every pixel of that colour: connected (area) or anywhere (same colour), like fill
          if (!inb) return; const probe = d.px.slice(), mark = (probe[c.y * d.w + c.x] ^ 0x5a5a5a5a) >>> 0, m = new Uint8Array(d.w * d.h);
          for (const i of S.fillMode === 'same' ? fillSame(probe, c.x, c.y, d.w, mark) : floodFill(probe, d.w, d.h, c.x, c.y, mark)) m[i] = 1;
          setSelMask(d, m, op); render(); status(); return;
        }
        if (tool === 'lasso') { drag = { tool: 'lasso', pts: [[c.x, c.y]], op, prev }; render(); return; }
        drag = { tool, start: c, op, prev }; if (op) setSelMask(d, selMask(rectBetween(c, c, d.w, d.h), d.w, d.h), op); else S.sel = rectBetween(c, c, d.w, d.h); render(); status(); return;
      }
      if (tool === 'gradient') { // the area: the selection, else what a fill would cover from here
        if (!inb) return;
        let region;
        if (S.sel) { region = []; for (let y = S.sel.y; y < S.sel.y + S.sel.h; y++) for (let x = S.sel.x; x < S.sel.x + S.sel.w; x++) if (selHas(x, y)) region.push(y * d.w + x); }
        else { const probe = d.px.slice(), mark = (probe[c.y * d.w + c.x] ^ 0x5a5a5a5a) >>> 0; region = S.fillMode === 'same' ? fillSame(probe, c.x, c.y, d.w, mark) : floodFill(probe, d.w, d.h, c.x, c.y, mark); }
        d.snapshot(); if (touchEdit && touchEdit.d === d) touchEdit.snap = d.undo[d.undo.length - 1];
        drag = { tool, start: c, last: c, region, base: d.px.slice(), a: right ? S.color2 : S.color, b: right ? S.color : S.color2 };
        d.px = ditherGradient(drag.base.slice(), d.w, region, c.x, c.y, c.x, c.y, drag.a, drag.b); changedUi(); return;
      }
      let value = right ? S.color2 : S.color; if (tool === 'erase') value = 0;
      if (!inb && !isShape(tool)) return;
      d.snapshot(); if (touchEdit && touchEdit.d === d) touchEdit.snap = d.undo[d.undo.length - 1];
      drag = { tool, value, dir: right ? -1 : 1, start: c, last: c, rec: new Map(), trail: [c], visits: new Map([[c.y * d.w + c.x, 1]]), moved: false };
      if (tool === 'fill') { if (!fillAt(d, c.x, c.y, value, right ? S.color : S.color2)) d.undo.pop(); drag = null; changedUi(); return; }
      if (tool === 'pen' && e.shiftKey && S.lastPt) { for (const [x, y] of linePoints(S.lastPt.x, S.lastPt.y, c.x, c.y)) dab(d, x, y, drag); }
      else if (!isShape(tool)) dab(d, c.x, c.y, drag);
      changedUi();
    });
    view.addEventListener('pointermove', (e) => {
      const d = doc(); if (!d) return;
      if (pointers.has(e.pointerId)) pointers.set(e.pointerId, e);
      if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const nd = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); const r = view.getBoundingClientRect(), dpr = view.width / r.width; const z = Math.max(1, Math.min(64, Math.round(pinch.zoom * nd / pinch.dist))); if (z !== S.zoom) { const cx = (pinch.cx - r.left) * dpr, cy = (pinch.cy - r.top) * dpr, px = (cx - S.ox) / S.zoom, py = (cy - S.oy) / S.zoom; S.zoom = z; S.ox = Math.round(cx - px * z); S.oy = Math.round(cy - py * z); render(); status(); } return; }
      if (pan) { S.touched = true; const r = view.getBoundingClientRect(), dpr = view.width / r.width; S.ox = Math.round(pan.ox + (e.clientX - pan.x) * dpr); S.oy = Math.round(pan.oy + (e.clientY - pan.y) * dpr); render(); return; }
      const c = toCell(e), p = cell(d, c.x, c.y);
      $('.pf-s-pos').textContent = p ? `x ${p[0]}  y ${p[1]}  ${toHex(d.flat()[p[1] * d.w + p[0]])}${isClear(d.flat()[p[1] * d.w + p[0]]) ? ' (clear)' : ''}` : '';
      const hovered = !S.hover || S.hover.x !== c.x || S.hover.y !== c.y; S.hover = c;
      if (!drag) { if (hovered && sized(S.tool)) render(); return; }
      if (drag.tool === 'select') {
        if (drag.move) { S.float.x = drag.fx + c.x - drag.start.x; S.float.y = drag.fy + c.y - drag.start.y; S.sel = { x: S.float.x, y: S.float.y, w: S.float.w, h: S.float.h, ...(S.float.mask ? { mask: S.float.mask } : {}) }; }
        else if (drag.op) { S.sel = drag.prev; setSelMask(d, selMask(rectBetween(drag.start, c, d.w, d.h), d.w, d.h), drag.op); }
        else S.sel = rectBetween(drag.start, c, d.w, d.h);
        render(); status(); return;
      }
      if (drag.tool === 'gradient') {
        if (c.x === drag.last.x && c.y === drag.last.y) return; drag.last = c;
        d.px = ditherGradient(drag.base.slice(), d.w, drag.region, drag.start.x, drag.start.y, c.x, c.y, drag.a, drag.b); changedUi(); return;
      }
      if (drag.tool === 'lasso') { const l = drag.pts[drag.pts.length - 1]; if (l[0] !== c.x || l[1] !== c.y) { drag.pts.push([c.x, c.y]); render(); } return; }
      if (drag.tool === 'pen' || drag.tool === 'erase' || drag.tool === 'shade') {
        for (const [x, y] of linePoints(drag.last.x, drag.last.y, c.x, c.y).slice(1)) {
          dab(d, x, y, drag); drag.trail.push({ x, y }); const vk = y * d.w + x; drag.visits.set(vk, (drag.visits.get(vk) || 0) + 1);
          if (S.pp && drag.tool === 'pen' && S.size === 1 && S.pattern === 'solid' && drag.trail.length >= 3) { /* pixel-perfect: drop the middle pixel of an L-shaped corner */
            const [p1, p2, p3] = drag.trail.slice(-3), i = p2.y * d.w + p2.x;
            // only a corner this stroke has just made: never a pixel it already drew earlier (going back over your own stroke must not erase it)
            if (Math.abs(p3.x - p1.x) === 1 && Math.abs(p3.y - p1.y) === 1 && (p2.x === p1.x || p2.y === p1.y) && !(S.mx || S.my || S.tile) && drag.visits.get(i) === 1) { if (drag.rec.has(i)) d.px[i] = drag.rec.get(i); drag.visits.delete(i); drag.trail.splice(-2, 1); }
          }
        }
        drag.last = c; changedUi();
      } else if (isShape(drag.tool)) { // shapes: preview only until release
        const b = e.shiftKey ? constrain(drag.start, c, drag.tool === 'line' ? 'line' : 'box') : c;
        let pts = mirrorPts(d, shapePts(drag.tool, drag.start, b)).map(([x, y]) => cell(d, x, y)).filter(Boolean);
        if (S.pattern === 'dither') pts = pts.filter(([x, y]) => ditherOn(x, y));
        overlay = { pts, value: drag.value }; drag.last = c; drag.moved = true; render();
      }
    });
    const end = (e) => {
      pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; pan = null; if (!pointers.size) touchEdit = null;
      const d = doc(); if (!drag || !d) return;
      if (drag.tool === 'lasso') { S.sel = drag.prev; setSelMask(d, lassoMask(drag.pts, d.w, d.h), drag.op); drag = null; render(); status(); return; }
      if (drag.tool === 'select') { if (!drag.move && !drag.op && S.sel && S.sel.w * S.sel.h <= 1 && drag.start.x === (S.hover || drag.start).x && drag.start.y === (S.hover || drag.start).y) S.sel = null; drag = null; render(); status(); return; }
      if (overlay) { for (const [x, y] of overlay.pts) d.px[y * d.w + x] = overlay.value; overlay = null; }
      else if (isShape(drag.tool) && !drag.moved) { for (const [x, y] of mirrorPts(d, shapePts(drag.tool, drag.start, drag.start))) { const c = cell(d, x, y); if (c && (S.pattern !== 'dither' || ditherOn(c[0], c[1]))) d.px[c[1] * d.w + c[0]] = drag.value; } }
      if (drag.tool === 'pen' || drag.tool === 'erase') S.lastPt = drag.last;
      const same = !d.undo.length || countDiff(d.undo[d.undo.length - 1].px, d.px) === 0 && d.undo[d.undo.length - 1].w === d.w; if (same) d.undo.pop();
      drag = null; changedUi();
    };
    view.addEventListener('pointerup', end); view.addEventListener('pointercancel', end);
    view.addEventListener('pointerleave', () => { if (!drag && S.hover) { S.hover = null; render(); } });
    view.addEventListener('wheel', (e) => { e.preventDefault(); const r = view.getBoundingClientRect(), dpr = view.width / r.width; zoomAt(e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr); status(); }, { passive: false });
    setTool('pen');

    /* ---------- operations ---------- */
    function edit(fn) { const d = doc(); if (!d) return; d.snapshot(); fn(d); changedUi(); }
    /** An edit of the whole image (flip, rotate, resize…): every layer, as one undo step. */
    function editAll(fn) { const d = doc(); if (!d) return; d.snapshot(); d.allLayers(fn); changedUi(); }
    const undo = () => { const d = doc(); if (!d) return; S.float = null; S.sel = null; if (d.undoOnce()) { if (!S.touched) fit(); changedUi(); } else render(); };
    const redo = () => { const d = doc(); if (!d) return; commitFloat(); S.sel = null; if (d.redoOnce()) { if (!S.touched) fit(); changedUi(); } };

    /* ---------- saving & exporting ---------- */
    /* The project's alpha rule, applied as an ordinary (undoable) edit just before a sprite leaves the editor, so the file
       always matches what is on screen. Same-size originals give the hint for kept values. */
    function tidyAlpha(d) {
      if (!S.alpha) return 0;
      const hint = !d.layered && d.base.w === d.w && d.base.h === d.h ? d.base.px : null, out = d.layers.map((l) => { const px = l.px.slice(); return { px, n: snapAlpha(px, S.alpha, hint) }; }), n = out.reduce((t, o) => t + o.n, 0);
      if (n) { d.snapshot(); d.layers.forEach((l, k) => { l.px = out[k].px; }); note(`${n} stray-alpha pixel${n > 1 ? 's' : ''} snapped to the project's alpha rule in ${fileName(d)} (undo brings them back)`); }
      return n;
    }
    async function pngOf(d, scale = 1) {
      if (hasStreams()) return new Blob([await encodePngBytes(d.w, d.h, d.flat(), scale)], { type: 'image/png' });
      const c = document.createElement('canvas'); drawPx(c, d, scale); return toBlob(c);
    }
    /* Save: writes to the project when it can be written (local server, folder, the page's save hook). Everything else stays in
       this browser, kept as you draw (Save only makes that immediate): Download and Propose PR are how sprites leave it. */
    /** Write one sprite (and its layers file) out of the browser. Returns how many stray-alpha pixels were snapped first. */
    async function writeOut(d) {
      const snapped = tidyAlpha(d), blob = await pngOf(d);
      if (O.save) await O.save(d, blob); else {
        await S.src.write(d.path, new Uint8Array(await blob.arrayBuffer()));
        const lf = await layerFile(d); if (lf && lf.delete && S.src.remove) await S.src.remove(lf.path); else if (lf && !lf.delete) await S.src.write(lf.path, lf.blob); if (lf && (!lf.delete || S.src.remove)) layersSent(d, lf);
      }
      d.markSaved(); d.onDisk = true; return snapped;
    }
    async function save() {
      const d = doc(); if (!d) return; commitFloat();
      try {
        if (savesOut(d)) {
          const snapped = await writeOut(d), ids = new Set(d.layers.filter((l) => l.link).map((l) => l.link.id)), also = [];
          if (ids.size) await linkBusy; // the frames a linked layer changed are part of this edit: they are saved with it
          for (const x of S.docs.values()) if (x !== d && savesOut(x) && x.unsaved && x.layers.some((l) => l.link && ids.has(l.link.id)) && famFor(d) && famFor(d).members.includes(x.path)) { await writeOut(x); also.push(fileName(x)); }
          note('saved ' + d.path + (also.length ? ` and the linked frame${also.length > 1 ? 's' : ''} ${also.join(', ')}` : '') + (snapped ? ` · ${snapped} stray-alpha pixel${snapped > 1 ? 's' : ''} snapped to the project's alpha rule (undo brings them back)` : ''));
        } else {
          await flushDrafts(); if (!keeping()) note('This browser cannot keep edits: use Download.'); // otherwise the status bar already says "kept in this browser"
        }
        changedUi();
      } catch (e) { note('Save failed: ' + e.message); }
    }
    function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 3000); }
    const fileName = (d) => d.path.split('/').pop();
    async function downloadPng(scale = 1) { const d = doc(); if (!d) return; commitFloat(); tidyAlpha(d); download(await pngOf(d, scale), fileName(d).replace(/\.png$/i, '') + (scale > 1 ? '@' + scale + 'x' : '') + '.png'); }
    const changedDocs = () => [...S.docs.values()].filter((d) => d.changed || d.local || d.isNew);
    async function downloadAll() {
      commitFloat(); const list = changedDocs(); if (!list.length) return;
      const files = []; for (const d of list) { tidyAlpha(d); files.push({ name: d.path, bytes: new Uint8Array(await (await pngOf(d)).arrayBuffer()) }); if (d.layered) files.push({ name: layersPath(d.path), bytes: await layersPng(d) }); }
      const proj = (S.src && S.src.kind === 'github' && S.src.repo.slug.split('/')[1]) || (S.src && S.src.name) || 'sprites';
      download(new Blob([zipFiles(files)], { type: 'application/zip' }), proj.replace(/[^\w.-]+/g, '-') + '-changed.zip'); note(`downloaded ${files.length} sprite${files.length > 1 ? 's' : ''} as a .zip (with their folders)`);
    }
    function closeDlMenu() { const m = root.querySelector('.pf-dlmenu'); if (m) m.remove(); }
    function openDlMenu() {
      closeDlMenu(); const d = doc(); if (!d) return; const n = changedDocs().length;
      const menu = el(`<div class="pf-bgmenu pf-dlmenu" role="menu">
        <button role="menuitem" data-dl="1"><b>${esc(fileName(d))}</b>&nbsp;<span class="pf-note">${d.w}×${d.h} PNG</span></button>
        ${[2, 4, 8, 16].map((k) => `<button role="menuitem" data-dl="${k}">at ${k}× <span class="pf-note">${d.w * k}×${d.h * k}, for sharing</span></button>`).join('')}
        <button role="menuitem" data-dl="all"${n ? '' : ' disabled'}>All changed sprites (.zip) <span class="pf-note">${n}</span></button></div>`);
      root.appendChild(menu);
      const b = $('.pf-download').getBoundingClientRect(), r = root.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(b.left - r.left, r.width - menu.offsetWidth - 4)) + 'px'; menu.style.top = (b.bottom - r.top + 4) + 'px';
      menu.onclick = (e) => { const t = e.target.closest('[data-dl]'); if (!t || t.disabled) return; closeDlMenu(); if (t.dataset.dl === 'all') downloadAll(); else downloadPng(+t.dataset.dl); };
    }

    /* ---------- preview & animation ---------- */
    const frameKey = (d) => 'pf:frames:' + d.path;
    function loadFrames(d) {
      let f = d.frames; try { const s = JSON.parse(localStorage.getItem(frameKey(d))); if (s) f = s; } catch { /* none */ }
      if (!f) f = d.w > d.h && d.w % d.h === 0 ? { w: d.h, h: d.h, fps: 8 } : { w: d.w, h: d.h, fps: 8 };
      d.frames = f; $('.pf-fw').value = f.w; $('.pf-fh').value = f.h; $('.pf-fps').value = f.fps || 8;
    }
    const frameSize = (d) => (d && d.frames ? { w: Math.max(1, Math.min(d.w, d.frames.w | 0)), h: Math.max(1, Math.min(d.h, d.frames.h | 0)) } : null);
    /* Families (poses, variants, numbered animation frames in separate files): any member as something drawable.
       An open document wins, so edits show up in the strip, the flipbook and the onion skin straight away. */
    const famFor = (d) => { const f = d && famOf.get(d.path); return f && f.members.length > 1 ? f : null; };
    /** A lone sprite as a one-member family. Only the family panel and its + frame button use this —
        everything that plays families (flipbook, stepping, GIF) keeps famFor, so single sprites behave exactly as before. */
    const famOrSingle = (d) => famFor(d) || (d && famOf.get(d.path) && { key: stem(d.path), members: [d.path], animated: false });
    const pending = new Set();
    function memberImage(path) {
      const d = S.docs.get(path);
      if (d) { const c = document.createElement('canvas'); c.width = d.w; c.height = d.h; c.getContext('2d').putImageData(d.imageData(), 0, 0); return c; }
      const bm = thumbs.get(path); if (bm) return bm;
      if (S.src && !pending.has(path)) {
        pending.add(path); const src = S.src;
        src.read(path).then((b) => createImageBitmap(new Blob([b], { type: 'image/png' }))).then((bm2) => { if (S.src !== src) return; thumbs.set(path, bm2); renderFamily(); drawPreview(); render(); }).catch(() => {}).finally(() => pending.delete(path));
      }
      return null;
    }
    const memberLabel = (fam, p) => { const r = p.split('/').pop().replace(/\.png$/i, '').slice(fam.key.length).replace(/^[_-]/, ''); return r || 'base'; };
    function renderFamily() {
      renderSheet();
      const d = doc(), fam = famOrSingle(d), box = $('.pf-fam:not(.pf-sheet)'); box.hidden = !fam || (fam.members.length < 2 && isSheet(d)); if (box.hidden) return;
      const at = fam.members.indexOf(d.path), one = fam.members.length < 2; $('.pf-fam-left').disabled = at <= 0; $('.pf-fam-right').disabled = at >= fam.members.length - 1;
      $('.pf-fam-left').hidden = $('.pf-fam-right').hidden = $('.pf-fam-hint').hidden = $('.pf-fam-port').hidden = one; $('.pf-fam-strip:not(.pf-sheet-strip)').hidden = one;
      $('.pf-fam-name').textContent = fam.key; $('.pf-fam-kind').textContent = fam.members.length > 1 ? (fam.animated ? `animation · ${fam.members.length} frames` : `${fam.members.length} poses / variants`) : 'single sprite';
      const strip = $('.pf-fam-strip:not(.pf-sheet-strip)'); strip.innerHTML = '';
      for (const p of fam.members) {
        const k = fam.members.indexOf(p), hd = fam.members.length > 1 ? holdsOf(d)[k] || 1 : 0;
        const b = el(`<button class="pf-fam-m${p === S.cur ? ' on' : ''}" data-path="${esc(p)}" role="option" title="${esc(p)}"><canvas></canvas><span>${esc(memberLabel(fam, p))}</span>${hd ? `<i class="pf-hold${hd > 1 ? ' x' : ''}" data-k="${k}" title="How long this frame holds: click for ×1 to ×4">×${hd}</i>` : ''}</button>`);
        strip.appendChild(b); const img = memberImage(p), c = b.querySelector('canvas');
        if (img) { c.width = img.width; c.height = img.height; const k = c.getContext('2d'); k.imageSmoothingEnabled = false; k.drawImage(img, 0, 0); }
      }
    }
    function stepMember(dir) { const d = doc(), fam = famFor(d); if (!fam) return; const i = fam.members.indexOf(d.path); openSprite(fam.members[(i + dir + fam.members.length) % fam.members.length]); }
    function drawPreview() {
      const d = doc(), p1 = $('.pf-p1'), p2 = $('.pf-p2');
      if (!d) { p1.width = p1.height = p2.width = p2.height = 0; return; } // nothing open: no picture left over from the last project
      drawPx(p1, d, d.w <= 32 ? 2 : 1);
      const sheet = frameSize(d), fam = famFor(d);
      const flip = !!fam && !(sheet.w < d.w || sheet.h < d.h); p1.hidden = !isSheet(d); $('.pf-sheet-row').hidden = flip;
      if (flip) { // flipbook through the family's images
        const i = S.anim.timer ? holdFrame(S.anim.t, holdsOf(d), fam.members.length) : fam.members.indexOf(d.path), img = memberImage(fam.members[i]);
        $$('.pf-fam-m:not(.pf-sheet-m)').forEach((b, k) => b.classList.toggle('playing', !!S.anim.timer && k === i));
        const w = img ? img.width : d.w, h = img ? img.height : d.h, sc = Math.max(1, Math.min(8, Math.floor(190 / Math.max(w, h))));
        p2.width = w * sc; p2.height = h * sc; const k = p2.getContext('2d'); k.imageSmoothingEnabled = false; k.clearRect(0, 0, p2.width, p2.height);
        if (img) k.drawImage(img, 0, 0, w * sc, h * sc);
        return;
      }
      const f = sheet, cols = Math.max(1, Math.floor(d.w / f.w)), rows = Math.max(1, Math.floor(d.h / f.h)), n = cols * rows, i = S.anim.timer ? holdFrame(S.anim.t, holdsOf(d), n) : Math.min(S.sheetK || 0, n - 1);
      $$('.pf-sheet-m').forEach((b, k) => b.classList.toggle('playing', !!S.anim.timer && k === i));
      const sc = Math.max(1, Math.min(8, Math.floor(190 / f.w)));
      p2.width = f.w * sc; p2.height = f.h * sc; const k = p2.getContext('2d'); k.imageSmoothingEnabled = false; k.clearRect(0, 0, p2.width, p2.height);
      offscreen.width = d.w; offscreen.height = d.h; offscreen.getContext('2d').putImageData(d.imageData(), 0, 0);
      k.drawImage(offscreen, (i % cols) * f.w, Math.floor(i / cols) * f.h, f.w, f.h, 0, 0, f.w * sc, f.h * sc);
    }
    function play(on) {
      clearInterval(S.anim.timer); S.anim.timer = 0; $('.pf-play').textContent = on ? 'Stop' : 'Play';
      if (on) S.anim.timer = setInterval(() => { S.anim.t++; drawPreview(); }, 1000 / Math.max(1, Math.min(60, +$('.pf-fps').value || 8)));
    }
    function frameInputs() {
      const d = doc(); if (!d) return; d.frames = { ...(d.frames || {}), w: +$('.pf-fw').value || d.w, h: +$('.pf-fh').value || d.h, fps: +$('.pf-fps').value || 8 }; // holds stay
      try { localStorage.setItem(frameKey(d), JSON.stringify(d.frames)); } catch { /* ignore */ }
      if (S.anim.timer) play(true); drawPreview(); render(); renderSheet();
    }

    /* ---------- pull request dialog ---------- */
    /** PNG blobs plus description previews for a set of changed documents. */
    async function filesAndPreviews(docs) {
      const files = [], previews = [], extra = [];
      for (const d of docs) {
        const lf = await layerFile(d); if (lf) extra.push({ ...lf, doc: d });
        const sc = previewScale(Math.max(d.w, d.base.w), Math.max(d.h, d.base.h)); // one scale for both sides so they compare 1:1
        tidyAlpha(d); files.push({ path: d.path, blob: await pngOf(d), w: d.w, h: d.h, pixels: d.changedPixels(), scale: sc, baseW: d.base.w, isNew: !!(d.local || d.isNew) });
        previews.push({ before: d.local || d.isNew ? null : await pngOf(new Doc(d.path, d.base.w, d.base.h, d.base.px), sc), after: await pngOf(d, sc) });
      }
      return { files, previews, extra };
    }
    /** After a push: the work lives on the branch, so the documents read clean from here on. */
    function markPushed(docs) { for (const d of docs) { d.base = d.mark(); d.isNew = false; if (!canWrite()) d.local = false; } }
    function openPr() {
      commitFloat(); const changed = [...S.docs.values()].filter((d) => d.changed); if (!changed.length) return;
      const gh = S.meta.repo || {}, dlg = $('.pf-dlg-pr');
      $('.pf-pr-repo').value = $('.pf-pr-repo').value || gh.slug || gh.repo || ''; $('.pf-pr-base').value = $('.pf-pr-base').value || gh.base || gh.branch || '';
      $('.pf-pr-title').value = $('.pf-pr-title').value || (changed.length === 1 ? 'Update ' + changed[0].path.split('/').pop() : 'Update ' + changed.length + ' sprites');
      if (!S.auth.token) try { $('.pf-pr-token').value = $('.pf-pr-token').value || sessionStorage.getItem('pf:token') || localStorage.getItem('pf:token') || ''; } catch { /* storage blocked */ }
      $('.pf-chg-list').innerHTML = changed.map((d) => `<div class="pf-chg"><canvas data-b="${esc(d.path)}" title="before"></canvas><i class="pf-arrow">→</i><canvas data-p="${esc(d.path)}" title="after"></canvas><span>${esc(d.path)}<br><span class="pf-note">${d.w}×${d.h} · ${d.changedPixels()} px changed</span></span></div>`).join('');
      $$('.pf-chg canvas[data-p]').forEach((c) => drawPx(c, S.docs.get(c.dataset.p)));
      $$('.pf-chg canvas[data-b]').forEach((c) => { const b = S.docs.get(c.dataset.b).base; drawPx(c, { w: b.w, h: b.h, imageData: () => new ImageData(new Uint8ClampedArray(b.px.buffer.slice(0)), b.w, b.h) }); });
      $('.pf-log').textContent = ''; dlg.showModal();
    }
    async function submitPr() {
      const changed = [...S.docs.values()].filter((d) => d.changed), log = $('.pf-log'), go = $('.pf-pr-go');
      const typed = $('.pf-pr-token').value.trim(), repo = $('.pf-pr-repo').value.trim(), title = $('.pf-pr-title').value.trim() || 'Update sprites';
      try { if (typed) { if ($('.pf-pr-remember').checked) localStorage.setItem('pf:token', typed); else sessionStorage.setItem('pf:token', typed); } } catch { /* ignore */ }
      go.disabled = true; log.textContent = '';
      try {
        const token = (S.auth.token && !typed ? await authToken() : typed) || '';
        if (!token) throw new Error(authBase ? 'Sign in with GitHub first.' : 'Paste a GitHub token first.');
        const { files, previews, extra } = await filesAndPreviews(changed), cfgOut = pendingConfig(), sentNotes = allNotes();
        const prefix = (S.meta.repo && S.meta.repo.prefix) || '', desc = [$('.pf-pr-desc').value.trim(), cfgOut && configNote(cfgOut)].filter(Boolean).join('\n\n');
        const res = await createPullRequest({ token, repo, base: $('.pf-pr-base').value.trim() || undefined, prefix, title, apiBase: O.apiBase, files: files.map((f) => ({ path: f.path, blob: f.blob })).concat(extra.map(({ path, blob, delete: del }) => ({ path, blob, delete: del })), cfgOut ? [configFile(cfgOut)] : []), previews, branch: 'art/' + slug(title) + '-' + Date.now().toString(36),
          body: (ctx) => prBody({ files, repo, prefix, description: desc, notes: sentNotes, baseSha: ctx.baseSha, commit: ctx.commit, headRepo: ctx.headRepo, previewSha: ctx.previewSha, previewDir: ctx.previewDir }), onProgress: (m) => { log.textContent += m + '\n'; log.scrollTop = log.scrollHeight; } });
        log.innerHTML = `${esc(log.textContent)}Done${res.forked ? ' (from your fork)' : ''}: <a href="${esc(res.url)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">${esc(res.url)}</a>`;
        markPushed(changed); for (const f of extra) layersSent(f.doc, f); // the work now lives in the pull request
        if (sentNotes.length) clearSentNotes(sentNotes);
        if (cfgOut) writeFolders(S.src, { ...cfgOut, sent: true });
        keepSoon(); status(); renderList();
      } catch (e) { log.textContent += '\n' + e.message; if (/rejected the (sign-in|token)/.test(e.message) && S.auth.token) signOut(); } finally { go.disabled = false; }
    }

    /* ---------- commit panel: changes in chunks, outside the pull request dialog ----------
       Tick the files a commit should hold, write a message, and Commit pushes them to a branch:
       an existing one, or a new name that is created on push. The pull request for the branch is
       opened separately, when the work is ready — the panel offers it whenever the branch has none
       open, so chunks accumulate first and one pull request carries them all. */
    let commitSig = null, branchesFor = null, commitBranchWant = ''; // what the panel last rendered; which project the branch lists are for; the branch the panel should target
    const workKey = () => 'pf:work:' + ((S.meta.repo && S.meta.repo.slug) || '');
    function saveWork() { try { if (S.work && S.work.branch) localStorage.setItem(workKey(), JSON.stringify(S.work)); else localStorage.removeItem(workKey()); } catch { /* the work still pushes, only the shortcut is not remembered */ } }
    function loadWork() {
      S.work = null; S.lastPush = null; S.commitSel = null; commitSig = null; branchesFor = null;
      try { const w = JSON.parse(localStorage.getItem(workKey()) || 'null'); if (w && w.branch) S.work = w; } catch { /* start without a remembered branch */ }
      commitBranchWant = (S.work && S.work.branch) || '';
      setCommitBranch(commitBranchWant);
    }
    /** The branch the next commit goes to: the picked one, or the typed new name. */
    function commitBranch() {
      const sel = $('.pf-commit-branches');
      if (sel && sel.value) return sel.value;
      const typed = $('.pf-commit-branch').value.trim();
      return typed || commitBranchWant || '';
    }
    /** Point the panel at a branch: pick it when listed, otherwise offer it as the new name. */
    function setCommitBranch(name) {
      const sel = $('.pf-commit-branches'), input = $('.pf-commit-branch');
      commitBranchWant = name || '';
      if (!sel || !input) return;
      const has = !!name && [...sel.options].some((o) => o.value === name);
      if (has) { sel.value = name; input.hidden = true; }
      else { sel.value = ''; input.hidden = false; if (name) input.value = name; }
    }
    const commitToken = async () => (S.auth.token ? authToken().catch(() => '') : storedToken());
    function renderCommit() {
      const panel = $('.pf-commit'), repo = O.pr !== false && S.meta.repo && S.meta.repo.slug;
      panel.hidden = !repo;
      if (!repo) return;
      const changed = [...S.docs.values()].filter((d) => d.changed);
      $('.pf-commit-n').textContent = changed.length ? `(${changed.length})` : '';
      $('.pf-commit-go').disabled = !changed.length;
      const sig = changed.map((d) => d.path + ':' + d.changedPixels()).join('|');
      if (sig === commitSig) return;
      commitSig = sig;
      if (S.commitSel) S.commitSel = new Set([...S.commitSel].filter((p) => changed.some((d) => d.path === p)));
      $('.pf-commit-list').innerHTML = changed.length ? changed.map((d) => `<label title="${esc(d.path)}"><input type="checkbox" data-path="${esc(d.path)}"${!S.commitSel || S.commitSel.has(d.path) ? ' checked' : ''}><span class="n">${esc(d.path)}<br><small>${d.w}×${d.h} · ${d.changedPixels()} px changed</small></span></label>`).join('')
        : '<div class="pf-note">No changes.</div>';
    }
    /** Branch names for the panel picker and the connect datalist, fetched once per project. Quiet when signed out or offline. */
    async function fillBranches() {
      if (branchesFor === S.src) return; branchesFor = S.src;
      const gh = S.meta.repo || {}, token = await commitToken();
      let names = [];
      if (gh.slug && token) { try { names = await listBranches({ token, repo: gh.slug, apiBase: O.apiBase }); } catch { branchesFor = null; } }
      const sel = $('.pf-commit-branches');
      if (sel) sel.innerHTML = names.map((b) => `<option value="${esc(b)}">⎇ ${esc(b)}</option>`).join('') + '<option value="">+ New</option>';
      const dl = $('#pf-c-branchlist');
      if (dl && gh.slug && token && names.length) dl.innerHTML = names.map((b) => `<option value="${esc(b)}">`).join('');
      setCommitBranch(commitBranchWant || (sel && sel.value) || '');
    }
    async function submitCommit() {
      commitFloat();
      const all = [...S.docs.values()].filter((d) => d.changed);
      const sel = !S.commitSel ? all : all.filter((d) => S.commitSel.has(d.path));
      const note = $('.pf-commit-note'), go = $('.pf-commit-go');
      if (!sel.length) { note.textContent = all.length ? 'Tick at least one sprite to commit.' : 'No changes.'; return; }
      const token = await commitToken();
      if (!token) { note.textContent = 'Sign in at the top of this panel, or open Propose PR once to add a token, then Commit again.'; return; }
      const gh = S.meta.repo || {};
      const message = $('.pf-commit-msg').value.trim() || (sel.length === 1 ? 'Update ' + sel[0].path.split('/').pop() : 'Update ' + sel.length + ' sprites');
      const branch = commitBranch() || (S.work && S.work.branch) || ('art/' + slug(message) + '-' + Date.now().toString(36));
      go.disabled = true; note.textContent = '';
      try {
        const { files, extra } = await filesAndPreviews(sel), cfgOut = pendingConfig();
        const res = await pushSprites({ token, repo: gh.slug, base: gh.base || undefined, branch, prefix: gh.prefix || '', files: files.map((f) => ({ path: f.path, blob: f.blob })).concat(extra.map(({ path, blob, delete: del }) => ({ path, blob, delete: del })), cfgOut ? [configFile(cfgOut)] : []), message, apiBase: O.apiBase, onProgress: (m) => { note.textContent = m; } });
        markPushed(sel); for (const f of extra) layersSent(f.doc, f); if (cfgOut) writeFolders(S.src, { ...cfgOut, sent: true });
        S.commitSel = null; commitSig = null; $('.pf-commit-msg').value = '';
        if (![...$('.pf-commit-branches').options].some((o) => o.value === res.branch)) $('.pf-commit-branches').insertAdjacentHTML('afterbegin', `<option value="${esc(res.branch)}">⎇ ${esc(res.branch)}</option>`);
        setCommitBranch(res.branch);
        const meta = files.map((f) => ({ path: f.path, w: f.w, h: f.h, pixels: f.pixels, scale: f.scale, baseW: f.baseW, isNew: f.isNew }));
        const prev = S.lastPush && S.lastPush.branch === res.branch ? S.lastPush : null;
        S.lastPush = { branch: res.branch, message, files: (prev ? prev.files : []).filter((m) => !meta.some((x) => x.path === m.path)).concat(meta), baseSha: res.baseSha || (prev && prev.baseSha) || null, commit: res.commit };
        S.work = { branch: res.branch, headRepo: res.headRepo, headOwner: res.headOwner, base: res.base, pr: (S.work && S.work.branch === res.branch && S.work.pr) || null };
        saveWork(); branchesFor = null;
        const open = await openPulls({ token, repo: gh.slug, branch: res.branch, owner: res.headOwner || undefined, apiBase: O.apiBase }).catch(() => null);
        const found = open && open[0];
        if (found) {
          S.work.pr = { number: found.number, url: found.url }; saveWork();
          note.innerHTML = `Committed ${sel.length} sprite${sel.length > 1 ? 's' : ''} to ${esc(res.branch)} — added to <a href="${esc(found.url)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">#${found.number}</a>.`;
        } else {
          note.innerHTML = `${esc(res.created ? 'Created' : 'Committed to')} ${esc(res.branch)} (${esc(res.commit.slice(0, 7))}). <button type="button" class="pf-commit-openpr">Open a pull request</button>`;
        }
        keepSoon(); status(); renderList();
      } catch (e) { note.textContent = e.message; if (/rejected the (sign-in|token)/.test(e.message) && S.auth.token) signOut(); } finally { go.disabled = false; }
    }
    async function submitOpenPr() {
      const btn = $('.pf-commit-openpr'), note = $('.pf-commit-note');
      const work = S.work || {}, lp = S.lastPush || {};
      const branch = work.branch || lp.branch || commitBranch();
      if (!branch) { note.textContent = 'Commit something first.'; return; }
      const token = await commitToken();
      if (!token) { note.textContent = 'Sign in at the top of this panel, or open Propose PR once to add a token, then try again.'; return; }
      const gh = S.meta.repo || {};
      if (btn) btn.disabled = true;
      try {
        const files = lp.branch === branch ? lp.files : [], sentNotes = allNotes();
        const res = await openPull({ token, repo: gh.slug, branch, headOwner: work.headOwner || undefined, base: work.base || gh.base || undefined, title: $('.pf-commit-msg').value.trim() || lp.message || branch,
          body: prBody({ files, notes: sentNotes, description: '', repo: gh.slug, baseSha: lp.baseSha || undefined, commit: lp.commit || undefined, headRepo: work.headRepo || undefined, prefix: gh.prefix || '' }), apiBase: O.apiBase, onProgress: (m) => { note.textContent = m; } });
        S.work = { ...work, branch, pr: { number: res.number, url: res.url } }; saveWork(); if (sentNotes.length) clearSentNotes(sentNotes);
        note.innerHTML = `Pull request <a href="${esc(res.url)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">#${res.number}</a> opened for ${esc(branch)}.`;
      } catch (e) { note.textContent = e.message; } finally { if (btn) btn.disabled = false; }
    }

    /* ---------- events ---------- */
    root.addEventListener('click', (e) => {
      const hold = e.target.closest('.pf-hold'); if (hold) { e.stopPropagation(); return cycleHold(+hold.dataset.k); }
      const t = e.target.closest('button'); if (!t) return;
      if (t.dataset.t) return setTool(t.dataset.t);
      if (t.classList.contains('pf-sheet-m')) return pickSheetFrame(+t.dataset.k);
      if (t.classList.contains('pf-item')) return openSprite(t.dataset.path);
      if (t.classList.contains('pf-dir')) return toggleDir(t.dataset.dir);
      if (t.classList.contains('pf-openrow')) return toggleDir(t.dataset.dir);
      if (t.classList.contains('pf-fold-all')) return setAllFolded(true);
      if (t.classList.contains('pf-unfold-all')) return setAllFolded(false);
      if (t.classList.contains('pf-commit-openpr')) return submitOpenPr();
      if (t.classList.contains('pf-hidden-toggle')) { const hid = S.src.hidden || []; if (S.sprites.some((x) => x.hiddenByDefault)) S.sprites = S.sprites.filter((x) => !x.hiddenByDefault); else S.sprites = S.sprites.concat(hid.filter((x) => !isLayersFile(x.path)).map((x) => ({ ...x, hiddenByDefault: true }))); return renderList(); }
      if (t.classList.contains('pf-fam-m')) return openSprite(t.dataset.path);
      if (t.dataset.c !== undefined && t.closest('.pf-sw')) return e.shiftKey ? setColor2(+t.dataset.c) : setColor(+t.dataset.c);
      if (t.dataset.d) { const [dx, dy] = t.dataset.d.split(',').map(Number); return editAll((d) => { d.px = shiftWrap(d.px, d.w, d.h, dx, dy); }); }
    });
    root.addEventListener('contextmenu', (e) => { const t = e.target.closest('.pf-sw button[data-c]'); if (t) { e.preventDefault(); setColor2(+t.dataset.c); } });
    $('.pf-q').oninput = renderList;
    $('.pf-commit-go').onclick = submitCommit;
    $('.pf-commit').addEventListener('toggle', () => { if ($('.pf-commit').open) fillBranches(); });
    $('.pf-commit-branches').addEventListener('focus', fillBranches);
    $('.pf-commit-branches').addEventListener('change', () => {
      const sel = $('.pf-commit-branches'), input = $('.pf-commit-branch');
      input.hidden = sel.value !== '';
      if (sel.value) commitBranchWant = sel.value;
    });
    root.addEventListener('change', (e) => {
      const c = e.target.closest('.pf-commit-list input[type=checkbox]'); if (!c) return;
      if (!S.commitSel) S.commitSel = new Set([...S.docs.values()].filter((d) => d.changed).map((d) => d.path));
      if (c.checked) S.commitSel.add(c.dataset.path); else S.commitSel.delete(c.dataset.path);
    });
    /* background behind transparent pixels: a menu on the Background button, K cycles, the choice is remembered */
    const projectBg = () => { const b = O.background || (S.src && S.src.background); return typeof b === 'string' && fromHex(b) != null ? toHex(fromHex(b)) : null; };
    const bgModes = () => BACKGROUNDS.filter(([m]) => m !== 'project' || projectBg());
    const bgMode = () => (S.bg === 'auto' || (S.bg === 'project' && !projectBg()) ? (projectBg() ? 'project' : 'dark') : S.bg);
    function bgColors() {
      const m = bgMode();
      if (m === 'light') return ['#d6d6de', '#f2f2f6'];
      if (m === 'black') return ['#000000', '#000000'];
      if (m === 'white') return ['#ffffff', '#ffffff'];
      if (m === 'custom') return [S.bgCustom, S.bgCustom];
      if (m === 'project') return [projectBg(), projectBg()];
      return ['#3a3150', '#29223a'];
    }
    function applyBg() {
      const [a, b] = bgColors(); root.style.setProperty('--pf-ck1', a); root.style.setProperty('--pf-ck2', b);
      $('.pf-bg').title = 'Background: ' + BACKGROUNDS.find(([m]) => m === bgMode())[1].toLowerCase() + ' (K cycles)'; render();
      const menu = root.querySelector('.pf-bgmenu'); if (menu) menu.querySelectorAll('[data-bg]').forEach((x) => x.classList.toggle('on', x.dataset.bg === bgMode()));
    }
    function setBg(mode, custom) { S.bg = mode; if (custom) S.bgCustom = custom; try { localStorage.setItem('pf:bg', JSON.stringify({ mode, custom: S.bgCustom })); } catch { /* not remembered */ } applyBg(); }
    try { const saved = JSON.parse(localStorage.getItem('pf:bg') || 'null'); if (saved) { S.bg = saved.mode || 'auto'; if (fromHex(saved.custom || '') != null) S.bgCustom = saved.custom; } } catch { /* defaults */ }
    const swatchCss = (m) => { const [a, b] = m === 'dark' ? ['#3a3150', '#29223a'] : m === 'light' ? ['#d6d6de', '#f2f2f6'] : m === 'black' ? ['#000', '#000'] : m === 'white' ? ['#fff', '#fff'] : m === 'custom' ? [S.bgCustom, S.bgCustom] : [projectBg(), projectBg()]; return `background:repeating-conic-gradient(${a} 0 25%,${b} 0 50%) 0 0/8px 8px`; };
    function closeBgMenu() { const m = root.querySelector('.pf-bgmenu'); if (m) m.remove(); }
    function openBgMenu() {
      closeBgMenu();
      const menu = el(`<div class="pf-bgmenu" role="menu">${bgModes().map(([m, n]) => `<button role="menuitemradio" data-bg="${m}"><span class="pf-bg-sw" style="${swatchCss(m)}"></span>${esc(n)}${m === 'project' ? ` <span class="pf-note">${esc(projectBg())}</span>` : ''}</button>`).join('')}<label>custom <input type="color" class="pf-bgcustom" value="${esc(S.bgCustom)}"></label></div>`);
      root.appendChild(menu);
      const b = $('.pf-bg').getBoundingClientRect(), r = root.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(b.left - r.left, r.width - menu.offsetWidth - 4)) + 'px'; menu.style.top = (b.bottom - r.top + 4) + 'px';
      menu.onclick = (e) => { const t = e.target.closest('[data-bg]'); if (!t) return; setBg(t.dataset.bg); closeBgMenu(); };
      menu.querySelector('.pf-bgcustom').oninput = (e) => { setBg('custom', e.target.value); menu.querySelector('[data-bg="custom"] .pf-bg-sw').setAttribute('style', swatchCss('custom')); };
      applyBg();
    }
    $('.pf-bg').onclick = (e) => { e.stopPropagation(); root.querySelector('.pf-bgmenu') ? closeBgMenu() : openBgMenu(); };
    const bgOutside = (e) => { const m = root.querySelector('.pf-bgmenu'); if (m && !m.contains(e.target) && !e.target.closest('.pf-bg')) closeBgMenu(); };
    document.addEventListener('pointerdown', bgOutside);
    const cycleBg = () => { const list = bgModes().map(([m]) => m), i = list.indexOf(bgMode()); setBg(list[(i + 1) % list.length]); };
    /* tool options */
    const segOn = (box, b) => $$(box + ' button').forEach((x) => x.classList.toggle('on', x === b));
    const setSize = (n) => { S.size = Math.max(1, Math.min(16, n | 0)); $('.pf-size').value = S.size; $('.pf-sizev').textContent = S.size; render(); };
    $('.pf-size').oninput = (e) => setSize(+e.target.value);
    $$('.pf-shape button').forEach((b) => (b.onclick = () => { S.shape = b.dataset.shape; segOn('.pf-shape', b); render(); }));
    $$('.pf-pattern button').forEach((b) => (b.onclick = () => { S.pattern = b.dataset.pattern; segOn('.pf-pattern', b); }));
    $$('.pf-fillmode button').forEach((b) => (b.onclick = () => { S.fillMode = b.dataset.fill; segOn('.pf-fillmode', b); }));
    $$('.pf-filled button').forEach((b) => (b.onclick = () => { const base = railOf(S.tool); setTool(b.dataset.filled === '1' ? base + 'f' : base); }));
    $('.pf-tile').onclick = (e) => { S.tile = !S.tile; e.currentTarget.classList.toggle('on', S.tile); if (S.tile && !S.touched && doc()) { const d = doc(), r = stage.getBoundingClientRect(), dpr = window.devicePixelRatio || 1; S.zoom = Math.max(1, Math.min(64, Math.floor(Math.min((r.width * dpr - 40) / (d.w * 3), (r.height * dpr - 40) / (d.h * 3))))); S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2); } else if (!S.tile && !S.touched) fit(); render(); status(); };
    $('.pf-onion').onclick = (e) => { S.onion = !S.onion; e.currentTarget.classList.toggle('on', S.onion); const d = doc(), f = frameSize(d); if (S.onion && d && !(f.w < d.w || f.h < d.h) && !famFor(d)) note('Onion skin needs animation frames: a sprite sheet (set the frame size under Preview) or numbered files like walk_0, walk_1.'); render(); };
    $('.pf-help').onclick = () => $('.pf-dlg-keys').showModal();
    /* feedback: signed in with GitHub, the screenshot and the details go to the sign-in service's /feedback, which opens the issue as
       the reporter with the screenshot inline (see worker/index.js). Signed out, or when sending fails, a prefilled issue link (see feedbackUrl). */
    const fbRepo = O.feedback === false ? null : typeof O.feedback === 'string' ? O.feedback : (O.feedback && O.feedback.repo) || FEEDBACK_REPO;
    let fbKind = 'bug', fbShot = null, fbDetails = '', fbCopied = false; S.fbSending = false; S.fbFailed = false; // on S: renderAuth asks fbSync, maybe before this line has run
    const FB_HINT = { bug: 'What happened, and what did you expect instead?', idea: 'What would make spritewright better for you?', other: 'Anything you would like to tell us.' };
    const FB_NOTE = 'Sent as a public GitHub issue on spritewright, with the screenshot and the details above. Your sprites are not sent.';
    function feedbackRows() {
      const d = doc(), src = S.src, pub = !!(src && src.kind === 'github' && src.public), f = d && frameSize(d), fam = d && famFor(d);
      const project = !src ? 'none' : src.kind === 'github' ? (pub ? `${src.repo.slug} @ ${src.branch}` : 'GitHub repository (private or unknown, name left out)') : ({ folder: 'folder on this computer', browser: 'project in this browser', server: 'local server (npx spritewright)', static: 'static manifest' }[src.kind] || src.kind);
      const changed = [...S.docs.values()].filter((x) => x.changed).length;
      const rows = [['Page', location.hostname === 'snowu.github.io' ? 'hosted (snowu.github.io)' : src && src.kind === 'server' ? 'local server' : 'self-hosted or embedded'], ['Project', project], ['Sprites', `${S.sprites.length} listed · ${changed} changed`]];
      if (d) rows.push(['Sprite', `${pub ? d.path + ' · ' : ''}${d.w}×${d.h}${f && (f.w < d.w || f.h < d.h) ? ` · frames ${f.w}×${f.h}` : ''}${fam ? ' · in a family' : ''}${d.changed ? ` · ${d.changedPixels()} px changed` : ''}`]);
      rows.push(['Tool', `${S.tool} · size ${S.size} ${S.shape}${S.pattern !== 'solid' ? ' · ' + S.pattern : ''}${S.mx || S.my ? ' · mirror ' + (S.mx ? 'X' : '') + (S.my ? 'Y' : '') : ''}${S.sel ? ` · selection ${S.sel.w}×${S.sel.h}` : ''}`],
        ['View', [`zoom ${S.zoom}×`, S.grid && 'grid', S.tile && 'tile', S.onion && 'onion skin', S.ctx && 'context', S.vision !== 'normal' && 'vision ' + S.vision, 'background ' + S.bg, root.classList.contains('pf-fs') && 'fullscreen'].filter(Boolean).join(' · ')],
        ['Kept in browser', keeping() ? 'yes' : 'no (storage blocked)']);
      if (S.notice) rows.push(['Last message', S.notice]);
      const standalone = typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches;
      rows.push(['Screen', `${innerWidth}×${innerHeight} @${window.devicePixelRatio || 1}x${navigator.maxTouchPoints > 0 ? ' · touch' : ''}${standalone ? ' · installed app' : ''}`], ['Browser', navigator.userAgent]);
      return rows;
    }
    const FB_LINK_NOTE = 'Opens a GitHub issue in a new tab with all of this filled in, and copies the screenshot so you can paste it there (Ctrl+V). You need a GitHub account, and issues are public. Your sprites never leave this browser.';
    const fbLink = () => { const a = $('.pf-fb-go'); if (a) a.href = feedbackUrl({ what: $('.pf-fb-text').value, details: fbDetails, kind: fbKind, repo: fbRepo }); };
    /** Send is for signed-in people (with a sign-in service) with something written; everyone else gets the prefilled link. renderAuth
        calls this too, so signing in from the dialog swaps the link for Send. A failed send shows the link as well. */
    function fbSync() {
      const on = !!(authBase && S.auth.token), send = $('.pf-fb-send'); if (!send) return;
      send.disabled = !on || S.fbSending || !!$('.pf-fb-done') || !$('.pf-fb-text').value.trim(); send.hidden = !on;
      $('.pf-fb-link').hidden = on && !S.fbFailed; $('.pf-dlg-feedback .pf-auth-row').hidden = !authBase;
      if (!S.fbSending && !$('.pf-fb-done') && !S.fbFailed && !fbCopied) $('.pf-fb-note').textContent = on ? FB_NOTE : authBase ? FB_LINK_NOTE + ' Or sign in with GitHub to send it from here, screenshot included.' : FB_LINK_NOTE;
    }
    /** Chrome and Safari take a promise here, which keeps the write inside the click that asked for it. */
    async function fbCopy() {
      try {
        if (!fbShot || !navigator.clipboard || !navigator.clipboard.write || typeof ClipboardItem === 'undefined') return false;
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': fbShot.then((b) => b || Promise.reject(new Error('no screenshot'))) })]); return true;
      } catch { return false; }
    }
    const fbNote = (ok) => { $('.pf-fb-note').textContent = ok ? 'Screenshot copied: paste it into the issue on GitHub with Ctrl+V (⌘V).' : 'Could not copy the screenshot: use Save screenshot and attach the file to the issue.'; };
    /** At most 4 MB (what the service takes): a screenshot from a big high-density screen is drawn again at half size. */
    async function fbPng(b) {
      for (let i = 0; b && b.size > 4e6 && i < 3; i++) { const img = await createImageBitmap(b), c = document.createElement('canvas'); c.width = img.width >> 1; c.height = img.height >> 1; c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); b = await toBlob(c); }
      return b && b.size <= 4e6 ? b : null;
    }
    async function fbSend() {
      const what = $('.pf-fb-text').value.trim(); if (!what || S.fbSending) return;
      S.fbSending = true; S.fbFailed = false; $('.pf-fb-text').disabled = true; $('.pf-fb-send').textContent = 'Sending…'; fbSync(); $('.pf-fb-note').textContent = '';
      try {
        const token = await authToken(); if (!token) throw new Error('Sign in with GitHub to send feedback.');
        const png = await fbPng(fbShot ? await fbShot : null), bytes = png ? new Uint8Array(await png.arrayBuffer()) : null;
        let bin = ''; if (bytes) for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        const r = await fetch(authBase.replace(/\/$/, '') + '/feedback', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify({ kind: fbKind, what, details: fbDetails, screenshot: bytes ? btoa(bin) : null }) });
        const res = await r.json().catch(() => ({}));
        if (!r.ok || !res.url) throw new Error(res.error || 'The feedback service answered ' + r.status + '.');
        $('.pf-fb-note').innerHTML = `<span class="pf-fb-done">Sent, thank you! It is issue <a href="${esc(res.url)}" target="_blank" rel="noopener" style="color:var(--pf-accent)">#${esc(res.number)}</a> on GitHub, where you can add more any time.</span>`;
        $('.pf-fb-send').textContent = 'Sent'; S.fbSending = false; $('.pf-fb-send').disabled = true;
      } catch (err) {
        S.fbSending = false; S.fbFailed = true; $('.pf-fb-text').disabled = false; $('.pf-fb-send').textContent = 'Send feedback'; fbLink(); fbSync();
        $('.pf-fb-note').textContent = ((err && err.message) || 'Could not send it.') + ' Try again, or open it on GitHub yourself.';
      }
    }
    function openFeedback() {
      if (!fbRepo) return;
      const capture = captureDom(root); // before the dialog opens, so the picture is of the editor, not of the form
      fbShot = capture ? capture().then(async (b) => b || (doc() ? await toBlob(view).catch(() => null) : null)) : Promise.resolve(null); // a browser that will not draw the DOM: the sprite canvas alone
      const rows = feedbackRows(); fbDetails = feedbackDetails(rows);
      $('.pf-fb-facts').innerHTML = '<tbody>' + rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join('') + '</tbody>';
      const shot = $('.pf-fb-shot'), old = shot.querySelector('img'); if (old) URL.revokeObjectURL(old.src);
      shot.innerHTML = '<span class="pf-note">Taking a screenshot…</span>'; $('.pf-fb-copy').disabled = $('.pf-fb-save').disabled = true;
      const mine = fbShot;
      fbShot.then((b) => {
        if (mine !== fbShot) return;
        if (!b) { shot.innerHTML = '<span class="pf-note">The screenshot did not work in this browser: the feedback goes without one (on GitHub, you can paste one of your own).</span>'; return; }
        const img = document.createElement('img'); img.alt = 'Screenshot that goes with the feedback'; img.src = URL.createObjectURL(b); shot.replaceChildren(img);
        $('.pf-fb-copy').disabled = $('.pf-fb-save').disabled = false;
      });
      if ($('.pf-fb-done')) $('.pf-fb-text').value = ''; // a fresh form after a report went out
      $('.pf-fb-note').textContent = ''; $('.pf-fb-text').disabled = false; $('.pf-fb-send').textContent = 'Send feedback'; S.fbSending = S.fbFailed = fbCopied = false;
      renderAuth(); fbLink(); fbSync(); $('.pf-dlg-feedback').showModal(); $('.pf-fb-text').focus();
    }
    $('.pf-feedback').hidden = !fbRepo;
    $('.pf-feedback').onclick = openFeedback;
    $$('.pf-fb-kind button').forEach((b) => (b.onclick = () => { fbKind = b.dataset.kind; segOn('.pf-fb-kind', b); $('.pf-fb-text').placeholder = FB_HINT[fbKind]; fbLink(); }));
    $('.pf-fb-text').placeholder = FB_HINT.bug; $('.pf-fb-text').oninput = () => { fbLink(); fbSync(); };
    $('.pf-fb-send').onclick = fbSend;
    // Copy first, then open: opening the tab first moves focus away, and a clipboard write from an unfocused page is refused,
    // silently. The click's user activation outlives the copy, so the tab still opens as the person's own action.
    $('.pf-fb-go').onclick = (e) => {
      if (fbCopied) return; // already on the clipboard: a plain link again
      e.preventDefault(); const href = $('.pf-fb-go').href;
      fbCopy().then((ok) => {
        fbCopied = true; fbNote(ok); setTimeout(() => (fbCopied = false), 3000);
        const w = window.open(href, '_blank'); // not 'noopener' in the features: with it, window.open returns null even when the tab opened
        if (w) w.opener = null; else $('.pf-fb-note').textContent += ' Your browser blocked the new tab: press Open on GitHub again.';
      });
    };
    $('.pf-fb-copy').onclick = () => fbCopy().then(fbNote);
    $('.pf-fb-save').onclick = () => fbShot && fbShot.then((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `spritewright-feedback-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); });
    /* vision check: how the art reads by value alone, and to players with the three main kinds of colour blindness */
    const VISION = [['normal', ''], ['grey', 'values (greyscale)'], ['protan', 'protanopia · red-blind'], ['deutan', 'deuteranopia · green-blind'], ['tritan', 'tritanopia · blue-blind']];
    function setVision(mode) {
      S.vision = mode; root.dataset.vision = mode; const v = VISION.find(([m]) => m === mode);
      $('.pf-vision').classList.toggle('on', mode !== 'normal'); $('.pf-vision-tag').hidden = mode === 'normal'; $('.pf-vision-tag').textContent = v[1];
      $('.pf-vision').title = 'Vision check: ' + (mode === 'normal' ? 'normal' : v[1]) + ' (Y cycles)';
    }
    $('.pf-vision').onclick = () => { const i = VISION.findIndex(([m]) => m === S.vision); setVision(VISION[(i + 1) % VISION.length][0]); };
    /* animation: frames that are separate numbered files (flame_0, flame_1...) */
    const frameNo = (fam, p) => { const r = p.split('/').pop().replace(/\.png$/i, '').slice(fam.key.length); const m = /^([_-])(\d+)$/.exec(r); return m ? { sep: m[1], n: +m[2], pad: m[2].length } : null; };
    $('.pf-fam-add').onclick = async () => {
      const d = doc(); if (!d) return;
      const fam = famOrSingle(d); if (!fam) return;
      const nums = fam.members.map((p) => frameNo(fam, p)).filter(Boolean), sep = nums[0] ? nums[0].sep : '_', pad = nums[0] ? nums[0].pad : 1, n = nums.length ? Math.max(...nums.map((x) => x.n)) + 1 : 1;
      const dir = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/') + 1) : '', path = `${dir}${fam.key}${sep}${String(n).padStart(pad, '0')}.png`;
      if (S.sprites.some((x) => x.path === path)) return note(path + ' already exists');
      await addLocal(path, d.w, d.h, d.flat().slice(), canWrite(), true);
      const nd = S.docs.get(path); if (nd && d.layered) { nd.setLayers(copyLayers(d.layers), d.active); changedUi(); } // the copy keeps the layers
      note(`new frame ${path.split('/').pop()}: a copy of ${d.path.split('/').pop()}${canWrite() ? '' : ' (kept in this browser; Propose PR adds it)'}`);
    };
    async function moveFrame(dir) {
      const d = doc(), fam = famFor(d); if (!d || !fam) return;
      const i = fam.members.indexOf(d.path), j = i + dir; if (j < 0 || j >= fam.members.length) return;
      const o = await loadDoc(fam.members[j]); if (!o) return;
      d.snapshot(); o.snapshot();
      [d.layers, o.layers] = [o.layers, d.layers]; [d.active, o.active] = [o.active, d.active]; [d.w, o.w] = [o.w, d.w]; [d.h, o.h] = [o.h, d.h];
      await openSprite(o.path); note(`moved ${dir < 0 ? 'earlier' : 'later'}: now ${o.path.split('/').pop()}`); changedUi(); renderList();
    }
    $('.pf-fam-left').onclick = () => moveFrame(-1); $('.pf-fam-right').onclick = () => moveFrame(1);
    /* ---------- sprite sheets: the frames of one image, and how long each one holds ----------
       A sheet's holds live with its frame size (d.frames.holds, remembered like the size); a family's in this browser per family. */
    const isSheet = (d) => { const f = d && frameSize(d); return !!f && (f.w < d.w || f.h < d.h); };
    const famHoldKey = (fam, d) => 'pf:holds:' + (d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/') + 1) : '') + fam.key;
    function holdsOf(d) {
      if (!d) return [];
      if (isSheet(d)) return (d.frames && d.frames.holds) || [];
      const fam = famFor(d); if (!fam) return []; try { return JSON.parse(localStorage.getItem(famHoldKey(fam, d)) || '[]'); } catch { return []; }
    }
    function setHolds(d, hs) {
      if (isSheet(d)) { d.frames = { ...d.frames, holds: hs }; try { localStorage.setItem(frameKey(d), JSON.stringify(d.frames)); } catch { /* this visit */ } return; }
      const fam = famFor(d); if (fam) try { localStorage.setItem(famHoldKey(fam, d), JSON.stringify(hs)); } catch { /* this visit */ }
    }
    function cycleHold(k) { const d = doc(); if (!d) return; const hs = holdsOf(d).slice(); hs[k] = ((hs[k] || 1) % 4) + 1; for (let i = 0; i < k; i++) hs[i] = hs[i] || 1; setHolds(d, hs); renderFamily(); drawPreview(); note(`frame ${k + 1} holds ×${hs[k]}`); }
    function sheetInfo(d) { const f = frameSize(d), cols = Math.max(1, Math.floor(d.w / f.w)), rows = Math.max(1, Math.floor(d.h / f.h)); return { f, cols, rows, n: cols * rows }; }
    function renderSheet() {
      const d = doc(), box = $('.pf-sheet'), on = isSheet(d); box.hidden = !on; if (!on) return;
      const { f, cols, n } = sheetInfo(d), k0 = Math.min(S.sheetK || 0, n - 1), hs = holdsOf(d); S.sheetK = k0;
      $('.pf-sheet-kind').textContent = `${n} frames · ${f.w}×${f.h}`;
      $('.pf-sh-left').disabled = k0 <= 0; $('.pf-sh-right').disabled = k0 >= n - 1; $('.pf-sh-del').disabled = n <= 1;
      const strip = $('.pf-sheet-strip'); strip.innerHTML = '';
      for (let k = 0; k < n; k++) {
        const b = el(`<button class="pf-fam-m pf-sheet-m${k === k0 ? ' on' : ''}" data-k="${k}" role="option" title="frame ${k + 1}"><canvas></canvas><span>${k + 1}</span><i class="pf-hold${(hs[k] || 1) > 1 ? ' x' : ''}" data-k="${k}" title="How long this frame holds: click for ×1 to ×4">×${hs[k] || 1}</i></button>`);
        strip.appendChild(b); const px = copyRect(d.flat(), d.w, d.h, { x: (k % cols) * f.w, y: Math.floor(k / cols) * f.h, w: f.w, h: f.h }), c = b.querySelector('canvas');
        c.width = f.w; c.height = f.h; c.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px.buffer), f.w, f.h), 0, 0);
      }
    }
    /** Click a frame: it becomes the one the buttons act on, and is selected on the canvas so flip, rotate and friends work on it. */
    function pickSheetFrame(k) {
      const d = doc(); if (!isSheet(d)) return; const { f, cols } = sheetInfo(d); commitFloat();
      S.sheetK = k; S.sel = { x: (k % cols) * f.w, y: Math.floor(k / cols) * f.h, w: f.w, h: f.h }; renderSheet(); drawPreview(); render(); status();
    }
    function sheetOp(op, dir) {
      const d = doc(); if (!isSheet(d)) return; commitFloat(); const { f, n } = sheetInfo(d), k = S.sheetK || 0, j = k + (dir || 0);
      if (op === 'swap' && (j < 0 || j >= n)) return; if (op === 'del' && n <= 1) return;
      const hs = holdsOf(d).slice(); while (hs.length < n) hs.push(1);
      editAll((dd) => { const r = sheetEdit(dd.px, dd.w, dd.h, f.w, f.h, op, k, j); dd.px = r.px; dd.w = r.w; dd.h = r.h; });
      if (op === 'swap') [hs[k], hs[j]] = [hs[j], hs[k]]; else if (op === 'dup') hs.splice(k + 1, 0, hs[k]); else if (op === 'del') hs.splice(k, 1);
      setHolds(d, hs); if (!S.touched) fit();
      pickSheetFrame(op === 'swap' ? j : op === 'dup' ? k + 1 : Math.max(0, Math.min(k, n - 2)));
      note(op === 'swap' ? `frame moved to ${j + 1}` : op === 'dup' ? `frame ${k + 1} copied: now ${n + 1} frames (${d.w}×${d.h})` : `frame ${k + 1} deleted: now ${n - 1} frames`);
    }
    $('.pf-sh-left').onclick = () => sheetOp('swap', -1); $('.pf-sh-right').onclick = () => sheetOp('swap', 1);
    $('.pf-sh-add').onclick = () => sheetOp('dup'); $('.pf-sh-del').onclick = () => sheetOp('del');
    /* Apply edit: what changed in this frame, carried over to the other frames (files of a family, or frames of a sheet) by
       portLayers: where things go is found on the flattened images, what is written goes layer by layer (matched by name), so a
       pixel drawn on the shading layer lands on the target's shading layer. A frame remembers itself as of the last apply
       (`ported`, layers included), so applying again carries only what changed since; a target keeps `todo`, the pixels left to
       redraw by hand, outlined on the canvas until drawn over. */
    let port = null;
    /** The source as it was (ref) and is, cut by `cut`: per layer when ref kept the layers, else one flat layer (names: null,
        layers made or merged since then). A one-layer sprite is one layer either way. */
    function portSource(d, ref, cut) {
      const now = cut(d.flat()), before = cut(ref.px), flat = [{ before, after: now }];
      if (!d.layered) return { names: [d.layers[0].name], layers: flat, before, after: now };
      if (!ref.layers) return { names: null, layers: flat, before, after: now };
      const names = d.layers.map((l) => l.name), m = layerMap(names, ref.layers.map((l) => l.name));
      return { names, layers: d.layers.map((l, k) => ({ before: m[k] >= 0 ? cut(ref.layers[m[k]].px) : new Uint32Array(now.length), after: cut(l.px) })), before, after: now };
    }
    /** How the source goes into a target's layers: layer to layer by name, the flat picture into a one-layer target, or (no layer
        names to go by) each pixel into the layer that shows it. */
    const portInto = (src, dst) => (dst.length === 1 ? { src: [{ before: src.before, after: src.after }], map: [0] } : src.names && src.names.length > 1 ? { src: src.layers, map: layerMap(src.names, dst.map((l) => l.name)) } : { src: [{ before: src.before, after: src.after }], map: 'shown' });
    async function portPlan(d, all) {
      const orig = d.isNew || d.baseFrom === 'new' ? d.saved : d.base, from = !all && d.ported ? d.ported : orig; // not committed yet: the last save stands in for the original
      const since = from === d.ported ? 'since the last apply' : from === d.saved ? 'since the last save' : 'since the original (hold \\ to see it)';
      if (from.w !== d.w || from.h !== d.h) return { why: 'The canvas size changed since then, so the edit cannot be lined up with the other frames.' };
      const fam = famFor(d), whole = (px) => px;
      if (isSheet(d)) {
        const { f, cols, n: count } = sheetInfo(d), cells = [...Array(count).keys()].map((k) => ({ x: (k % cols) * f.w, y: Math.floor(k / cols) * f.h, w: f.w, h: f.h })), cutAt = (r) => (px) => copyRect(px, d.w, d.h, r);
        const n = cells.map((r) => { const s = portSource(d, from, cutAt(r)); return s.layers.reduce((t, l) => t + countDiff(l.before, l.after), 0); }), k = n[S.sheetK || 0] ? S.sheetK || 0 : n.indexOf(Math.max(...n));
        if (!n[k]) return { why: `Nothing has changed in this sheet ${since}.` };
        const r = cells[k], src = portSource(d, from, cutAt(r));
        return { w: r.w, h: r.h, label: `frame ${k + 1}`, since, src, targets: cells.flatMap((c, j) => (j === k ? [] : [{ label: `frame ${j + 1}`, doc: d, rect: c, dst: d.layers.map((l) => ({ ...l, px: cutAt(c)(l.px) })) }])) };
      }
      if (!fam) return { why: 'This sprite has no other frames: numbered files (walk_0, walk_1…) or a sprite sheet (set the frame size under Animation).' };
      const src = portSource(d, from, whole);
      if (!src.layers.some((l) => countDiff(l.before, l.after))) return { why: `Nothing has changed in ${fileName(d)} ${since}.` };
      const targets = [], odd = [];
      for (const p of fam.members) { if (p === d.path) continue; const x = await loadDoc(p); if (!x) continue; if (x.w !== d.w || x.h !== d.h) odd.push(memberLabel(fam, p)); else targets.push({ label: memberLabel(fam, p), doc: x, dst: x.layers }); }
      if (!targets.length) return { why: `The other frames are a different size from ${fileName(d)}.` };
      return { w: d.w, h: d.h, label: fileName(d), since, src, odd, targets };
    }
    async function openPort(all) {
      const d = doc(); if (!d) return; commitFloat();
      const plan = await portPlan(d, all); if (plan.why) { if ($('.pf-dlg-port').open) $('.pf-dlg-port').close(); return note(plan.why); }
      port = { d, ...plan }; const { w, h, src } = plan;
      for (const t of port.targets) {
        const how = portInto(src, t.dst), tgt = flattenLayers(t.dst, w * h);
        t.res = portLayers({ w, h, before: src.before, after: src.after, target: tgt, src: how.src, dst: t.dst, map: how.map, active: t.doc.active }); t.map = how.map;
        t.n = t.res.layers.reduce((a, px, i) => a + countDiff(px, t.dst[i].px), 0); t.on = t.n > 0;
        t.lost = [...t.res.lost].map((k) => (how.src === src.layers ? src.names[k] : 'this layer'));
      }
      const n = countDiff(src.before, src.after) || src.layers.reduce((a, l) => a + countDiff(l.before, l.after), 0), rc = port.targets[0].res.recolours.reduce((a, m) => a + m.size, 0);
      const byLayer = src.names && src.names.length > 1 ? ` Layer by layer: ${src.names.join(', ')}.` : d.layered ? ' The layers were made or merged since then, so each pixel goes into the layer that shows it.' : '';
      $('.pf-port-what').textContent = `${n} pixel${n > 1 ? 's' : ''} changed in ${plan.label} ${plan.since}${rc ? ` (${rc} colour${rc > 1 ? 's' : ''} swapped outright)` : ''}.${byLayer} Each frame below shows the result; untick one to leave it alone.${plan.odd && plan.odd.length ? ` Left out, another size: ${plan.odd.join(', ')}.` : ''}`;
      $('.pf-port-allrow').hidden = !d.ported; $('.pf-port-all').checked = !!all;
      const box = $('.pf-port-list'); box.innerHTML = '';
      for (const t of port.targets) {
        const left = t.res.todo.length, card = el(`<label class="pf-port-f"><canvas></canvas><span><input type="checkbox"${t.on ? ' checked' : ' disabled'}> <b>${esc(t.label)}</b></span><span class="pf-note">${t.n ? `${t.n} px` : 'nothing to change'}${left ? ` · <span class="pf-port-key">${left} to redraw</span>` : ''}${t.lost.length ? ` · no ${t.lost.map((x) => `“${esc(x)}”`).join(', ')} layer` : ''}</span></label>`);
        card.querySelector('input').onchange = (e) => { t.on = e.target.checked; };
        const c = card.querySelector('canvas'), k = Math.max(4, Math.ceil(128 / Math.max(w, h))), img = flattenLayers(t.dst.map((l, i) => ({ ...l, px: t.res.layers[i] })), w * h);
        drawPx(c, { w, h, imageData: () => new ImageData(new Uint8ClampedArray(img.buffer), w, h) }, k);
        const g2 = c.getContext('2d'); g2.strokeStyle = '#ffb000'; for (const i of t.res.todo) g2.strokeRect((i % w) * k + 0.5, ((i / w) | 0) * k + 0.5, k - 1, k - 1);
        box.appendChild(card);
      }
      if (!$('.pf-dlg-port').open) $('.pf-dlg-port').showModal();
    }
    $('.pf-fam-port').onclick = $('.pf-sh-port').onclick = () => openPort(false);
    $('.pf-port-all').onchange = (e) => openPort(e.target.checked);
    $('.pf-port-go').onclick = () => {
      const p = port; if (!p) return; $('.pf-dlg-port').close(); port = null;
      const picked = p.targets.filter((t) => t.on), todo = new Map(), synced = new Set(); let px = 0, left = 0;
      for (const t of picked) {
        const x = t.doc, cells = t.rect ? t.res.todo.map((i) => (t.rect.y + ((i / p.w) | 0)) * x.w + t.rect.x + (i % p.w)) : t.res.todo;
        if (!todo.has(x)) { // one undo step per image, however many of its frames change
          const was = x.ported || x.base; x.snapshot(); todo.set(x, []);
          if (x !== p.d && x.same(was)) synced.add(x); // a frame with no edits of its own starts its next edit from here
        }
        t.res.layers.forEach((out, i) => { if (out === t.dst[i].px) return; if (t.rect) pasteRect(x.layers[i].px, x.w, x.h, out, p.w, p.h, t.rect.x, t.rect.y, true); else x.layers[i].px = out; });
        todo.get(x).push(...cells); px += t.n; left += cells.length;
      }
      for (const [x, cells] of todo) { const flat = x.flat(); x.todo = cells.length ? { layers: x.layers, cells: new Map(cells.map((i) => [i, flat[i]])) } : null; if (synced.has(x)) x.ported = x.mark(); }
      p.d.ported = p.d.mark();
      changedUi(); renderList();
      note(picked.length ? `applied to ${picked.length} frame${picked.length > 1 ? 's' : ''}: ${px} pixel${px === 1 ? '' : 's'}${left ? ` · ${left} left to redraw, outlined in orange (Onion skin, N, shows the frame before)` : ''} · Ctrl+Z undoes it frame by frame` : 'no frame picked: nothing changed');
    };
    /** The animation as one sheet PNG plus a JSON of its frames (Aseprite json-array), zipped. A family is packed into a row. */
    $('.pf-sheet-out').onclick = async () => {
      const d = doc(); if (!d) return; commitFloat(); const fam = famFor(d), ms = Math.round(1000 / Math.max(1, +$('.pf-fps').value || 8)), hs = holdsOf(d);
      let img, rects, names, name;
      if (isSheet(d)) { const { f, cols, n } = sheetInfo(d); img = { px: d.flat(), w: d.w, h: d.h }; rects = [...Array(n).keys()].map((k) => ({ x: (k % cols) * f.w, y: Math.floor(k / cols) * f.h, w: f.w, h: f.h })); name = stem(d.path); names = rects.map((_, k) => `${name} ${k}`); }
      else if (fam) { const fr = []; for (const p of fam.members) { const x = await loadDoc(p); if (x) fr.push({ px: x.flat(), w: x.w, h: x.h }); } const pk = packSheet(fr); img = pk; rects = pk.rects; name = fam.key; names = fam.members.map(stem); }
      else return note('Sheet + JSON is for animations: a sprite sheet, or numbered frames like walk_0, walk_1.');
      const png = new Uint8Array(await (await pngOf(new Doc(name + '.png', img.w, img.h, img.px))).arrayBuffer());
      const json = new TextEncoder().encode(JSON.stringify(sheetJson(name + '.png', img.w, img.h, rects, rects.map((_, i) => ms * (hs[i] || 1)), names), null, 2) + '\n');
      download(new Blob([zipFiles([{ name: name + '.png', bytes: png }, { name: name + '.json', bytes: json }])], { type: 'application/zip' }), name + '-sheet.zip');
      note(`${name}-sheet.zip: ${rects.length} frames in a ${img.w}×${img.h} sheet, with ${name}.json`);
    };
    $('.pf-gif').onclick = async () => {
      const d = doc(); if (!d) return; const fam = famFor(d), sheet = frameSize(d), frames = [];
      if (sheet.w < d.w || sheet.h < d.h) { const cols = Math.floor(d.w / sheet.w), rows = Math.floor(d.h / sheet.h); for (let k = 0; k < cols * rows; k++) frames.push({ w: sheet.w, h: sheet.h, px: copyRect(d.flat(), d.w, d.h, { x: (k % cols) * sheet.w, y: Math.floor(k / cols) * sheet.h, w: sheet.w, h: sheet.h }) }); }
      else if (fam) { for (const p of fam.members) { const x = await loadDoc(p); if (x) frames.push({ w: x.w, h: x.h, px: x.flat() }); } }
      else frames.push({ w: d.w, h: d.h, px: d.flat() });
      const s = +(prompt(`GIF of ${frames.length} frame${frames.length > 1 ? 's' : ''} at ${+$('.pf-fps').value || 8} fps. Scale (1 = original size):`, String(Math.max(1, Math.min(8, Math.floor(256 / Math.max(d.w, d.h)))))) || 0);
      if (!s || s < 1 || s > 32) return;
      const base = Math.max(2, Math.round(100 / Math.max(1, +$('.pf-fps').value || 8))), hs = holdsOf(d); if (frames.length > 1) frames.forEach((f, i) => { f.delay = base * (hs[i] || 1); });
      const gif = encodeGif(frames, { delay: base, scale: Math.floor(s) });
      download(new Blob([gif], { type: 'image/gif' }), (fam && !(sheet.w < d.w) ? fam.key : d.path.split('/').pop().replace(/\.png$/i, '')) + (s > 1 ? '@' + s + 'x' : '') + '.gif');
      note(`GIF: ${frames.length} frame${frames.length > 1 ? 's' : ''}, ${(gif.length / 1024).toFixed(1)} KB`);
    };
    function setRef(img, name, pixel) {
      S.ref = { img, name, pixel, opacity: +$('.pf-ref-op').value / 100, over: $('.pf-ref-place button.on').dataset.place === 'over', fit: $('.pf-ref-fit button.on').dataset.fit, visible: true };
      $('.pf-ref-on').hidden = false; foldPanel($('.pf-refpanel'), false, false); $('.pf-ref-name').textContent = `${name} · ${img.width}×${img.height}`; $('.pf-ref-toggle').textContent = 'hide'; render();
    }
    $('.pf-ref-load').onclick = () => $('.pf-ref-file').click();
    $('.pf-ref-file').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { setRef(await createImageBitmap(f), f.name, false); } catch (err) { note('Could not read that image: ' + err.message); } };
    $('.pf-ref-sprite').onfocus = () => { const sel = $('.pf-ref-sprite'), cur = sel.value; sel.innerHTML = '<option value="">or a sprite…</option>' + S.sprites.map((x) => `<option value="${esc(x.path)}">${esc(x.path)}</option>`).join(''); sel.value = cur; };
    $('.pf-ref-sprite').onchange = async (e) => { const path = e.target.value; if (!path) return; const d = await loadDoc(path); if (!d) return; const c = document.createElement('canvas'); c.width = d.w; c.height = d.h; c.getContext('2d').putImageData(d.imageData(), 0, 0); setRef(c, path.split('/').pop(), true); e.target.value = ''; e.target.blur(); /* shortcuts (H) work straight away */ };
    $('.pf-ref-op').oninput = (e) => { if (S.ref) { S.ref.opacity = +e.target.value / 100; render(); } };
    $$('.pf-ref-place button').forEach((b) => (b.onclick = () => { segOn('.pf-ref-place', b); if (S.ref) { S.ref.over = b.dataset.place === 'over'; render(); } }));
    $$('.pf-ref-fit button').forEach((b) => (b.onclick = () => { segOn('.pf-ref-fit', b); if (S.ref) { S.ref.fit = b.dataset.fit; render(); } }));
    const toggleRef = () => { if (!S.ref) return; S.ref.visible = !S.ref.visible; $('.pf-ref-toggle').textContent = S.ref.visible ? 'hide' : 'show'; render(); };
    $('.pf-ref-toggle').onclick = toggleRef;
    $('.pf-ref-clear').onclick = () => { S.ref = null; $('.pf-ref-on').hidden = true; render(); };
    /* variants: a recoloured copy of a whole family (or one sprite) as new files */
    let variant = null;
    async function openVariant() {
      const d = doc(); if (!d) return;
      const fam = famFor(d), key = fam ? fam.key : d.path.split('/').pop().replace(/\.png$/i, ''), members = fam ? fam.members : [d.path], docs = [];
      for (const p of members) { const x = await loadDoc(p); if (x) docs.push(x); }
      const counts = new Map(); for (const x of docs) for (const c of x.flat()) if (!isClear(c)) counts.set(c, (counts.get(c) || 0) + 1);
      variant = { key, docs, cols: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 48).map(([c]) => c), swap: new Map() };
      $('.pf-v-what').textContent = `${docs.length > 1 ? `The whole "${key}" family: ${docs.length} images` : d.path.split('/').pop()}, recoloured into new files.`;
      $('.pf-v-cols').innerHTML = variant.cols.map((c, i) => `<label class="pf-v-col"><i style="background:${toHex(c)}"></i>→<input type="color" data-i="${i}" value="${toHex(c)}"></label>`).join('');
      for (const [sel, v] of [['.pf-v-h', 0], ['.pf-v-s', 0], ['.pf-v-l', 0]]) $(sel).value = v;
      variantPreview(); $('.pf-dlg-variant').showModal();
    }
    const suffixOf = () => ($('.pf-v-suffix').value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'variant');
    function variantFn() {
      if ($('.pf-v-mode button.on').dataset.mode === 'swap') return (c) => (isClear(c) ? c : variant.swap.has(c) ? ((variant.swap.get(c) & 0xffffff) | (c & 0xff000000)) >>> 0 : c);
      const dh = +$('.pf-v-h').value, ds = +$('.pf-v-s').value / 100, dl = +$('.pf-v-l').value / 100, keep = $('.pf-v-keep').checked, memo = new Map();
      return (c) => { let r = memo.get(c); if (r === undefined) memo.set(c, (r = shiftColor(c, dh, ds, dl, keep))); return r; };
    }
    function variantPreview() {
      if (!variant) return; const fn = variantFn(), sfx = suffixOf();
      $('.pf-v-hv').textContent = $('.pf-v-h').value + '°'; $('.pf-v-sv').textContent = $('.pf-v-s').value; $('.pf-v-lv').textContent = $('.pf-v-l').value;
      $('.pf-v-names').textContent = '→ ' + variant.docs.map((x) => variantPath(x.path, variant.key, sfx).split('/').pop()).join(', ');
      const box = $('.pf-v-preview'); box.innerHTML = '';
      for (const x of variant.docs) { const c = document.createElement('canvas'); box.appendChild(c); drawPx(c, { w: x.w, h: x.h, imageData: () => new ImageData(new Uint8ClampedArray(x.flat().map(fn).buffer), x.w, x.h) }); c.style.width = Math.round(72 * x.w / x.h) + 'px'; }
    }
    $('.pf-variant').onclick = openVariant;
    ['.pf-v-h', '.pf-v-s', '.pf-v-l', '.pf-v-keep', '.pf-v-suffix'].forEach((sel) => ($(sel).oninput = variantPreview));
    $$('.pf-v-mode button').forEach((b) => (b.onclick = () => { segOn('.pf-v-mode', b); $('.pf-v-shift').hidden = b.dataset.mode !== 'shift'; $('.pf-v-swap').hidden = b.dataset.mode !== 'swap'; variantPreview(); }));
    $('.pf-v-cols').oninput = (e) => { const i = e.target.dataset.i; if (i == null) return; variant.swap.set(variant.cols[+i], fromHex(e.target.value)); variantPreview(); };
    $('.pf-v-go').onclick = async () => {
      const fn = variantFn(), sfx = suffixOf(), made = [];
      for (const x of variant.docs) {
        const path = variantPath(x.path, variant.key, sfx);
        if (S.sprites.some((s) => s.path === path)) { note(path.split('/').pop() + ' already exists: pick another name'); return; }
      }
      $('.pf-dlg-variant').close();
      for (const x of variant.docs) { const path = variantPath(x.path, variant.key, sfx); await addLocal(path, x.w, x.h, x.flat().map(fn), canWrite(), true); made.push(path); }
      await openSprite(made[0]); note(`variant: ${made.length} new file${made.length > 1 ? 's' : ''} (${canWrite() ? 'Save writes each' : 'kept in this browser; Propose PR adds them'})`);
    };
    /* history: earlier versions of the open sprite from git (GitHub repositories and the local server) */
    let histFor = null, histPick = null;
    async function loadHistory() {
      const d = doc(), box = $('.pf-hist-list'); if (!d || !S.src || !S.src.history || !$('.pf-hist').open) return;
      if (histFor === d.path) return; histFor = d.path; histPick = null; $('.pf-hist-act').hidden = true;
      box.innerHTML = '<div class="pf-note">Loading…</div>';
      let list = []; try { list = d.isNew || d.local ? [] : await S.src.history(d.path); } catch (e) { box.innerHTML = `<div class="pf-note">${esc(e.message)}</div>`; return; }
      if (histFor !== d.path) return;
      box.innerHTML = list.length ? '' : '<div class="pf-note">No earlier versions.</div>';
      for (const c of list) {
        const b = el(`<button class="pf-hist-e" data-sha="${esc(c.sha)}" title="${esc(c.message)}"><canvas></canvas><b>${esc(c.message)}</b><small>${esc(String(c.date).slice(0, 10))} · ${esc(c.author)} · ${esc(c.sha.slice(0, 7))}</small></button>`);
        box.appendChild(b); const cv = b.querySelector('canvas'), path = d.path;
        S.src.readAt(path, c.sha).then((bytes) => createImageBitmap(new Blob([bytes], { type: 'image/png' }))).then((bm) => { cv.width = bm.width; cv.height = bm.height; const k = cv.getContext('2d'); k.imageSmoothingEnabled = false; k.drawImage(bm, 0, 0); }).catch(() => { b.disabled = true; b.title = 'Not in that commit (renamed or added later)'; });
      }
    }
    const resetHistory = () => { histFor = null; $('.pf-hist').hidden = !(S.src && S.src.history); if ($('.pf-hist').open) loadHistory(); };
    $('.pf-hist').addEventListener('toggle', loadHistory);
    $('.pf-hist-list').onclick = (e) => { const b = e.target.closest('.pf-hist-e'); if (!b || b.disabled) return; $$('.pf-hist-e').forEach((x) => x.classList.toggle('on', x === b)); histPick = b.dataset.sha; $('.pf-hist-act').hidden = false; $('.pf-hist-sel').textContent = histPick.slice(0, 7); };
    $('.pf-hist-restore').onclick = async () => {
      const d = doc(); if (!d || !histPick) return;
      try { const img = await decodePng(new Blob([await S.src.readAt(d.path, histPick)], { type: 'image/png' })); d.snapshot(); d.setFlat(img.w, img.h, img.px); fit(); changedUi(); note(`restored the version from ${histPick.slice(0, 7)} (Ctrl+Z undoes it)`); }
      catch (e) { note('Could not restore: ' + e.message); }
    };
    $('.pf-context').onclick = (e) => { S.ctx = !S.ctx; e.currentTarget.classList.toggle('on', S.ctx); $('.pf-ctx').hidden = !S.ctx; try { localStorage.setItem('pf:ctx', S.ctx ? '1' : '0'); } catch { /* ignore */ } requestAnimationFrame(() => { resizeView(); if (!S.touched) fit(); render(); }); };
    const ctxHitAt = (e) => { const cv = $('.pf-ctx-cv'), r = cv.getBoundingClientRect(), x = (e.clientX - r.left) * (cv.width / r.width), y = (e.clientY - r.top) * (cv.height / r.height), pad = 4 * (window.devicePixelRatio || 1); return ctxHits.find((h) => x >= h.x - pad && x <= h.x + h.w + pad && y >= h.y - pad && y <= h.y + h.h + pad); };
    $('.pf-ctx-cv').addEventListener('click', (e) => { const h = ctxHitAt(e); if (h) openSprite(h.path); });
    $('.pf-ctx-cv').addEventListener('pointermove', (e) => { const h = ctxHitAt(e); e.currentTarget.classList.toggle('pf-ctx-hit', !!h); e.currentTarget.title = h ? 'Open ' + h.path : ''; });
    $('.pf-ctx-group').onchange = (e) => { S.ctxGroup = e.target.value; try { localStorage.setItem('pf:ctxgroup', S.ctxGroup); } catch { /* ignore */ } render(); };
    try { const v = localStorage.getItem('pf:ctxgroup'); if (v != null) S.ctxGroup = v; } catch { /* default */ }
    $$('.pf-ctx-scale button').forEach((b) => (b.onclick = () => { S.ctxScale = +b.dataset.scale; segOn('.pf-ctx-scale', b); render(); }));
    try { if (localStorage.getItem('pf:ctx') === '1') { S.ctx = true; $('.pf-context').classList.add('on'); $('.pf-ctx').hidden = false; } } catch { /* off */ }
    $('.pf-changes').onclick = (e) => { S.changes = !S.changes; e.currentTarget.classList.toggle('on', S.changes); render(); };
    /** What the held view shows: \ the original (the branch version where it is known), Shift+\ the last save. */
    const peekLabel = (d) => (S.peek === 'saved' ? 'LAST SAVE' : d.baseFrom === 'new' ? 'BRANCH: NOT COMMITTED YET' : d.baseFrom === 'branch' || (S.src && S.src.kind === 'github') ? 'ON THE BRANCH' : 'AS OPENED');
    const peek = (on) => { if (S.peek === on || !doc()) return; S.peek = on; render(); };
    $('.pf-status').addEventListener('pointerdown', (e) => { if (e.target.closest('.pf-s-peek')) { e.preventDefault(); peek('base'); } });
    const peekOff = () => peek(false); window.addEventListener('pointerup', peekOff);
    $('.pf-swap').onclick = () => { [S.color, S.color2] = [S.color2, S.color]; renderColors(); swatches(); }; // only the colours: Z is the pencil / eraser switch
    /* The colour popover opens from the swatch under the tools, next to where you draw. */
    function placeCpop() {
      const pop = $('.pf-cpop'), r = $('.pf-swatch').getBoundingClientRect(), pw = pop.offsetWidth, ph = pop.offsetHeight, vw = innerWidth, vh = innerHeight;
      let x = r.right + 10, y = r.bottom - ph; // beside the rail, bottoms aligned
      if (x + pw > vw - 8) { x = Math.max(8, Math.min(r.left, vw - pw - 8)); y = r.top - ph - 10; if (y < 8) y = r.bottom + 10; } // a phone: above (or below) the swatch
      pop.style.left = Math.round(x) + 'px'; pop.style.top = Math.round(Math.max(8, Math.min(y, vh - ph - 8))) + 'px';
    }
    function colourPop(open = $('.pf-cpop').hidden) {
      const pop = $('.pf-cpop'); pop.hidden = !open; $('.pf-prim').setAttribute('aria-expanded', String(open)); $('.pf-prim').classList.toggle('open', open);
      if (open) { renderColors(); placeCpop(); }
    }
    $('.pf-prim').setAttribute('aria-haspopup', 'dialog'); $('.pf-prim').setAttribute('aria-expanded', 'false');
    $('.pf-prim').onclick = () => colourPop();
    document.addEventListener('pointerdown', (e) => { if (!$('.pf-cpop').hidden && !e.target.closest('.pf-cpop') && !e.target.closest('.pf-prim')) colourPop(false); });
    addEventListener('resize', () => { if (!$('.pf-cpop').hidden) placeCpop(); });
    $('.pf-sec').onclick = () => $('.pf-swap').click();
    /* Quick palette at the cursor (Tab): the project palette plus "in this image", opened where the mouse is so colours
       are picked without travelling to the side panel. Click picks the primary colour, Shift+click or right click the
       secondary one; Tab or Esc closes it. */
    const lastMouse = { clientX: null, clientY: null };
    const trackMouse = (e) => { lastMouse.clientX = e.clientX; lastMouse.clientY = e.clientY; };
    document.addEventListener('pointermove', trackMouse, { passive: true });
    let qpalAt = null;
    const qpalOpen = () => !$('.pf-qpal').hidden;
    function renderQpal() {
      const d = doc();
      $('.pf-qpal-colors').innerHTML = S.palette.length ? S.palette.map((c) => `<button data-c="${c}" title="${toHex(c)}" style="background:${toHex(c)}" class="${c === S.color ? 'on' : ''} ${c === S.color2 ? 'sec' : ''}"></button>`).join('') : '<span class="pf-note">no palette yet</span>';
      if (!d) { $('.pf-qpal-img').innerHTML = '<span class="pf-note">no image open</span>'; return; }
      const cols = colorsOf(d.flat()).filter(([c]) => !isClear(c)).slice(0, 64);
      $('.pf-qpal-img').innerHTML = cols.map(([c, n]) => `<button data-c="${c}" title="${toHex(c)} · ${n}px" style="background:${toHex(c)}" class="${c === S.color ? 'on' : ''} ${c === S.color2 ? 'sec' : ''}"></button>`).join('') || '<span class="pf-note">transparent</span>';
    }
    function qpalPlace(x, y) {
      const pop = $('.pf-qpal'), pw = pop.offsetWidth || 260, ph = pop.offsetHeight || 180, vw = innerWidth, vh = innerHeight;
      pop.style.left = Math.round(Math.max(8, Math.min(x + 14, vw - pw - 8))) + 'px';
      pop.style.top = Math.round(Math.max(8, Math.min(y + 14, vh - ph - 8))) + 'px';
    }
    function qpalShow(x, y) { qpalAt = { x, y }; renderQpal(); $('.pf-qpal').hidden = false; qpalPlace(x, y); }
    function qpalHide() { $('.pf-qpal').hidden = true; qpalAt = null; }
    function qpalToggle() { if (qpalOpen()) qpalHide(); else { const p = lastMouse.clientX != null ? lastMouse : { clientX: innerWidth / 2, clientY: innerHeight / 2 }; qpalShow(p.clientX, p.clientY); } }
    $('.pf-qpal').addEventListener('click', (e) => { const b = e.target.closest('button[data-c]'); if (!b) return; e.shiftKey ? setColor2(+b.dataset.c) : setColor(+b.dataset.c); renderQpal(); qpalHide(); });
    $('.pf-qpal').addEventListener('contextmenu', (e) => { const b = e.target.closest('button[data-c]'); if (!b) return; e.preventDefault(); setColor2(+b.dataset.c); renderQpal(); qpalHide(); });
    const qpalOutside = (e) => { if (qpalOpen() && !e.target.closest('.pf-qpal')) qpalHide(); };
    document.addEventListener('pointerdown', qpalOutside, true);
    $('.pf-ramp-btn').onclick = () => { if (isClear(S.color)) return note('Pick a colour first.'); const r = hueRamp(S.color, 5); $('.pf-ramp').hidden = false; $('.pf-ramp-colors').innerHTML = r.map((c) => `<button data-c="${c}" title="${toHex(c)}" style="background:${toHex(c)}"></button>`).join(''); S.ramp = r; renderColors(); };
    $('.pf-ramp-add').onclick = () => { const add = (S.ramp || []).filter((c) => !S.palette.includes(c)); S.palette = S.palette.concat(add); renderPalette(); renderColors(); note('added ' + add.length + ' colours to the palette'); };
    $('.pf-pal-add').onclick = () => { if (isClear(S.color) || S.palette.includes(S.color)) return; S.palette = S.palette.concat([S.color]); renderPalette(); renderColors(); };
    $('.pf-sel-copy').onclick = () => copySel(false); $('.pf-sel-cut').onclick = () => copySel(true); $('.pf-sel-paste').onclick = () => { if (S.clip) pastePx(S.clip.px, S.clip.w, S.clip.h); else note('Nothing copied yet.'); };
    $('.pf-sel-del').onclick = deleteSel; $('.pf-sel-all').onclick = selectAll; $('.pf-sel-none').onclick = dropSelection;
    $('.pf-undo').onclick = undo; $('.pf-redo').onclick = redo;
    $('.pf-zin').onclick = () => { S.zoom = Math.min(64, S.zoom + 1); S.touched = true; fit2(); }; $('.pf-zout').onclick = () => { S.zoom = Math.max(1, S.zoom - 1); S.touched = true; fit2(); };
    function fit2() { const d = doc(); if (d) { S.ox = Math.round((view.width - d.w * S.zoom) / 2); S.oy = Math.round((view.height - d.h * S.zoom) / 2); } render(); status(); }
    $('.pf-fit').onclick = () => { fit(); render(); status(); };
    /* Fullscreen: the editor covers the screen (the browser's own fullscreen and a landscape lock where the browser allows
       them; a fixed overlay where it does not, as on iPhone). The toolbar and tool options move into the right drawer
       while it lasts and go back when it ends. */
    let fsReal = false;
    const fsOn = () => root.classList.contains('pf-fs');
    const fsRail = () => root.style.setProperty('--pf-rail-w', $('.pf-rail').offsetWidth + 'px');
    function fsDrawer(side) {
      root.classList.toggle('pf-fs-lopen', side === 'l'); root.classList.toggle('pf-fs-ropen', side === 'r');
      handles();
    }
    /* The ‹ › handles point the way their panel will move: in fullscreen they slide a drawer in, on a wide screen they fold
       a column away (remembered in this browser). */
    function handles() {
      const fs = fsOn(), l = fs ? root.classList.contains('pf-fs-lopen') : !root.classList.contains('pf-lhide'), r = fs ? root.classList.contains('pf-fs-ropen') : !root.classList.contains('pf-rhide');
      const hl = $('.pf-fs-hl'), hr = $('.pf-fs-hr'); hl.textContent = l ? '‹' : '›'; hr.textContent = r ? '›' : '‹';
      hl.setAttribute('aria-expanded', String(l)); hr.setAttribute('aria-expanded', String(r));
      hl.title = fs ? '' : l ? 'Hide the sprite list' : 'Show the sprite list'; hr.title = fs ? '' : r ? 'Hide the colour panel' : 'Show the colour panel';
    }
    function fold(side, hide) {
      root.classList.toggle(side === 'l' ? 'pf-lhide' : 'pf-rhide', hide); handles();
      try { localStorage.setItem('pf:fold', (root.classList.contains('pf-lhide') ? 'l' : '') + (root.classList.contains('pf-rhide') ? 'r' : '')); } catch { /* not remembered */ }
      requestAnimationFrame(() => { resizeView(); if (!S.touched) fit(); render(); });
    }
    try { const f = localStorage.getItem('pf:fold') || ''; root.classList.toggle('pf-lhide', f.includes('l')); root.classList.toggle('pf-rhide', f.includes('r')); } catch { /* both shown */ }
    function fsSet(on) {
      if (on === fsOn()) return;
      root.classList.toggle('pf-fs', on); fsDrawer(null);
      if (on) $('.pf-right').prepend($('.pf-bar'), $('.pf-opts')); else $('.pf-main').prepend($('.pf-bar'), $('.pf-opts'));
      if (on) {
        const req = root.requestFullscreen && root.requestFullscreen({ navigationUI: 'hide' });
        if (req && req.then) req.then(() => { fsReal = true; const o = screen.orientation; if (o && o.lock) o.lock('landscape').catch(() => {}); }).catch(() => {});
      } else {
        if (fsReal && document.fullscreenElement) document.exitFullscreen().catch(() => {});
        fsReal = false; try { screen.orientation.unlock(); } catch { /* not locked */ }
      }
      requestAnimationFrame(() => { fsRail(); resizeView(); fit(); render(); status(); });
    }
    $('.pf-fs-go').onclick = () => fsSet(true); $('.pf-fs-exit').onclick = () => fsSet(false);
    $('.pf-fs-hl').onclick = () => (fsOn() ? fsDrawer(root.classList.contains('pf-fs-lopen') ? null : 'l') : fold('l', !root.classList.contains('pf-lhide')));
    $('.pf-fs-hr').onclick = () => (fsOn() ? fsDrawer(root.classList.contains('pf-fs-ropen') ? null : 'r') : fold('r', !root.classList.contains('pf-rhide')));
    handles();
    $('.pf-fs-scrim').onclick = () => fsDrawer(null);
    $('.pf-fs-undo').onclick = undo; $('.pf-fs-redo').onclick = redo; $('.pf-fs-fit').onclick = () => $('.pf-fit').click();
    $('.pf-side').addEventListener('click', (e) => { if (fsOn() && e.target.closest('.pf-item,.pf-openrow')) setTimeout(() => fsDrawer(null), 150); });
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement && fsReal && fsOn()) { fsReal = false; fsSet(false); } }); // left with the back gesture or Esc
    window.addEventListener('resize', () => { if (fsOn()) fsRail(); });
    $$('.pf-selmode button').forEach((b) => (b.onclick = () => setTool(b.dataset.t)));
    /* pixel check: recomputed only when the pixels changed since the last check, not on every redraw while panning or zooming */
    let lintMemo = null;
    function lintCache(d) {
      const flat = d.flat(); if (lintMemo && lintMemo.d === d && lintMemo.px.length === flat.length && lintMemo.w === d.w && countDiff(lintMemo.px, flat) === 0) return lintMemo.res;
      lintMemo = { d, w: d.w, px: flat.slice(), res: lintPixels(flat, d.w, d.h) }; return lintMemo.res;
    }
    $('.pf-lint').onclick = (e) => { S.lint = !S.lint; e.currentTarget.classList.toggle('on', S.lint); $('.pf-lint-tag').hidden = !S.lint; render(); };
    /* ---------- review notes: pinned to a pixel of a sprite, kept in this browser, sent with the next pull request ---------- */
    const notesKey = (path) => 'pf:notes:' + ((S.meta && S.meta.repo && S.meta.repo.slug) || (S.src && (S.src.name || S.src.kind)) || '') + ':' + path;
    function notesOf(d) { if (!d) return []; try { return JSON.parse(localStorage.getItem(notesKey(d.path)) || '[]'); } catch { return []; } }
    function setNotes(path, list) { try { if (list.length) localStorage.setItem(notesKey(path), JSON.stringify(list)); else localStorage.removeItem(notesKey(path)); } catch { /* this visit */ } }
    /** Every sprite of this project with notes: [{ path, items }]. */
    function allNotes() { const out = []; for (const sp of S.sprites) { try { const items = JSON.parse(localStorage.getItem(notesKey(sp.path)) || '[]'); if (items.length) out.push({ path: sp.path, items }); } catch { /* skip */ } } return out; }
    function clearSentNotes(list) { for (const n of list) setNotes(n.path, []); renderNotes(); render(); }
    function addNote(d, x, y) { const list = notesOf(d); list.push({ x, y, text: '' }); setNotes(d.path, list); S.placingNote = false; renderNotes(); render(); const ins = $$('.pf-note-item input'); if (ins.length) ins[ins.length - 1].focus(); }
    function renderNotes() {
      const d = doc(), list = notesOf(d); $('.pf-note-add').classList.toggle('on', !!S.placingNote); $('.pf-note-add').disabled = !d;
      $('.pf-notes-n').textContent = list.length ? '· ' + list.length : ''; $('.pf-notes-tip').hidden = !!list.length; if (list.length && $('.pf-notes').classList.contains('pf-shut')) foldPanel($('.pf-notes'), false, false);
      $('.pf-note-list').innerHTML = list.map((n, i) => `<div class="pf-note-item"><b>${i + 1}</b><input type="text" data-i="${i}" value="${esc(n.text)}" placeholder="what to look at (${n.x}, ${n.y})" aria-label="Note ${i + 1}"><button type="button" class="pf-note-del" data-i="${i}" title="Remove this note">✕</button></div>`).join('');
    }
    /* ---------- layers: line art, colour, shading… drawn apart, saved flattened (and kept in name.layers.png) ---------- */
    function renderLayers() {
      const d = doc(), list = $('.pf-ly-list'); $$('.pf-layers .pf-row button').forEach((b) => { b.disabled = !d; });
      if (!d) { list.innerHTML = ''; $('.pf-ly-n').textContent = ''; $('.pf-ly-oprow').hidden = true; return; }
      const n = d.layers.length, a = d.active;
      $('.pf-ly-n').textContent = n > 1 ? '· ' + n : ''; $('.pf-ly-del').disabled = n < 2; $('.pf-ly-merge').disabled = a === 0; $('.pf-ly-down').disabled = a === 0; $('.pf-ly-up').disabled = a === n - 1;
      $('.pf-ly-oprow').hidden = n < 2; for (const c of ['.pf-ly-up', '.pf-ly-down', '.pf-ly-merge', '.pf-ly-del']) $(c).hidden = n < 2; $('.pf-ly-op').value = d.layer.opacity; $('.pf-ly-opv').textContent = d.layer.opacity + '%';
      $('.pf-ly-tip').hidden = n < 2; $('.pf-ly-file').textContent = layersPath(fileName(d));
      list.innerHTML = n < 2 ? '' : d.layers.map((l, k) => [l, k]).reverse().map(([l, k]) => `<div class="pf-ly${k === a ? ' on' : ''}${l.visible ? '' : ' off'}" data-k="${k}" role="option" aria-selected="${k === a}"><button type="button" class="pf-ly-eye" data-k="${k}" aria-pressed="${l.visible}" title="${l.visible ? 'Hide' : 'Show'} this layer">${l.visible ? '◉' : '○'}</button><canvas data-k="${k}"></canvas><input type="text" data-k="${k}" value="${esc(l.name)}" aria-label="Layer name"><button type="button" class="pf-ly-link${l.link ? ' on' : ''}" data-k="${k}" aria-pressed="${!!l.link}" title="${l.link ? 'Linked: one drawing shared by every frame of the animation. Click to unlink (each frame keeps its copy)' : 'Link this layer across the frames of the animation: draw it once, every frame follows'}"${l.link || famFor(d) ? '' : ' hidden'}>${icon('link')}</button></div>`).join('');
      const lk = d.layer.link; $('.pf-ly-linkrow').hidden = !lk || n < 2; if (lk) $('.pf-ly-linkat').textContent = `${lk.x}, ${lk.y}`;
      $$('.pf-ly canvas').forEach((c) => { const l = d.layers[+c.dataset.k]; drawPx(c, { w: d.w, h: d.h, imageData: () => new ImageData(new Uint8ClampedArray(l.px.buffer.slice(0)), d.w, d.h) }); });
    }
    /** A change to the layers (not their pixels): one undo step. */
    function layerEdit(fn) { const d = doc(); if (!d) return; commitFloat(); S.sel = null; d.snapshot(); fn(d); changedUi(); renderLayers(); }
    const blank = (d, name) => layerOf({ name, px: new Uint32Array(d.w * d.h) });
    const freeName = (d) => { let k = d.layers.length + 1; while (d.layers.some((l) => l.name === 'Layer ' + k)) k++; return 'Layer ' + k; };
    $('.pf-ly-add').onclick = () => layerEdit((d) => { d.layers.splice(d.active + 1, 0, blank(d, freeName(d))); d.active++; });
    $('.pf-ly-dup').onclick = () => layerEdit((d) => { const l = d.layer; d.layers.splice(d.active + 1, 0, { ...l, name: l.name + ' copy', px: l.px.slice() }); d.active++; });
    const moveLayer = (dir) => layerEdit((d) => { const a = d.active, b = a + dir; if (b < 0 || b >= d.layers.length) return; [d.layers[a], d.layers[b]] = [d.layers[b], d.layers[a]]; d.active = b; });
    $('.pf-ly-up').onclick = () => moveLayer(1); $('.pf-ly-down').onclick = () => moveLayer(-1);
    $('.pf-ly-merge').onclick = () => { const d = doc(); if (!d || d.active === 0) return; layerEdit((x) => { const a = x.active, below = x.layers[a - 1]; below.px = flattenLayers([{ ...below, visible: true, opacity: 100 }, x.layers[a]], x.w * x.h); x.layers.splice(a, 1); x.active = a - 1; }); note('merged into the layer below (Ctrl+Z undoes it)'); };
    $('.pf-ly-del').onclick = () => { const d = doc(); if (!d || d.layers.length < 2) return; const name = d.layer.name; layerEdit((x) => { x.layers.splice(x.active, 1); x.active = Math.max(0, x.active - 1); }); note(`deleted ${name} (Ctrl+Z brings it back)`); };
    $('.pf-ly-list').addEventListener('click', (e) => {
      const d = doc(), row = e.target.closest('.pf-ly'); if (!d || !row) return; const k = +row.dataset.k;
      if (e.target.closest('.pf-ly-link')) return d.layers[k].link ? unlinkLayer(d, k) : linkLayer(d, k);
      if (e.target.closest('.pf-ly-eye')) return layerEdit((x) => { x.layers[k].visible = !x.layers[k].visible; });
      if (k !== d.active) { commitFloat(); S.sel = null; d.active = k; keepSoon(); renderLayers(); render(); }
    });
    $('.pf-ly-list').addEventListener('change', (e) => { const k = e.target.dataset.k, v = e.target.value.trim(); if (k == null || e.target.tagName !== 'INPUT') return; const d = doc(); if (!d || !v || d.layers[k].name === v) return renderLayers(); layerEdit((x) => { x.layers[k].name = v; }); });
    { let session = false;
      $('.pf-ly-op').oninput = (e) => { const d = doc(); if (!d) return; if (!session) { d.snapshot(); session = true; } d.layer.opacity = +e.target.value; $('.pf-ly-opv').textContent = d.layer.opacity + '%'; keepSoon(); status(); render(); drawPreview(); };
      $('.pf-ly-op').onchange = () => { session = false; changedUi(); }; }
    /* Linked layers: one drawing (a helm, a weapon) shared by the frames of an animation. Each frame keeps its own copy, at
       its own offset (layer.link.x, .y); an edit to the copy in one frame is made in the others, moved by the difference of the
       offsets (linkCarry). `linkWas` holds each linked layer as it was last carried, so only new changes travel, undo included. */
    const linkWas = new WeakMap(); // doc → Map(id → { px, x, y })
    const wasOf = (d) => { let m = linkWas.get(d); if (!m) linkWas.set(d, (m = new Map())); return m; };
    function linkBase(d) { if (!d) return; const m = wasOf(d); for (const l of d.layers) if (l.link && !m.has(l.link.id)) m.set(l.link.id, { px: l.px.slice(), x: l.link.x, y: l.link.y }); }
    const linked = (x, id) => x.layers.find((l) => l.link && l.link.id === id);
    async function linkPeers(d) { const fam = famFor(d), out = []; if (!fam) return out; for (const p of fam.members) { if (p === d.path) continue; const x = await loadDoc(p); if (x && x.w === d.w && x.h === d.h) out.push(x); } return out; }
    let linkBusy = Promise.resolve(), linkTimer = 0;
    const syncLinksSoon = () => { clearTimeout(linkTimer); linkTimer = setTimeout(() => { const d = doc(); if (d && d.layers.some((l) => l.link)) linkBusy = linkBusy.then(() => syncLinks(d)); }, 0); };
    async function syncLinks(d) {
      const m = wasOf(d), changed = [];
      for (const l of d.layers) {
        if (!l.link) continue; const id = l.link.id, was = m.get(id);
        if (!was || was.x !== l.link.x || was.y !== l.link.y) { m.set(id, { px: l.px.slice(), x: l.link.x, y: l.link.y }); continue; } // new here, or this copy was moved: nothing to carry
        if (was.px.every((v, i) => v === l.px[i])) continue;
        const after = l.px.slice(); let frames = 0;
        for (const x of await linkPeers(d)) {
          const M = linked(x, id); if (!M) continue; linkBase(x);
          const copy = M.px.slice(), n = linkCarry(was.px, after, copy, d.w, d.h, M.link.x - l.link.x, M.link.y - l.link.y); if (!n) continue;
          x.snapshot(); M.px = copy; wasOf(x).set(id, { px: copy.slice(), x: M.link.x, y: M.link.y }); frames++;
        }
        m.set(id, { px: after, x: l.link.x, y: l.link.y }); if (frames) changed.push(`${l.name} → ${frames} frame${frames > 1 ? 's' : ''}`);
      }
      if (changed.length) { renderList(); renderFamily(); drawPreview(); note(`linked layer${changed.length > 1 ? 's' : ''} carried over: ${changed.join(', ')}${savesOut(d) ? ' (Save writes them too)' : ''}`); }
    }
    /** Link layer k of d across its frames: the other frames get a copy where it fits them best (their own layer of that name,
        or their picture), lifted out of the layers under it there. One undo step per image. */
    async function linkLayer(d, k) {
      commitFloat(); const L = d.layers[k], peers = await linkPeers(d);
      if (!peers.length) return note('Linking shares a layer between the frames of an animation (numbered files like walk_0, walk_1) of the same size: this sprite has none.');
      const id = L.name, plan = peers.map((x) => {
        const M = x.layers.find((l) => l.name === L.name), sh = findShift(L.px, M ? M.px : x.flat(), d.w, d.h), copy = new Uint32Array(d.w * d.h);
        linkCarry(new Uint32Array(d.w * d.h), L.px, copy, d.w, d.h, sh.x, sh.y);
        return { x, M, sh, copy, differs: M ? countDiff(M.px, copy) : 0 };
      });
      const odd = plan.filter((q) => q.differs).map((q) => `${fileName(q.x)} (${q.differs} px differ)`);
      if (!confirm(`Link “${L.name}” across ${plan.length + 1} frames? Draw it in any of them and the others follow.\n\n${plan.filter((q) => !q.M).length ? `Frames without a “${L.name}” layer get one, holding a copy of it where it fits them best.\n` : ''}${odd.length ? `These frames' own “${L.name}” layers become this copy: ${odd.join(', ')}.\n` : ''}\nCtrl+Z undoes it frame by frame.`)) return;
      d.snapshot(); L.link = { id, x: 0, y: 0 }; wasOf(d).set(id, { px: L.px.slice(), x: 0, y: 0 });
      for (const q of plan) {
        const { x, copy, sh } = q, link = { id, x: sh.x, y: sh.y }; x.snapshot();
        if (q.M) { q.M.px = copy; q.M.link = link; }
        else {
          const flat = x.flat(); // lift the drawing out of whatever shows it now, so it is not drawn twice
          for (let i = 0; i < copy.length; i++) { if (isClear(copy[i]) || !samePx(copy[i], flat[i])) continue; for (let t = x.layers.length - 1; t >= 0; t--) if (x.layers[t].visible !== false && !isClear(x.layers[t].px[i])) { x.layers[t].px[i] = 0; break; } }
          x.layers.splice(Math.min(k, x.layers.length), 0, layerOf({ name: L.name, px: copy, link }));
        }
        wasOf(x).set(id, { px: copy.slice(), x: link.x, y: link.y });
      }
      changedUi(); renderList(); note(`“${L.name}” linked across ${plan.length + 1} frames: draw it in one, the others follow`);
    }
    async function unlinkLayer(d, k) {
      commitFloat(); const id = d.layers[k].link.id, name = d.layers[k].name;
      d.snapshot(); delete d.layers[k].link; wasOf(d).delete(id);
      for (const x of await linkPeers(d)) { const M = linked(x, id); if (!M) continue; x.snapshot(); delete M.link; wasOf(x).delete(id); }
      changedUi(); renderList(); note(`“${name}” unlinked: every frame keeps its own copy`);
    }
    $('.pf-ly-nudge').onclick = (e) => {
      const b = e.target.closest('[data-nudge]'), d = doc(); if (!b || !d || !d.layer.link) return; const [dx, dy] = b.dataset.nudge.split(',').map(Number);
      commitFloat(); S.sel = null; d.snapshot(); const l = d.layer, moved = new Uint32Array(d.w * d.h);
      linkCarry(new Uint32Array(d.w * d.h), l.px, moved, d.w, d.h, dx, dy); l.px = moved; l.link = { ...l.link, x: l.link.x + dx, y: l.link.y + dy };
      wasOf(d).set(l.link.id, { px: moved.slice(), x: l.link.x, y: l.link.y }); changedUi();
    };
    /* Fold the right column's sections by their titles. Notes and Reference start folded; the choice is remembered. */
    const SHUT_KEY = 'pf:shut', panelKey = (p) => ([...p.classList].find((c) => c !== 'pf-panel' && c !== 'pf-shut') || p.querySelector(':scope>h4').textContent.trim().split(/\s/)[0]).replace(/^pf-/, '').toLowerCase();
    let shut; try { shut = new Set(JSON.parse(localStorage.getItem(SHUT_KEY) || 'null') || ['notes', 'refpanel']); } catch { shut = new Set(['notes', 'refpanel']); }
    const foldPanel = (p, on, keep = true) => {
      p.classList.toggle('pf-shut', on); p.querySelector(':scope>h4').setAttribute('aria-expanded', String(!on));
      if (!keep) return; const k = panelKey(p); if (on) shut.add(k); else shut.delete(k); try { localStorage.setItem(SHUT_KEY, JSON.stringify([...shut])); } catch { /* this visit */ }
    };
    $$('.pf-right > .pf-panel').forEach((p) => {
      const h = p.querySelector(':scope>h4'); if (!h) return; h.tabIndex = 0; h.setAttribute('role', 'button'); foldPanel(p, shut.has(panelKey(p)), false);
      h.onclick = () => foldPanel(p, !p.classList.contains('pf-shut'));
      h.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); h.click(); } };
    });
    $('.pf-note-add').onclick = () => { S.placingNote = !S.placingNote; renderNotes(); if (S.placingNote) note('Click the pixel the note is about.'); };
    $('.pf-note-list').addEventListener('input', (e) => { const i = e.target.dataset.i; if (i == null) return; const d = doc(), list = notesOf(d); if (!list[i]) return; list[i].text = e.target.value; setNotes(d.path, list); });
    $('.pf-note-list').addEventListener('click', (e) => { const b = e.target.closest('.pf-note-del'); if (!b) return; const d = doc(), list = notesOf(d); list.splice(+b.dataset.i, 1); setNotes(d.path, list); renderNotes(); render(); });
    $('.pf-grid').onclick = (e) => { S.grid = !S.grid; e.currentTarget.classList.toggle('on', S.grid); render(); };
    /* Tile grid: 0 (off) or a size in pixels (sprite sheets already show their frames). The project's config sets the default
       ("tileGrid": 16); a choice made here is remembered per project. */
    const tgKey = () => 'pf:tgrid:' + ((S.meta && S.meta.repo && S.meta.repo.slug) || (S.src && (S.src.name || S.src.kind)) || '');
    /* S.tgrid is the size drawn (0 = off); S.tgridSize the last size picked, which the toggle brings back. Stored as { v, size }
       (older visits stored just the number). */
    function loadTileGrid() {
      let v = null; try { v = JSON.parse(localStorage.getItem(tgKey()) || 'null'); } catch { /* none */ }
      const dflt = (S.src && S.src.tileGrid) || 0;
      if (v && typeof v === 'object') { S.tgrid = +v.v | 0; S.tgridSize = +v.size | 0 || dflt || 16; } else { S.tgrid = v != null ? +v | 0 : dflt; S.tgridSize = S.tgrid || dflt || 16; }
      $('.pf-tgrid').classList.toggle('on', !!S.tgrid);
    }
    const tileGridSize = () => +S.tgrid | 0;
    function setTileGrid(v) {
      S.tgrid = v; if (v) S.tgridSize = v; try { localStorage.setItem(tgKey(), JSON.stringify({ v: S.tgrid, size: S.tgridSize })); } catch { /* this visit only */ }
      $('.pf-tgrid').classList.toggle('on', !!v); render();
    }
    $('.pf-tgrid').onclick = () => setTileGrid(S.tgrid ? 0 : S.tgridSize || 16);
    $('.pf-grid-more').onclick = (e) => {
      e.stopPropagation(); const open = root.querySelector('.pf-tgmenu'); if (open) return open.remove();
      const opts = [[0, 'Tile grid off'], [8, '8 × 8'], [16, '16 × 16'], [32, '32 × 32'], [64, '64 × 64']];
      const menu = el(`<div class="pf-bgmenu pf-tgmenu" role="menu">${opts.map(([v, n]) => `<button role="menuitemradio" data-v="${v}"${String(S.tgrid || 0) === String(v) ? ' class="on" aria-checked="true"' : ''}>${n}</button>`).join('')}</div>`);
      root.appendChild(menu); const b = e.currentTarget.getBoundingClientRect(), r = root.getBoundingClientRect();
      menu.style.left = Math.max(4, Math.min(b.left - r.left, r.width - menu.offsetWidth - 4)) + 'px'; menu.style.top = (b.bottom - r.top + 4) + 'px';
      menu.onclick = (ev) => { const t = ev.target.closest('[data-v]'); if (!t) return; menu.remove(); setTileGrid(+t.dataset.v); };
    };
    const tgOutside = (e) => { const m = root.querySelector('.pf-tgmenu'); if (m && !m.contains(e.target) && !e.target.closest('.pf-grid-more')) m.remove(); };
    document.addEventListener('pointerdown', tgOutside);
    $('.pf-mx').onclick = (e) => { S.mx = !S.mx; e.currentTarget.classList.toggle('on', S.mx); render(); };
    $('.pf-my').onclick = (e) => { S.my = !S.my; e.currentTarget.classList.toggle('on', S.my); render(); };
    try { S.pp = localStorage.getItem('pf:cleanlines') === '1'; } catch { /* default off */ } $('.pf-pp').classList.toggle('on', S.pp);
    $('.pf-pp').onclick = (e) => { S.pp = !S.pp; e.currentTarget.classList.toggle('on', S.pp); try { localStorage.setItem('pf:cleanlines', S.pp ? '1' : '0'); } catch { /* ignore */ } };
    $('.pf-save').onclick = save; $('.pf-download').onclick = (e) => { e.stopPropagation(); root.querySelector('.pf-dlmenu') ? closeDlMenu() : openDlMenu(); }; $('.pf-prbtn').onclick = openPr; $('.pf-pr-go').onclick = submitPr;
    $('.pf-cpick').oninput = (e) => setColor(fromHex(e.target.value));
    $('.pf-chex').onchange = (e) => { const c = fromHex(e.target.value); if (c != null) setColor(c); else renderColors(); e.target.value = toHex(S.color); }; // shows what it became (Indexed snaps it), even while the field keeps focus
    $('.pf-recolor').onclick = () => { const i = $('.pf-recolor-in'); i.value = toHex(S.color); i.click(); };
    { let session = null;
      $('.pf-recolor-in').oninput = (e) => { const d = doc(), to = fromHex(e.target.value); if (!d || to == null) return; if (!session) { if (!d.layers.some((l) => l.px.includes(S.color))) { note('That colour is not in this image.'); return; } d.snapshot(); session = { from: S.color }; } for (const l of d.layers) for (let i = 0; i < l.px.length; i++) if (l.px[i] === session.from) l.px[i] = to; session.from = to; S.color = to; changedUi(); };
      $('.pf-recolor-in').onchange = () => { session = null; }; }
    $('.pf-fliph').onclick = () => transformSel((px, w, h) => ({ px: flipH(px, w, h), w, h })) || editAll((d) => { d.px = flipH(d.px, d.w, d.h); });
    $('.pf-flipv').onclick = () => transformSel((px, w, h) => ({ px: flipV(px, w, h), w, h })) || editAll((d) => { d.px = flipV(d.px, d.w, d.h); });
    /* Rotate by any angle (RotSprite): the selection grows to fit what it becomes; the whole image turns round its centre
       inside the same canvas (corners that leave it are cut). Previewed live. */
    function rotTarget() { const d = doc(); if (!d) return null; if (S.float) return { px: S.float.px, w: S.float.w, h: S.float.h, sel: true }; if (S.sel) return { px: copySelPx(d), w: S.sel.w, h: S.sel.h, sel: true }; return { px: d.flat(), w: d.w, h: d.h, sel: false }; } // a lasso or wand selection previews just its pixels
    function rotPreview() {
      const t = rotTarget(); if (!t) return; const a = +$('.pf-rot-n').value || 0, r = t.sel ? rotSprite(t.px, t.w, t.h, a) : rotSprite(t.px, t.w, t.h, a, t.w, t.h);
      const c = $('.pf-rot-prev'), sc = Math.max(1, Math.min(8, Math.floor(240 / Math.max(r.w, r.h)))); drawPx(c, { w: r.w, h: r.h, imageData: () => new ImageData(new Uint8ClampedArray(r.px.buffer.slice(0)), r.w, r.h) }, sc);
      $('.pf-rot-what').textContent = t.sel ? `the selection, ${t.w}×${t.h} → ${r.w}×${r.h}` : `the whole image, round its centre (${t.w}×${t.h} stays)`;
    }
    const rotSet = (a) => { a = Math.max(-180, Math.min(180, Math.round(+a || 0))); $('.pf-rot-a').value = a; $('.pf-rot-n').value = a; rotPreview(); };
    $('.pf-rotfree').onclick = () => { if (!doc()) return; rotPreview(); $('.pf-dlg-rot').showModal(); };
    $('.pf-rot-a').oninput = (e) => rotSet(e.target.value); $('.pf-rot-n').oninput = (e) => rotSet(e.target.value);
    $('.pf-rot-quick').onclick = (e) => { const b = e.target.closest('[data-a]'); if (b) rotSet(b.dataset.a); };
    $('.pf-rot-go').onclick = () => {
      const a = +$('.pf-rot-n').value || 0; $('.pf-dlg-rot').close(); if (!a) return;
      transformSel((px, w, h) => rotSprite(px, w, h, a)) || editAll((d) => { d.px = rotSprite(d.px, d.w, d.h, a, d.w, d.h).px; });
      note(`rotated ${a}°`);
    };
    $('.pf-x2').onclick = () => transformSel((px, w, h) => scale2x(px, w, h)) || editAll((d) => { const r = scale2x(d.px, d.w, d.h); d.px = r.px; d.w = r.w; d.h = r.h; fit(); });
    $('.pf-rot').onclick = () => transformSel((px, w, h) => ({ px: rotateCW(px, w, h), w: h, h: w })) || editAll((d) => { d.px = rotateCW(d.px, d.w, d.h); [d.w, d.h] = [d.h, d.w]; fit(); });
    const outline = (corners) => { if (isClear(S.color)) return note('Pick an opaque primary colour for the outline.'); commitFloat(); edit((d) => { d.px = outlinePx(d.px, d.w, d.h, S.color, corners); }); };
    $('.pf-outline').onclick = () => outline(false); $('.pf-outline8').onclick = () => outline(true);
    { const tips = $('.pf-imgtools'), line = $('.pf-imgtip'), idle = line.textContent; // name the button under the pointer (or keyboard focus)
      const show = (e) => { const b = e.target.closest('[data-tip]'); line.textContent = b ? b.dataset.tip : idle; };
      tips.addEventListener('pointerover', show); tips.addEventListener('focusin', show); tips.addEventListener('pointerleave', () => { line.textContent = idle; }); }
    $('.pf-clear').onclick = () => edit((d) => { d.px = new Uint32Array(d.w * d.h); });
    /* canvas size: grow or cut the canvas around an anchor, or scale the image; optionally every frame and pose of the family */
    const sz = { mode: 'canvas', anchor: 'c' };
    const szVal = (c) => Math.max(1, Math.min(1024, +$(c).value | 0));
    const famMembers = (d) => { const f = famOf.get(d.path); return f && f.members.length > 1 ? f.members : [d.path]; };
    function openSize() {
      const d = doc(); if (!d) return; commitFloat();
      $('.pf-sz-w').value = d.w; $('.pf-sz-h').value = d.h; sz.ratio = d.w / d.h;
      const m = famMembers(d); $('.pf-sz-famrow').hidden = m.length < 2; $('.pf-sz-famtext').textContent = `all ${m.length} ${famOf.get(d.path) && famOf.get(d.path).animated ? 'frames' : 'images'} of "${famOf.get(d.path) ? famOf.get(d.path).key.split('/').pop() : ''}" (they should match)`;
      sizeUi(); $('.pf-dlg-size').showModal();
    }
    function sizeResult(d, w, h) { return sz.mode === 'scale' ? scalePx(d.px, d.w, d.h, w, h) : resizePx(d.px, d.w, d.h, w, h, sz.anchor); }
    function sizeUi() {
      const d = doc(); if (!d) return; const w = szVal('.pf-sz-w'), h = szVal('.pf-sz-h');
      $$('.pf-sz-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === sz.mode));
      $$('.pf-sz-anchor button').forEach((b) => b.classList.toggle('on', b.dataset.a === sz.anchor));
      $('.pf-sz-anchorrow').hidden = sz.mode !== 'canvas'; $('.pf-sz-lockrow').hidden = sz.mode !== 'scale';
      const cv = $('.pf-sz-cv'), k = Math.max(1, Math.floor(160 / Math.max(w, h, d.w, d.h)));
      drawPx(cv, { w, h, imageData: () => new ImageData(new Uint8ClampedArray(sizeResult({ px: d.flat(), w: d.w, h: d.h }, w, h).buffer), w, h) }); cv.style.width = w * k + 'px'; cv.style.height = h * k + 'px';
      const lost = sz.mode === 'canvas' && (w < d.w || h < d.h) && (() => { const o = anchorOffset(d.w, d.h, w, h, sz.anchor), b = opaqueBounds(d.flat(), d.w, d.h); return b && (b.x + o.x < 0 || b.y + o.y < 0 || b.x + b.w + o.x > w || b.y + b.h + o.y > h); })();
      $('.pf-sz-info').innerHTML = `${d.w}×${d.h} → <b>${w}×${h}</b>${lost ? '<br><span class="pf-bad">cuts off visible pixels</span>' : ''}`;
    }
    function applySize(fn, what) {
      const d = doc(); if (!d) return; commitFloat(); S.sel = null;
      editAll((x) => { const r = fn(x); x.px = r.px; x.w = r.w; x.h = r.h; }); fit(); render(); note(what);
    }
    $('.pf-resize').onclick = openSize;
    root.addEventListener('click', (e) => { if (e.target.closest('.pf-s-size')) openSize(); });
    $('.pf-sz-mode').onclick = (e) => { const b = e.target.closest('[data-mode]'); if (!b) return; sz.mode = b.dataset.mode; const d = doc(); if (d) sz.ratio = d.w / d.h; sizeUi(); };
    $('.pf-sz-anchor').onclick = (e) => { const b = e.target.closest('[data-a]'); if (!b) return; sz.anchor = b.dataset.a; sizeUi(); };
    $('.pf-sz-w').oninput = () => { if (sz.mode === 'scale' && $('.pf-sz-lock').checked) $('.pf-sz-h').value = Math.max(1, Math.round(szVal('.pf-sz-w') / sz.ratio)); sizeUi(); };
    $('.pf-sz-h').oninput = () => { if (sz.mode === 'scale' && $('.pf-sz-lock').checked) $('.pf-sz-w').value = Math.max(1, Math.round(szVal('.pf-sz-h') * sz.ratio)); sizeUi(); };
    $('.pf-sz-quick').onclick = (e) => {
      const b = e.target.closest('[data-q]'); if (!b) return; let w = szVal('.pf-sz-w'), h = szVal('.pf-sz-h'); const p2 = (n) => 2 ** Math.ceil(Math.log2(n));
      ({ half: () => { w = Math.max(1, Math.round(w / 2)); h = Math.max(1, Math.round(h / 2)); }, double: () => { w *= 2; h *= 2; }, pow2: () => { w = p2(w); h = p2(h); }, square: () => { w = h = Math.max(w, h); } })[b.dataset.q]();
      $('.pf-sz-w').value = Math.min(1024, w); $('.pf-sz-h').value = Math.min(1024, h); sizeUi();
    };
    $('.pf-sz-ok').onclick = async () => {
      const d = doc(); if (!d) return; const w = szVal('.pf-sz-w'), h = szVal('.pf-sz-h'), all = !$('.pf-sz-famrow').hidden && $('.pf-sz-fam').checked;
      $('.pf-dlg-size').close(); commitFloat(); S.sel = null;
      const paths = all ? famMembers(d) : [d.path]; let n = 0;
      for (const p of paths) { const x = await loadDoc(p); if (!x || (x.w === w && x.h === h)) continue; x.snapshot(); x.allLayers((y) => { y.px = sizeResult(y, w, h); y.w = w; y.h = h; }); n++; }
      fit(); changedUi(); note(`${sz.mode === 'scale' ? 'scaled' : 'canvas'} ${w}×${h}${paths.length > 1 ? ` · ${n} of ${paths.length} images changed (undo works per image)` : ''}`);
    };
    $('.pf-trim').onclick = () => { const d = doc(); if (!d) return; commitFloat(); const b = opaqueBounds(d.flat(), d.w, d.h); if (!b) return note('Nothing to trim: the image is empty.'); if (b.w === d.w && b.h === d.h) return note('Nothing to trim: no empty border.'); applySize((x) => ({ px: copyRect(x.px, x.w, x.h, b), w: b.w, h: b.h }), `trimmed to ${b.w}×${b.h}`); };
    $('.pf-sel-crop').onclick = () => { const d = doc(); if (!d) return; commitFloat(); const r = S.sel; if (!r) return note('Select an area first (S, then drag).'); applySize((x) => ({ px: copyRect(x.px, x.w, x.h, r), w: r.w, h: r.h }), `cropped to ${r.w}×${r.h}`); };
    $('.pf-revert').onclick = () => { const d = doc(); if (!d || !d.changed) return; commitFloat(); S.sel = null; edit((x) => { if (x.base.layers) { x.w = x.base.w; x.h = x.base.h; x.setLayers(copyLayers(x.base.layers), x.active); } else x.setFlat(x.base.w, x.base.h, x.base.px.slice()); }); fit(); render(); note('back to the original (Ctrl+Z brings your changes back)'); };
    const dlOutside = (e) => { const m = root.querySelector('.pf-dlmenu'); if (m && !m.contains(e.target) && !e.target.closest('.pf-download')) closeDlMenu(); };
    document.addEventListener('pointerdown', dlOutside);
    /* New sprite: the four sizes this project uses most as one-click choices (standard squares when it has fewer), any size by hand */
    function commonSizes() {
      const n = new Map(); for (const x of S.sprites) if (x.w && x.h && !x.hiddenByDefault) { const k = x.w + 'x' + x.h; n.set(k, (n.get(k) || 0) + 1); }
      const top = [...n].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, c]) => { const [w, h] = k.split('x').map(Number); return { w, h, c }; });
      for (const d of [16, 32, 64, 128]) { if (top.length >= 4) break; if (!top.some((t) => t.w === d && t.h === d)) top.push({ w: d, h: d, c: 0 }); }
      return top.sort((a, b) => a.w * a.h - b.w * b.h);
    }
    const markQuick = () => $$('.pf-n-quick button').forEach((b) => b.classList.toggle('on', b.dataset.w === $('.pf-nw').value && b.dataset.h === $('.pf-nh').value));
    /** The name sidebar New suggests: the next free `new_sprite[N].png`, so creating never silently numbers a duplicate. */
    /** Where a new sprite goes in a project with none open yet: its art folder (configured, or just picked), else the top level. */
    function artDir() {
      if (doc()) return '';
      const src = S.src, f = src && src.kind === 'github' ? readFolders(src) : null, dirs = (f && f.cfg && f.cfg.dirs) || (src && src.config && src.config.dirs) || [];
      return dirs[0] && dirs[0] !== '.' ? dirs[0].replace(/\/+$/, '') + '/' : '';
    }
    function nextSpriteName() { const taken = new Set(S.sprites.map((s) => s.path)), dir = artDir(); if (!taken.has(dir + 'new_sprite.png')) return dir + 'new_sprite.png'; let n = 1; while (taken.has(`${dir}new_sprite${n}.png`)) n++; return `${dir}new_sprite${n}.png`; }
    function openNew() {
      const sizes = commonSizes(), d = doc();
      $('.pf-n-quick').innerHTML = sizes.map((x) => `<button type="button" data-w="${x.w}" data-h="${x.h}" title="${x.c ? x.c + ' sprite' + (x.c > 1 ? 's' : '') + ' in this project are this size' : 'a common size'}">${x.w}×${x.h}</button>`).join('');
      const pick = sizes.find((x) => d && x.w === d.w && x.h === d.h) || sizes.reduce((a, b) => (b.c > a.c ? b : a), sizes[0]); // the open sprite's size, else the project's most used
      $('.pf-nw').value = pick.w; $('.pf-nh').value = pick.h; markQuick(); $('.pf-nn').value = nextSpriteName(); $('.pf-dlg-new').showModal();
    }
    $('.pf-n-quick').onclick = (e) => { const b = e.target.closest('[data-w]'); if (!b) return; $('.pf-nw').value = b.dataset.w; $('.pf-nh').value = b.dataset.h; markQuick(); };
    $('.pf-nw').oninput = markQuick; $('.pf-nh').oninput = markQuick;
    $('.pf-new').onclick = openNew;
    $('.pf-new-ok').onclick = () => { const w = Math.max(1, Math.min(1024, +$('.pf-nw').value | 0)), h = Math.max(1, Math.min(1024, +$('.pf-nh').value | 0)); let n = $('.pf-nn').value.trim().replace(/^\/+/, '') || 'new-sprite.png'; if (!/\.png$/i.test(n)) n += '.png'; $('.pf-dlg-new').close(); addLocal(n, w, h, new Uint32Array(w * h), canWrite()); };
    $('.pf-open').onclick = () => { uploadToNew = false; $('.pf-file').click(); };
    $('.pf-file').onchange = async (e) => { const files = [...e.target.files]; e.target.value = ''; if (!files.length) return; if (uploadToNew) { uploadToNew = false; if (!(await newLocalProject({ sprite: false }))) return; } for (const f of files) await importFile(f); };
    async function importFile(f) { try { const img = await decodePng(f); addLocal(f.name, img.w, img.h, img.px); } catch (err) { note('Could not read ' + f.name + ': ' + err.message); } }
    stage.addEventListener('dragover', (e) => e.preventDefault());
    stage.addEventListener('drop', async (e) => { e.preventDefault(); for (const f of e.dataTransfer.files) if (/^image\//.test(f.type)) await importFile(f); });
    /** Branch names for the connect dialog, so an existing branch can be picked instead of typed. Quiet when signed out or offline. */
    async function fillConnectBranches() {
      const dl = $('#pf-c-branchlist'); if (!dl) return;
      const repo = $('.pf-c-repo').value.trim(); if (!repo) { dl.innerHTML = ''; return; }
      const token = await commitToken();
      if (!token) return;
      try { dl.innerHTML = (await listBranches({ token, repo, apiBase: O.apiBase })).map((b) => `<option value="${esc(b)}">`).join(''); } catch { /* leave free typing */ }
    }
    function openConnect(msg) {
      const dlg = $('.pf-dlg-connect'), gh = O.github || {};
      $('.pf-c-repo').value = $('.pf-c-repo').value || gh.slug || ''; $('.pf-c-branch').value = $('.pf-c-branch').value || gh.base || ''; if (!S.auth.token) $('.pf-c-token').value = $('.pf-c-token').value || storedToken();
      if (S.auth.token) loadRepos();
      fillConnectBranches();
      const canFolder = typeof window.showDirectoryPicker === 'function'; $('.pf-c-folder').disabled = !canFolder; $('.pf-c-foldernote').textContent = canFolder ? 'Saves the PNGs in place. Chrome, Edge and Opera.' : 'Needs Chrome, Edge or Opera.';
      $('.pf-c-msg').textContent = msg || ''; if (!dlg.open) dlg.showModal();
      renderLocals();
    }
    $('.pf-c-locals').onclick = async (e) => {
      const b = e.target.closest('button[data-id]'); if (!b) return; const id = b.dataset.id;
      if (b.classList.contains('pf-c-ldel')) return deleteLocalProject(id);
      if (b.classList.contains('pf-c-lren')) { const n = (prompt('Project name:', localName(id)) || '').trim(); if (!n) return; const l = localProjects(); const x = l.find((p) => p.id === id); if (x) x.name = n; else l.push({ id, name: n, at: Date.now() }); saveLocalProjects(l); if (S.src && S.src.kind === 'browser' && (S.src.id || '') === id) { S.src.name = n; sourceButton(); } return renderLocals(); }
      if (await useSource(browserSource(id, localName(id)))) $('.pf-dlg-connect').close();
    };
    $('.pf-source').onclick = (e) => { e.stopPropagation(); if (S.src && S.src.kind === 'github' && S.src.repo.slug) { root.querySelector('.pf-brmenu') ? closeBrMenu() : openBranchMenu(); } else openConnect(); };
    authRows('.pf-signin').forEach((b) => (b.onclick = () => { const d = b.closest('dialog'); doSignIn(d && d.querySelector('.pf-c-msg, .pf-log')); }));
    authRows('.pf-signout').forEach((b) => (b.onclick = () => { signOut(); if (!b.closest('dialog')) note('Signed out of GitHub on this device.'); }));
    $('.pf-c-repolist').onclick = (e) => { const b = e.target.closest('.pf-c-pick'); if (!b) return; $('.pf-c-repo').value = b.dataset.repo; $('.pf-c-branch').value = b.dataset.branch; $('.pf-c-gh').click(); };
    $('.pf-c-repo').addEventListener('change', fillConnectBranches);
    let uploadToNew = false; // Upload PNG in the dialog starts a project in this browser (unless one is open); Open PNG in the sidebar adds to the open project
    $('.pf-c-upload').onclick = () => { uploadToNew = !(S.src && S.src.kind === 'browser'); $('.pf-dlg-connect').close(); $('.pf-file').click(); };
    $('.pf-c-blank').onclick = () => newLocalProject();
    $('.pf-delete').onclick = deleteSprite;
    $('.pf-c-gh').onclick = async () => {
      const msg = $('.pf-c-msg'), typed = S.auth.token ? '' : $('.pf-c-token').value.trim(), repo = $('.pf-c-repo').value.trim();
      if (!repo) { msg.textContent = 'Pick a repository, or type owner/name.'; return; }
      // The dialog gets out of the way at once; the sprite list shows the loading, and the dialog comes back only if it fails.
      $('.pf-dlg-connect').close(); showLoading(repo);
      const ticket = ++loadSeq, current = () => ticket === loadSeq; // picking again while one loads: the newer pick wins
      try {
        const token = typed || await authToken();
        const src = await githubSource({ repo, branch: $('.pf-c-branch').value.trim() || undefined, token, apiBase: O.apiBase, onProgress: (t) => current() && loadingStep(t) });
        if (!current()) return;
        try { if (typed) { if ($('.pf-c-remember').checked) localStorage.setItem('pf:token', token); else sessionStorage.setItem('pf:token', token); } } catch { /* storage blocked */ }
        loadingStep(src.sprites.length + ' PNG file' + (src.sprites.length === 1 ? '' : 's') + ' found');
        if (!(await useSource(src))) { hideLoading(); openConnect(); }
      } catch (e) { if (!current()) return; hideLoading(); openConnect(e.message); if (/rejected the (sign-in|token)/.test(e.message) && S.auth.token) signOut(); }
    };
    $('.pf-c-folder').onclick = async () => {
      const msg = $('.pf-c-msg'); msg.textContent = '';
      try {
        const dir = await window.showDirectoryPicker({ mode: 'readwrite' }); msg.textContent = 'Scanning ' + dir.name + '…';
        const src = await folderSource(dir); msg.textContent = src.sprites.length + ' PNG file' + (src.sprites.length === 1 ? '' : 's') + ' found.';
        if (await useSource(src)) $('.pf-dlg-connect').close();
      } catch (e) { msg.textContent = e && e.name === 'AbortError' ? '' : 'Could not open the folder: ' + (e && e.message); }
    };
    $('.pf-palload').onclick = () => $('.pf-palfile').click();
    /* Lospec: the palette's name (the end of its lospec.com/palette-list/… address) or the address itself. Its .json answers CORS. */
    $('.pf-lospec-btn').onclick = () => { const f = $('.pf-lospec'); f.hidden = !f.hidden; if (!f.hidden) $('.pf-lospec-name').focus(); };
    $('.pf-lospec').onsubmit = async (e) => {
      e.preventDefault(); const raw = $('.pf-lospec-name').value.trim(), m = /palette-list\/([\w-]+)/.exec(raw), slug = (m ? m[1] : raw).toLowerCase().replace(/\s+/g, '-').replace(/\.(hex|json)$/, '');
      if (!/^[a-z0-9-]+$/.test(slug)) { note('Type a Lospec palette name, like endesga-32'); return; }
      note('Loading ' + slug + ' from Lospec…');
      try {
        const r = await fetch((O.lospecBase || 'https://lospec.com/palette-list/') + slug + '.json'); if (!r.ok) throw new Error(r.status === 404 ? 'no palette called ' + slug : 'Lospec answered ' + r.status);
        const j = await r.json(), cols = (j.colors || []).map((h) => fromHex('#' + String(h).replace('#', ''))).filter((c) => c != null);
        if (!cols.length) throw new Error('that palette has no colours');
        S.palette = cols; renderPalette(); renderColors(); $('.pf-lospec').hidden = true;
        note(`${j.name || slug}: ${cols.length} colours${j.author ? ' by ' + j.author : ''} (Save .hex keeps it with the project)`);
      } catch (err) { note('Could not load it from Lospec: ' + err.message); }
    };
    /* Indexed mode: remembered per project; "indexed": true in the config turns it on by default, "maxColors" sets the limit shown. */
    const idxKey = () => 'pf:indexed:' + ((S.meta && S.meta.repo && S.meta.repo.slug) || (S.src && (S.src.name || S.src.kind)) || '');
    function loadIndexed() { let v = null; try { v = JSON.parse(localStorage.getItem(idxKey()) || 'null'); } catch { /* none */ } S.indexed = v != null ? v : !!(S.src && S.src.indexed); S.maxColors = O.maxColors || (S.src && S.src.maxColors) || null; renderPalette(); }
    $('.pf-pal-lock').onclick = () => {
      if (!S.palette.length && !S.indexed) return note('Load or build a palette first: indexed mode keeps every colour to it.');
      S.indexed = !S.indexed; try { localStorage.setItem(idxKey(), JSON.stringify(S.indexed)); } catch { /* this visit */ }
      if (S.indexed) { S.color = inPal(S.color); S.color2 = inPal(S.color2); }
      renderPalette(); renderColors(); note(S.indexed ? 'Indexed: picks snap to the palette; double-click a palette colour to change it everywhere in the image' : 'Indexed off: any colour');
    };
    /* Edit a palette slot (indexed mode): double-click a palette colour, pick the new one, and every pixel of the old colour follows. */
    let slotOld = null;
    $('.pf-pal-colors').addEventListener('dblclick', (e) => { const b = e.target.closest('button[data-c]'); if (!b || !S.indexed) return; slotOld = +b.dataset.c; const inp = $('.pf-slot-in'); inp.value = toHex(slotOld); inp.click(); });
    $('.pf-slot-in').onchange = (e) => {
      const nw = fromHex(e.target.value), old = slotOld; slotOld = null; if (nw == null || old == null || nw === old) return;
      S.palette = S.palette.map((c) => (c === old ? nw : c));
      let n = 0; const d = doc(); if (d) editAll((dd) => { for (let i = 0; i < dd.px.length; i++) if (dd.px[i] === old) { dd.px[i] = nw; n++; } });
      if (S.color === old) S.color = nw; if (S.color2 === old) S.color2 = nw;
      renderPalette(); renderColors(); note(`${toHex(old)} → ${toHex(nw)}: ${n} pixel${n === 1 ? '' : 's'} changed`);
    };
    $('.pf-palfile').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const p = parsePalette(await f.text()); if (p.length) { S.palette = p; renderPalette(); renderColors(); note('palette: ' + p.length + ' colours'); } else note('No colours found in ' + f.name); e.target.value = ''; };
    $('.pf-palsave').onclick = () => { const d = doc(); if (!d) return; const cols = S.palette.length ? S.palette : colorsOf(d.flat()).filter(([c]) => c !== 0).map(([c]) => c); download(new Blob([cols.map((c) => toHex(c).slice(1)).join('\n') + '\n'], { type: 'text/plain' }), 'palette.hex'); };
    $('.pf-snap').onclick = () => editAll((d) => { for (let i = 0; i < d.px.length; i++) if (!isClear(d.px[i])) d.px[i] = nearestColor(d.px[i], S.palette); });
    $('.pf-play').onclick = () => play(!S.anim.timer);
    ['.pf-fw', '.pf-fh', '.pf-fps'].forEach((s) => ($(s).oninput = frameInputs));
    function keydown(e) {
      if (!root.isConnected) return;
      const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      if (root.querySelector('dialog[open]')) return;
      const k = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
      if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); } else if (mod && k === 'y') { e.preventDefault(); redo(); } else if (mod && k === 's') { e.preventDefault(); e.shiftKey ? downloadPng(1) : save(); }
      else if (mod && e.altKey && k === 'c') { e.preventDefault(); openSize(); }
      else if (mod && k === 'c') { if (copySel(false)) e.preventDefault(); } else if (mod && k === 'x') { if (copySel(true)) e.preventDefault(); }
      else if (mod && k === 'a') { e.preventDefault(); selectAll(); }
      else if (mod && k === 'v') { pasteSoon = setTimeout(() => { if (S.clip) pastePx(S.clip.px, S.clip.w, S.clip.h); }, 60); } // the paste event below wins when the clipboard holds an image from another app
      else if (k === 'escape' && qpalOpen()) { e.preventDefault(); qpalHide(); }
      else if (k === 'escape' && !$('.pf-cpop').hidden) { e.preventDefault(); colourPop(false); $('.pf-prim').focus(); }
      else if (k === 'escape' && root.querySelector('.pf-bgmenu')) { e.preventDefault(); closeBgMenu(); closeDlMenu(); }
      else if (k === 'escape' && (S.sel || S.float)) { e.preventDefault(); dropSelection(); }
      else if (k === 'enter' && S.float) { e.preventDefault(); commitFloat(); render(); status(); }
      else if ((k === 'delete' || k === 'backspace') && (S.sel || S.float)) { e.preventDefault(); deleteSel(); }
      else if (k.startsWith('arrow') && S.sel && !mod) { e.preventDefault(); const n = e.shiftKey ? 8 : 1; nudge(k === 'arrowleft' ? -n : k === 'arrowright' ? n : 0, k === 'arrowup' ? -n : k === 'arrowdown' ? n : 0); }
      else if (!mod && !e.altKey) {
        if (k === 'tab') { e.preventDefault(); qpalToggle(); }
        else {
        const t = TOOLS.find((x) => x[2].toLowerCase() === k); if (t) setTool(t[0]);
        else if (k === 'i') setTool('pick'); // the old picker key, kept for muscle memory: A is now the home-row picker next to Z/X
        else if (k === 'm') $('.pf-mx').click(); else if (k === '+' || k === '=') $('.pf-zin').click(); else if (k === '-') $('.pf-zout').click(); else if (k === '0') $('.pf-fit').click(); else if (k === '#') $('.pf-grid').click();
        else if (k === 'x') $('.pf-swap').click(); else if (k === 'z') setTool(S.tool === 'erase' ? 'pen' : 'erase'); else if (k === '[') setSize(S.size - 1); else if (k === ']') setSize(S.size + 1);
        else if (k === 'k') cycleBg(); else if (k === 'y') $('.pf-vision').click(); else if (k === 'p') $('.pf-lint').click(); else if (k === 'h') toggleRef(); else if (k === 'c') $('.pf-changes').click(); else if (k === 'v') $('.pf-context').click(); else if (e.code === 'Backslash' || e.key === '\\' || e.key === '|') { e.preventDefault(); peek(e.shiftKey ? 'saved' : 'base'); } else if (k === ',') stepMember(-1); else if (k === '.') stepMember(1);
        else if (k === 't') $('.pf-tile').click(); else if (k === 'n') $('.pf-onion').click(); else if (e.key === '?') $('.pf-help').click();
        else if (k === ' ') { space = true; e.preventDefault(); }
        }
      }
    }
    const keyup = (e) => { if (e.key === ' ') space = false; if (e.code === 'Backslash' || e.key === '\\' || e.key === '|') peek(false); };
    let pasteSoon = 0;
    async function onPaste(e) {
      if (!root.isConnected || root.querySelector('dialog[open]') || !doc()) return;
      const tag = (e.target.tagName || '').toLowerCase(); if (tag === 'input' || tag === 'textarea') return;
      const file = [...((e.clipboardData && e.clipboardData.files) || [])].find((f) => /^image\//.test(f.type)); if (!file) return;
      e.preventDefault(); clearTimeout(pasteSoon);
      try { const img = await decodePng(file); pastePx(img.px, img.w, img.h); } catch (err) { note('Could not paste that image: ' + err.message); }
    }
    document.addEventListener('keydown', keydown); document.addEventListener('keyup', keyup); document.addEventListener('paste', onPaste);
    const leaveGuard = (e) => { if ([...S.docs.values()].some(atRisk)) { flushDrafts(); e.preventDefault(); e.returnValue = ''; } }; /* work that is neither saved nor kept in the browser would be lost: ask first */
    const hideFlush = () => { if (document.visibilityState === 'hidden') flushDrafts(); }; document.addEventListener('visibilitychange', hideFlush);
    window.addEventListener('beforeunload', leaveGuard);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => { const had = doc(); fsRail(); resizeView(); if (had && !S.touched) fit(); render(); }) : null; if (ro) ro.observe(stage);
    resizeView(); renderAuth(); applyBg(); init();

    const ctrl = {
      get docs() { return S.docs; }, get current() { return doc(); }, open: openSprite, save, setColor, setColor2, setTool, undo, redo, selectAll, state: S,
      dispose() { document.removeEventListener('pointerdown', tgOutside); window.removeEventListener('focus', reposOnReturn); document.removeEventListener('keydown', keydown); document.removeEventListener('keyup', keyup); document.removeEventListener('paste', onPaste); document.removeEventListener('pointerdown', bgOutside); document.removeEventListener('pointerdown', brOutside); document.removeEventListener('pointerdown', qpalOutside, true); document.removeEventListener('pointermove', trackMouse); window.removeEventListener('pointerup', peekOff); window.removeEventListener('beforeunload', leaveGuard); document.removeEventListener('visibilitychange', hideFlush); document.removeEventListener('pointerdown', dlOutside); if (ro) ro.disconnect(); clearInterval(S.anim.timer); host.innerHTML = ''; delete host.__pf; },
    };
    host.__pf = ctrl;
    return ctrl;
  }

  return { mount, createPullRequest, prBody, feedback: { url: feedbackUrl, title: feedbackTitle, details: feedbackDetails, repo: FEEDBACK_REPO }, pushSprites, openPull, openPulls, listBranches, png: { decode: decodePngBytes, encode: encodePngBytes }, auth: { signIn: githubSignIn, refresh: githubRefresh, user: githubUser, listRepos, explainError: explainGithubError, tokenUrl: PAT_URL }, sources: { githubSource, folderSource, staticSource, serverSource, applyConfig }, core: { portEdit, portLayers, layerMap, linkCarry, findShift, ditherGradient, selMask, maskSel, lassoMask, combineMasks, lintPixels, scale2x, rotSprite, sheetCut, sheetJoin, sheetEdit, packSheet, sheetJson, holdFrame, artFolders, folderConfig, pack, unpack, toHex, fromHex, parsePalette, nearestColor, linePoints, rectPoints, ellipsePoints, brushOffsets, thicken, ditherOn, floodFill, fillSame, outlinePx, toHsv, fromHsv, shadeColor, hueRamp, copyRect, pasteRect, rectBetween, constrain, colorsOf, groupSprites, encodeGif, shiftColor, variantPath, flipH, flipV, rotateCW, shiftWrap, resizePx, scalePx, anchorOffset, opaqueBounds, zipFiles, browserDrafts, countDiff, snapAlpha, normAlpha, normGroups, flattenLayers, packLayers, unpackLayers, layersPath, isLayersFile, layersSig, Doc } };
});
