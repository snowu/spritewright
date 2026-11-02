#!/usr/bin/env node
// spritewright scan  [dir] [-o pixel-art.json]   list the project's pixel art as JSON
// spritewright serve [dir] [--port 5173] [--open] edit it in the browser (the default command)
// spritewright init  [dir] [--force]               write a starter spritewright.config.json from what a scan finds
// spritewright check [dir] [--since <git ref>] [--summary <file>] [--json] [--strict]   art check for pull requests
// spritewright mcp   [dir]                          an MCP server on stdio, so coding agents can draw precisely
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { scan, suggestConfig } from '../src/scan.mjs';
import { createServer } from '../src/serve.mjs';

const args = process.argv.slice(2);
const cmd = ['scan', 'serve', 'init', 'check', 'mcp'].includes(args[0]) ? args.shift() : 'serve';
const flag = (n) => { const i = args.indexOf(n); if (i < 0) return null; const [, v] = args.splice(i, 2); return v ?? null; };
const has = (n) => { const i = args.indexOf(n); if (i < 0) return false; args.splice(i, 1); return true; };

if (has('--help') || has('-h')) {
  console.log(`spritewright: edit a project's pixel art in the browser

  spritewright [serve] [dir] [--port 5173] [--open]
  spritewright scan [dir] [-o pixel-art.json]
  spritewright init [dir] [--force]      write a starter spritewright.config.json (skips docs, screenshots, previews)
  spritewright check [dir] [--since <git ref>] [--summary <file>] [--json] [--strict]
                                         check sprites (only those changed since the ref); Markdown to the
                                         summary file (e.g. $GITHUB_STEP_SUMMARY) or stdout; exit 1 on errors
                                         (and on warnings with --strict)
  spritewright mcp [dir]                 an MCP server on stdio for coding agents (pixel grids, palette-checked
                                         drawing, drafts with undo, lint); e.g. claude mcp add spritewright -- npx spritewright mcp

Put spritewright.config.json in the project to choose folders, ignore patterns, a palette (.hex) and animation frame sizes. See README.md.`);
  process.exit(0);
}
const out = flag('-o'), port = +(flag('--port') || 5173), open = has('--open'), force = has('--force'), since = flag('--since'), summary = flag('--summary'), json = has('--json'), strict = has('--strict');
const dir = args[0] || '.';
if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`Not a folder: ${dir}`); process.exit(1); }

if (cmd === 'mcp') {
  const { runStdio } = await import('../src/mcp.mjs');
  runStdio({ root: dir });
} else if (cmd === 'init') {
  const file = path.join(dir, 'spritewright.config.json');
  if (fs.existsSync(file) && !force) { console.error(`${file} already exists (use --force to overwrite).`); process.exit(1); }
  const before = scan(dir, { dirs: [] }), { config, kept, skipped } = suggestConfig(before);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  console.log(`Wrote ${file}\n  ${before.sprites.length} PNGs found, ${kept} look like game art${skipped ? ` (${skipped} in docs/screenshots/previews/test folders are skipped)` : ''}.\n  dirs: ${config.dirs ? config.dirs.join(', ') : '(whole project)'}\n\nNext:  npx spritewright --open      (add  "art": "spritewright --open"  to package.json scripts if you like)`);
} else if (cmd === 'check') {
  const { check, markdown } = await import('../src/check.mjs');
  const res = await check(dir, { since });
  if (json) process.stdout.write(JSON.stringify(res, null, 2) + '\n');
  else { const md = markdown(res); if (summary) fs.appendFileSync(summary, md + '\n'); process.stdout.write(md); }
  process.exitCode = res.errors || (strict && res.warnings) ? 1 : 0;
} else if (cmd === 'scan') {
  const m = scan(dir), json = JSON.stringify(m, null, 2) + '\n';
  if (out) { fs.writeFileSync(out, json); console.error(`${m.sprites.length} sprites -> ${out}`); } else process.stdout.write(json);
} else {
  const s = createServer({ root: dir, port });
  s.listen().then((url) => {
    const n = scan(dir).sprites.length;
    console.log(`spritewright: ${n} sprite${n === 1 ? '' : 's'} found in ${s.root}\n  ${url}\nCtrl+C to stop. Saving writes straight into that folder.`);
    if (open) { const opener = process.platform === 'darwin' ? ['open'] : process.platform === 'win32' ? ['cmd', '/c', 'start'] : ['xdg-open']; spawn(opener[0], [...opener.slice(1), url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); }
  }).catch((e) => { console.error(e.code === 'EADDRINUSE' ? `Port ${port} is busy. Try --port ${port + 1}.` : e.message); process.exit(1); });
}
