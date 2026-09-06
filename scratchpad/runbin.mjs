// generic: run a provisioned binary under the engine, print exit/stdout/stderr
import { LinuxEngine } from '../engine/linux.mjs';
import { setFlagsFromString } from 'node:v8';
if (process.env.WASM_LAZY !== '0') setFlagsFromString('--wasm-lazy-compilation');   // V8 compiles each wasm function at its first call: most translated functions of a compiler run are never entered (clang -S 45 s -> 39 s), m4 steady state neutral on a quiet machine; WASM_LAZY=0 restores eager
import { makeAssembler } from '../tools/assemble.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, existsSync, opendirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
let an = 0;
globalThis.__jtabStats = { structured: 0 }; globalThis.__layoutOf = new Map();
let watBytes = 0, watUnits = 0;
if (process.env.ASMTRACE) globalThis.__asmTrace = true;   // ASMTRACE=1: deferred-assembly submit/return per unit, and the stack of a unit that fails
if (process.env.CFGDUMP) globalThis.__cfgDump = process.env.CFGDUMP;   // CFGDUMP=hex: when this function falls back to dispatch, write its N/succs to CFGDUMP_TO
const assembleWat = (wat) => { watBytes += wat.length; watUnits++; if (process.env.WATDUMP === 'all') writeFileSync('/tmp/scratch' + watUnits + '.wat', wat); else if (process.env.WATDUMP && wat.includes('$f_' + process.env.WATDUMP)) writeFileSync(process.env.WATDUMP_TO || ('/tmp/scratch' + process.env.WATDUMP + '.wat'), wat);                       // AOT=1: tier live, like breadth
  return asm(wat); };
const asm = makeAssembler({ debugNames: true, tag: 'rb' });   // pre-forked: 4 ms a unit instead of 133 from a 3 GB process
const bin = process.argv[2], args = process.argv.slice(3);
const files = {}, mtimes = {};
const byReal = new Map();   // /lib/x86_64-linux-gnu and /usr/lib/x86_64-linux-gnu are one directory: share the bytes (the doubled copy was half of a 4 GB baseline)
const add = (g, h = g) => { try { let b = byReal.get(h); if (!b) { b = new Uint8Array(readFileSync(h)); byReal.set(h, b); } files[g] = b; mtimes[g] = 1; } catch {} };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} }
}
add('/etc/ld.so.cache'); add(bin);
for (const b of (process.env.BINS||'').split(',').filter(Boolean)) add(resolve(b));   // a relative name would be a guest path under / now that relative names normalise there
const rawDir = (d) => { const dir = opendirSync(d), out = []; let e; while ((e = dir.readSync()) !== null) out.push(e.name); dir.closeSync(); return out; };   // host getdents order, not readdirSync's sorted one
const walk = (d) => { let e; try { e = rawDir(d); } catch { return; } for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; } if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);   // TREE=dir:dir - provision whole directories
const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin', 'HOME=/root', 'LANG=C', ...(process.env.EXTRAENV || '').split(' ').filter(Boolean)], files, mtimes, memMB: process.env.MEM ? +process.env.MEM : 512, assembleWat: process.env.AOT ? assembleWat : undefined, ...(process.env.LOOPUNITS === '0' ? { aotLoopThreshold: Infinity } : process.env.LOOPTHRESH ? { aotLoopThreshold: +process.env.LOOPTHRESH } : {}) });   // LOOPTHRESH=N: loop-head roots tier up after N back edges   // LOOPUNITS=0: no loop-head roots (bisects veto whole functions)
if (process.env.CHILDTRACE) eng.children = new Proxy([], { set(t, k, v) { if (v && typeof v === 'object' && 'pid' in v) console.error(`<childrec pid=${v.pid} exited=${v.exited} eng=${!!v.eng} pp=${v.pp ? v.pp.pid : null} at ${new Error().stack.split('\n').slice(2, 5).map(x => x.trim().replace(/^at /, '')).join(' <- ')}>`); t[k] = v; return true; } });   // CHILDTRACE=1: who pushed each child record (a lost background job)
if (process.env.KIDS) eng.onChildEngine = (ce, argv) => { ce._label = (argv || [])[0]; seenEng.add(ce); if (eng.strace) ce.strace = new (eng.strace.constructor)(); };   // children trace like the parent (STRACENR/STRACEERR filters included)   // KIDS=1: record every child engine at creation (the run-loop sweep misses ones reaped within a slice)
if (process.env.AOT && process.env.ASYNC_ASM !== '0') { eng.assembleWatDeferred = (w, cb) => asm.submit(w, cb); eng.pumpAsm = () => asm.pump(); }   // units assemble while the guest keeps running (default); ASYNC_ASM=0: synchronous assembly
if (process.env.CHILDMEM) eng.childMemMB = +process.env.CHILDMEM;   // CHILDMEM=MB: execve'd children get this much (default 256: a rustc child could not map its 265 MB of libraries and ld.so exited 127)
if (process.env.UNITLOG) eng.onUnitWat = (n, entry, unit) => console.error(`<unit ${n} entry ${entry.toString(16)} fns ${unit.funcs?.length ?? '?'}${process.env.UNITLOG === 'fns' ? ' ' + (unit.funcs || []).map(a => a.toString(16)).join(' ') : ''}>`);
if (process.env.FNALLOW) { const ok = new Set(process.env.FNALLOW.split(',').filter(Boolean).map(h => BigInt('0x' + h).toString())); eng.fnAllow = ok; eng.unitFilter = (n, entry) => ok.has(entry.toString()); }   // FNALLOW=hex,hex: compile only these functions
if (process.env.FNVETO) { const bad = new Set(process.env.FNVETO.split(',').filter(Boolean).map(h => BigInt('0x' + h).toString())); eng.fnVeto = bad; eng.unitFilter = (n, entry) => !bad.has(entry.toString()); }   // FNVETO=hex,hex: never compile these functions, as roots or inside closures   // UNITLOG=1: one line per compiled unit
if (process.env.UNITVETOADDR) { const bad = new Set(process.env.UNITVETOADDR.split(',').filter(Boolean).map(h => BigInt('0x' + h))); eng.unitFilter = (n, entry) => !bad.has(entry); }   // UNITVETOADDR=hex,hex: those entries stay interpreted
if (process.env.SHADOWLIB) { eng.shadowLib = process.env.SHADOWLIB; eng.shadowMax = process.env.SHADOWMAX ? +process.env.SHADOWMAX : 50; }   // SHADOWLIB=libc.so.6: run each compiled dispatch in that library both ways, report the first divergence
if (process.env.UNITVETO) { const [lo, hi] = process.env.UNITVETO.split('-').map(Number); eng.unitFilter = (n) => !(n >= lo && n < hi); }   // UNITVETO=lo-hi: units [lo,hi) stay interpreted (bisect)
if (process.env.RIPTRACE) { eng.ripTrace = new Array(1024).fill(0n); eng.ripTraceI = 0; } if (process.env.LOOPTRACE) globalThis.__loopTrace = true; if (process.env.TAILTRACE) globalThis.__tailTrace = true; if (process.env.TAILNOCHAIN) globalThis.__tailNoChain = true; if (process.env.TAILCUT_LO) { const lo = +process.env.TAILCUT_LO, hi = +process.env.TAILCUT_HI; globalThis.__tailCutAllow = (n) => n > lo && n <= hi; } if (process.env.AOTFAIL) eng.onAotFail = (a, m) => console.error(`<aotfail ${a.toString(16)}: ${String(m).slice(0, 300)}>`); if (process.env.STRACE) eng.strace = []; if (process.env.STRACENR || process.env.STRACEERR) { const want = new Set((process.env.STRACENR || '').split(',').filter(Boolean)); const errs = new Set((process.env.STRACEERR || '').split(',').filter(Boolean).map(e => '=-' + e)); class TA extends Array { push(l) { const nr = l.slice(l.indexOf(']') + 1, l.indexOf('(')); const ret = l.slice(l.indexOf(')=') + 1).split(' ')[0]; if (want.has(nr) || errs.has(ret)) console.error('<st ' + l + '>'); return super.push(l); } } eng.strace = new TA(); } if (process.env.IHIST) globalThis.__ihist = new Map(); if (process.env.DEOPTLOG) eng.deoptLog = new Map(); if (process.env.SIGTRACE) globalThis.__sigtrace = true; if (process.env.FRAMETRACE) globalThis.__frameTrace = true; if (process.env.DBG) { globalThis.__dbg = true; console.error('<constructed>'); }   // STRACEERR=38,22: print every syscall returning those errnos   // STRACENR=28,9: print every call of those numbers to stderr as it happens (the ring only keeps the last 400)
if (process.env.PROGRESS) { let k=0; eng.onProgress = (w) => { if ((k++ % 5) === 0) console.error(`<progress ${w} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} rip=${eng.cpu.rip.toString(16)} thr=${eng.threads.map(t=>t.id+':'+t.state).join(' ')} kids=${(eng.children||[]).map(c=>c.pid+':'+(c.exited??'live')).join(' ')} rss=${(process.memoryUsage().rss/1e6)|0}MB heap=${(process.memoryUsage().heapUsed/1e6)|0}MB ext=${(process.memoryUsage().external/1e6)|0}MB ab=${(process.memoryUsage().arrayBuffers/1e6)|0}MB units=${watUnits} wat=${(watBytes/1e6)|0}MB>`); }; }
process.on('SIGUSR1', () => { console.error(`<usr1 interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} ti=${eng.ti} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} kids=${(eng.children || []).map(c => c.pid + ':' + c.exited).join(',')}>`); if (process.env.KIDS) kidsReport(); });   // kill -USR1: sample the tree without stopping
process.on('SIGINT', () => { try { console.error(`<sigint rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} strace=${(eng.strace || []).slice(-8).join(' | ')}>`); } catch (e) { console.error('<sigint ' + e.message + '>'); } process.exit(3); });   // timeout -s INT: where it was
let err = null, guard = 0; const t0 = Date.now();
const nap = new Int32Array(new SharedArrayBuffer(4));
// child-engine tracing: arm every child engine's strace ring as it appears
const seenEng = new Set();
const kidsReport = () => { for (const ce of seenEng) console.log(`--- child ${ce._label} argv ${JSON.stringify(process.env.KIDSARGV ? (ce._ctor?.argv || []) : (ce._ctor?.argv || []).slice(0, 3))} exit ${ce.exitCode} interp ${ce.stats?.interpreted} aot ${ce.stats?.aotRuns} rip ${ce.cpu?.rip?.toString(16)} blocked ${JSON.stringify(ce.blocked)} ti ${ce.ti} dl ${ce._deadline} now ${ce.nowMs?.()} threads ${(ce.threads || []).map(t => t.id + ':' + t.state + (t.futex ? '@' + (typeof t.futex === 'object' ? JSON.stringify(t.futex, (k, v) => typeof v === 'bigint' ? v.toString(16) : v) : t.futex.toString(16)) : '') + (t._dl != null ? '/dl' + t._dl : '')).join(' ')} kids ${(ce.children || []).map(c => c.pid + ':' + c.exited).join(',')} stderr ${JSON.stringify((ce.stderr || []).join('').slice(0, 400))} strace ${(ce.strace || []).slice(-10).join(' | ').slice(0, 900)}`); };
const armChildren = (e) => { for (const c of e.children ?? []) if (c.eng && !seenEng.has(c.eng)) { seenEng.add(c.eng); c.eng._label = `pid${c.pid}`; if (process.env.STRACE) c.eng.strace = []; armChildren(c.eng); } };
const libOf = (rip) => { let base = rip & ~0xfffn; for (let n = 0; n < 65536 && base >= eng.base; n++, base -= 0x1000n) { let hdr; try { hdr = eng.mem.view(base, 64n); } catch { return '?'; } if (hdr[0] === 0x7f && hdr[1] === 0x45 && hdr[2] === 0x4c && hdr[3] === 0x46) { let name = '?'; for (const [k, v] of Object.entries(eng.files)) if (v.length > 64 && v[0] === 0x7f && v.subarray(0, 64).every((b, i) => b === hdr[i])) { name = k; break; } return `${name} base ${base.toString(16)} + ${(rip - base).toString(16)}`; } } return '?'; };
try { while (eng.exitCode === null) { armChildren(eng); if (process.env.SAMPLEFILE && existsSync(process.env.SAMPLEFILE)) { try { unlinkSync(process.env.SAMPLEFILE); } catch {} console.error(`<sample t=${Date.now() - t0} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} ti=${eng.ti} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} kids=${(eng.children || []).map(c => c.pid + ':' + c.exited + (c.error ? ' ERROR ' + String(c.errorStack || c.error).slice(0, 1500) : '')).join(',')}>`); if (process.env.KIDS) kidsReport(); }   // SAMPLEFILE=path: touch it to print the tree's state and keep running (signals never fire: the loop is synchronous)
  if (process.env.STOPFILE && existsSync(process.env.STOPFILE)) { console.error('<stopfile-lib ' + libOf(eng.cpu.rip) + '>'); if (process.env.KIDS) kidsReport(); console.error(`<stopfile rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)} threads=${eng.threads.map(t => t.id + ':' + t.state).join(' ')} strace=${(eng.strace || []).slice(-10).join(' | ')}>`); process.exit(3); } if (process.env.DBG) { eng.run(2e5); console.error(`<slice rip=${eng.cpu.rip.toString(16)} interp=${eng.stats.interpreted} aot=${eng.stats.aotRuns} blocked=${JSON.stringify(eng.blocked)}>`); } else eng.run(5e7);
  if (eng.blocked) { const dl = eng.blocked.deadline; if (dl != null && isFinite(dl)) { const ms = dl - eng.nowMs(); if (ms > 0) { Atomics.wait(nap, 0, 0, Math.min(ms, 1000)); guard--; } } eng.wake(); }
  if (++guard > (process.env.GUARD ? +process.env.GUARD : 20000)) { err='no exit'; break; } } }
catch (e) { err = e.stack || e.message; }
if (process.env.KIDS) kidsReport();   // KIDS=1: every execve'd child's argv, exit, stderr and strace tail
console.log('children:', JSON.stringify((eng.children||[]).map(c=>({pid:c.pid,exited:c.exited,error:c.error,ceng:c.eng?c.eng.exitCode:null,termSig:c.eng?c.eng.termSig:null,interp:c.eng?c.eng.stats.interpreted:0}))));
console.log('code:', eng.exitCode, 'err:', err, 'ms:', Date.now()-t0, 'rip:', eng.cpu.rip.toString(16), 'blocked:', JSON.stringify(eng.blocked), 'threads:', eng.threads.map(t=>`${t.id}:${t.state}:pend=${t.pending}:eintr=${t.eintr}`).join(' '), 'interp:', eng.stats.interpreted, 'aot:', eng.stats.aotRuns);
process.stdout.write('--- stdout ---\n' + (eng.stdoutBytes&&eng.stdoutBytes.length?Buffer.concat(eng.stdoutBytes.map(b=>Buffer.from(b))):Buffer.from((eng.stdout||[]).join(''),'binary')).toString());
if (process.env.TEXTCHECK) {   // TEXTCHECK=1: after the run, compare every file mapping's guest bytes with the file (text with no relocations must match; a mismatch is a wild store or a mapping bug)
  let bad = 0;
  for (const m of eng.maps ?? []) {
    if (!m.h?.bytes || m.shared) continue;
    const src = eng.files?.[m.path] ?? m.h.bytes, o = Number(m.at - eng.base), n = Math.min(Number(m.len), Math.max(0, src.length - m.fileOff));
    if (!(m.path.includes('.so') || m.path === bin)) continue;
    let first = -1, cnt = 0;
    for (let i = 0; i < n; i++) if (eng.ram[o + i] !== src[m.fileOff + i]) { if (first < 0) first = i; cnt++; }
    if (cnt) { bad++; console.log(`--- textcheck ${m.path} map ${m.at.toString(16)}+${m.len.toString(16)} fileOff ${m.fileOff.toString(16)}: ${cnt} bytes differ, first at ${(m.at + BigInt(first)).toString(16)} mem ${Array.from(eng.ram.subarray(o + first, o + first + 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')} file ${Array.from(src.subarray(m.fileOff + first, m.fileOff + first + 8)).map(b => b.toString(16).padStart(2, '0')).join(' ')}`); }
  }
  console.log(`--- textcheck: ${bad} mappings differ from their files`);
}
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
      console.log(`--- rip ${rip.toString(16)} = ${name} base ${found.toString(16)} + ${(rip - found).toString(16)}  bytes ${code.join(' ')}  regs rax=${eng.cpu.regs[0].toString(16)} rcx=${eng.cpu.regs[1].toString(16)} rdx=${eng.cpu.regs[2].toString(16)} rbx=${eng.cpu.regs[3].toString(16)} rsp=${eng.cpu.regs[4].toString(16)} rbp=${eng.cpu.regs[5].toString(16)} rsi=${eng.cpu.regs[6].toString(16)} rdi=${eng.cpu.regs[7].toString(16)} fs=${eng.cpu.fsBase?.toString(16)} fsSlot=${(eng.fsview ? BigInt.asUintN(64, eng.fsview[0]) : -1n).toString(16)} frameGone=${eng.stats.frameGone|0} deopts=${eng.stats.deopts|0}`); }
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
console.log(`--- layouts: ${JSON.stringify(globalThis.__inlStats || {})} jtab=${JSON.stringify(globalThis.__jtabStats)} unroll=${JSON.stringify(globalThis.__unrollStats || {})} deopts=${eng.stats.deopts|0} layout=${JSON.stringify(globalThis.__layoutStats||{})} split=${JSON.stringify(globalThis.__splitStats||{})} hotUnprune=${JSON.stringify(globalThis.__hotUnpruneStats||{})}`);
console.log(`--- wat: units=${watUnits} bytes=${(watBytes/1e6).toFixed(2)}MB loopHot=${eng.stats.loopHot|0} yieldTop=${eng.stats.loopYieldTop|0} yieldNested=${eng.stats.loopYieldNested|0} aotFns=${eng.aotFns.size}`);
if (process.env.OXWASM_FNPROF === '1') {   // per-function entry counts (see FNPROF in aot_wat.mjs); top 40, collisions flagged
  const { fnprofSlot } = await import('../engine/aot_wat.mjs');
  const dv = new DataView(eng.wmem.buffer), bySlot = new Map(), rows = [];
  for (const a of eng.aotFns.keys()) { const sl = fnprofSlot(a); (bySlot.get(sl) || bySlot.set(sl, []).get(sl)).push(a); }
  for (const [sl, as] of bySlot) { const n = dv.getBigUint64(sl, true); if (n) rows.push([n, as]); }
  rows.sort((x, y) => (y[0] > x[0]) - (y[0] < x[0]));
  const tot = rows.reduce((s, r) => s + r[0], 0n);
  { const hb = {}; let never = 0; for (const [sl, as] of bySlot) { const n = Number(dv.getBigUint64(sl, true)); if (!n) { never += as.length; continue; } const bk = n < 4 ? '<4' : n < 16 ? '<16' : n < 64 ? '<64' : n < 256 ? '<256' : n < 4096 ? '<4096' : '>=4096'; hb[bk] = (hb[bk] || 0) + as.length; }
    console.log(`--- fnprof hist (translated fns by entry count; never = translated but never entered): never=${never} ${JSON.stringify(hb)} roots=${[...eng.aotFns.keys()].filter(a => (eng.aotCalls.get(a) || 0) >= eng.aotCallThreshold).length}`); }   // OXWASM_FNPROF=1 also prints this histogram
  if (globalThis.__aotPhase?.big) {   // OXWASM_PHASE=1 too: entry counts of the giant (>=2000 insn) functions, weighted by instructions
    const big = globalThis.__aotPhase.big, byN = {}; let fns = 0, insns = 0;
    for (const [k, n] of big) { if (!eng.aotFns.has(BigInt(k))) continue; fns++; insns += n; const e = Number(dv.getBigUint64(fnprofSlot(BigInt(k)), true)); const bk = e === 0 ? 'never' : e < 4 ? '<4' : e < 16 ? '<16' : e < 64 ? '<64' : e < 256 ? '<256' : '>=256'; const r = byN[bk] ??= [0, 0]; r[0]++; r[1] += n; }
    console.log(`--- giants: ${fns} translated fns of >=2000 insns, ${insns} insns; by entries [fns, insns]: ${JSON.stringify(byN)}`); }
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
if (globalThis.__aotPhase) { const ph = globalThis.__aotPhase; console.log('--- phase:', JSON.stringify({ ...ph, seen: ph.seen ? ph.seen.size : 0 }, (k, v) => typeof v === 'number' ? Math.round(v) : v)); }   // OXWASM_PHASE=1: translation time by phase (ms)
if (process.env.FILEOUT) { const [g, h] = process.env.FILEOUT.split(':'); const f = eng.files[g]; if (f) { writeFileSync(h, f); console.log(`--- fileout ${g} -> ${h} (${f.length} bytes)`); } else console.log(`--- fileout ${g} missing`); }   // FILEOUT=guest:host - copy a guest file out as bytes
if (process.env.DEOPTLOG) {   // DEOPTLOG=1: deopt landings by target (the lib each lies in) - where translated code keeps leaving wasm
  const rows = [...eng.deoptLog.entries()].sort((a, b) => b[1] - a[1]); const tot = rows.reduce((s, r) => s + r[1], 0);
  const lib = (a) => { const m = (eng.maps ?? []).find(m => a >= m.at && a < m.at + m.len); return m ? `${m.path.split('/').pop()}+${(a - m.at + BigInt(m.fileOff ?? 0)).toString(16)}` : 'anon/exe'; };
  console.log(`--- deoptlog: ${rows.length} targets, ${tot} deopts\n` + rows.slice(0, 25).map(([a, n]) => `  ${a.toString(16)} ${lib(a)} ${(100 * n / tot).toFixed(1)}% compiled=${eng.aotFns.has(a)} failed=${eng.aotFailed.has(a)}`).join('\n'));
}
if (process.env.IHIST) {   // IHIST=1: top interpreted rips (every 64th step sampled; the lib each lies in) - what never tiers up
  const h = globalThis.__ihist, rows = [...h.entries()].sort((a, b) => b[1] - a[1]); const tot = rows.reduce((s, r) => s + r[1], 0);
  const lib = (a) => { const m = (eng.maps ?? []).find(m => a >= m.at && a < m.at + m.len); return m ? `${m.path.split('/').pop()}+${(a - m.at + BigInt(m.fileOff ?? 0)).toString(16)}` : 'anon/exe'; };
  console.log(`--- ihist: ${rows.length} distinct rips, ${tot * 64} steps sampled\n` + rows.slice(0, 25).map(([a, n]) => `  ${a.toString(16)} ${lib(a)} ${(100 * n / tot).toFixed(1)}%`).join('\n'));
  const byLib = new Map(); for (const [a, n] of rows) { const l = lib(a).split('+')[0]; byLib.set(l, (byLib.get(l) || 0) + n); }
  console.log('  by lib: ' + [...byLib.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([l, n]) => `${l} ${(100 * n / tot).toFixed(1)}%`).join(', '));
}
if (process.env.LAYOUTS) for (const h of process.env.LAYOUTS.split(',')) { const k = BigInt('0x' + h).toString(); console.log(`--- layout ${h}: ${JSON.stringify(globalThis.__layoutOf?.get(k) ?? globalThis.__layoutOf?.get(h) ?? 'unknown')}`); }   // LAYOUTS=hex,hex: the emitted layout (structured/dispatch) of these functions
if (process.env.LIBOF) for (const h of process.env.LIBOF.split(',')) { const a = BigInt('0x' + h); const m = (eng.maps ?? []).find(m => a >= m.at && a < m.at + m.len); console.log(`--- libof ${h}: ${m ? `${m.path} map ${m.at.toString(16)}+${m.len.toString(16)} fileOff ${(m.fileOff ?? 0n).toString(16)} -> file offset ${(a - m.at + BigInt(m.fileOff ?? 0)).toString(16)}` : libOf(a)}`); }   // LIBOF=hex,hex: which mapping holds these guest addresses (wasm trap frames name f_<hex>)
if (process.env.STDOUTFILE) writeFileSync(process.env.STDOUTFILE, eng.stdoutBytes && eng.stdoutBytes.length ? Buffer.concat(eng.stdoutBytes.map(b => Buffer.from(b))) : Buffer.from((eng.stdout || []).join(''), 'binary'));   // STDOUTFILE=path: the guest's raw stdout bytes
if (process.env.FILE) { const f = eng.files[process.env.FILE]; console.log('--- file ' + process.env.FILE + ' ---\n' + (f ? Buffer.from(f).toString() : '(missing)')); }
if (eng.stderr&&eng.stderr.length) console.log('--- stderr ---\n' + eng.stderr.join('').slice(0, process.env.STDERRMAX ? +process.env.STDERRMAX : 4000));
if (process.env.STRACE) console.log('--- strace tail ---\n' + eng.strace.slice(process.env.STRACE === 'full' ? 0 : -40).join('\n'));
if (process.env.STRACE) { armChildren(eng); for (const ce of seenEng) console.log(`--- child ${ce._label} exit=${ce.exitCode} blocked=${JSON.stringify(ce.blocked)} threads=${ce.threads.map(t=>t.id+':'+t.state).join(' ')} strace tail ---\n` + (ce.strace||[]).slice(-30).join('\n')); }
if (globalThis.__cfgDumped) { const d = globalThis.__cfgDumped; writeFileSync(process.env.CFGDUMP_TO || (process.cwd() + '/cfg.json'), JSON.stringify(d)); console.log(`--- cfgdump: N=${d.N} ${d.err}`); }
