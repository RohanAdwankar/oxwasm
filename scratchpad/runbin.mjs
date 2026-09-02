// generic: run a provisioned binary under the engine, print exit/stdout/stderr
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
let an = 0;
const assembleWat = (wat) => {                       // AOT=1: tier live, like breadth
  const w = `/tmp/rb_${process.pid}_${an++}`; writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm')); try { unlinkSync(w+'.wat'); unlinkSync(w+'.wasm'); } catch {} return b; };
const bin = process.argv[2], args = process.argv.slice(3);
const files = {}, mtimes = {};
const add = (g, h = g) => { try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = 1; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache'); add(bin);
for (const b of (process.env.BINS||'').split(',').filter(Boolean)) add(b);
const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin', 'HOME=/root', 'LANG=C'], files, mtimes, memMB: process.env.MEM ? +process.env.MEM : 512, assembleWat: process.env.AOT ? assembleWat : undefined });
if (process.env.STRACE) eng.strace = []; if (process.env.DBG) { globalThis.__dbg = true; console.error('<constructed>'); }
if (process.env.PROGRESS) { let k=0; eng.onProgress = (w) => { if ((k++ % 5) === 0) console.error(`<progress ${w} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} rip=${eng.cpu.rip.toString(16)} blocked=${JSON.stringify(eng.blocked)} pend=${eng.threads[0].pending} mask=${eng.threads[0].sigmask}>`); }; }
let err = null, guard = 0; const t0 = Date.now();
const nap = new Int32Array(new SharedArrayBuffer(4));
// child-engine tracing: arm every child engine's strace ring as it appears
const seenEng = new Set();
const armChildren = (e) => { for (const c of e.children ?? []) if (c.eng && !seenEng.has(c.eng)) { seenEng.add(c.eng); c.eng._label = `pid${c.pid}`; if (process.env.STRACE) c.eng.strace = []; armChildren(c.eng); } };
try { while (eng.exitCode === null) { armChildren(eng); if (process.env.DBG) { eng.run(2e5); console.error(`<slice rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)}>`); } else eng.run(5e7);
  if (eng.blocked) { const dl = eng.blocked.deadline; if (dl != null && isFinite(dl)) { const ms = dl - eng.nowMs(); if (ms > 0) { Atomics.wait(nap, 0, 0, Math.min(ms, 1000)); guard--; } } eng.wake(); }
  if (++guard > (process.env.GUARD ? +process.env.GUARD : 20000)) { err='no exit'; break; } } }
catch (e) { err = e.stack || e.message; }
console.log('children:', JSON.stringify((eng.children||[]).map(c=>({pid:c.pid,exited:c.exited,ceng:c.eng?c.eng.exitCode:null,termSig:c.eng?c.eng.termSig:null,interp:c.eng?c.eng.stats.interpreted:0}))));
console.log('code:', eng.exitCode, 'err:', err, 'ms:', Date.now()-t0, 'rip:', eng.cpu.rip.toString(16), 'blocked:', JSON.stringify(eng.blocked), 'threads:', eng.threads.map(t=>`${t.id}:${t.state}:pend=${t.pending}:eintr=${t.eintr}`).join(' '), 'interp:', eng.stats.interpreted, 'aot:', eng.stats.aotRuns);
process.stdout.write('--- stdout ---\n' + (eng.stdoutBytes&&eng.stdoutBytes.length?Buffer.concat(eng.stdoutBytes.map(b=>Buffer.from(b))):Buffer.from((eng.stdout||[]).join(''),'binary')).toString());
if (process.env.FILE) { const f = eng.files[process.env.FILE]; console.log('--- file ' + process.env.FILE + ' ---\n' + (f ? Buffer.from(f).toString() : '(missing)')); }
if (eng.stderr&&eng.stderr.length) console.log('--- stderr ---\n' + eng.stderr.join('').slice(0,500));
if (process.env.STRACE) console.log('--- strace tail ---\n' + eng.strace.slice(process.env.STRACE === 'full' ? 0 : -40).join('\n'));
if (process.env.STRACE) { armChildren(eng); for (const ce of seenEng) console.log(`--- child ${ce._label} exit=${ce.exitCode} blocked=${JSON.stringify(ce.blocked)} threads=${ce.threads.map(t=>t.id+':'+t.state).join(' ')} strace tail ---\n` + (ce.strace||[]).slice(-30).join('\n')); }
