import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createMcp } from '../src/mcp.mjs';
import { decodePng, fromRows } from './png.mjs';
const PF = globalThis.Spritewright, C = PF.core;

const PAL = { k: [26, 20, 38], g: [60, 180, 80], G: [120, 230, 130], r: [200, 67, 75] };
const hex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
/** A throwaway project: a palette, a 4x4 slime, a 2-frame 4x4 sheet and a layered sprite. */
async function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-'));
  fs.mkdirSync(path.join(root, 'art'));
  fs.writeFileSync(path.join(root, 'pal.hex'), Object.values(PAL).map((c) => hex(c).slice(1)).join('\n'));
  fs.writeFileSync(path.join(root, 'spritewright.config.json'), JSON.stringify({ palette: 'pal.hex', frames: { 'art/sheet.png': { w: 4, h: 4 } } }));
  fs.writeFileSync(path.join(root, 'art/slime.png'), fromRows(['.gg.', 'gGGg', 'gGGg', '.gg.'], PAL).png);
  fs.writeFileSync(path.join(root, 'art/sheet.png'), fromRows(['kkkkgggg', 'k..kg..g', 'k..kg..g', 'kkkkgggg'], PAL).png);
  const L = (rows) => { const r = fromRows(rows, PAL); return new Uint32Array(r.rgba.buffer.slice(r.rgba.byteOffset, r.rgba.byteOffset + r.rgba.length)); };
  const layers = [{ name: 'base', px: L(['gggg', 'gggg', 'gggg', 'gggg']) }, { name: 'ink', px: L(['k..k', '....', '....', 'k..k']) }];
  const flat = C.flattenLayers(layers, 16), packed = C.packLayers(layers, 4, 4);
  fs.writeFileSync(path.join(root, 'art/layered.png'), await PF.png.encode(4, 4, flat));
  fs.writeFileSync(path.join(root, 'art/layered.layers.png'), await PF.png.encode(packed.w, packed.h, packed.px, 1, packed.text));
  const mcp = createMcp({ root });
  let id = 0;
  const call = async (name, args = {}) => {
    const r = await mcp.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } });
    return { ...r.result, text: r.result.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n') };
  };
  const ok = async (name, args) => { const r = await call(name, args); assert.ok(!r.isError, `${name} failed: ${r.text}`); return r; };
  const bad = async (name, args, re) => { const r = await call(name, args); assert.ok(r.isError, `${name} should fail`); assert.match(r.text, re); return r; };
  const disk = (rel) => { const img = decodePng(fs.readFileSync(path.join(root, rel))); return img; };
  return { root, mcp, call, ok, bad, disk };
}
const gridOf = (text) => text.split('\n').filter((l) => /^\s*\d+ /.test(l)).map((l) => l.replace(/^\s*\d+ /, ''));
const keyOf = (c) => String(Object.keys(PAL).indexOf(c)); // palette keys are the palette order: 0 1 2 3

test('mcp: initialize, tools/list, notifications and unknown methods', async () => {
  const { mcp } = await project();
  const init = await mcp.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  assert.equal(init.result.protocolVersion, '2025-06-18'); assert.deepEqual(init.result.capabilities, { tools: {} }); assert.equal(init.result.serverInfo.name, 'spritewright');
  assert.equal(await mcp.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null, 'notifications get no reply');
  const list = await mcp.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['list_sprites', 'read_sprite', 'write_pixels', 'draw', 'transform', 'create_sprite', 'preview', 'lint', 'diff', 'undo', 'discard', 'commit']);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object');
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 3, method: 'nope' })).error.code, -32601);
  assert.equal((await mcp.handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } })).error.code, -32602);
});

test('mcp: list_sprites shows sprites (not layers files), frames, layers and palette keys', async () => {
  const { ok } = await project();
  const t = (await ok('list_sprites')).text;
  assert.match(t, /art\/sheet\.png {2}8×4 {2}frames 4×4/); assert.match(t, /art\/layered\.png {2}4×4 {2}\(layers\)/);
  assert.doesNotMatch(t, /layered\.layers\.png/);
  assert.match(t, /"0":"#1a1426","1":"#3cb450"/);
});

test('mcp: read_sprite gives a grid with rulers and a legend of palette keys, by frame and region', async () => {
  const { ok, bad } = await project();
  const r = await ok('read_sprite', { path: 'art/slime.png' });
  assert.deepEqual(gridOf(r.text), ['.11.', '1221', '1221', '.11.']);
  assert.match(r.text, /Legend: \{"1":"#3cb450","2":"#78e682",".":"clear"\}/);
  assert.match(r.text, /^ {3}0123$/m, 'x ruler');
  const f = await ok('read_sprite', { path: 'art/sheet.png', frame: 1 });
  assert.deepEqual(gridOf(f.text), ['1111', '1..1', '1..1', '1111']); assert.match(f.text, /frame 1 \(at 4,0 in the sheet\)/);
  assert.deepEqual(gridOf((await ok('read_sprite', { path: 'art/slime.png', x: 1, y: 1, w: 2, h: 2 })).text), ['22', '22']);
  await bad('read_sprite', { path: 'art/slime.png', x: 3, w: 2 }, /does not fit/);
  await bad('read_sprite', { path: 'art/sheet.png', frame: 2 }, /past the end.*0-1/);
  await bad('read_sprite', { path: 'art/slime.png', frame: 0 }, /no frames configured/);
  assert.match((await ok('read_sprite', { path: 'art/layered.png' })).text, /shown flattened/);
  assert.deepEqual(gridOf((await ok('read_sprite', { path: 'art/layered.png', layer: 'ink' })).text), ['0..0', '....', '....', '0..0']);
});

test('mcp: write_pixels is exact, checks the grid and palette, and is all or nothing', async () => {
  const { ok, bad, mcp, disk } = await project();
  const before = disk('art/slime.png').rgba;
  const w = await ok('write_pixels', { path: 'art/slime.png', x: 1, y: 1, rows: ['33', '3_'], legend: { 3: hex(PAL.r), _: 'keep' } });
  assert.match(w.text, /Changed 3 pixels in x 1-2, y 1-2/);
  assert.deepEqual(gridOf((await ok('read_sprite', { path: 'art/slime.png' })).text), ['.11.', '1331', '1321', '.11.']);
  assert.deepEqual(disk('art/slime.png').rgba, before, 'nothing is written before commit');
  await ok('write_pixels', { path: 'art/slime.png', rows: ['0'] }); // with a palette, its keys work without a legend
  await bad('write_pixels', { path: 'art/slime.png', rows: ['00', '0'] }, /row 1 is 1 characters wide but row 0 is 2/);
  await bad('write_pixels', { path: 'art/slime.png', rows: ['z'] }, /not in the legend or this sprite's keys: "z"/);
  await bad('write_pixels', { path: 'art/slime.png', rows: ['a'], legend: { a: '#ff00ff' } }, /not in the project palette \(nearest: #c8434b\)/);
  const snap = await ok('write_pixels', { path: 'art/slime.png', rows: ['a'], legend: { a: '#ff00ff' }, snap: true }); assert.match(snap.text, /Changed 1 pixel/);
  const d = mcp.drafts.get('art/slime.png'), px = d.layers[0].px.slice();
  await bad('write_pixels', { path: 'art/slime.png', x: 3, y: 3, rows: ['00'] }, /1 pixel would land outside the image \(4×4\), e\.g\. \(4,3\)/);
  assert.deepEqual(d.layers[0].px, px, 'a refused write changes nothing');
  await ok('write_pixels', { path: 'art/slime.png', x: 3, y: 3, rows: ['00'], clip: true });
});

test('mcp: draw uses the editor\'s algorithms, frame-relative, and reports new lint', async () => {
  const { ok, bad } = await project();
  await ok('create_sprite', { path: 'art/new.png', w: 8, h: 8 });
  await ok('draw', { path: 'art/new.png', op: 'line', x0: 0, y0: 0, x1: 7, y1: 3, color: hex(PAL.k) });
  const g = gridOf((await ok('read_sprite', { path: 'art/new.png' })).text), pts = [];
  g.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '0') pts.push([x, y]); }));
  assert.deepEqual(pts.sort(), C.linePoints(0, 0, 7, 3).sort(), 'same pixels as the editor\'s line tool');
  await ok('draw', { path: 'art/new.png', op: 'rect', x0: 0, y0: 5, x1: 2, y1: 7, filled: true, color: hex(PAL.g) });
  await ok('draw', { path: 'art/new.png', op: 'fill', x: 7, y: 7, color: hex(PAL.G) });
  const g2 = gridOf((await ok('read_sprite', { path: 'art/new.png' })).text);
  assert.equal(g2[7], '11122222'); assert.equal(g2[0], '00......', 'a 4-way flood fill stops at a diagonal line, like the editor\'s');
  const dust = await ok('draw', { path: 'art/new.png', op: 'pixel', x: 5, y: 6, color: hex(PAL.r) });
  assert.doesNotMatch(dust.text, /stray/i, 'a speck inside another colour is not dust');
  await ok('create_sprite', { path: 'art/dust.png', w: 5, h: 5 });
  assert.match((await ok('draw', { path: 'art/dust.png', op: 'pixel', x: 2, y: 2, color: hex(PAL.r) })).text, /New stray pixels \(dust or holes\): \(2,2\)/);
  // frames: coordinates relative to the frame, edits stay inside it
  const f = await ok('draw', { path: 'art/sheet.png', frame: 1, op: 'fill', x: 1, y: 1, color: hex(PAL.r) });
  assert.match(f.text, /Changed 4 pixels in frame x 1-2, y 1-2 \(sheet x 5-6, y 1-2\)/);
  await bad('draw', { path: 'art/sheet.png', frame: 0, op: 'line', x0: 0, y0: 0, x1: 4, y1: 0, color: hex(PAL.r) }, /outside the frame \(4×4\)/);
  await ok('draw', { path: 'art/sheet.png', op: 'replace_color', from: hex(PAL.k), color: hex(PAL.G) });
  assert.deepEqual(gridOf((await ok('read_sprite', { path: 'art/sheet.png' })).text), ['22221111', '2..21331', '2..21331', '22221111']);
  await ok('draw', { path: 'art/slime.png', op: 'outline', color: hex(PAL.k), clip: true });
  await bad('draw', { path: 'art/slime.png', op: 'line', x0: 0, y0: 0, color: '#000000' }, /not in the project palette/);
  await bad('draw', { path: 'art/slime.png', op: 'line', x0: 0, y0: 0, color: hex(PAL.k) }, /x1 \(for line\) is required/);
  const sh = await ok('draw', { path: 'art/slime.png', op: 'shade', amount: 1 });
  assert.match(sh.text, /Changed/); await ok('lint', { path: 'art/slime.png' }).then((r) => assert.doesNotMatch(r.text, /Outside the palette/, 'shading snaps to the palette'));
});

test('mcp: layered sprites need a layer, and commit writes the flattened PNG and the layers file', async () => {
  const { ok, bad, disk, root } = await project();
  await bad('draw', { path: 'art/layered.png', op: 'pixel', x: 1, y: 1, color: hex(PAL.r) }, /has 2 layers \(0: "base", 1: "ink"\); say which/);
  await bad('draw', { path: 'art/layered.png', op: 'pixel', x: 1, y: 1, color: hex(PAL.r), layer: 'nope' }, /no layer "nope"/);
  await ok('draw', { path: 'art/layered.png', op: 'pixel', x: 1, y: 1, color: hex(PAL.r), layer: 'ink' });
  assert.match((await ok('commit', { path: 'art/layered.png' })).text, /Wrote art\/layered\.png \(4×4, 2 layers, 1 pixels changed\)/);
  const flat = disk('art/layered.png'); assert.deepEqual([...flat.rgba.subarray(20, 24)], [...PAL.r, 255]);
  const L = C.unpackLayers(await PF.png.decode(new Uint8Array(fs.readFileSync(path.join(root, 'art/layered.layers.png')))), 4, 4);
  assert.deepEqual(L.map((l) => l.name), ['base', 'ink']); assert.equal(L[0].px[5], C.pack(...PAL.g), 'the base layer is untouched'); assert.equal(L[1].px[5], C.pack(...PAL.r));
});

test('mcp: undo, diff, discard and commit (lossless, refuses to overwrite changes made on disk)', async () => {
  const { ok, bad, disk, root } = await project();
  await ok('draw', { path: 'art/slime.png', op: 'pixel', x: 0, y: 0, color: hex(PAL.r) });
  await ok('draw', { path: 'art/slime.png', op: 'pixel', x: 3, y: 3, color: hex(PAL.r) });
  const df = await ok('diff', { path: 'art/slime.png' });
  assert.match(df.text, /2 pixels changed in x 0-3, y 0-3/); assert.match(df.text, /Before:\n {3}0123\n 0 \.11\.\n[\s\S]*After:\n {3}0123\n 0 311\.\n/);
  assert.match((await ok('undo', { path: 'art/slime.png' })).text, /Undid 1 edit.*1 more/);
  assert.match((await ok('diff', { path: 'art/slime.png' })).text, /1 pixel changed in x 0-0, y 0-0/);
  await ok('discard', { path: 'art/slime.png' });
  assert.match((await ok('diff', { path: 'art/slime.png' })).text, /no changes/);
  assert.match((await ok('commit', { path: 'art/slime.png' })).text, /no changes to write/);
  await ok('draw', { path: 'art/slime.png', op: 'pixel', x: 0, y: 0, color: hex(PAL.r) });
  fs.writeFileSync(path.join(root, 'art/slime.png'), fromRows(['gggg', 'gggg', 'gggg', 'gggg'], PAL).png); // someone else saved meanwhile
  await bad('commit', { path: 'art/slime.png' }, /changed on disk since it was opened/);
  await ok('commit', { path: 'art/slime.png', force: true });
  const img = disk('art/slime.png'); assert.deepEqual([...img.rgba.subarray(0, 4)], [...PAL.r, 255]); assert.deepEqual([...img.rgba.subarray(4, 8)], [...PAL.g, 255]);
  assert.match((await ok('commit', { path: 'art/slime.png' })).text, /no changes to write/);
  // semi-transparent colours survive exactly (no premultiplied-alpha rounding)
  await ok('write_pixels', { path: 'art/slime.png', rows: ['a'], legend: { a: hex(PAL.r) + '7f' } });
  await ok('commit', { path: 'art/slime.png' });
  assert.deepEqual([...disk('art/slime.png').rgba.subarray(0, 4)], [...PAL.r, 0x7f]);
});

test('mcp: create_sprite, paths that escape the project, preview and lint', async () => {
  const { ok, bad, root } = await project();
  await bad('create_sprite', { path: 'art/slime.png', w: 4, h: 4 }, /already exists/);
  await bad('read_sprite', { path: '../outside.png' }, /not a path inside the project/);
  await bad('read_sprite', { path: 'node_modules/x.png' }, /not a path inside the project/);
  await bad('read_sprite', { path: 'art/layered.layers.png' }, /is a layers file/);
  await bad('read_sprite', { path: 'pal.hex' }, /only \.png/);
  await ok('create_sprite', { path: 'art/sub/new.png', w: 3, h: 2, fill: hex(PAL.k) });
  assert.match((await ok('list_sprites')).text, /art\/sub\/new\.png {2}3×2 {2}\[new, not yet committed\]/);
  await ok('commit', { path: 'art/sub/new.png' });
  assert.ok(fs.existsSync(path.join(root, 'art/sub/new.png')));
  const p = await ok('preview', { path: 'art/slime.png', scale: 4, compare: true });
  const img = p.content.find((c) => c.type === 'image'); assert.equal(img.mimeType, 'image/png');
  const dec = decodePng(Buffer.from(img.data, 'base64')); assert.equal(dec.w, 4 * 4 * 2 + 8); assert.equal(dec.h, 16);
  fs.writeFileSync(path.join(root, 'art/messy.png'), fromRows(['r....', '.....', '..g..', '.....', '.....'], { ...PAL, r: [255, 0, 255] }).png);
  const l = (await ok('lint', { path: 'art/messy.png' })).text;
  assert.match(l, /Stray pixels \(2\): \(0,0\) \(2,2\)/); assert.match(l, /Outside the palette: #ff00ff \(1 px, first at \(0,0\); nearest #c8434b\)/);
  assert.match((await ok('lint', { path: 'art/slime.png' })).text, /no problems found/);
});

test('mcp: the CLI speaks JSON-RPC over stdio, one message per line', async () => {
  const { root } = await project();
  const child = spawn(process.execPath, ['bin/spritewright.mjs', 'mcp', root], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = []; let buf = '';
  const got = new Promise((resolve) => child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } if (lines.length >= 3) resolve(); }));
  const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_sprite', arguments: { path: 'art/slime.png' } } });
  child.stdin.write('not json\n');
  await got; child.kill();
  assert.equal(lines[0].id, 1); assert.equal(lines[1].id, 2); assert.match(lines[1].result.content[0].text, /\.11\./);
  assert.equal(lines[2].error.code, -32700);
});

test('mcp: without a palette, grid keys stay the same for a sprite across reads, diffs and writes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-')), m = createMcp({ root }); let id = 0;
  fs.writeFileSync(path.join(root, 'hero.png'), fromRows(['.gg.', 'gGGg', 'gkkg', '.gg.'], PAL).png);
  const call = async (name, args) => { const r = (await m.handle({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } })).result; assert.ok(!r.isError, r.content[0].text); return r.content[0].text; };
  const legend = (t) => JSON.parse(/Legend: (\{.*\})/.exec(t)[1]);
  const first = legend(await call('read_sprite', { path: 'hero.png' }));
  const keyOfHex = (lg, h) => Object.keys(lg).find((k) => lg[k] === h);
  const gKey = keyOfHex(first, hex(PAL.g)), GKey = keyOfHex(first, hex(PAL.G));
  // make the light green the most common colour: a frequency-ordered legend would now swap keys
  await call('write_pixels', { path: 'hero.png', rows: [GKey + GKey + GKey + GKey], legend: {} });
  await call('write_pixels', { path: 'hero.png', y: 3, rows: ['r'], legend: { r: hex(PAL.r) } });
  const again = legend(await call('read_sprite', { path: 'hero.png' }));
  assert.equal(again[gKey], hex(PAL.g)); assert.equal(again[GKey], hex(PAL.G), 'keys do not move when colour counts change');
  const rKey = keyOfHex(again, hex(PAL.r)); assert.ok(rKey && ![gKey, GKey].includes(rKey), 'a new colour gets a new key');
  const df = await call('diff', { path: 'hero.png' }), dl = legend(df);
  assert.equal(dl[gKey], hex(PAL.g)); assert.equal(dl[GKey], hex(PAL.G)); assert.equal(dl[rKey], hex(PAL.r), 'diff uses the same keys');
  await call('write_pixels', { path: 'hero.png', x: 1, y: 1, rows: [rKey + gKey] }); // no legend: the sprite's own keys
  assert.match(await call('read_sprite', { path: 'hero.png', x: 1, y: 1, w: 2, h: 1 }), new RegExp(' 1 ' + rKey + gKey + '$', 'm'));
});

test('mcp: possible doubled corners are hints, not problems', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mcp-')), m = createMcp({ root });
  fs.writeFileSync(path.join(root, 'stair.png'), fromRows(['k....', 'kk...', '.kk..', '..kk.', '...k.'], PAL).png);
  const r = (await m.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lint', arguments: { path: 'stair.png' } } })).result.content[0].text;
  assert.match(r, /no problems found/); assert.match(r, /Worth a look, possible doubled corners/); assert.match(r, /often intentional/);
});
