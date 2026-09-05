// Multi-process pipelines of DYNAMIC binaries: dash forks and execs real
// coreutils, so every child runs its own ld.so relocation pass in a fresh
// child engine. The subprocess machinery was built against static busybox
// (NOEXEC applets, no ld.so) and GIMP plug-ins, so this is a different path.
import { LinuxEngine } from '../linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
if (!existsSync('/bin/dash') || !existsSync('/usr/bin/sort')) {
  console.log('pipetest SKIPPED: no dynamic /bin/dash + coreutils on this host');
  process.exit(0);
}
const base = {}, mtimes = {};
const add = (g, h) => { try { base[g] = new Uint8Array(readFileSync(h)); mtimes[g] = 0; return true; } catch { return false; } };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} } }
add('/etc/ld.so.cache', '/etc/ld.so.cache');
for (const b of ['/bin/dash', '/bin/sh', '/usr/bin/sort', '/usr/bin/head', '/usr/bin/wc', '/usr/bin/tr',
                 '/usr/bin/cat', '/usr/bin/seq', '/usr/bin/grep', '/usr/bin/cut', '/usr/bin/uniq', '/usr/bin/tail'])
  add(b, b.startsWith('/bin/sh') ? '/bin/dash' : b);
const DATA = Array.from({length: 400}, (_, i) => `${(i*7919)%997} line${i%13}`).join('\n') + '\n';
writeFileSync('/tmp/pt_in.txt', DATA);
const cases = [
  ['single exec',      'seq 1 20 | wc -l'],
  ['two-stage pipe',   'seq 1 100 | sort -n | tail -3'],
  ['three-stage pipe', 'cat /data/in.txt | cut -d" " -f1 | sort -n | uniq | wc -l'],
  ['subshell',         '(seq 1 5; seq 6 10) | sort -n | tr "\\n" ","'],
  ['cmd substitution', 'echo "count=$(grep -c line /data/in.txt)"'],
  ['sequential execs', 'for i in 1 2 3; do seq 1 $i | wc -l; done'],
  ['exit status',      'grep -q nosuchpattern /data/in.txt; echo rc=$?'],
  ['pipe + redirect',  'sort -n /data/in.txt > /data/out.txt; wc -l < /data/out.txt'],
];
let pass = 0, fail = 0; const fails = [];
for (const [name, script] of cases) {
  let want;
  try { want = execFileSync('/bin/dash', ['-c', script.replace(/\/data\//g, '/tmp/pt_')],
        { encoding: 'utf8', env: { LC_ALL: 'C', PATH: '/usr/bin:/bin' }, timeout: 30000 }); }
  catch (e) { fails.push([name, 'native failed: ' + e.message.slice(0,50)]); fail++; continue; }
  const files = { ...base };
  files['/data/in.txt'] = new TextEncoder().encode(DATA);
  const eng = new LinuxEngine(files['/bin/dash'], { argv: ['/bin/dash', '-c', script],
    env: ['LC_ALL=C', 'PATH=/usr/bin:/bin', 'HOME=/root'], files, mtimes, memMB: 512 });
  eng.childMemMB = 256;
  const t0 = Date.now();
  try { while (eng.exitCode === null && Date.now() - t0 < 180000) { eng.run(5e7); if (eng.blocked) eng.wake(); } }
  catch (e) { fails.push([name, 'THREW ' + e.message.slice(0,70)]); fail++; process.stdout.write('X'); continue; }
  const got = eng.stdout.join('');
  if (got === want) { pass++; process.stdout.write('.'); }
  else { fail++; fails.push([name, `got ${JSON.stringify(got.slice(0,60))} want ${JSON.stringify(want.slice(0,60))}`]);
         process.stdout.write('X'); }
}
if (fail) { console.log(`\nPIPETEST FAIL: ${pass} pass, ${fail} fail`);
  for (const f of fails) console.log('  FAIL ' + f[0] + ' — ' + f[1]);
  process.exit(1); }
console.log(`\ndynamic multi-process pipelines (dash + coreutils, ld.so per child) ${pass}/${pass} exact`);
