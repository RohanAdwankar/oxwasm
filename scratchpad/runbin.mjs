// generic: run a provisioned binary under the engine, print exit/stdout/stderr
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
let an = 0;
globalThis.__jtabStats = { structured: 0 }; globalThis.__layoutOf = new Map();
let watBytes = 0, watUnits = 0;
const assembleWat = (wat) => { watBytes += wat.length; watUnits++; if (process.env.WATDUMP === 'all') writeFileSync('/tmp/claude-0/-home-user-0/39bd4f7f-c25c-5004-92d0-ce544ed5705a/scratchpad/dump/unit_' + watUnits + '.wat', wat); else if (process.env.WATDUMP && wat.includes('$f_' + process.env.WATDUMP)) writeFileSync(process.env.WATDUMP_TO || ('/tmp/claude-0/-home-user-0/39bd4f7f-c25c-5004-92d0-ce544ed5705a/scratchpad/unit_' + process.env.WATDUMP + '.wat'), wat);                       // AOT=1: tier live, like breadth
  const w = `/tmp/rb_${process.pid}_${an++}`; writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '--debug-names', w + '.wat', '-o', w + '.wasm']);
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
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; } for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; } if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);   // TREE=dir:dir - provision whole directories
const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin', 'HOME=/root', 'LANG=C', ...(process.env.EXTRAENV || '').split(' ').filter(Boolean)], files, mtimes, memMB: process.env.MEM ? +process.env.MEM : 512, assembleWat: process.env.AOT ? assembleWat : undefined });
if (process.env.UNITLOG) eng.onUnitWat = (n, entry, unit) => console.error(`<unit ${n} entry ${entry.toString(16)} fns ${unit.funcs?.length ?? '?'}${process.env.UNITLOG === 'fns' ? ' ' + (unit.funcs || []).map(a => a.toString(16)).join(' ') : ''}>`);
if (process.env.FNALLOW) { const ok = new Set(process.env.FNALLOW.split(',').filter(Boolean).map(h => BigInt('0x' + h).toString())); eng.fnAllow = ok; eng.unitFilter = (n, entry) => ok.has(entry.toString()); }   // FNALLOW=hex,hex: compile only these functions
if (process.env.FNVETO) { const bad = new Set(process.env.FNVETO.split(',').filter(Boolean).map(h => BigInt('0x' + h).toString())); eng.fnVeto = bad; eng.unitFilter = (n, entry) => !bad.has(entry.toString()); }   // FNVETO=hex,hex: never compile these functions, as roots or inside closures   // UNITLOG=1: one line per compiled unit
if (process.env.UNITVETOADDR) { const bad = new Set(process.env.UNITVETOADDR.split(',').filter(Boolean).map(h => BigInt('0x' + h))); eng.unitFilter = (n, entry) => !bad.has(entry); }   // UNITVETOADDR=hex,hex: those entries stay interpreted
if (process.env.UNITVETO) { const [lo, hi] = process.env.UNITVETO.split('-').map(Number); eng.unitFilter = (n) => !(n >= lo && n < hi); }   // UNITVETO=lo-hi: units [lo,hi) stay interpreted (bisect)
if (process.env.RIPTRACE) { eng.ripTrace = new Array(1024).fill(0n); eng.ripTraceI = 0; } if (process.env.LOOPTRACE) globalThis.__loopTrace = true; if (process.env.TAILTRACE) globalThis.__tailTrace = true; if (process.env.TAILNOCHAIN) globalThis.__tailNoChain = true; if (process.env.TAILCUT_LO) { const lo = +process.env.TAILCUT_LO, hi = +process.env.TAILCUT_HI; globalThis.__tailCutAllow = (n) => n > lo && n <= hi; } if (process.env.AOTFAIL) eng.onAotFail = (a, m) => console.error(`<aotfail ${a.toString(16)}: ${String(m).slice(0, 300)}>`); if (process.env.STRACE) eng.strace = []; if (process.env.SIGTRACE) globalThis.__sigtrace = true; if (process.env.DBG) { globalThis.__dbg = true; console.error('<constructed>'); }
if (process.env.PROGRESS) { let k=0; eng.onProgress = (w) => { if ((k++ % 5) === 0) console.error(`<progress ${w} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} rip=${eng.cpu.rip.toString(16)} thr=${eng.threads.map(t=>t.id+':'+t.state).join(' ')} kids=${(eng.children||[]).map(c=>c.pid+':'+(c.exited??'live')).join(' ')} rss=${(process.memoryUsage().rss/1e6)|0}MB>`); }; }
process.on('SIGINT', () => { try { console.error(`<sigint rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} strace=${(eng.strace || []).slice(-8).join(' | ')}>`); } catch (e) { console.error('<sigint ' + e.message + '>'); } process.exit(3); });   // timeout -s INT: where it was
let err = null, guard = 0; const t0 = Date.now();
const nap = new Int32Array(new SharedArrayBuffer(4));
// child-engine tracing: arm every child engine's strace ring as it appears
const seenEng = new Set();
const armChildren = (e) => { for (const c of e.children ?? []) if (c.eng && !seenEng.has(c.eng)) { seenEng.add(c.eng); c.eng._label = `pid${c.pid}`; if (process.env.STRACE) c.eng.strace = []; armChildren(c.eng); } };
const libOf = (rip) => { let base = rip & ~0xfffn; for (let n = 0; n < 65536 && base >= eng.base; n++, base -= 0x1000n) { let hdr; try { hdr = eng.mem.view(base, 64n); } catch { return '?'; } if (hdr[0] === 0x7f && hdr[1] === 0x45 && hdr[2] === 0x4c && hdr[3] === 0x46) { let name = '?'; for (const [k, v] of Object.entries(eng.files)) if (v.length > 64 && v[0] === 0x7f && v.subarray(0, 64).every((b, i) => b === hdr[i])) { name = k; break; } return `${name} base ${base.toString(16)} + ${(rip - base).toString(16)}`; } } return '?'; };
try { while (eng.exitCode === null) { armChildren(eng); if (process.env.STOPFILE && existsSync(process.env.STOPFILE)) { console.error('<stopfile-lib ' + libOf(eng.cpu.rip) + '>'); console.error(`<stopfile rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} strace=${(eng.strace || []).slice(-10).join(' | ')}>`); process.exit(3); } if (process.env.DBG) { eng.run(2e5); console.error(`<slice rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)}>`); } else eng.run(5e7);
  if (eng.blocked) { const dl = eng.blocked.deadline; if (dl != null && isFinite(dl)) { const ms = dl - eng.nowMs(); if (ms > 0) { Atomics.wait(nap, 0, 0, Math.min(ms, 1000)); guard--; } } eng.wake(); }
  if (++guard > (process.env.GUARD ? +process.env.GUARD : 20000)) { err='no exit'; break; } } }
catch (e) { err = e.stack || e.message; }
console.log('children:', JSON.stringify((eng.children||[]).map(c=>({pid:c.pid,exited:c.exited,ceng:c.eng?c.eng.exitCode:null,termSig:c.eng?c.eng.termSig:null,interp:c.eng?c.eng.stats.interpreted:0}))));
console.log('code:', eng.exitCode, 'err:', err, 'ms:', Date.now()-t0, 'rip:', eng.cpu.rip.toString(16), 'blocked:', JSON.stringify(eng.blocked), 'threads:', eng.threads.map(t=>`${t.id}:${t.state}:pend=${t.pending}:eintr=${t.eintr}`).join(' '), 'interp:', eng.stats.interpreted, 'aot:', eng.stats.aotRuns);
process.stdout.write('--- stdout ---\n' + (eng.stdoutBytes&&eng.stdoutBytes.length?Buffer.concat(eng.stdoutBytes.map(b=>Buffer.from(b))):Buffer.from((eng.stdout||[]).join(''),'binary')).toString());
if (err) {   // where did it die: the mapping holding rip (library + file offset), and the last interpreted rips
  const rip = eng.cpu.rip;
  for (const m of eng.maps ?? []) if (rip >= m.at && rip < m.at + m.len) console.log(`--- rip ${rip.toString(16)} in ${m.path} map ${m.at.toString(16)}+${m.len.toString(16)} fileOff ${m.fileOff.toString(16)} -> file offset ${(rip - m.at + BigInt(m.fileOff)).toString(16)}`);
  { // which ELF image holds rip: walk down page by page to an ELF header, then match it against the provisioned files
    let base = rip & ~0xfffn, found = null;
    for (let n = 0; n < 65536 && base >= eng.base; n++, base -= 0x1000n) {
      let hdr; try { hdr = eng.mem.view(base, 64n); } catch { break; }
      if (hdr[0] === 0x7f && hdr[1] === 0x45 && hdr[2] === 0x4c && hdr[3] === 0x46) { found = base; break; } }
    if (found !== null) { const h = eng.mem.view(found, 64n); let name = '?';
      for (const [k, v] of Object.entries(eng.files)) if (v.length > 64 && v[0] === 0x7f && v[1] === 0x45 && v.subarray(0, 64).every((b, i) => b === h[i])) { name = k; break; }
      const code = []; try { for (const b of eng.mem.view(rip, 16n)) code.push(b.toString(16).padStart(2, '0')); } catch {}
      console.log(`--- rip ${rip.toString(16)} = ${name} base ${found.toString(16)} + ${(rip - found).toString(16)}  bytes ${code.join(' ')}  regs rax=${eng.cpu.regs[0].toString(16)} rcx=${eng.cpu.regs[1].toString(16)} rdx=${eng.cpu.regs[2].toString(16)} rbx=${eng.cpu.regs[3].toString(16)} rsp=${eng.cpu.regs[4].toString(16)} rbp=${eng.cpu.regs[5].toString(16)} rsi=${eng.cpu.regs[6].toString(16)} rdi=${eng.cpu.regs[7].toString(16)}`); }
  }
  if (eng.ripTrace) { const out = []; for (let i = 1; i <= 48; i++) { const v = eng.ripTrace[(eng.ripTraceI - i) & 1023]; if (v === 0n || v === undefined) break; out.push((v < 0n ? 'A' : '') + (v < 0n ? -v : v).toString(16)); }
    console.log('--- last rips (newest first; A=AOT entry/exit): ' + out.join(' ')); }
}
const __fdv = new DataView(eng.wmem.buffer), __yt = __fdv.getUint32(0x10000 + 24, true), __yn = __fdv.getUint32(0x10000 + 28, true);
console.log(`--- yields: top=${__yt} nested=${__yn} entries=${__fdv.getBigUint64(0x10000 + 32, true)}`);
globalThis.__jtabStats ??= { structured: 0 };
if (process.env.LAYOUTOF) for (const a of process.env.LAYOUTOF.split(',')) console.log(`--- layout ${a}: ${globalThis.__layoutOf.get(a)}`);
if (globalThis.__inlStats?.rej) console.log(`--- inline rejections (${globalThis.__inlStats.rej.length}):\n` + [...new Set(globalThis.__inlStats.rej)].slice(0, 40).join('\n'));
console.log(`--- narrow: ${JSON.stringify(globalThis.__narrowStats || {})}`);
console.log(`--- layouts: ${JSON.stringify(globalThis.__inlStats || {})} jtab=${JSON.stringify(globalThis.__jtabStats)} unroll=${JSON.stringify(globalThis.__unrollStats || {})} deopts=${eng.stats.deopts|0} layout=${JSON.stringify(globalThis.__layoutStats||{})}`);
console.log(`--- wat: units=${watUnits} bytes=${(watBytes/1e6).toFixed(2)}MB loopHot=${eng.stats.loopHot|0} yieldTop=${eng.stats.loopYieldTop|0} yieldNested=${eng.stats.loopYieldNested|0} aotFns=${eng.aotFns.size}`);
if (process.env.OXWASM_FNPROF === '1') {   // per-function entry counts (see FNPROF in aot_wat.mjs); top 40, collisions flagged
  const { fnprofSlot } = await import('../engine/aot_wat.mjs');
  const dv = new DataView(eng.wmem.buffer), bySlot = new Map(), rows = [];
  for (const a of eng.aotFns.keys()) { const sl = fnprofSlot(a); (bySlot.get(sl) || bySlot.set(sl, []).get(sl)).push(a); }
  for (const [sl, as] of bySlot) { const n = dv.getBigUint64(sl, true); if (n) rows.push([n, as]); }
  rows.sort((x, y) => (y[0] > x[0]) - (y[0] < x[0]));
  const tot = rows.reduce((s, r) => s + r[0], 0n);
  console.log(`--- fnprof: ${rows.length} entered fns, ${tot} entries\n` + rows.slice(0, 40).map(([n, as]) => `  ${as.map(a => a.toString(16)).join('|')} x${n} (${(Number(n * 1000n / tot) / 10).toFixed(1)}%)`).join('\n'));
}
if (process.env.OXWASM_BLKPROF) {   // per-block entry counts of the named functions: top 40 by guest block address
  const { blkprofSlot, BLKPROF_BASE, BLKPROF_SLOTS } = await import('../engine/aot_wat.mjs');
  const dv = new DataView(eng.wmem.buffer), rows = [];
  for (let i = 0; i < BLKPROF_SLOTS; i++) { const n = dv.getBigUint64(BLKPROF_BASE + i * 8, true); if (n) rows.push([n, i]); }
  rows.sort((x, y) => (y[0] > x[0]) - (y[0] < x[0]));
  const tot = rows.reduce((s, r) => s + r[0], 0n);
  console.log(`--- blkprof ${process.env.OXWASM_BLKPROF}: ${rows.length} blocks, ${tot} entries (slot = (addr>>2)&0x3fff; resolve against the function's block list)\n` +
    rows.slice(0, 40).map(([n, i]) => `  slot ${i} x${n} (${(Number(n * 1000n / tot) / 10).toFixed(1)}%)`).join('\n'));
}
if (process.env.DUMP) {   // DUMP=hexrip,...: tiering state of given entries + the hottest uncompiled call targets
  console.log(`--- tiering: loopHot=${eng.stats.loopHot|0} yieldTop=${eng.stats.loopYieldTop|0} yieldNested=${eng.stats.loopYieldNested|0} aotFns=${eng.aotFns.size} aotFailed=${eng.aotFailed?.size} ftCount=${eng._ftCount} ftFull=${eng._ftFull} tiers=${JSON.stringify(eng.stats.tiers)}`);
  for (const h of process.env.DUMP.split(',').filter(Boolean)) { const a = BigInt('0x' + h);
    console.log(`  ${h}: aotFns=${eng.aotFns.has(a)} failed=${eng.aotFailed?.has(a)} calls=${eng.aotCalls?.get(a)} trampoline=${eng.isTrampoline(a)}`); }
  console.log('  syscalls: ' + Object.entries(eng.stats.syscalls).sort((x, y) => y[1] - x[1]).slice(0, 10).map(([n, c]) => n + 'x' + c).join(' '));
  const hot = [...(eng.aotCalls ?? [])].filter(([a]) => !eng.aotFns.has(a)).sort((x, y) => y[1] - x[1]).slice(0, 12);
  const hotAll = [...(eng.aotCalls ?? [])].sort((x, y) => y[1] - x[1]).slice(0, 24);
  console.log('  hottest call targets: ' + hotAll.map(([a, n]) => a.toString(16) + 'x' + n + (eng.aotFns.has(a) ? '' : '(uncompiled)')).join(' '));
  console.log('  hottest uncompiled call targets: ' + hot.map(([a, n]) => a.toString(16) + 'x' + n + (eng.aotFailed?.has(a) ? '(failed)' : '')).join(' '));
}
if (process.env.FILE) { const f = eng.files[process.env.FILE]; console.log('--- file ' + process.env.FILE + ' ---\n' + (f ? Buffer.from(f).toString() : '(missing)')); }
if (eng.stderr&&eng.stderr.length) console.log('--- stderr ---\n' + eng.stderr.join('').slice(0,500));
if (process.env.STRACE) console.log('--- strace tail ---\n' + eng.strace.slice(process.env.STRACE === 'full' ? 0 : -40).join('\n'));
if (process.env.STRACE) { armChildren(eng); for (const ce of seenEng) console.log(`--- child ${ce._label} exit=${ce.exitCode} blocked=${JSON.stringify(ce.blocked)} threads=${ce.threads.map(t=>t.id+':'+t.state).join(' ')} strace tail ---\n` + (ce.strace||[]).slice(-30).join('\n')); }
