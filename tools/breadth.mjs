// Breadth: run unmodified system binaries end to end and check the engine
// produces byte-identical output to running them natively.
//
// The point is generality, not speed. Each case runs natively and on the
// engine with the AOT tier live, and stdout plus exit status must match
// exactly. A case that differs is a real bug in the engine, and printing the
// guest's own stdout alongside the fault is what turned "CPython faults
// during startup" into "CPython prints 42 and then crashes" - a failure
// address alone hides whether the program worked.
//
//   node tools/breadth.mjs            # every case
//   node tools/breadth.mjs sort grep  # only cases whose name matches
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync, writeFileSync,
         existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const files = {}, mtimes = {};
const add = (g, h) => {
  try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); }
  catch {}
};
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');
// tar resolves uname/gname through getpwuid/getgrgid: without these the
// engine's archive carries empty owner names (and a checksum to match)
// while native says root - a provisioning gap, not an engine one
add('/etc/passwd', '/etc/passwd');
add('/etc/group', '/etc/group');

// A shared input, written once so native and engine see identical bytes.
const IN = '/tmp/breadth_in.txt';
if (!existsSync(IN)) {
  const lines = [];
  for (let i = 0; i < 2000; i++) lines.push(`${(i * 7919) % 1000} line ${i} ${'abcdefghij'[i % 10].repeat(1 + i % 5)}`);
  writeFileSync(IN, lines.join('\n') + '\n');
}
add(IN, IN);

// wat2wasm for the AOT tier; cached by text hash so repeat cases are cheap
const CACHE = new URL('../bench/kernels/watcache/', import.meta.url).pathname;
mkdirSync(CACHE, { recursive: true });
let an = 0;
const assembleWat = (wat) => {
  const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
  if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
  const w = `/tmp/bw_${process.pid}_${an++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm'));
  try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
  try { writeFileSync(cp, b); } catch {}
  return b;
};

// tree: provision a whole directory (an interpreter is not one file - without
// its stdlib CPython never reaches main, and the case would measure its own
// startup failure). Walked once per distinct tree.
const walked = new Set();
const walk = (d) => { if (walked.has(d)) return; walked.add(d);
  let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f);
    let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };

const CASES = [
  ['wc',      '/usr/bin/wc',      ['-l', '-w', '-c', IN]],
  ['head',    '/usr/bin/head',    ['-n', '5', IN]],
  ['sort',    '/bin/sort',        [IN]],
  ['sort-n',  '/bin/sort',        ['-n', IN]],
  ['uniq',    '/usr/bin/uniq',    ['-c', IN]],
  ['grep',    '/bin/grep',        ['-c', 'line 1', IN]],
  ['grep-re', '/bin/grep',        ['-E', '^[0-9]{3} line [0-9]+ a+$', IN]],
  ['sed',     '/bin/sed',         ['s/line/LINE/g;10q', IN]],
  ['tr',      '/usr/bin/tr',      ['a-z', 'A-Z']],
  ['cut',     '/usr/bin/cut',     ['-d', ' ', '-f', '2,3', IN]],
  ['base64',  '/usr/bin/base64',  [IN]],
  ['md5sum',  '/usr/bin/md5sum',  [IN]],
  ['sha256',  '/usr/bin/sha256sum', [IN]],
  ['od',      '/usr/bin/od',      ['-A', 'x', '-t', 'x1', '-N', '256', IN]],
  ['seq',     '/usr/bin/seq',     ['1', '2', '999']],
  ['factor',  '/usr/bin/factor',  ['600851475143', '1234567891', '999999999989']],
  ['expr',    '/usr/bin/expr',    ['31337', '*', '1337']],
  ['printf',  '/usr/bin/printf',  ['%s=%d %.4f\n', 'x', '42', '3.14159']],
  ['nl',      '/usr/bin/nl',      [IN]],
  ['fold',    '/usr/bin/fold',    ['-w', '13', IN]],
  ['paste',   '/usr/bin/paste',   ['-d', ':', IN, IN]],
  ['bc',      '/usr/bin/bc',      ['-q']],
  // xz -9 reserves a 512MB+ dictionary, more than the default guest. Give it
  // room so this case tests compression; the out-of-memory path is covered by
  // the brk fix, where it now exits 1 like native instead of faulting.
  ['xz',      '/usr/bin/xz',      ['-9', '-c', IN], { memMB: 1536 }],
  ['xz-1',    '/usr/bin/xz',      ['-1', '-c', IN]],
  ['gzip',    '/bin/gzip',        ['-9', '-c', IN]],
  ['diff',    '/usr/bin/diff',    ['-u', IN, IN]],
  ['sh',      '/bin/sh',          ['-c', 'echo start; for i in 1 2 3; do echo line $i; done; echo done']],
  ['perl',    '/usr/bin/perl',    ['-e', 'my $s=0; $s+=$_ for 1..100; print "sum=$s\n"; print join(",", map { $_*$_ } 1..8), "\n"']],
  ['openssl', '/usr/bin/openssl', ['dgst', '-sha256', IN]],
  ['openssl-b64', '/usr/bin/openssl', ['enc', '-base64', '-in', IN]],
  // The two-tier CPython case that took two silicon-semantics bugs to make
  // pass (movhlps moving the wrong half, bsr clobbering a preserved
  // destination). It stays in the sweep so neither can regress silently.
  ['python3', '/usr/bin/python3', ['-S', '-c', 'print(6*7); print(sorted("breadth")); print(sum(range(100)))'],
              { tree: '/usr/lib/python3.11', memMB: 1024 }],
  ['jq',      '/usr/bin/jq',      ['-c', '{n: (.a + .b), l: [.a, .b] | map(. * 2)}']],
  ['zstd',    '/usr/bin/zstd',    ['-19', '-c', IN]],
  ['bzip2',   '/bin/bzip2',       ['-9', '-c', IN]],
  ['tar',     '/bin/tar',         ['-cf', '-', IN]],
  ['dash',    '/bin/dash',        ['-c', 'x=1; while [ $x -le 20 ]; do echo "n$x"; x=$((x+1)); done']],
  ['rev',     '/usr/bin/rev',     [IN]],
  ['tac',     '/usr/bin/tac',     [IN]],
  ['expand',  '/usr/bin/expand',  ['-t', '3', IN]],
  ['fmt',     '/usr/bin/fmt',     ['-w', '40', IN]],
];
const STDIN = { tr: readFileSync(IN), bc: Buffer.from('scale=20\n7/3\n2^64\nsqrt(2)\nquit\n'),
                jq: Buffer.from('{"a": 3, "b": 4}\n{"a": 10, "b": -2}\n') };

const only = process.argv.slice(2);
const pick = (n) => !only.length || only.some(o => n.includes(o));

const native = (bin, args, stdin) => {
  try { const out = execFileSync(bin, args, { input: stdin, maxBuffer: 1 << 28 });
        return { out, code: 0 }; }
  catch (e) { return { out: e.stdout ?? Buffer.alloc(0), code: e.status ?? -1 }; }
};

const engine = (bin, args, stdin, opts = {}) => {
  add(bin, bin);
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C'],
      files, mtimes, memMB: opts.memMB || 512, assembleWat, stdin });

  const t0 = process.hrtime.bigint();
  let err = null;
  try {
    let guard = 0;
    while (eng.exitCode === null) {
      eng.run(5e7);
      if (eng.blocked) eng.wake();
      if (++guard > 4000) { err = 'no exit after 200e9 steps'; break; }
    }
  } catch (e) { err = e.message; }
  // stdoutBytes, not stdout: the string view mangles binary output, and
  // comparing it reported gzip as differing from byte 1 when the bytes were
  // fine. A generality harness that corrupts its own evidence is worse than
  // none.
  const raw = eng.stdoutBytes && eng.stdoutBytes.length
    ? Buffer.concat(eng.stdoutBytes.map(b => Buffer.from(b)))
    : Buffer.from(eng.stdout.join(''), 'binary');
  return { out: raw, code: eng.exitCode,
           ms: Number(process.hrtime.bigint() - t0) / 1e6,
           units: eng.aotFns.size, insns: eng.stats.interpreted, err };
};

let pass = 0, fail = 0;
const failures = [];
for (const [name, bin, args, opts] of CASES) {
  if (!pick(name)) continue;
  if (!existsSync(bin)) { console.log(`  SKIP ${name.padEnd(9)} (${bin} not present)`); continue; }
  const stdin = STDIN[name] || null;
  if (opts && opts.tree) walk(opts.tree);
  const nat = native(bin, args, stdin);
  const eng = engine(bin, args, stdin, opts);
  // compare the bytes, not a summary: a truncated stdout that happens to
  // share a prefix is exactly the failure a length check alone would miss
  const same = eng.code === nat.code && Buffer.compare(eng.out, nat.out) === 0;
  if (same) { pass++;
    console.log(`  ok   ${name.padEnd(9)} ${String(nat.out.length).padStart(8)}B out, ` +
                `${eng.units} fns, ${(eng.ms).toFixed(0)}ms`); }
  else { fail++;
    const why = eng.err ? `threw: ${eng.err}`
      : eng.code !== nat.code ? `exit ${eng.code} vs native ${nat.code}`
      : `stdout ${eng.out.length}B vs native ${nat.out.length}B`;
    failures.push([name, why]);
    console.log(`  FAIL ${name.padEnd(9)} ${why}`);
    if (!eng.err && eng.out.length && nat.out.length) {
      let i = 0; while (i < eng.out.length && i < nat.out.length && eng.out[i] === nat.out[i]) i++;
      console.log(`         first difference at byte ${i}`);
      console.log(`         engine: ${JSON.stringify(eng.out.subarray(Math.max(0,i-20), i+40).toString('latin1'))}`);
      console.log(`         native: ${JSON.stringify(nat.out.subarray(Math.max(0,i-20), i+40).toString('latin1'))}`);
    }
  }
}
console.log(`\n${pass}/${pass + fail} unmodified binaries byte-identical to native`);
if (failures.length) { console.log('failures:'); for (const [n, w] of failures) console.log(`  ${n}: ${w}`); }
process.exit(fail ? 1 : 0);
