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

// Bisect over ENTRY ADDRESSES, not unit numbers.
//
// The first version of this tool capped a unit COUNT, and that is not a stable
// identifier: which functions get hot, and in what order, depends on what is
// already compiled, so "unit 327" names a different function in every
// configuration. Compiling only unit 327 produced a one-function closure at
// 0x51fbe7 in python3, where the capped bisect had reported libc+0xbae80 - two
// different functions under the same number. An address means the same thing
// in every run.
//
// So: record the order in which entries are offered for compilation in a full
// run, then bisect over a PREFIX of that address list. The filter admits an
// address if it is in the allowed set, whatever unit number it lands on.
const run = (allow) => {          // allow: null = compile all, else a Set of entry rips
  const order = [];               // entry rips, in the order they were offered
  const funcsOf = new Map();      // entry rip -> its closure
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'LANG=C', 'HOME=/root'],
      files, mtimes, memMB: Number(process.env.MEMMB || 1024), assembleWat });
  if (process.env.SHADOW) eng.shadowLib = process.env.SHADOW;
  if (process.env.SHADOWMAX) eng.shadowMax = Number(process.env.SHADOWMAX);
  eng.onUnitWat = (n, entry, unit) => funcsOf.set(entry, unit.funcs);
  eng.unitFilter = (n, entry) => { order.push(entry); return allow === null || allow.has(entry); };
  let err = null;
  try { let g = 0; while (eng.exitCode === null) { eng.run(5e6); if (eng.blocked) eng.wake();
          if (++g > 40000) { err = 'no exit'; break; } } }
  catch (e) { err = e.message; }
  const se = (eng.stderr || []).join('');
  const out = (eng.stdoutBytes || []).reduce((a, b) => a + b.length, 0);
  const good = !err && eng.exitCode === 0 && !/Error|Traceback|error/.test(se);
  if (eng._shadowStats) { const q = eng._shadowStats;
    console.log(`  shadow: tried=${q.tried} compared=${q.compared} aborted=${q.aborted} diverged=${q.diverged}`); }
  return { good, err, exit: eng.exitCode, out, se, order, funcsOf,
           units: order.length, insns: eng.stats.interpreted };
};

const say = (tag, r) => console.log(
  `  ${tag.padEnd(14)} ${r.good ? 'GOOD' : 'BAD '}  exit=${r.exit} stdout=${r.out}B units=${r.units}` +
  (r.err ? ` threw:${r.err}` : '') +
  (r.se ? `  stderr:${r.se.trim().split('\n').pop().slice(0, 70)}` : ''));

// ADDR=0x5ccce80 - compile ONLY that entry and interpret everything else.
// Unlike selecting by unit number (which names a different function in every
// configuration), an address is stable, and with a single function compiled
// every entry into it is a JS dispatch, so the lockstep shadow can compare it.
if (process.env.ADDR) {
  const a = BigInt(process.env.ADDR);
  const r = run(new Set([a]));
  say(`only 0x${a.toString(16)}`, r);
  const fs = r.funcsOf.get(a);
  if (fs) console.log(`  closure: ${fs.length} functions: ${fs.map(x=>'0x'+x.toString(16)).join(' ')}`);
  else console.log('  that entry was never offered in this run');
  process.exit(r.good ? 0 : 1);
}

const all = run(null);  say('all units', all);
if (all.good) { console.log('\nnothing to bisect: the uncapped run is already good'); process.exit(0); }
const none = run(new Set());  say('no units', none);
if (!none.good) { console.log('\nnothing to bisect: it fails with everything interpreted too, ' +
                              'so this is not an AOT-only bug'); process.exit(1); }

// The offer order is recorded from the FULL run; a prefix of it is a stable,
// address-named set that means the same thing in every configuration.
const order = [...new Set(all.order.map(String))].map(BigInt);
let lo = 0, hi = order.length;
console.log(`\nbisecting over ${hi} distinct entry addresses...`);
while (hi - lo > 1) {
  const mid = (lo + hi) >> 1;
  const r = run(new Set(order.slice(0, mid)));
  say(`first ${mid}`, r);
  if (r.good) lo = mid; else hi = mid;
}
const culprit = order[hi - 1];
console.log(`\nculprit entry: 0x${culprit.toString(16)}  (the first ${lo} addresses are clean)`);
const fs = all.funcsOf.get(culprit);
if (fs) { console.log(`  closure: ${fs.length} functions`);
  for (const a of fs.slice(0, 40)) console.log(`   0x${a.toString(16)}`); }
