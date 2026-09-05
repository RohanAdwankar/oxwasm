import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const files = {}, mtimes = {};
const add = (g, h = g) => { try { files[g] = new Uint8Array(readFileSync(h)); mtimes[g] = 1; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache'); 
const bin = process.argv[2]; add(bin);
let an = 0;
const assembleWat = (wat) => { const w = `/tmp/ri_${process.pid}_${an++}`; writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  const b = new Uint8Array(readFileSync(w + '.wasm')); try { unlinkSync(w+'.wat'); unlinkSync(w+'.wasm'); } catch {} return b; };
const rss = () => (process.memoryUsage().rss / 1e6) | 0;
let t0 = Date.now(); console.error(`provisioned ${Object.keys(files).length} files rss=${rss()}MB`);
const eng = new LinuxEngine(new Uint8Array(files[bin]), { argv: [bin, ...process.argv.slice(3)],
  env: ['PATH=/usr/bin', 'HOME=/root', 'LANG=C'], files, mtimes, memMB: 1024, assembleWat });
console.error(`constructed in ${Date.now() - t0}ms rss=${rss()}MB`);
globalThis.__sigtrace = true;
eng.strace = []; for (let i = 0; i < 12 && eng.exitCode === null; i++) {
  t0 = Date.now(); eng.run(2e5);
  console.error(`slice ${i}: ${Date.now() - t0}ms interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} fns=${eng.aotFns.size} rip=${eng.cpu.rip.toString(16)} thr=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} kids=${(eng.children || []).map(c => c.pid + ':' + (c.exited ?? 'live')).join(' ')} blocked=${JSON.stringify(eng.blocked)} rss=${rss()}MB strace=[${eng.strace.slice(-6).join(" | ")}]`);
  for (const c of eng.children ?? []) if (c.eng && c.exited === null) { c.eng.strace ??= [];
    console.error(`   child ${c.pid}: exit=${c.eng.exitCode} blocked=${JSON.stringify(c.eng.blocked)} thr=${c.eng.threads.map(t => `${t.id}:${t.state}${t.futex ? '@' + t.futex.toString(16) : ''}${t.dl != null ? '/dl' : ''}`).join(' ')} rip=${c.eng.cpu.rip.toString(16)} strace=[${c.eng.strace.slice(-8).join(' | ')}]`); }
  if (eng.blocked) { const dl = eng.blocked.deadline; if (dl != null && isFinite(dl)) { const ms = dl - eng.nowMs(); if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(ms, 500)); } eng.wake(); }
}
console.error(`exit=${eng.exitCode} stdout=${JSON.stringify((eng.stdout || []).join(''))}`);
