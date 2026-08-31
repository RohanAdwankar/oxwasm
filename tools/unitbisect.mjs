// Which translation unit breaks a guest? Compile only the first N units and
// interpret the rest, then binary search N for the smallest value that
// reproduces the failure. The unit at that boundary is the culprit.
//
// This is how unit 134 was named for the earlier CPython crash; writing it
// down as a tool because a second AOT-only failure needed exactly the same
// search.
//
// A run is GOOD when the guest exits 0 with nothing error-shaped on stderr,
// BAD otherwise. Comparing stderr matters: an AOT bug that makes the guest
// raise its own exception exits non-zero with no fault at all, so a
// crash-only predicate would call it good.
//
//   TREE=/usr/lib/python3.11 node tools/unitbisect.mjs /usr/bin/python3 -S -c "print(6*7)"
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync,
         writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const files = {}, mtimes = {};
const add = (g, h) => { try { files[g] = new Uint8Array(readFileSync(h));
                              mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); } catch {} };
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} } }
add('/etc/ld.so.cache', '/etc/ld.so.cache');
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);

const bin = process.argv[2], args = process.argv.slice(3);
if (!bin) { console.log('usage: unitbisect.mjs <binary> [args...]'); process.exit(2); }
add(bin, bin);
for (const p of args) if (existsSync(p)) add(p, p);

const CACHE = new URL('../bench/kernels/watcache/', import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true }); let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/ub_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

const run = (cap) => {
  const entries = new Map();                        // unit number -> entry rip
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'LANG=C', 'HOME=/root'],
      files, mtimes, memMB: Number(process.env.MEMMB || 1024), assembleWat });
  eng.unitFilter = (n, entry) => { entries.set(n, entry); return cap === null || n <= cap; };
  let err = null;
  try { let g = 0; while (eng.exitCode === null) { eng.run(5e6); if (eng.blocked) eng.wake();
          if (++g > 40000) { err = 'no exit'; break; } } }
  catch (e) { err = e.message; }
  const se = (eng.stderr || []).join('');
  const out = (eng.stdoutBytes || []).reduce((a, b) => a + b.length, 0);
  const good = !err && eng.exitCode === 0 && !/Error|Traceback|error/.test(se);
  return { good, err, exit: eng.exitCode, out, se, entries, units: eng._unitN || 0,
           insns: eng.stats.interpreted };
};

const say = (tag, r) => console.log(
  `  ${tag.padEnd(14)} ${r.good ? 'GOOD' : 'BAD '}  exit=${r.exit} stdout=${r.out}B units=${r.units}` +
  (r.err ? ` threw:${r.err}` : '') +
  (r.se ? `  stderr:${r.se.trim().split('\n').pop().slice(0, 70)}` : ''));

const all = run(null);  say('all units', all);
if (all.good) { console.log('\nnothing to bisect: the uncapped run is already good'); process.exit(0); }
const none = run(0);    say('no units', none);
if (!none.good) { console.log('\nnothing to bisect: it fails with everything interpreted too, ' +
                              'so this is not an AOT-only bug'); process.exit(1); }

// smallest cap that is BAD; lo is known good, hi is known bad
let lo = 0, hi = all.units;
console.log(`\nbisecting over ${hi} units...`);
while (hi - lo > 1) {
  const mid = (lo + hi) >> 1;
  const r = run(mid);
  say(`cap=${mid}`, r);
  if (r.good) lo = mid; else hi = mid;
}
const entry = all.entries.get(hi);
console.log(`\nunit ${hi} is the culprit (unit ${lo} is clean)`);
console.log(`  entry rip 0x${entry ? entry.toString(16) : '?'}`);
