// One timed run of one binary under the engine, for bench/realab.mjs.
// Prints a single RESULT line: milliseconds, exit code, and a hash of stdout
// so the A/B can prove the two configurations ran the same program.
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync,
         writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const CACHE = new URL('./watcache/', import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true });
let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/ra_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

const files = {}, mtimes = {};
const add = (g, h) => { try { files[g] = new Uint8Array(readFileSync(h));
  mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f));
    if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);
const bin = process.argv[2], args = process.argv.slice(3);
add(bin, bin);
for (const p of (process.env.INFILE || '').split(':').filter(Boolean)) add(p, p);

const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'LANG=C'],
    files, mtimes, memMB: Number(process.env.MEMMB || 512), assembleWat });
const t0 = process.hrtime.bigint();
while (eng.exitCode === null) { eng.run(5e7); if (eng.blocked) eng.wake(); }
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
const hash = eng.stdoutBytes.length
  ? createHash('sha1').update(Buffer.concat(eng.stdoutBytes.map(Buffer.from))).digest('hex').slice(0, 16)
  : 'empty';
console.log(`RESULT ${ms.toFixed(1)} ${eng.exitCode} ${hash}`);
