// Installs the package into a throwaway project the way a user would (`npm i -D <tarball>`) and uses it: the CLI, the ESM entry, the types
// and the server that ships inside it. Needs npm (offline is fine: the package has no dependencies).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const here = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
let pass = 0, fail = 0; const ok = (c, m) => { if (c) { pass++; console.log('  PASS', m); } else { fail++; console.log('  FAIL', m); } };
const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: 'utf8' });

const pack = run('npm', ['pack', '--json', '--pack-destination', os.tmpdir()], here); ok(pack.status === 0, 'npm pack works');
const parsed = JSON.parse(pack.stdout), info = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0], files = info.files.map((f) => f.path);
for (const f of ['spritewright.js', 'index.mjs', 'index.d.ts', 'index.html', 'bin/spritewright.mjs', 'src/scan.mjs', 'src/serve.mjs', 'src/mcp.mjs', 'README.md', 'LICENSE', 'package.json']) ok(files.includes(f), 'tarball contains ' + f);
ok(!files.some((f) => f.startsWith('test/') || f.startsWith('.github/')), 'tests and CI files are not shipped');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-consumer-')); fs.mkdirSync(path.join(proj, 'art'));
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'my-game', private: true, type: 'module' }));
const { encodePng } = await import('./png.mjs'); fs.writeFileSync(path.join(proj, 'art/a.png'), encodePng(2, 2, Buffer.alloc(16)));
const inst = run('npm', ['install', '-D', path.join(os.tmpdir(), info.filename), '--offline', '--no-audit', '--no-fund'], proj); ok(inst.status === 0, 'npm install -D <tarball> works' + (inst.status ? ': ' + inst.stderr.slice(0, 200) : ''));
const bin = path.join(proj, 'node_modules/.bin/spritewright'); ok(fs.existsSync(bin), 'the spritewright command is linked into node_modules/.bin');
const scan = run(bin, ['scan', '.'], proj); ok(scan.status === 0 && JSON.parse(scan.stdout).sprites[0].path === 'art/a.png', 'npx spritewright scan finds the project\'s sprites');
ok(run(bin, ['init', '.'], proj).status === 0 && fs.existsSync(path.join(proj, 'spritewright.config.json')), 'npx spritewright init writes the config');
const esm = run('node', ['--input-type=module', '-e', "import PF, { mount, createPullRequest, png, sources } from 'spritewright'; import * as scanner from 'spritewright/scan'; console.log(JSON.stringify([typeof PF.mount, typeof mount, typeof createPullRequest, typeof png.decode, typeof sources.githubSource, typeof scanner.scan]))"], proj);
ok(esm.status === 0 && esm.stdout.trim() === '["function","function","function","function","function","function"]', 'import Spritewright from "spritewright" exposes the API (and spritewright/scan works): ' + (esm.stdout.trim() || esm.stderr.slice(0, 150)));
const ts = path.join(proj, 'check.ts'); fs.writeFileSync(ts, "import Spritewright, { type MountOptions, type Source } from 'spritewright';\nconst o: MountOptions = { github: { slug: 'me/game' }, accent: '#b98cff' };\nconst e = Spritewright.mount(document.body, o);\nconst d = e.current; if (d) { const n: number = d.px[0]; void n; }\nconst s: Promise<Source> = Spritewright.sources.githubSource({ repo: 'me/game' }); void s;\n");
const tscBin = process.env.TSC || (run('tsc', ['--version'], here).status === 0 ? 'tsc' : null);
if (tscBin) { const t = run(tscBin, ['--noEmit', '--strict', '--module', 'esnext', '--moduleResolution', 'bundler', '--target', 'es2022', '--lib', 'es2022,dom,dom.iterable', '--skipLibCheck', ts], proj); ok(t.status === 0, 'TypeScript accepts the typings' + (t.status ? ': ' + t.stdout.slice(0, 300) : '')); } else console.log('  SKIP typings (no tsc found; set TSC=/path/to/tsc)');
// the server inside node_modules serves its own editor and the project's sprites
const { createServer } = await import(path.join(proj, 'node_modules/spritewright/src/serve.mjs')); const srv = createServer({ root: proj, port: 0 }), base = await srv.listen();
const mf = await (await fetch(base + 'api/manifest')).json(); const js = await fetch(base + 'spritewright.js'); const html = await (await fetch(base)).text();
ok(mf.sprites.length === 1 && js.status === 200 && /pf-token/.test(html), 'the installed copy serves the editor and the project\'s sprites');
await srv.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
