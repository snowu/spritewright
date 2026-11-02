// `spritewright mcp`: a Model Context Protocol server (JSON-RPC 2.0 over stdio, newline-delimited) so coding agents can draw
// pixel art precisely instead of writing one-off image scripts. No dependencies: it uses the editor's own drawing core and
// lossless PNG codec.
//
// What keeps agents honest:
//   - sprites are read and written as character grids with a colour legend and coordinate rulers, never guessed from an image
//   - with a project palette, a colour outside it is refused (or snapped with snap: true), never written by accident
//   - every edit goes into an in-memory draft with undo; nothing touches the disk until commit, and commit refuses to overwrite
//     a file that changed on disk since it was opened
//   - every edit answers with what changed (pixel count and bounding box) and any new pixel-lint problems it introduced
//   - shapes, fills, outlines, shading and dithers use the same algorithms as the editor, so they are exact and repeatable
//   - out-of-bounds writes are errors, not silently clipped (unless clip: true); a sheet's frames are addressed by index
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { scan, DEFAULTS, loadConfig } from './scan.mjs';
import { safeResolve } from './serve.mjs';
await import('../spritewright.js');
const PF = globalThis.Spritewright, C = PF.core;

const VERSION = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')).version;
const PROTOCOL = '2025-06-18';
const KEYS = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ!#$%&*+-=?@^~<>;:/|()[]{}';
const MAX_GRID = 128 * 128; // larger reads need a region
const isClear = (c) => c >>> 24 === 0;
const rgb = (c) => c & 0xffffff;
const hexA = (c) => isClear(c) ? 'clear' : C.toHex(c) + (c >>> 24 === 255 ? '' : (c >>> 24).toString(16).padStart(2, '0'));
const sha = (b) => crypto.createHash('sha1').update(b).digest('hex');

class ToolError extends Error {}
const fail = (msg) => { throw new ToolError(msg); };
const int = (v, name, { min = -Infinity, def } = {}) => {
  if (v == null) { if (def !== undefined) return def; fail(`${name} is required`); }
  if (!Number.isInteger(v) || v < min) fail(`${name} must be an integer${min > -Infinity ? ' ≥ ' + min : ''} (got ${JSON.stringify(v)})`);
  return v;
};

/* ---------------------------------------------------------------------------------------------------------------------------- */

export function createMcp({ root = '.' } = {}) {
  root = fs.realpathSync(path.resolve(root));
  const ignore = [...DEFAULTS.ignore, ...(loadConfig(root).ignore || [])];
  const drafts = new Map(); // path -> draft
  const manifest = () => scan(root);
  const projectPalette = () => { // read on every call (cheap), so a palette edited meanwhile applies at once
    const f = loadConfig(root).palette; if (typeof f !== 'string') return null;
    try { const p = C.parsePalette(fs.readFileSync(path.resolve(root, f), 'utf8')).map((c) => (c | 0xff000000) >>> 0); return p.length ? p : null; } catch { return null; }
  };

  const resolve = (rel) => {
    if (typeof rel !== 'string' || !rel) fail('path is required (relative to the project, e.g. "art/hero.png")');
    rel = rel.replace(/^\.\//, '');
    if (!/\.png$/i.test(rel)) fail(`${rel}: only .png sprites can be edited`);
    if (C.isLayersFile(rel)) fail(`${rel} is a layers file; open the sprite itself (${rel.replace(/\.layers\.png$/i, '.png')}) and pick a layer`);
    const abs = safeResolve(root, rel.split('/').map(encodeURIComponent).join('/'), ignore);
    if (!abs) fail(`${rel}: not a path inside the project (no "..", hidden or ignored folders)`);
    return { rel, abs };
  };

  /* ---- drafts ---- */
  async function open(rel) {
    const r = resolve(rel);
    if (drafts.has(r.rel)) return drafts.get(r.rel);
    if (!fs.existsSync(r.abs)) fail(`${r.rel} does not exist (use create_sprite for a new one; list_sprites shows what is there)`);
    const bytes = fs.readFileSync(r.abs), img = await PF.png.decode(new Uint8Array(bytes));
    let layers = null, layersHash = null;
    const lp = C.layersPath(r.abs);
    if (fs.existsSync(lp)) {
      const lb = fs.readFileSync(lp); layersHash = sha(lb);
      try { layers = C.unpackLayers(await PF.png.decode(new Uint8Array(lb)), img.w, img.h); } catch { layers = null; }
    }
    if (!layers) layers = [{ name: 'Layer 1', visible: true, opacity: 100, px: img.px.slice() }];
    const entry = manifest().sprites.find((s) => s.path === r.rel);
    const d = { ...r, w: img.w, h: img.h, layers, frames: entry?.frames || null, undo: [], hash: sha(bytes), layersHash, isNew: false,
      base: { w: img.w, h: img.h, px: flat(layers, img.w * img.h) } };
    initKeys(d); drafts.set(r.rel, d);
    return d;
  }
  const flat = (layers, n) => layers.length === 1 ? layers[0].px.slice() : C.flattenLayers(layers, n);
  const flatOf = (d) => flat(d.layers, d.w * d.h);
  const dirty = (d) => d.isNew || d.base.w !== d.w || d.base.h !== d.h || C.countDiff(d.base.px, flatOf(d)) > 0;

  function pickLayer(d, layer) {
    if (layer == null) {
      if (d.layers.length === 1) return 0;
      fail(`${d.rel} has ${d.layers.length} layers (${d.layers.map((l, i) => `${i}: "${l.name}"`).join(', ')}); say which with layer (index or name)`);
    }
    const i = typeof layer === 'number' ? layer : d.layers.findIndex((l) => l.name === layer);
    if (!d.layers[i]) fail(`no layer ${JSON.stringify(layer)} in ${d.rel} (layers: ${d.layers.map((l, k) => `${k}: "${l.name}"`).join(', ')})`);
    return i;
  }
  function frameRect(d, frame) {
    if (frame == null) return { x: 0, y: 0, w: d.w, h: d.h };
    if (!d.frames) fail(`${d.rel} has no frames configured (set "frames" for it in spritewright.config.json); use coordinates on the whole image instead`);
    const cols = Math.max(1, Math.floor(d.w / d.frames.w)), rows = Math.max(1, Math.floor(d.h / d.frames.h)), n = cols * rows;
    int(frame, 'frame', { min: 0 });
    if (frame >= n) fail(`frame ${frame} is past the end: ${d.rel} has ${n} frames of ${d.frames.w}×${d.frames.h} (0-${n - 1})`);
    return { x: (frame % cols) * d.frames.w, y: Math.floor(frame / cols) * d.frames.h, w: d.frames.w, h: d.frames.h };
  }

  /* ---- colours ---- */
  function parseColor(v, { palette, snap, what = 'colour' }) {
    if (v === 'clear' || v === 'transparent' || v === null) return 0;
    const c = typeof v === 'string' ? C.fromHex(v) : null;
    if (c == null) fail(`${what} ${JSON.stringify(v)} is not a colour: use "#rrggbb", "#rrggbbaa" or "clear"`);
    if (isClear(c)) return 0;
    if (palette && !palette.some((p) => rgb(p) === rgb(c))) {
      const near = C.nearestColor(c, palette);
      if (!snap) fail(`${what} ${v} is not in the project palette (nearest: ${C.toHex(near)}). Use a palette colour, or pass snap: true to snap to the nearest`);
      return ((c & 0xff000000) | rgb(near)) >>> 0;
    }
    return c;
  }
  /* Grid keys belong to a draft and never change while it is open, so a key read once means the same colour in every later
     read, diff and write. The project palette's colours take the first keys (the same in every sprite); the sprite's other
     colours get the next free keys, in the order they are first seen. */
  function initKeys(d) {
    d.keys = { byColor: new Map(), byKey: new Map() };
    const pal = projectPalette();
    if (pal) for (const p of pal.slice(0, KEYS.length)) addKey(d, p);
    for (const [c] of C.colorsOf(flatOf(d))) if (c !== 0 && d.keys.byColor.size < KEYS.length) addKey(d, c);
  }
  function addKey(d, c) {
    c >>>= 0; if (d.keys.byColor.has(c)) return d.keys.byColor.get(c);
    const used = new Set(d.keys.byKey.keys()), k = [...KEYS].find((ch) => !used.has(ch));
    if (!k) fail(`too many colours for a character grid (more than ${KEYS.length}); read a smaller region or use preview`);
    d.keys.byColor.set(c, k); d.keys.byKey.set(k, c); return k;
  }
  /** The draft's keys, with any colours of px that have none yet added; legend lists only the keys px uses. */
  function keysFor(d, px) {
    const legend = {};
    for (const [c] of C.colorsOf(px)) if (c !== 0) legend[addKey(d, c)] = hexA(c);
    legend['.'] = 'clear';
    return { byColor: d.keys.byColor, legend };
  }
  const paletteLegend = (palette) => palette ? Object.fromEntries(palette.slice(0, KEYS.length).map((p, i) => [KEYS[i], C.toHex(p)])) : null;

  function gridText(px, w, h, ox, oy, byColor, rulers) {
    const lines = [], pad = String(oy + h - 1).length + 1;
    if (rulers) {
      const xs = Array.from({ length: w }, (_, i) => String(ox + i)), digits = Math.max(...xs.map((s) => s.length));
      for (let d = 0; d < digits; d++) lines.push(' '.repeat(pad + 1) + xs.map((s) => s.padStart(digits)[d]).join(''));
    }
    for (let y = 0; y < h; y++) {
      let row = '';
      for (let x = 0; x < w; x++) { const c = px[y * w + x]; row += isClear(c) ? '.' : byColor.get(c >>> 0); }
      lines.push(rulers ? String(oy + y).padStart(pad) + ' ' + row : row);
    }
    return lines.join('\n');
  }

  /* ---- edits ---- */
  const snapshot = (d) => ({ w: d.w, h: d.h, layers: d.layers.map((l) => ({ ...l, px: l.px.slice() })) });
  function lintSet(px, w, h) { const l = C.lintPixels(px, w, h); return { stray: new Set(l.stray), doubles: new Set(l.doubles) }; }
  /** Run an edit on a draft and report what it did: pixels changed, where, and pixel-lint problems it introduced. */
  async function edit(d, fn, frame) {
    const before = snapshot(d), flatBefore = flatOf(d), lintBefore = lintSet(flatBefore, d.w, d.h);
    let note;
    try { note = fn() || ''; } catch (e) { d.w = before.w; d.h = before.h; d.layers = before.layers; throw e; } // an edit is all or nothing
    const after = flatOf(d);
    if (d.w === before.w && d.h === before.h && C.countDiff(flatBefore, after) === 0 && before.layers.every((l, i) => C.countDiff(l.px, d.layers[i].px) === 0)) return `No pixels changed.${note ? ' ' + note : ''}`;
    d.undo.push(before); if (d.undo.length > 100) d.undo.shift();
    return summary(d, flatBefore, before.w, before.h, after, lintBefore, frame == null ? null : frameRect(d, frame)) + (note ? '\n' + note : '');
  }
  function summary(d, a, aw, ah, b, lintBefore, fr) {
    const out = [];
    if (aw !== d.w || ah !== d.h) out.push(`Size is now ${d.w}×${d.h} (was ${aw}×${ah}).`);
    else {
      let n = 0, x0 = d.w, y0 = d.h, x1 = -1, y1 = -1;
      for (let i = 0; i < b.length; i++) if (a[i] !== b[i] && !(isClear(a[i]) && isClear(b[i]))) { n++; const x = i % d.w, y = (i / d.w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      out.push(!n ? 'No visible pixels changed (a hidden or transparent layer was edited).'
        : fr ? `Changed ${n} pixel${n === 1 ? '' : 's'} in frame x ${x0 - fr.x}-${x1 - fr.x}, y ${y0 - fr.y}-${y1 - fr.y} (sheet x ${x0}-${x1}, y ${y0}-${y1}).`
          : `Changed ${n} pixel${n === 1 ? '' : 's'} in x ${x0}-${x1}, y ${y0}-${y1}.`);
    }
    const l = C.lintPixels(b, d.w, d.h), at = (i) => `(${i % d.w},${(i / d.w) | 0})` + (fr ? ' sheet' : '');
    const newStray = lintBefore && aw === d.w && ah === d.h ? l.stray.filter((i) => !lintBefore.stray.has(i)) : l.stray;
    const newDbl = lintBefore && aw === d.w && ah === d.h ? l.doubles.filter((i) => !lintBefore.doubles.has(i)) : l.doubles;
    if (newStray.length) out.push(`New stray pixels (dust or holes): ${newStray.slice(0, 12).map(at).join(' ')}${newStray.length > 12 ? ' …' : ''}`);
    if (newDbl.length) out.push(`Worth a look, new possible doubled corners: ${newDbl.slice(0, 12).map(at).join(' ')}${newDbl.length > 12 ? ' …' : ''} (fine if this is shading or closes an outline; if fixing one only moves it next door, it was fine)`);
    out.push('Draft only: commit to write it to disk.');
    return out.join('\n');
  }

  /** Where an edit may draw: a layer of a draft, limited to a frame. set(x, y, c) takes coordinates relative to the frame. */
  function canvas(d, a) {
    const li = pickLayer(d, a.layer), L = d.layers[li], r = frameRect(d, a.frame), clip = !!a.clip;
    const inside = (x, y) => x >= 0 && y >= 0 && x < r.w && y < r.h;
    const set = (x, y, c) => { if (inside(x, y)) L.px[(r.y + y) * d.w + r.x + x] = c; };
    const get = (x, y) => L.px[(r.y + y) * d.w + r.x + x];
    const check = (pts) => { // refuse a whole edit that reaches outside, rather than drawing part of it
      if (clip) return pts.filter(([x, y]) => inside(x, y));
      const out = pts.filter(([x, y]) => !inside(x, y));
      if (out.length) fail(`${out.length} pixel${out.length === 1 ? '' : 's'} would land outside the ${a.frame != null ? `frame (${r.w}×${r.h})` : `image (${d.w}×${d.h})`}, e.g. (${out[0][0]},${out[0][1]}). Coordinates are 0-based${a.frame != null ? ' and relative to the frame' : ''}; pass clip: true to drop them`);
      return pts;
    };
    const note = L.link ? `Note: layer "${L.name}" is linked to other frames' files; this edit was not carried to them (open them and edit the same way if needed).` : '';
    return { L, li, r, set, get, inside, check, note };
  }

  /* ---------------------------------------------------------------------------------------------------------------------- */
  const tools = [];
  const tool = (name, description, properties, required, run) => tools.push({ name, description, inputSchema: { type: 'object', properties, required, additionalProperties: false }, run });
  const P = {
    path: { type: 'string', description: 'Sprite path relative to the project root, e.g. "art/hero.png"' },
    frame: { type: 'integer', minimum: 0, description: 'Frame index of a sprite sheet (frames left to right, then down; sizes from spritewright.config.json "frames"). Coordinates become relative to the frame.' },
    layer: { type: ['integer', 'string'], description: 'Layer index (0 = bottom) or name. Required when the sprite has more than one layer.' },
    color: { type: 'string', description: '"#rrggbb", "#rrggbbaa" or "clear"' },
    snap: { type: 'boolean', description: 'Snap colours outside the project palette to the nearest palette colour instead of refusing' },
    clip: { type: 'boolean', description: 'Drop pixels outside the image or frame instead of refusing the edit' },
    dither: { type: 'boolean', description: 'Paint only every other pixel in a checkerboard (the editor\'s dither pattern)' },
  };

  tool('list_sprites', 'List the project\'s sprites (path, size, frames, layers), its palette with the grid key of each colour, and open drafts with unsaved changes. Start here.', {}, [], async () => {
    const m = manifest(), pal = projectPalette(), sprites = m.sprites.filter((s) => !C.isLayersFile(s.path));
    const lines = [`Project: ${root}`, `${sprites.length} sprite${sprites.length === 1 ? '' : 's'}:`];
    for (const s of sprites) lines.push(`  ${s.path}  ${s.w}×${s.h}${s.frames ? `  frames ${s.frames.w}×${s.frames.h}` : ''}${fs.existsSync(C.layersPath(path.join(root, s.path))) ? '  (layers)' : ''}${drafts.has(s.path) && dirty(drafts.get(s.path)) ? '  [unsaved draft]' : ''}`);
    for (const d of drafts.values()) if (d.isNew) lines.push(`  ${d.rel}  ${d.w}×${d.h}  [new, not yet committed]`);
    if (pal) lines.push('', `Palette (${pal.length} colours; colours outside it are refused). Grid keys: ${JSON.stringify(paletteLegend(pal))}`);
    else lines.push('', 'No project palette configured, so any colour is allowed. Set "palette" in spritewright.config.json to enforce one.');
    return lines.join('\n');
  });

  tool('read_sprite', 'Read a sprite (or a frame, layer or region of it) as a character grid: one character per pixel, "." is clear, the legend maps the others to colours. Rulers give x along the top (read the digits downward) and y down the left. Reads the draft if it has unsaved edits.', {
    path: P.path, frame: P.frame, layer: { ...P.layer, description: 'Layer index or name; default: all visible layers flattened' },
    x: { type: 'integer', minimum: 0 }, y: { type: 'integer', minimum: 0 }, w: { type: 'integer', minimum: 1 }, h: { type: 'integer', minimum: 1 },
    rulers: { type: 'boolean', description: 'Coordinate rulers (default true)' },
  }, ['path'], async (a) => {
    const d = await open(a.path), fr = frameRect(d, a.frame), src = a.layer == null ? flatOf(d) : d.layers[pickLayer(d, a.layer)].px;
    const x = int(a.x, 'x', { min: 0, def: 0 }), y = int(a.y, 'y', { min: 0, def: 0 });
    const w = int(a.w, 'w', { min: 1, def: fr.w - x }), h = int(a.h, 'h', { min: 1, def: fr.h - y });
    if (x + w > fr.w || y + h > fr.h || w < 1 || h < 1) fail(`region x ${x} y ${y} w ${w} h ${h} does not fit the ${a.frame != null ? 'frame' : 'image'} (${fr.w}×${fr.h})`);
    if (w * h > MAX_GRID) fail(`${w}×${h} is too big for one grid; read a region (x, y, w, h) of at most ${MAX_GRID} pixels, or use preview`);
    const px = C.copyRect(src, d.w, d.h, { x: fr.x + x, y: fr.y + y, w, h }), { byColor, legend: shown } = keysFor(d, px);
    const head = [`${d.rel}  ${d.w}×${d.h}${d.frames ? `, frames ${d.frames.w}×${d.frames.h}` : ''}${a.frame != null ? `, frame ${a.frame} (at ${fr.x},${fr.y} in the sheet)` : ''}${d.layers.length > 1 ? `, layers: ${d.layers.map((l, i) => `${i} "${l.name}"${l.visible === false ? ' (hidden)' : ''}`).join(', ')}${a.layer == null ? ' (shown flattened)' : `, showing layer ${pickLayer(d, a.layer)}`}` : ''}${dirty(d) ? ', unsaved draft' : ''}`,
      `Region x ${x}-${x + w - 1}, y ${y}-${y + h - 1}${a.frame != null ? ' (frame coordinates)' : ''}`, `Legend: ${JSON.stringify(shown)}`, ''];
    return head.join('\n') + gridText(px, w, h, x, y, byColor, a.rulers !== false);
  });

  tool('write_pixels', 'Write a block of pixels from a character grid, with its top-left corner at (x, y). Every row must be the same length. Characters map to colours through legend ("." means clear unless the legend says otherwise); a legend value of "keep" leaves that pixel as it is. Without a legend, the keys read_sprite showed for this sprite are used (they stay the same while the sprite is open); legend entries add keys or override them.', {
    path: P.path, x: { type: 'integer' }, y: { type: 'integer' },
    rows: { type: 'array', items: { type: 'string' }, description: 'The grid, one string per row, no rulers' },
    legend: { type: 'object', additionalProperties: { type: 'string' }, description: 'Character → "#rrggbb", "#rrggbbaa", "clear" or "keep"' },
    frame: P.frame, layer: P.layer, snap: P.snap, clip: P.clip,
  }, ['path', 'rows'], async (a) => {
    const d = await open(a.path), pal = projectPalette();
    if (!Array.isArray(a.rows) || !a.rows.length || a.rows.some((r) => typeof r !== 'string')) fail('rows must be a non-empty array of strings');
    const rows = a.rows.map((r) => [...r]), width = rows[0].length;
    const ragged = rows.findIndex((r) => r.length !== width);
    if (ragged >= 0) fail(`row ${ragged} is ${rows[ragged].length} characters wide but row 0 is ${width}; every row must be the same width (use a "keep" character for pixels to leave alone)`);
    const given = a.legend || {};
    for (const k of Object.keys(given)) if ([...k].length !== 1) fail(`legend key ${JSON.stringify(k)} must be a single character`);
    const usedCh = [...new Set(rows.flat())], unknown = usedCh.filter((ch) => !(ch in given) && ch !== '.' && !d.keys.byKey.has(ch));
    if (unknown.length) fail(`characters not in the legend or this sprite's keys: ${unknown.map((c) => JSON.stringify(c)).join(' ')} (read_sprite shows the keys; add others with legend, e.g. {"z": "#1a1c2c"})`);
    const map = new Map(); // only the characters used are checked, so an unused key for an off-palette colour is no obstacle
    for (const ch of usedCh) {
      const v = ch in given ? given[ch] : ch === '.' ? 'clear' : hexA(d.keys.byKey.get(ch));
      map.set(ch, v === 'keep' ? 'keep' : parseColor(v, { palette: pal, snap: a.snap, what: ch in given ? `legend "${ch}"` : `key "${ch}" (${v})` }));
    }
    const x0 = int(a.x, 'x', { def: 0 }), y0 = int(a.y, 'y', { def: 0 });
    return edit(d, () => {
      const cv = canvas(d, a), pts = [];
      rows.forEach((r, j) => r.forEach((ch, i) => { if (map.get(ch) !== 'keep') pts.push([x0 + i, y0 + j, map.get(ch)]); }));
      for (const [x, y, c] of cv.check(pts)) cv.set(x, y, c);
      return cv.note;
    }, a.frame);
  });

  tool('draw', 'Draw with the editor\'s tools on a draft. op: "pixel" (x, y), "line" (x0, y0 → x1, y1, optional brush size), "rect" / "ellipse" (corners x0, y0, x1, y1; filled), "fill" (flood fill from x, y; same_color: true fills every pixel of that colour instead), "replace_color" (from → color), "outline" (color around every opaque shape; corners: true includes diagonals), "shade" (step colours lighter (amount > 0) or darker (amount < 0) with hue shifting, inside the rectangle x0, y0, x1, y1 or the whole image/frame, snapping to the palette if there is one), "dither_gradient" (ordered dither from color at x0, y0 to color2 at x1, y1, over the area connected to (x0, y0) or the rectangle given by rx0, ry0, rx1, ry1). All coordinates are 0-based and inclusive.', {
    path: P.path, op: { type: 'string', enum: ['pixel', 'line', 'rect', 'ellipse', 'fill', 'replace_color', 'outline', 'shade', 'dither_gradient'] },
    x: { type: 'integer' }, y: { type: 'integer' }, x0: { type: 'integer' }, y0: { type: 'integer' }, x1: { type: 'integer' }, y1: { type: 'integer' },
    rx0: { type: 'integer' }, ry0: { type: 'integer' }, rx1: { type: 'integer' }, ry1: { type: 'integer' },
    color: P.color, color2: P.color, from: P.color, filled: { type: 'boolean' }, brush: { type: 'integer', minimum: 1, maximum: 16 }, round: { type: 'boolean', description: 'Round brush tip' },
    same_color: { type: 'boolean' }, corners: { type: 'boolean' }, amount: { type: 'integer', description: 'shade: steps, positive lighter, negative darker' },
    dither: P.dither, frame: P.frame, layer: P.layer, snap: P.snap, clip: P.clip,
  }, ['path', 'op'], async (a) => {
    const d = await open(a.path), pal = projectPalette(), col = (k = 'color') => parseColor(a[k], { palette: pal, snap: a.snap, what: k });
    const op = a.op, need = (...ks) => ks.forEach((k) => int(a[k], `${k} (for ${op})`));
    // validate everything before the edit, so a mistake changes nothing
    let color = null;
    if (['pixel', 'line', 'rect', 'ellipse', 'fill', 'replace_color', 'outline'].includes(op)) { if (a.color === undefined) fail(`color is required for ${op}`); color = col(); }
    return edit(d, () => {
      const cv = canvas(d, a), r = cv.r, dith = (pts) => (a.dither ? pts.filter(([x, y]) => C.ditherOn(x, y)) : pts);
      const paint = (pts) => { for (const [x, y] of cv.check(dith(pts))) cv.set(x, y, color); };
      if (op === 'pixel') { need('x', 'y'); paint([[a.x, a.y]]); }
      else if (op === 'line') { need('x0', 'y0', 'x1', 'y1'); paint(C.thicken(C.linePoints(a.x0, a.y0, a.x1, a.y1), a.brush || 1, a.round ? 'round' : 'square')); }
      else if (op === 'rect' || op === 'ellipse') {
        need('x0', 'y0', 'x1', 'y1');
        const pts = (op === 'rect' ? C.rectPoints : C.ellipsePoints)(a.x0, a.y0, a.x1, a.y1, !!a.filled);
        paint(a.filled ? pts : C.thicken(pts, a.brush || 1, a.round ? 'round' : 'square'));
      } else if (op === 'fill') {
        need('x', 'y'); if (!cv.inside(a.x, a.y)) fail(`(${a.x},${a.y}) is outside the ${a.frame != null ? 'frame' : 'image'} (${r.w}×${r.h})`);
        // fill a copy with a marker value that differs from the start pixel, only to find the area's pixels; then paint those
        const probe = C.copyRect(cv.L.px, d.w, d.h, r), t = probe[a.y * r.w + a.x], mark = t === 0 ? 1 : 0;
        const idx = a.same_color ? C.fillSame(probe, a.x, a.y, r.w, mark) : C.floodFill(probe, r.w, r.h, a.x, a.y, mark);
        paint(idx.map((i) => [i % r.w, (i / r.w) | 0]));
      } else if (op === 'replace_color') {
        if (a.from === undefined) fail('from is required for replace_color'); const from = parseColor(a.from, { palette: null, what: 'from' }), pts = [];
        for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) { const v = cv.get(x, y); if (v === from || (isClear(v) && isClear(from))) pts.push([x, y]); }
        if (!pts.length) return `No pixels of ${a.from} found.`;
        paint(pts);
      } else if (op === 'outline') {
        if (!color) fail('an outline needs a visible colour');
        const px = C.copyRect(cv.L.px, d.w, d.h, r), o = C.outlinePx(px, r.w, r.h, color, !!a.corners), pts = [];
        for (let i = 0; i < px.length; i++) if (o[i] !== px[i]) pts.push([i % r.w, (i / r.w) | 0]);
        paint(pts);
      } else if (op === 'shade') {
        const amt = int(a.amount, 'amount'); if (!amt) fail('amount must not be 0');
        if (a.x0 != null) need('x0', 'y0', 'x1', 'y1');
        const box = a.x0 != null ? { x0: Math.min(a.x0, a.x1), y0: Math.min(a.y0, a.y1), x1: Math.max(a.x0, a.x1), y1: Math.max(a.y0, a.y1) } : { x0: 0, y0: 0, x1: r.w - 1, y1: r.h - 1 };
        const pts = cv.check(dith(C.rectPoints(box.x0, box.y0, box.x1, box.y1, true)));
        for (const [x, y] of pts) { let v = cv.get(x, y); if (isClear(v)) continue; for (let s = 0; s < Math.abs(amt); s++) v = C.shadeColor(v, Math.sign(amt), pal); cv.set(x, y, v); }
      } else if (op === 'dither_gradient') {
        need('x0', 'y0', 'x1', 'y1'); if (a.color === undefined || a.color2 === undefined) fail('color and color2 are required for dither_gradient');
        const c1 = col(), c2 = col('color2'); let idx;
        if (a.rx0 != null) { need('rx0', 'ry0', 'rx1', 'ry1'); idx = cv.check(C.rectPoints(a.rx0, a.ry0, a.rx1, a.ry1, true)).map(([x, y]) => y * r.w + x); }
        else { if (!cv.inside(a.x0, a.y0)) fail(`(${a.x0},${a.y0}) is outside the ${a.frame != null ? 'frame' : 'image'}`); const probe = C.copyRect(cv.L.px, d.w, d.h, r); idx = C.floodFill(probe, r.w, r.h, a.x0, a.y0, probe[a.y0 * r.w + a.x0] === 0 ? 1 : 0); } // marker fill, as for "fill"
        const px = C.copyRect(cv.L.px, d.w, d.h, r); C.ditherGradient(px, r.w, idx, a.x0, a.y0, a.x1, a.y1, c1, c2);
        for (const i of idx) cv.set(i % r.w, (i / r.w) | 0, px[i]);
      } else fail(`unknown op ${JSON.stringify(op)}`);
      return cv.note;
    }, a.frame);
  });

  tool('transform', 'Flip, rotate or shift a whole sprite, one frame of it, or one layer. op: "flip_h", "flip_v", "rotate_cw" (90° clockwise; a frame or a non-square image must stay the same shape, so only square ones), "rotate_ccw", "shift" (dx, dy, wrapping around the edges).', {
    path: P.path, op: { type: 'string', enum: ['flip_h', 'flip_v', 'rotate_cw', 'rotate_ccw', 'shift'] }, dx: { type: 'integer' }, dy: { type: 'integer' },
    frame: P.frame, layer: { ...P.layer, description: 'Layer index or name; default: every layer' },
  }, ['path', 'op'], async (a) => {
    const d = await open(a.path), r = frameRect(d, a.frame), which = a.layer == null ? d.layers.map((_, i) => i) : [pickLayer(d, a.layer)];
    if ((a.op === 'rotate_cw' || a.op === 'rotate_ccw') && r.w !== r.h) fail(`rotating needs a square ${a.frame != null ? 'frame' : 'image'} (this one is ${r.w}×${r.h})`);
    if (a.op === 'shift' && a.dx == null && a.dy == null) fail('shift needs dx and/or dy');
    const f = { flip_h: (p) => C.flipH(p, r.w, r.h), flip_v: (p) => C.flipV(p, r.w, r.h), rotate_cw: (p) => C.rotateCW(p, r.w, r.h),
      rotate_ccw: (p) => C.rotateCW(C.rotateCW(C.rotateCW(p, r.w, r.h), r.w, r.h), r.w, r.h), shift: (p) => C.shiftWrap(p, r.w, r.h, int(a.dx, 'dx', { def: 0 }), int(a.dy, 'dy', { def: 0 })) }[a.op];
    if (!f) fail(`unknown op ${JSON.stringify(a.op)}`);
    return edit(d, () => { for (const i of which) C.pasteRect(d.layers[i].px, d.w, d.h, f(C.copyRect(d.layers[i].px, d.w, d.h, r)), r.w, r.h, r.x, r.y, true); }, a.frame);
  });

  tool('create_sprite', 'Start a new sprite as a draft (written on commit). Fails if the file already exists.', {
    path: P.path, w: { type: 'integer', minimum: 1, maximum: 1024 }, h: { type: 'integer', minimum: 1, maximum: 1024 }, fill: { ...P.color, description: 'Background colour (default clear)' }, snap: P.snap,
  }, ['path', 'w', 'h'], async (a) => {
    const r = resolve(a.path), w = int(a.w, 'w', { min: 1 }), h = int(a.h, 'h', { min: 1 });
    if (w > 1024 || h > 1024) fail('sprites are at most 1024×1024');
    if (fs.existsSync(r.abs) || drafts.has(r.rel)) fail(`${r.rel} already exists; open it with read_sprite instead`);
    const px = new Uint32Array(w * h).fill(a.fill ? parseColor(a.fill, { palette: projectPalette(), snap: a.snap, what: 'fill' }) : 0);
    const d = { ...r, w, h, layers: [{ name: 'Layer 1', visible: true, opacity: 100, px }], frames: null, undo: [], hash: null, layersHash: null, isNew: true, base: { w, h, px: new Uint32Array(w * h) } };
    initKeys(d); drafts.set(r.rel, d);
    return `New ${w}×${h} draft ${r.rel}. Draw on it, then commit to write it.`;
  });

  tool('preview', 'Render a sprite as an enlarged PNG image to look at: transparency on a checkerboard, a pixel grid when large enough, frame borders in red. compare: true puts the saved version (left) beside the draft (right).', {
    path: P.path, frame: P.frame, scale: { type: 'integer', minimum: 1, maximum: 32, description: 'Pixels per sprite pixel (default: fit about 512px)' },
    grid: { type: 'boolean', description: 'Pixel grid lines (default: on when scale ≥ 8)' }, compare: { type: 'boolean' },
  }, ['path'], async (a) => {
    const d = await open(a.path), r = frameRect(d, a.frame);
    const s = int(a.scale, 'scale', { min: 1, def: Math.max(1, Math.min(32, Math.floor(512 / Math.max(r.w, r.h)))) }), grid = a.grid ?? s >= 8;
    const imgs = [C.copyRect(flatOf(d), d.w, d.h, r)];
    if (a.compare) { if (d.base.w !== d.w || d.base.h !== d.h) fail('the draft changed size, so it cannot be shown beside the saved version'); imgs.unshift(C.copyRect(d.base.px, d.w, d.h, r)); }
    const gap = 2 * s, W = imgs.length * r.w * s + (imgs.length - 1) * gap, H = r.h * s, out = new Uint32Array(W * H).fill(C.pack(255, 255, 255));
    const sheetFrames = a.frame == null && d.frames ? d.frames : null;
    imgs.forEach((px, k) => {
      const ox = k * (r.w * s + gap), cell = Math.max(1, s >> 1);
      for (let Y = 0; Y < H; Y++) for (let X = 0; X < r.w * s; X++) {
        const x = (X / s) | 0, y = (Y / s) | 0, c = px[y * r.w + x], bg = ((((X / cell) | 0) + ((Y / cell) | 0)) & 1) ? 0xcc : 0xee, al = (c >>> 24) / 255;
        const mix = (sh) => Math.round(((c >>> sh) & 255) * al + bg * (1 - al));
        let v = C.pack(mix(0), mix(8), mix(16));
        if (grid && (X % s === 0 || Y % s === 0)) v = C.pack(Math.round(mix(0) * 0.7), Math.round(mix(8) * 0.7), Math.round(mix(16) * 0.7));
        if (sheetFrames && ((X % (sheetFrames.w * s) === 0 && X) || (Y % (sheetFrames.h * s) === 0 && Y))) v = C.pack(230, 40, 40);
        out[Y * W + ox + X] = v;
      }
    });
    const png = await PF.png.encode(W, H, out);
    return [{ type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: `${d.rel}${a.frame != null ? ` frame ${a.frame}` : ''}: ${r.w}×${r.h} at ${s}x${a.compare ? ', saved (left) and draft (right)' : ''}${dirty(d) ? ', unsaved draft' : ''}` }];
  });

  tool('lint', 'Check a sprite (the draft if it has edits) for the mistakes pixel-art critique points out first: stray pixels (dust or holes), doubled corners on 1px lines, near-duplicate colours, colours outside the project palette, and wrongly sized sheets.', { path: P.path }, ['path'], async (a) => {
    const d = await open(a.path), px = flatOf(d), l = C.lintPixels(px, d.w, d.h), at = (i) => `(${i % d.w},${(i / d.w) | 0})`, out = [], pal = projectPalette();
    if (l.stray.length) out.push(`Stray pixels (${l.stray.length}): ${l.stray.slice(0, 40).map(at).join(' ')}${l.stray.length > 40 ? ' …' : ''}`);
    for (const n of l.near) out.push(`Near-duplicate colours: ${hexA(n.odd)} (${n.n} px) is almost ${hexA(n.keep)}`);
    const hints = l.doubles.length ? `Worth a look, possible doubled corners on 1px lines (${l.doubles.length}): ${l.doubles.slice(0, 40).map(at).join(' ')}${l.doubles.length > 40 ? ' …' : ''}\nThese are often intentional: steps in a shading band, or an outline corner that closes a shape. Fix one only if it is a jaggy on a line, and check that the fix does not just move it next door.` : '';
    if (pal) {
      const set = new Set(pal.map(rgb)), off = new Map();
      px.forEach((c, i) => { if (!isClear(c) && !set.has(rgb(c))) { const e = off.get(c) || { n: 0, first: i }; e.n++; off.set(c, e); } });
      for (const [c, e] of off) out.push(`Outside the palette: ${hexA(c)} (${e.n} px, first at ${at(e.first)}; nearest ${C.toHex(C.nearestColor(c, pal))})`);
    }
    if (d.frames && (d.w % d.frames.w || d.h % d.frames.h)) out.push(`${d.w}×${d.h} is not a whole number of ${d.frames.w}×${d.frames.h} frames`);
    if (!px.some((c) => !isClear(c))) out.push('Fully transparent');
    return (out.length ? `${d.rel}:\nProblems:\n` + out.join('\n') : `${d.rel}: no problems found.`) + (hints ? '\n\n' + hints : '');
  });

  tool('diff', 'What the draft changed compared with the saved file: pixel count, bounding box, and the changed area before and after as grids.', { path: P.path }, ['path'], async (a) => {
    const d = await open(a.path), b = flatOf(d);
    if (d.base.w !== d.w || d.base.h !== d.h) return `${d.rel}: size changed from ${d.base.w}×${d.base.h} to ${d.w}×${d.h}.`;
    let n = 0, x0 = d.w, y0 = d.h, x1 = -1, y1 = -1;
    for (let i = 0; i < b.length; i++) if (b[i] !== d.base.px[i] && !(isClear(b[i]) && isClear(d.base.px[i]))) { n++; const x = i % d.w, y = (i / d.w) | 0; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    if (!n) return `${d.rel}: no changes${d.isNew ? ' (new, empty sprite)' : ''}.`;
    const box = { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    if (box.w * box.h > MAX_GRID) return `${d.rel}: ${n} pixels changed in x ${x0}-${x1}, y ${y0}-${y1} (too large to show as a grid; use preview with compare: true).`;
    const before = C.copyRect(d.base.px, d.w, d.h, box), after = C.copyRect(b, d.w, d.h, box), { byColor, legend: shown } = keysFor(d, Uint32Array.from([...before, ...after]));
    return `${d.rel}: ${n} pixel${n === 1 ? '' : 's'} changed in x ${x0}-${x1}, y ${y0}-${y1}.\nLegend: ${JSON.stringify(shown)}\n\nBefore:\n${gridText(before, box.w, box.h, x0, y0, byColor, true)}\n\nAfter:\n${gridText(after, box.w, box.h, x0, y0, byColor, true)}`;
  });

  tool('undo', 'Undo the last edit(s) to a draft.', { path: P.path, steps: { type: 'integer', minimum: 1 } }, ['path'], async (a) => {
    const d = await open(a.path), n = int(a.steps, 'steps', { min: 1, def: 1 });
    if (!d.undo.length) fail(`nothing to undo in ${d.rel}`);
    let k = 0; for (; k < n && d.undo.length; k++) { const s = d.undo.pop(); d.w = s.w; d.h = s.h; d.layers = s.layers; }
    return `Undid ${k} edit${k === 1 ? '' : 's'} to ${d.rel}; ${d.undo.length} more can be undone.`;
  });

  tool('discard', 'Throw away a draft\'s unsaved edits (the file on disk is untouched).', { path: P.path }, ['path'], async (a) => {
    const r = resolve(a.path); if (!drafts.delete(r.rel)) return `${r.rel} had no draft.`; return `Discarded the draft of ${r.rel}.`;
  });

  tool('commit', 'Write a draft to disk: the sprite PNG (losslessly, 8-bit RGBA) and, for a layered sprite, its .layers.png. Refuses if the file changed on disk since it was opened (someone else edited it), unless force is true. Run lint first.', {
    path: P.path, force: { type: 'boolean' },
  }, ['path'], async (a) => {
    const r = resolve(a.path), d = drafts.get(r.rel);
    if (!d) fail(`${r.rel} has no draft (nothing has been edited)`);
    if (!dirty(d)) return `${d.rel}: no changes to write.`;
    const lp = C.layersPath(d.abs);
    if (!a.force) {
      if (d.isNew && fs.existsSync(d.abs)) fail(`${d.rel} was created on disk by someone else meanwhile; pass force: true to overwrite it`);
      if (!d.isNew && (!fs.existsSync(d.abs) || sha(fs.readFileSync(d.abs)) !== d.hash)) fail(`${d.rel} changed on disk since it was opened (another edit, or the browser editor). discard and redo the edit, or pass force: true to overwrite`);
      if (!d.isNew && (fs.existsSync(lp) ? sha(fs.readFileSync(lp)) : null) !== d.layersHash) fail(`${path.basename(lp)} changed on disk since it was opened; discard and redo the edit, or pass force: true`);
    }
    const px = flatOf(d), bytes = await PF.png.encode(d.w, d.h, px);
    const write = (abs, b) => { fs.mkdirSync(path.dirname(abs), { recursive: true }); const tmp = abs + '.pf-tmp-' + process.pid; fs.writeFileSync(tmp, b); fs.renameSync(tmp, abs); };
    write(d.abs, bytes); d.hash = sha(bytes);
    if (d.layers.length > 1) { const L = C.packLayers(d.layers, d.w, d.h), lb = await PF.png.encode(L.w, L.h, L.px, 1, L.text); write(lp, lb); d.layersHash = sha(lb); }
    const n = d.isNew ? d.w * d.h : C.countDiff(d.base.px, px);
    d.base = { w: d.w, h: d.h, px: px.slice() }; d.isNew = false; d.undo = [];
    const l = C.lintPixels(px, d.w, d.h), warn = l.stray.length + l.near.length;
    return `Wrote ${d.rel} (${d.w}×${d.h}${d.layers.length > 1 ? `, ${d.layers.length} layers` : ''}${n ? `, ${n} pixels changed` : ''}).${warn ? ` Lint: ${l.stray.length} stray, ${l.near.length} near-duplicate colours (run lint for where).` : ''}${l.doubles.length ? ` ${l.doubles.length} possible doubled corner${l.doubles.length === 1 ? '' : 's'} worth a look.` : ''}`;
  });

  /* ---- JSON-RPC ---- */
  async function handle(msg) {
    const { id, method, params } = msg || {};
    const reply = (result) => (id === undefined ? null : { jsonrpc: '2.0', id, result });
    const error = (code, message) => (id === undefined ? null : { jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') return reply({ protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: 'spritewright', version: VERSION },
      instructions: 'Pixel art editing for this project. Start with list_sprites, read_sprite to see pixels as a grid, then write_pixels / draw / transform. Edits stay in a draft until commit; check them with preview, diff and lint first.' });
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: tools.map(({ run, ...t }) => t) });
    if (method === 'tools/call') {
      const t = tools.find((x) => x.name === params?.name);
      if (!t) return error(-32602, `unknown tool ${JSON.stringify(params?.name)}`);
      try {
        const out = await t.run(params.arguments || {});
        return reply({ content: Array.isArray(out) ? out : [{ type: 'text', text: out }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'Error: ' + (e.stack || e.message) }], isError: true });
      }
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return null;
    return error(-32601, `method not found: ${method}`);
  }
  return { root, handle, tools: tools.map((t) => t.name), drafts };
}

/** Serve over stdin/stdout: one JSON-RPC message per line. Logs go to stderr; stdout carries only protocol messages. */
export function runStdio({ root = '.', input = process.stdin, output = process.stdout } = {}) {
  const mcp = createMcp({ root });
  let buf = '', queue = Promise.resolve();
  const send = (m) => { if (m) output.write(JSON.stringify(m) + '\n'); };
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buf += chunk; let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg = null; try { msg = JSON.parse(line); } catch { /* answered in order below */ }
      queue = queue.then(async () => { // one at a time, in order, so edits to a draft never interleave and replies keep their order
        if (msg === null) return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        if (Array.isArray(msg)) { const r = (await Promise.all(msg.map(mcp.handle))).filter(Boolean); if (r.length) send(r); } else send(await mcp.handle(msg));
      }).catch((e) => process.stderr.write('spritewright mcp: ' + e.stack + '\n'));
    }
  });
  return mcp;
}
