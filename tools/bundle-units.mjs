// Link the cached units of each program id into a few bundle_N.wasm files (see wasmlink.mjs for why).
//   node tools/bundle-units.mjs <cache>/units/<engine hash> [maxBundleMB=16] [minUnits=50]
// Safe to re-run: bundles are rebuilt from the individual unit files, which are left in place.
import { readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { link } from './wasmlink.mjs';

const root = process.argv[2];
const maxBytes = (+process.argv[3] || 16) * 1048576, minUnits = +process.argv[4] || 50;
if (!root) { console.error('usage: bundle-units.mjs <cache>/units/<engine hash> [maxBundleMB] [minUnits]'); process.exit(2); }

let total = 0;
for (const ex of readdirSync(root)) {
  const dir = join(root, ex);
  try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
  const names = readdirSync(dir);
  for (const f of names) if (f.startsWith('bundle_')) unlinkSync(join(dir, f));
  const units = names.filter((f) => f.endsWith('.wasm') && !f.startsWith('bundle_')).sort();
  if (units.length < minUnits) continue;
  let group = [], size = 0, n = 0;
  const flush = () => {
    if (!group.length) return;
    const bytes = link(group);
    const f = join(dir, `bundle_${n++}.wasm`), t = f + '.tmp';
    writeFileSync(t, bytes); renameSync(t, f);
    console.log(`${ex}: bundle ${n - 1}: ${group.length} units -> ${(bytes.length / 1048576).toFixed(1)} MB`);
    group = []; size = 0;
  };
  for (const u of units) {
    const b = readFileSync(join(dir, u));
    // a unit the linker cannot read stays a standalone file
    if (size + b.length > maxBytes) flush();
    group.push(b); size += b.length; total++;
  }
  flush();
}
console.log(`${total} units bundled`);
