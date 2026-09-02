// Probe: can the engine run g++ (cc1plus, a much larger frontend than cc1)
// through a full compile+link and run the result? Reuses trylink's proven
// provisioning, adds cc1plus + the C++ header tree + libstdc++.
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = {}, mtimes = {};
const add = (guest, host = guest) => { try { files[guest] = new Uint8Array(readFileSync(host)); mtimes[guest] = 1; } catch {} };
const walked = new Set();
const walk = (dir) => { if (walked.has(dir)) return; walked.add(dir);
  let ents; try { ents = readdirSync(dir); } catch { return; }
  for (const e of ents) { const p = join(dir, e); let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p); else { try { add(p, realpathSync(p)); } catch {} } } };

const SRC = '/tmp/tg_hello.cpp';
writeFileSync(SRC, '#include <cstdio>\nint main(){std::printf("hi from C++\\n");return 0;}\n');

for (const b of ['/usr/bin/g++', '/usr/bin/gcc',
  '/usr/libexec/gcc/x86_64-linux-gnu/13/cc1plus',
  '/usr/bin/as', '/usr/bin/x86_64-linux-gnu-as',
  '/usr/libexec/gcc/x86_64-linux-gnu/13/collect2',
  '/usr/bin/ld', '/usr/bin/x86_64-linux-gnu-ld', '/usr/bin/x86_64-linux-gnu-ld.bfd']) add(b, b);
add(SRC, SRC);
walk('/usr/lib/x86_64-linux-gnu'); walk('/usr/lib/gcc/x86_64-linux-gnu/13');
walk('/usr/include'); walk('/lib/x86_64-linux-gnu');
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');

const OUT = '/tmp/tg_aout';
const runEng = (bin, args, opts = {}) => {
  const eng = new LinuxEngine(new Uint8Array(files[bin] || readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C'],
      files, mtimes, memMB: opts.memMB || 2048 });
  let err = null, guard = 0;
  try { while (eng.exitCode === null) { eng.run(5e7); if (eng.blocked) eng.wake();
    if (++guard > 12000) { err = 'no exit'; break; } } } catch (e) { err = e.message; }
  return { eng, err, code: eng.exitCode, stderr: (eng.stderr || []).join(''),
           stdout: eng.stdoutBytes && eng.stdoutBytes.length
             ? Buffer.concat(eng.stdoutBytes.map(b => Buffer.from(b))) : Buffer.from((eng.stdout||[]).join(''),'binary') };
};

console.log('=== native g++ link ===');
execFileSync('/usr/bin/g++', ['-O1', '-o', '/tmp/tg_native', SRC]);
console.log('native out:', JSON.stringify(execFileSync('/tmp/tg_native').toString()), 'size', readFileSync('/tmp/tg_native').length);

console.log('=== engine g++ link ===');
const r = runEng('/usr/bin/g++', ['-O1', '-o', OUT, SRC]);
console.log('link code:', r.code, 'err:', r.err);
if (r.stderr) console.log('stderr:', r.stderr.slice(0, 600));
const aout = r.eng.files[OUT];
console.log('produced bytes:', aout ? aout.length : '(none)');
if (aout) {
  const nb = readFileSync('/tmp/tg_native');
  let diff = 0; const n = Math.min(nb.length, aout.length);
  for (let i = 0; i < n; i++) if (nb[i] !== aout[i]) diff++;
  console.log(`byte diff: ${diff} of ${n} (eng ${aout.length} vs nat ${nb.length})`);
  files[OUT] = aout; mtimes[OUT] = 1;
  console.log('=== run produced a.out ===');
  const r2 = runEng(OUT, []);
  console.log('a.out code:', r2.code, 'err:', r2.err, 'stdout:', JSON.stringify(r2.stdout.toString()));
  if (r2.stderr) console.log('a.out stderr:', r2.stderr.slice(0, 300));
}
