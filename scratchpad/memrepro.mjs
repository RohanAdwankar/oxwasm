import { LinuxEngine } from '../engine/linux.mjs';
import { makeAssembler } from '../tools/assemble.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const RT = '/root/.rustup/toolchains/stable-x86_64-unknown-linux-gnu';
const files = {}, mtimes = {}, byReal = new Map();
const add = (g, h = g) => { try { let b = byReal.get(h); if (!b) { b = new Uint8Array(readFileSync(h)); byReal.set(h, b); } files[g] = b; mtimes[g] = 1; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) { let e; try { e = readdirSync(d); } catch { continue; } for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} } }
add('/etc/ld.so.cache');
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; } for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; } if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
walk(RT + '/lib'); walk('/tmp/breadth_crate_bad'); add(RT + '/bin/rustc'); add(RT + '/bin/cargo');
const asm = makeAssembler({ tag: 'mr' });
const mem = (l) => { globalThis.gc(); globalThis.gc(); const m = process.memoryUsage(); console.log(`${l}: rss ${(m.rss/1e6)|0}MB heap ${(m.heapUsed/1e6)|0}MB ext ${(m.external/1e6)|0}MB ab ${(m.arrayBuffers/1e6)|0}MB`); };
const runOne = (bin, args, memMB, childMemMB) => {
  const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)), { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'HOME=/root', 'RUSTC=' + RT + '/bin/rustc'], files, mtimes, memMB, assembleWat: process.env.NOAOT ? undefined : (w) => asm(w) });
  if (childMemMB) eng.childMemMB = childMemMB;
  let kids = 0; eng.onChildEngine = () => { kids++; };
  const t0 = Date.now(); let guard = 0, lastP = Date.now();
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (eng.exitCode === null && guard++ < 200000) { eng.run(5e7); if (Date.now() - lastP > 30000) { lastP = Date.now(); console.log(`  <progress ${((Date.now() - t0) / 1000) | 0}s interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} kids=${(eng.children || []).map(c => c.pid + ':' + c.exited + (c.error ? ' ERR ' + c.error : '')).join(',')} kidThreads=${(eng.children || []).filter(c => c.eng && c.exited === null).map(c => c.eng.threads.map(t => t.id + ':' + t.state).join(' ') + ' interp=' + c.eng.stats.interpreted).join(' | ')}>`); } if (eng.blocked) { const dl = eng.blocked.deadline; if (dl != null && isFinite(dl)) { const ms = dl - eng.nowMs(); if (ms > 0) Atomics.wait(nap, 0, 0, Math.min(ms, 1000)); } eng.wake(); } }
  console.log(`${bin.split('/').pop()} exit ${eng.exitCode} in ${Date.now() - t0}ms, ${kids} child engines`);
};
mem('start');
runOne(process.argv[2] === 'wc' ? '/usr/bin/wc' : RT + '/bin/cargo', process.argv[2] === 'wc' ? ['-c', '/etc/ld.so.cache'] : ['build', '--offline', '--manifest-path', '/tmp/breadth_crate_bad/Cargo.toml'], 2048, 1024);
mem('after run (engine dropped)');
{ const big = Object.entries(files).filter(([k, v]) => v && v.buffer && v.buffer.byteLength > (64 << 20)).map(([k, v]) => `${k}(${v.byteLength}B of ${(v.buffer.byteLength / 1e6) | 0}MB)`);
  console.log(`files: ${Object.keys(files).length} entries; views on >64MB buffers: ${big.length} ${big.slice(0, 5).join(' ')}`);
  const m = files._meta; if (m) console.log(`meta: dirs ${m.dirs.size} links ${m.links.size} flocks ${m.flocks?.size ?? 0} rlocks ${m.rlocks?.size ?? 0} fifos ${m.fifos?.size ?? 0} hard ${m.hard?.size ?? 0}`);
  const written = Object.entries(files).filter(([k, v]) => !byReal.has(k) && ![...byReal.values()].includes(v)); let tot = 0; for (const [, v] of written) tot += v.byteLength; console.log(`guest-written entries: ${written.length}, ${(tot / 1e6) | 0}MB`); }
runOne('/usr/bin/wc', ['-c', '/etc/ld.so.cache'], 512, 0);
mem('after wc');
if (process.env.SNAP) { const v8 = await import('node:v8'); console.log('snapshot', v8.writeHeapSnapshot(process.env.SNAP)); }
