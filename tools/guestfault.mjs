// Name a guest fault: which image and symbol the rip is in, what the frame
// chain above it looks like, and the instruction bytes around it.
//
// gueststack.mjs did this for CPython and said the walk was "worth lifting
// out when a second guest needs them". xz is that second guest. Same idea,
// any binary: symbol resolution over eng.maps plus the main image, an rbp
// walk, and a disassembly window so a misdecoded instruction is visible
// rather than inferred.
//
//   node tools/guestfault.mjs /usr/bin/xz -9 -c /tmp/breadth_in.txt
//   TREE=/usr/lib/python3.11 node tools/guestfault.mjs /usr/bin/python3 -S -c pass
//   AOT=1 ...   # run with the AOT tier live instead of pure interpreter
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
if (!bin) { console.log('usage: guestfault.mjs <binary> [args...]'); process.exit(2); }
add(bin, bin);
for (const p of args) if (existsSync(p)) add(p, p);

// How far the main image actually extends, from its PT_LOAD headers. Guessing
// a fixed window instead put heap addresses inside the binary and labelled
// them "_end+0xc8eb10" - a symbol offset past the end of the file, which is
// the same mistake the CPython notes already record once.
// ET_EXEC (2) loads at its own vaddrs, so the guest address IS the vaddr and
// the load bias is 0; only ET_DYN is biased by the load base. Subtracting the
// base unconditionally turned every python3 text address into a vaddr ~1.2MB
// too low, which is why nothing resolved to a symbol and heap addresses came
// back labelled "python3+... (_end+0xc8eb10)".
const mainIsExec = (() => {
  try { const b = readFileSync(bin); return new DataView(b.buffer, b.byteOffset, b.length).getUint16(16, true) === 2; }
  catch { return false; }
})();
const mainSpan = (() => {
  try {
    const b = readFileSync(bin), dv = new DataView(b.buffer, b.byteOffset, b.length);
    const phoff = Number(dv.getBigUint64(0x20, true));
    const phentsize = dv.getUint16(0x36, true), phnum = dv.getUint16(0x38, true);
    let end = 0n;
    for (let i = 0; i < phnum; i++) {
      const o = phoff + i * phentsize;
      if (dv.getUint32(o, true) !== 1) continue;                 // PT_LOAD
      const e = dv.getBigUint64(o + 0x10, true) + dv.getBigUint64(o + 0x28, true);
      if (e > end) end = e;
    }
    return end || 0x2000000n;
  } catch { return 0x2000000n; }
})();

const symCache = new Map();
const syms = (path) => {
  if (symCache.has(path)) return symCache.get(path);
  let out = '';
  for (const flag of ['-n', '--dynamic -n']) {
    try { out = execFileSync('bash', ['-c', `nm ${flag} --defined-only ${path} 2>/dev/null`],
                             { encoding: 'utf8', maxBuffer: 64e6 }); } catch {}
    if (out.trim()) break;
  }
  const list = [];
  for (const l of out.split('\n')) { const m = /^([0-9a-f]+)\s+\S\s+(.+)$/.exec(l); if (m) list.push([BigInt('0x'+m[1]), m[2]]); }
  list.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  symCache.set(path, list); return list;
};
const nearest = (list, off) => { let lo=0, hi=list.length-1, best=null;
  while (lo <= hi) { const mid = (lo+hi)>>1; if (list[mid][0] <= off) { best = list[mid]; lo = mid+1; } else hi = mid-1; }
  return best; };
// A stripped binary leaves only its dynamic symbols - python3 has 1,699 for
// 2.7MB of text - so "nearest preceding symbol" can be kilobytes away and
// name a completely different function. Presenting that as a confident
// `_Py_CheckFunctionResult+0x9e0` is how a wrong story starts, so anything
// far from its symbol is labelled unreliable rather than trusted.
const FAR = 0x1000n;
const symLabel = (b, off) => !b ? '' :
  (off - b[0] > FAR ? ` (>${FAR}B past ${b[1]} - name unreliable)`
                    : ` (${b[1]}+0x${(off - b[0]).toString(16)})`);
// which image an address is in, and where inside it. An address in NO map is
// reported as such rather than attributed to the main binary - assuming it was
// the main image once produced a symbol name past the end of a 6MB file.
const locate = (eng, addr) => {
  for (const m of (eng.maps || [])) if (addr >= m.at && addr < m.at + BigInt(m.len)) {
    const off = addr - m.at + BigInt(m.fileOff ?? 0);
    const b = nearest(syms(m.path), off);
    return { path: m.path, off, label: `${m.path.split('/').pop()}+0x${off.toString(16)}` + symLabel(b, off) };
  }
  const bias = mainIsExec ? 0n : eng.base;
  if (addr >= eng.base && addr < bias + mainSpan) {
    const off = addr - bias;
    const b = nearest(syms(bin), off);
    return { path: bin, off, label: `${bin.split('/').pop()}+0x${off.toString(16)}` + symLabel(b, off) };
  }
  return { path: null, off: null, label: `0x${addr.toString(16)} in no mapped image` };
};

let assembleWat = null;
if (process.env.AOT) {
  const CACHE = new URL('../bench/kernels/watcache/', import.meta.url).pathname;
  mkdirSync(CACHE, { recursive: true }); let an = 0;
  assembleWat = (wat) => {
    const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
    if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
    const w = `/tmp/gf_${process.pid}_${an++}`;
    writeFileSync(w + '.wat', wat);
    execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
    const b = new Uint8Array(readFileSync(w + '.wasm'));
    try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
    try { writeFileSync(cp, b); } catch {}
    return b;
  };
}

const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'LANG=C', 'HOME=/root'],
    files, mtimes, memMB: Number(process.env.MEMMB || 512),
    ...(assembleWat ? { assembleWat } : {}) });
// WATCH=0x1b29280,16 - log every write overlapping that range, with the rip
// that made it. Memory's watchpoint fires before the store; the rep movs/stos
// bulk fast paths go through mem.view() and TypedArray.set instead of
// Memory.write, so OXWASM_NOBULK=1 is forced on here or a bulk copy over the
// watched word would be invisible.
const watchLog = [];
if (process.env.WATCH) {
  process.env.OXWASM_NOBULK = '1';
  const [aS, nS] = process.env.WATCH.split(',');
  const wa = BigInt(aS.trim()), wn = BigInt(nS || 8);
  eng.mem.watchLo = wa; eng.mem.watchHi = wa + wn;
  // WATCHSTR=1 also captures the object's PyUnicode payload at each write.
  // A compact-ASCII str keeps its characters at sizeof(PyASCIIObject) = 0x28,
  // so this reads out WHICH string is being refcounted - the one thing that
  // identifies the same object in a native run, where the address will differ.
  // Reading only the payload was not enough to identify the object: at
  // construction the bytes are still the previous occupant's, and afterwards
  // they read as empty. Dump the PyASCIIObject header too - length at +0x10,
  // state at +0x20 - so what the object IS can be read off rather than
  // guessed from characters that may not be there yet.
  const STR = process.env.WATCHSTR ? 0x28n : null;
  eng.mem.watch = (addr, n, v) => {
    let str = '';
    if (STR !== null) {
      try {
        const len = eng.mem.read(wa + 0x10n, 8n), st = eng.mem.read(wa + 0x20n, 8n);
        let chars = '';
        for (let i = 0n; i < 20n && i < len; i++) { const c = Number(eng.mem.read(wa + STR + i, 1n));
          chars += (c >= 32 && c < 127) ? String.fromCharCode(c) : `\\x${c.toString(16).padStart(2,'0')}`; }
        str = `len=${len} state=0x${st.toString(16)} "${chars}"`;
      } catch {}
    }
    if (watchLog.length < 100000) watchLog.push([eng.cpu.rip, addr, n, v, eng.stats.interpreted, str]);
  };
}

// SHADOW=libc.so.6 - run each compiled dispatch into that library BOTH ways,
// interpreter first with a memory journal, then the unit, and report the first
// register/memory divergence. This is what finds an AOT-only miscompile
// without guessing which instruction is wrong.
if (process.env.SHADOW) eng.shadowLib = process.env.SHADOW;

// The rbp walk, reusable: it is as useful at a syscall trap as at a fault.
const frames = () => {
  const out = []; let rbp = eng.cpu.regs[5];
  for (let i = 0; i < 20; i++) {
    let ret, next;
    try { next = eng.mem.read(rbp, 8n); ret = eng.mem.read(rbp + 8n, 8n); } catch { break; }
    if (!ret || ret > 0x800000000n) break;
    out.push(`#${i} ret 0x${ret.toString(16)} -> ${locate(eng, ret).label}`);
    if (next <= rbp || next === 0n) break;
    rbp = next;
  }
  return out;
};

// ONLYADDR=0x... - compile ONLY that entry, everything else interpreted. The
// minimal reproducer for an AOT-only bug.
if (process.env.ONLYADDR) {
  const only = BigInt(process.env.ONLYADDR);
  eng.unitFilter = (n, entry) => entry === only;
}

// NOFTAB=1 - register compiled functions for JS dispatch only, skipping the
// funcref table and the FTMAP/FTHASH map (the engine's own __noFtab bisect
// lever). With JS dispatches of the culprit measured at ZERO and the run
// still failing, this splits the remaining world in two: if the failure
// disappears, the vector is the in-wasm side of registration; if it stays,
// neither executing nor mapping the function explains it.
if (process.env.NOFTAB) globalThis.__noFtab = true;

// NOJTAB=1 - analyze() without jump-table discovery (the page's ?nojtab
// lever). If compiling the unit breaks the program even though the unit is
// never executed, the compile step's own side effects are the suspects, and
// jtab discovery is the analyzer's most invasive phase.
if (process.env.NOJTAB) globalThis.__noJtab = true;

// CHAINSLOW=1 - the engine's own diagnostic: disable the wasm-to-wasm
// fastpaths in x_callout chaining and deopt-landing chaining. The PLT stub
// closure's direct cachedFn() call is NOT gated by it, so this splits the
// three dispatchAot-bypassing entry paths into two testable halves.
if (process.env.CHAINSLOW) eng.chainSlow = true;

// REGWRAP=1 (with TRACEFN=<addr>): after the unit registers, replace the
// aotFns entry for that address with a logging wrapper around the raw wasm
// export. The funcref table keeps the RAW function (a JS wrapper is not a
// funcref), but the paths that bypassed every earlier probe - the PLT stub
// closure's cachedFn() and the deopt/callout chains - all consult aotFns, so
// they get the wrapper. When it fires, guest registers live in the wasm
// REGFILE (dispatchAot's syncOut already ran), so args are read from
// regview, not cpu.regs. And because the callee is a reverse byte search,
// the EXPECTED result is computable in JS from guest memory right here:
// scan [rdi, rdi+rdx) for the byte in rsi from the top. A recorded mismatch
// is the miscompile, caught in the act with its inputs.
const wrapLog = [];
if (process.env.REGWRAP && process.env.TRACEFN) {
  const target = BigInt(process.env.TRACEFN);
  const origReg = eng.registerAotFn.bind(eng);
  eng.registerAotFn = (a, f) => {
    origReg(a, f);
    if (a !== target || typeof f !== 'function') return;
    const raw = eng.aotFns.get(a);
    eng.aotFns.set(a, (...xs) => {
      const rv = eng.regview;
      const rdi = BigInt.asUintN(64, rv[7]), rsi = BigInt.asUintN(64, rv[6]), rdx = BigInt.asUintN(64, rv[2]);
      const out = raw(...xs);
      const rax = BigInt.asUintN(64, eng.regview[0]);
      let expect = null;
      if (rdx > 0n && rdx < 65536n) {
        try { expect = 0n;
          for (let i = rdx - 1n; i >= 0n; i--)
            if (Number(eng.mem.read(rdi + i, 1n)) === Number(rsi & 0xFFn)) { expect = rdi + i; break; }
        } catch { expect = null; }
      }
      if (wrapLog.length < 100000)
        wrapLog.push({ rdi, rsi, rdx, rax, expect, bad: expect !== null && rax !== expect });
      return out;
    });
  };
}

// DISCARD=1 - let compileUnitWat run for the allowed unit, then fail its
// assembly so nothing registers. Splits "analyzing/emitting the function"
// from "having it registered": if this run still fails, the compile step
// corrupts shared state all by itself.
if (process.env.DISCARD) {
  const orig = eng.assembleWat;
  if (orig) eng.assembleWat = (wat) => {
    if (process.env.ONLYADDR && wat.includes('f_' + BigInt(process.env.ONLYADDR).toString(16)))
      throw new Error('discarded by DISCARD=1');
    return orig(wat);
  };
}

// REGLOG=1 - log every registerAotFn: which address, whether the function
// object is the traced unit's (a PLT-stub ALIAS registers the callee's wasm
// under the stub's own address, which is an entry door TRACEFN by rip would
// never see).
if (process.env.REGLOG) {
  const orig = eng.registerAotFn.bind(eng);
  eng.registerAotFn = (a, f) => {
    const tf = process.env.TRACEFN ? eng.aotFns.get(BigInt(process.env.TRACEFN)) : null;
    console.log(`  [reg] 0x${a.toString(16)}${f === tf && tf ? '  <- ALIAS of traced fn' : ''}${f && f.jsStub ? ' (jsStub)' : ''}`);
    return orig(a, f);
  };
}

// BIGMMAP=<bytes> - when the guest asks mmap for more than this, print the
// registers and the guest stack right there. A wrong LENGTH is computed by
// the caller, not by the string routine that returned a bad pointer, so the
// frame chain at the allocation names the code that actually went wrong -
// which the faulting address alone never does.
if (process.env.BIGMMAP) {
  const lim = BigInt(process.env.BIGMMAP);
  const orig = eng.syscall.bind(eng);
  let fired = 0;
  eng.syscall = (cpu) => {
    if (cpu.regs[0] === 9n && cpu.regs[6] >= lim && fired < 3) {
      fired++;
      console.log(`\n*** mmap(len=0x${cpu.regs[6].toString(16)} = ${BigInt.asIntN(32, cpu.regs[6])} as i32) ` +
                  `at rip 0x${cpu.rip.toString(16)} -> ${locate(eng, cpu.rip).label}`);
      for (const l of frames()) console.log('    ' + l);
    }
    return orig(cpu);
  };
  eng.cpu.onSyscall = (cpu) => eng.syscall(cpu);
}

// TRACEFN=0x... - log every JS-side dispatch of that entry: argument
// registers in, rax out, and HOW it was reached (top-level vs nested under a
// shadow's compiled side). This funnels through dispatchAot, which both the
// plain path and the shadow's compiled side call, so comparing its count
// against the shadow's tried-count answers the open question directly: are
// there executions the shadow never compared? Only in-wasm drive re-entries
// can escape this counter.
const fnTrace = [];
if (process.env.TRACEFN) {
  // Trace by the WASM FUNCTION's identity, not by the entry rip. A PLT stub
  // in another image aliases to the same compiled function and dispatches at
  // the STUB's rip - filtering on rip missed every aliased entry, and a
  // shadow scoped to libc's address range missed the aliases living in
  // python3. Function identity catches them all; the rip column then shows
  // which door each call came through.
  const target = BigInt(process.env.TRACEFN);
  const orig = eng.dispatchAot.bind(eng);
  eng.dispatchAot = (f) => {
    const tf = eng.aotFns.get(target);
    const hit = f === tf || (f && f.jsStub && eng.cpu.rip !== target);
    if (!tf || !hit) return orig(f);
    const r = eng.cpu.regs;
    const rec = { rip: eng.cpu.rip, rdi: r[7], rsi: r[6], rdx: r[2], rcx: r[1],
                  nested: !!eng._shadowBusy };
    const exit = orig(f);
    rec.out = eng.cpu.regs[0]; rec.exit = exit;
    if (fnTrace.length < 200000) fnTrace.push(rec);
    return exit;
  };
}

let err = null;
try { let g = 0; while (eng.exitCode === null) { eng.run(5e6); if (eng.blocked) eng.wake();
        if (++g > 40000) { err = 'no exit'; break; } } }
catch (e) { err = e.message; }

console.log(`fault: ${err} @rip 0x${eng.cpu.rip.toString(16)} after ${eng.stats.interpreted} interpreted insns`);
// stderr matters as much as stdout here: a guest that exits 1 silently on
// stdout has usually said why on fd 2, and reporting only the fault address
// is what once turned "CPython prints 42" into "CPython faults at startup".
const errTxt = (eng.stderr || []).join('').trim();
if (errTxt) console.log('  guest stderr: ' + errTxt.slice(0, 400).replace(/\n/g, '\n                '));
console.log(`  exit=${eng.exitCode} stdout=${(eng.stdoutBytes||[]).reduce((a,b)=>a+b.length,0)}B` +
            (assembleWat ? ` aotFns=${eng.aotFns.size}` : ' (pure interpreter)'));
const at = locate(eng, eng.cpu.rip);
console.log(`  rip -> ${at.label}`);
const RN = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi',
            'r8','r9','r10','r11','r12','r13','r14','r15'];
for (let i = 0; i < 16; i += 4)
  console.log('  ' + RN.slice(i, i+4).map((n,j)=>
    `${n}=0x${eng.cpu.regs[i+j].toString(16)}`.padEnd(24)).join(''));

// Disassemble a window around the faulting rip straight out of guest memory,
// so a wrong instruction is read rather than guessed at.
if (at.path) {
  const lo = eng.cpu.rip - 48n, buf = Buffer.alloc(112);
  try {
    for (let i = 0; i < 112; i++) buf[i] = Number(eng.mem.read(lo + BigInt(i), 1n));
    const f = `/tmp/gf_dis_${process.pid}.bin`; writeFileSync(f, buf);
    const dis = execFileSync('bash', ['-c',
      `objdump -D -b binary -m i386:x86-64 --adjust-vma=0x${lo.toString(16)} ${f} 2>/dev/null | tail -n +8`],
      { encoding: 'utf8' });
    console.log('\n  around the fault (objdump, from guest memory):');
    for (const l of dis.split('\n')) {
      if (!l.trim()) continue;
      const isRip = l.includes(eng.cpu.rip.toString(16) + ':');
      console.log(`   ${isRip ? '>>' : '  '} ${l.trim()}`);
    }
    unlinkSync(f);
  } catch (e) { console.log('  (disassembly unavailable:', e.message + ')'); }
}

// DUMP=r13,8 or DUMP=0x1b29280,8 - qwords around an address at fault time.
// Whether a bad ob_type means the OBJECT was corrupted or the POINTER to it
// was off is not decidable from registers alone; the neighbouring words say
// which.
for (const spec of (process.env.DUMP || '').split(';').filter(Boolean)) {
  const [where, nS] = spec.split(',');
  const n = Number(nS || 8);
  const ri = RN.indexOf(where.trim());
  let addr; try { addr = ri >= 0 ? eng.cpu.regs[ri] : BigInt(where.trim()); } catch { continue; }
  console.log(`\n  memory at ${where.trim()} = 0x${addr.toString(16)}:`);
  for (let i = -2; i < n; i++) {
    const a = addr + BigInt(i * 8);
    let v; try { v = eng.mem.read(a, 8n); } catch { console.log(`   +${i*8}  <unreadable>`); continue; }
    const l = locate(eng, v);
    console.log(`   ${(i*8 >= 0 ? '+' : '') + (i*8)}`.padEnd(8) +
                `0x${a.toString(16)}  =  0x${v.toString(16)}`.padEnd(40) +
                (l.path ? l.label : ''));
  }
}

if (process.env.REGWRAP && process.env.TRACEFN) {
  const bad = wrapLog.filter(t => t.bad);
  console.log(`\n  wrapped calls of ${process.env.TRACEFN}: ${wrapLog.length}, MISMATCHES: ${bad.length}`);
  for (const t of bad.slice(0, 8))
    console.log(`   BAD rdi=0x${t.rdi.toString(16)} rsi=0x${t.rsi.toString(16)} rdx=0x${t.rdx.toString(16)}` +
                ` -> rax=0x${t.rax.toString(16)} expected 0x${t.expect.toString(16)}`);
  for (const t of wrapLog.slice(-5))
    console.log(`   last rdi=0x${t.rdi.toString(16)} rsi=0x${t.rsi.toString(16)} rdx=0x${t.rdx.toString(16)}` +
                ` -> rax=0x${t.rax.toString(16)}${t.expect !== null ? ` (exp 0x${t.expect.toString(16)})` : ''}`);
}

if (process.env.TRACEFN) {
  const nested = fnTrace.filter(t => t.nested).length;
  console.log(`\n  dispatches of ${process.env.TRACEFN}: ${fnTrace.length} via dispatchAot ` +
              `(${nested} nested under a shadow)` +
              (eng._shadowStats ? `; shadow tried=${eng._shadowStats.tried}` : ''));
  const doors = new Map();
  for (const t of fnTrace) { const k = t.rip.toString(16); doors.set(k, (doors.get(k) || 0) + 1); }
  console.log('  entry rips: ' + [...doors].map(([k, n]) => `0x${k} x${n}`).join('  '));
  // the interesting ones: a reverse search returning a pointer BELOW the
  // haystack makes the caller's p - start negative
  const bad = fnTrace.filter(t => t.out !== 0n && t.out < t.rdi);
  console.log(`  results below rdi (suspect for p - start < 0): ${bad.length}`);
  for (const t of fnTrace.slice(-10))
    console.log(`   rdi=0x${t.rdi.toString(16)} rsi=0x${t.rsi.toString(16)} rdx=0x${t.rdx.toString(16)}` +
                ` -> rax=0x${t.out.toString(16)}${t.nested ? '  [nested]' : ''}`);
}

if (process.env.WATCH) {
  console.log(`\n  writes to ${process.env.WATCH}: ${watchLog.length}`);
  const show = watchLog.slice(-Number(process.env.WATCHN || 30));
  if (watchLog.length > show.length) console.log(`   (last ${show.length})`);
  for (const [rip, addr, n, v, ic, str] of show)
    console.log(`   @${String(ic).padStart(10)}  0x${addr.toString(16)} <- ${n}B 0x${v.toString(16)}`.padEnd(52) +
                `from ${locate(eng, rip).label}` + (str ? `   str="${str}"` : ''));
}

console.log('\n  frame chain (rbp walk):');
for (const l of frames()) console.log('   ' + l);
