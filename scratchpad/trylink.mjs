// Probe: does the full gcc link lane produce a working a.out now that
// pwrite64 honours its explicit offset? Provisions cc1/as/collect2/ld and the
// crt objects into the engine FS, runs `gcc -O1 -o /tmp/a.out hello.c`, then
// re-runs the produced a.out under a fresh engine and checks its output.
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const files = {}, mtimes = {};
// add(guest, host): register the guest path (which may be a symlink NAME like
// libisl.so.23) pointing at the real file's bytes — the convention ld.so needs.
const add = (guest, host = guest) => { try { files[guest] = new Uint8Array(readFileSync(host)); mtimes[guest] = 1; } catch {} };
const walked = new Set();
const walk = (dir) => { if (walked.has(dir)) return; walked.add(dir);
  let ents; try { ents = readdirSync(dir); } catch { return; }
  for (const e of ents) { const p = join(dir, e); let st; try { st = lstatSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p); else { try { add(p, realpathSync(p)); } catch {} } } };

const HELLO_C = '/tmp/tl_hello.c';
writeFileSync(HELLO_C, 'int main(){__builtin_printf("hi from compiled C\\n");return 0;}\n');

// toolchain binaries the driver execs
for (const b of ['/usr/bin/gcc', '/usr/libexec/gcc/x86_64-linux-gnu/13/cc1',
  '/usr/bin/as', '/usr/bin/x86_64-linux-gnu-as',
  '/usr/libexec/gcc/x86_64-linux-gnu/13/collect2',
  '/usr/bin/ld', '/usr/bin/x86_64-linux-gnu-ld', '/usr/bin/x86_64-linux-gnu-ld.bfd']) add(b, b);
add(HELLO_C, HELLO_C);
// crt + libs + headers
walk('/usr/lib/x86_64-linux-gnu');
walk('/usr/lib/gcc/x86_64-linux-gnu/13');
walk('/usr/include');
walk('/usr/lib/gcc/x86_64-linux-gnu/13/include');
walk('/lib/x86_64-linux-gnu');
// breadth's top-level lib sweep: register each symlink NAME (e.g. libisl.so.23,
// ld-linux-x86-64.so.2) pointing at its real bytes — this is what ld.so opens.
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache', '/etc/ld.so.cache');

const OUT = '/tmp/tl_aout';
const runEng = (bin, args, opts = {}) => {
  const eng = new LinuxEngine(new Uint8Array(files[bin] || readFileSync(bin)),
    { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'LANG=C'],
      files, mtimes, memMB: opts.memMB || 1024 });
  let err = null, guard = 0;
  try { while (eng.exitCode === null) { eng.run(5e7); if (eng.blocked) eng.wake();
    if (++guard > 6000) { err = 'no exit'; break; } } } catch (e) { err = e.message; }
  return { eng, err, code: eng.exitCode,
           stderr: (eng.stderr || []).join(''),
           stdout: eng.stdoutBytes && eng.stdoutBytes.length
             ? Buffer.concat(eng.stdoutBytes.map(b => Buffer.from(b))) : Buffer.from((eng.stdout||[]).join(''),'binary') };
};

console.log('=== native link ===');
try { execFileSync('/usr/bin/gcc', ['-O1', '-o', '/tmp/tl_native', HELLO_C]);
  const no = execFileSync('/tmp/tl_native'); console.log('native a.out out:', JSON.stringify(no.toString())); } catch (e) { console.log('native fail', e.message); }

console.log('=== engine link ===');
const r = runEng('/usr/bin/gcc', ['-O1', '-o', OUT, HELLO_C]);
console.log('link code:', r.code, 'err:', r.err);
if (r.stderr) console.log('link stderr:', r.stderr.slice(0, 800));
const aout = r.eng.files[OUT];
console.log('produced a.out bytes:', aout ? aout.length : '(none)');
if (aout) {
  // inspect _start region: find entry from ELF header (e_entry @ 24)
  const dv = new DataView(aout.buffer, aout.byteOffset, aout.byteLength);
  const entry = dv.getBigUint64(24, true);
  console.log('e_entry:', '0x' + entry.toString(16));
  // dump 16 bytes around likely _start file offset (PIE: vaddr==offset for text-ish); just show first bytes of the 0x1060 region
  const at = 0x1060;
  console.log('bytes @0x1060:', [...aout.slice(at, at + 24)].map(b => b.toString(16).padStart(2,'0')).join(' '));
  writeFileSync('/tmp/tl_engine_aout', Buffer.from(aout));
  // compare to native
  try { const nb = readFileSync('/tmp/tl_native');
    console.log('native bytes @0x1060:', [...nb.slice(at, at + 24)].map(b => b.toString(16).padStart(2,'0')).join(' '));
    let diff = 0; const n = Math.min(nb.length, aout.length);
    for (let i = 0; i < n; i++) if (nb[i] !== aout[i]) diff++;
    console.log(`byte diff: ${diff} of ${n} (len eng ${aout.length} vs nat ${nb.length})`); } catch {}
  // run the produced a.out under a fresh engine
  files[OUT] = aout; mtimes[OUT] = 1;
  console.log('=== run produced a.out ===');
  const r2 = runEng(OUT, []);
  console.log('a.out code:', r2.code, 'err:', r2.err, 'stdout:', JSON.stringify(r2.stdout.toString()));
  if (r2.stderr) console.log('a.out stderr:', r2.stderr.slice(0, 400));
}
