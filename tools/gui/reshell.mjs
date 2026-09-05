// Re-shell a packed sidecar page: keep its state/mem/rom sidecars and its
// loader, replace only the ENGINE modules (the import map of data: URLs xpack
// inlines) and the units container's size. The shipped GIMP page's snapshot
// memory image survives only as its sidecars, so a full xpack run is not
// possible; and a units-only repack is not enough once the emitter needs a
// new runtime import (units emitted after the loop yield import env.loophot;
// the Sept-1 shell did not provide it, every recompiled unit failed to
// instantiate, and the File menu never appeared).
//
//   node tools/gui/reshell.mjs SRCDIR DSTDIR [--units new.units.gz]
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
const args = process.argv.slice(2);
const src = args[0], dst = args[1]; let unitsPath = null;
for (let i = 2; i < args.length; i++) if (args[i] === '--units') unitsPath = args[++i];
if (!src || !dst) { console.error('usage: reshell SRCDIR DSTDIR [--units new.units.gz]'); process.exit(1); }
const ENGINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engine');
// every engine module reachable from the roots by import (a fixed list went
// stale: xserver grew font5x7.mjs and the packed shell could not resolve it)
const MODS = (() => { const roots = ['linux', 'xserver', 'snapshot_core', 'pcf', 'jit2', 'jitsimd'], seen = [];
  const walk = (m) => { if (seen.includes(m)) return; seen.push(m);
    for (const [, d] of readFileSync(join(ENGINE, m + '.mjs'), 'utf8').matchAll(/from '\.\/(\w+)\.mjs'/g)) walk(d); };
  roots.forEach(walk); return seen; })();
const importMap = { imports: {} };
for (const m of MODS) {
  const s = readFileSync(join(ENGINE, m + '.mjs'), 'utf8').replace(/from '\.\/(\w+)\.mjs'/g, "from 'ox/$1'");
  importMap.imports['ox/' + m] = 'data:text/javascript;base64,' + Buffer.from(s).toString('base64');
}
mkdirSync(dst, { recursive: true });
let html = readFileSync(join(src, 'index.html'), 'utf8');
const im = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!im) { console.error('no import map in the shell'); process.exit(1); }
const old = JSON.parse(im[1]);
const missing = Object.keys(old.imports).filter(k => !importMap.imports[k]);
if (missing.length) { console.error('shell imports not in ENGINE: ' + missing.join(' ')); process.exit(1); }
html = html.replace(im[0], `<script type="importmap">${JSON.stringify(importMap)}</script>`);
for (const f of ['app.state.gz', 'app.mem.gz', 'app.rom.gz', 'app.wabt.gz', 'app.units.gz'])
  if (existsSync(join(src, f)) && src !== dst) copyFileSync(join(src, f), join(dst, f));
if (unitsPath) copyFileSync(unitsPath, join(dst, 'app.units.gz'));
const rawUnits = gunzipSync(readFileSync(join(dst, 'app.units.gz'))).length;
const before = html.match(/units: (\d+)/)[1];
html = html.replace(/units: \d+/, 'units: ' + rawUnits);
writeFileSync(join(dst, 'index.html'), html);
console.log(`reshell: engine ${MODS.length} modules ${(JSON.stringify(importMap).length / 1e6).toFixed(1)} MB (was ${(im[1].length / 1e6).toFixed(1)}), units raw ${before} -> ${rawUnits}, shell ${(html.length / 1e6).toFixed(2)} MB -> ${dst}/index.html`);
