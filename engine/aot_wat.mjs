// oxwasm M3 — AOT whole-function translator, x86-64 machine code -> WAT.
// Recovers the function CFG and emits ONE wasm function: all 16 GPRs in
// i64 locals for the function's lifetime, any control flow via the
// universal br_table dispatch loop, lazy flags (a flag op stashes inputs,
// the consuming jcc recomputes just the needed bit). Input is unmodified
// compiled machine code. Text backend, assembled by wat2wasm.
import { decode } from './decode.mjs';

const MASK = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
const SIGN = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };

// Global function-dispatch map, shared by ALL translation units of an engine:
// a sorted array of (guest address i64, funcref-table index i32, pad) 16-byte
// entries living in wasm-memory scratch below the guest RAM base (RAMOFF is
// 1MB; the regfile ends at 512). The engine appends an entry per registered
// compiled function; every unit's $ftr does an in-wasm binary search here and
// call_indirect's through the shared imported table — so indirect calls,
// cross-unit static calls, and indirect tail jumps chain wasm-to-wasm with no
// JS boundary and no regfile sync. A miss falls back to x_callout / x_deopt.
export const FTMAP = 0x10000;        // u32 count at +0, u32 chain depth at +8, entries at +16
export const FTMAP_MAX = 61000;      // entries: stays well below RAMOFF
// Wasm calls nest real host-stack frames, so unlike native calls they can
// blow the ~1MB stack under deep guest recursion — and a frame's size grows
// with the FUNCTION's size (V8 spill slots), so post-jump-table units (one
// giant function for a computed-goto interpreter) cost kilobytes per frame.
// Accounting is therefore WEIGHTED and callee-side: every unit function
// bumps the depth word at entry by ~its insn count / 512 (min 1) and drops
// it on every normal exit; unwinds are repaired because the engine's JS
// chain hops save/restore the word around f() and dispatchAot resets it at
// each top-level entry. Every call site — direct in-unit calls included —
// checks the budget first and takes its JS fallback past it; the engine's
// callout then INTERPRETS the callee (thin JS frames, any depth), so the
// worst case is the pre-chaining regime, bounded. Exported for linux.mjs.
export const FTDEPTH = FTMAP + 8, FTDLIMIT = 1200;
// Chain fuel (u32 at FTMAP+12): in-wasm chains bypass the JS callout's
// slice-deadline check, so a browser pump's 12ms slice could disappear into
// one unpreemptible multi-second wasm block. Every in-wasm chain site burns
// one fuel; at zero the site takes its x_callout fallback, whose entry
// checks the wall clock (unwinding the slice if it's over) and re-arms the
// fuel — so hot chains pay one JS hop per tankful, and a deadline is never
// more than a tankful away. dispatchAot fills the tank per dispatch from
// eng.chainFuel (hosts without deadlines leave it effectively unlimited).
export const FTFUEL = FTMAP + 12;

export function compileFunctionWatDispatch(mem, entry, { guestBase, ramBase, maxInsns = 8000 } = {}) {
  // ---- decode reachable code ----
  const insnAt = new Map(); const work = [entry]; const seen = new Set(); let count = 0;
  while (work.length) {
    const rip = work.pop(); const key = rip.toString();
    if (seen.has(key)) continue; seen.add(key);
    if (count++ > maxInsns) throw new Error('function too large');
    const insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip);
    insn.rip = rip; insn.next = rip + BigInt(insn.len); insnAt.set(key, insn);
    if (insn.mnem === 'ret' || insn.mnem === 'retn' || insn.mnem === 'leave') continue;
    if (insn.mnem === 'jmp') { work.push((insn.next + insn.rel) & MASK[8]); continue; }
    if (insn.mnem === 'jcc') { work.push((insn.next + insn.rel) & MASK[8]); work.push(insn.next); continue; }
    if (['jmpind','callind','call','syscall'].includes(insn.mnem)) throw new Error('AOT: control leaves function: ' + insn.mnem);
    work.push(insn.next);
  }
  const addrs = [...insnAt.keys()].map(BigInt).sort((a,b)=>a<b?-1:1);
  const leaders = new Set([entry.toString()]);
  for (const a of addrs) { const insn = insnAt.get(a.toString());
    if (insn.mnem === 'jcc') { leaders.add(((insn.next+insn.rel)&MASK[8]).toString()); leaders.add(insn.next.toString()); }
    if (insn.mnem === 'jmp') leaders.add(((insn.next+insn.rel)&MASK[8]).toString()); }
  const blocks = []; let cur = null;
  for (const a of addrs) { if (leaders.has(a.toString())) { cur = { start: a, insns: [] }; blocks.push(cur); } cur.insns.push(insnAt.get(a.toString())); }
  const bidx = new Map(blocks.map((b,i)=>[b.start.toString(), i])); const N = blocks.length;

  // ---- WAT emit ----
  const K32 = (guestAddr) => Number(BigInt.asIntN(32, guestAddr - guestBase + BigInt(ramBase)));   // guest -> wasm offset const
  const hexs = (v) => { v = BigInt.asIntN(64, v); return v.toString(); };
  let tmpN = 0; const tmps = new Set();
  const T = () => { const n = '$t' + (tmpN++); tmps.add(n); return n; };

  const reg = (r) => '$r' + r;
  // guest ADDRESS (for lea) as i64 expr
  const guestAddr = (op, next) => {
    if (op.ripRel) return `(i64.const ${hexs(next + op.disp)})`;
    let e = `(i64.const ${hexs(op.disp)})`;
    if (op.base >= 0) e = `(i64.add ${e} (local.get ${reg(op.base)}))`;
    if (op.index >= 0) { let ix = `(local.get ${reg(op.index)})`;
      if (op.scale > 1) ix = `(i64.shl ${ix} (i64.const ${Math.log2(op.scale)}))`;
      e = `(i64.add ${e} ${ix})`; }
    return e;
  };
  // wasm OFFSET (i32) for a memory access
  const wasmAddr = (op, next) => `(i32.add (i32.wrap_i64 ${op.ripRel ? `(i64.const ${hexs(next+op.disp)})` : guestAddr(op,next)}) (i32.const 0))`
                                  .replace('(i32.const 0)', `(i32.const ${Number(BigInt.asIntN(32, -guestBase + BigInt(ramBase)))})`);
  const LD = { 1:'i64.load8_u', 2:'i64.load16_u', 4:'i64.load32_u', 8:'i64.load' };
  const ST = { 1:'i64.store8', 2:'i64.store16', 4:'i64.store32', 8:'i64.store' };

  // read operand -> i64 expr (zero-extended to size)
  const rd = (op, size, next) => {
    // immediates are decoded sign-extended; mask to the operand width like
    // any other read — an unmasked 0xFF..86 poisons unsigned flag compares
    // (cmp $0x86,%dl + ja indexed a jump table out of range)
    if (op.kind === 'imm') return `(i64.const ${hexs(BigInt.asUintN((size || 8) * 8, op.v))})`;
    if (op.kind === 'reg') { let e = `(local.get ${reg(op.r)})`;
      if (op.high) e = `(i64.shr_u ${e} (i64.const 8))`;
      return size === 8 && !op.high ? e : `(i64.and ${e} (i64.const ${MASK[size]}))`; }
    return `(${LD[size]} ${wasmAddr(op, next)})`;
  };
  // write i64 expr to operand
  const wr = (op, size, expr, next) => {
    if (op.kind === 'reg') {
      if (isI32(op.r)) {
        if (size >= 4) return `(local.set ${reg(op.r)} (i32.wrap_i64 ${expr}))`;
        const m = MASKl[size];
        if (op.high) return `(local.set ${reg(op.r)} (i32.or (i32.and (local.get ${reg(op.r)}) (i32.const 0xFFFF00FF)) (i32.shl (i32.and (i32.wrap_i64 ${expr}) (i32.const 0xFF)) (i32.const 8))))`;
        return `(local.set ${reg(op.r)} (i32.or (i32.and (local.get ${reg(op.r)}) (i32.const ${Number((~m)&0xFFFFFFFFn)})) (i32.and (i32.wrap_i64 ${expr}) (i32.const ${Number(m)}))))`;
      }
      if (size === 8) return `(local.set ${reg(op.r)} ${expr})`;
      if (size === 4) return `(local.set ${reg(op.r)} (i64.and ${expr} (i64.const 0xFFFFFFFF)))`;
      const m = MASK[size];
      if (op.high) return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~0xFF00n)&MASK[8]})) (i64.shl (i64.and ${expr} (i64.const 0xFF)) (i64.const 8))))`;
      return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~m)&MASK[8]})) (i64.and ${expr} (i64.const ${m}))))`;
    }
    return `(${ST[size]} ${wasmAddr(op, next)} ${expr})`;
  };

  const ALU = { add:'i64.add', sub:'i64.sub', and:'i64.and', or:'i64.or', xor:'i64.xor' };
  const ALU32 = { add:'i32.add', sub:'i32.sub', and:'i32.and', or:'i32.or', xor:'i32.xor' };
  const LD32 = { 1:'i32.load8_u', 2:'i32.load16_u', 4:'i32.load' };
  // operand as an i32 value (for 32-bit arithmetic)
  const rd32 = (op, next) => {
    if (op.kind === 'imm') return `(i32.const ${Number(BigInt.asIntN(32, op.v))})`;
    if (op.kind === 'reg') { if (isI32(op.r) && !op.high) return `(local.get ${reg(op.r)})`;
      let e = `(local.get ${reg(op.r)})`; if (op.high) e = `(i64.shr_u ${e} (i64.const 8))`; return `(i32.wrap_i64 ${e})`; }
    return `(${LD32[op.size]||'i32.load'} ${wasmAddr(op, next)})`;
  };
  // write an i32 expr to a register (zero-extends the full 64-bit local)
  const wr32reg = (r, e32) => isI32(r) ? `(local.set ${reg(r)} ${e32})` : `(local.set ${reg(r)} (i64.extend_i32_u ${e32}))`;
  let flagState = null;   // {kind, size} — set at translate time per block

  function block(blk) {
    const L = [];
    const setFlags = (kind, size, aExpr, bExpr, rExpr) => {
      if (aExpr) L.push(`(local.set $fa ${aExpr})`);
      if (bExpr) L.push(`(local.set $fb ${bExpr})`);
      L.push(`(local.set $fr ${rExpr})`);
      flagState = { kind, size };
    };
    const cond = (cc) => {
      const fs = flagState; const S = fs.size, sgn = SIGN[S];
      const a = '(local.get $fa)', b = '(local.get $fb)', r = '(local.get $fr)';
      const zf = `(i64.eqz ${r})`, nz = `(i64.ne ${r} (i64.const 0))`;
      const sf = `(i64.ne (i64.and ${r} (i64.const ${sgn})) (i64.const 0))`;
      const nsf = `(i64.eq (i64.and ${r} (i64.const ${sgn})) (i64.const 0))`;
      if (fs.kind === 'sub') switch (cc) {
        case 'e': return zf; case 'ne': return nz;
        case 'b': return `(i64.lt_u ${a} ${b})`; case 'ae': return `(i64.ge_u ${a} ${b})`;
        case 'be': return `(i64.le_u ${a} ${b})`; case 'a': return `(i64.gt_u ${a} ${b})`;
        case 'l': return `(i64.lt_s ${sx(a,S)} ${sx(b,S)})`; case 'ge': return `(i64.ge_s ${sx(a,S)} ${sx(b,S)})`;
        case 'le': return `(i64.le_s ${sx(a,S)} ${sx(b,S)})`; case 'g': return `(i64.gt_s ${sx(a,S)} ${sx(b,S)})`;
        case 's': return sf; case 'ns': return nsf; }
      else switch (cc) {   // logic/inc/dec
        case 'e': return zf; case 'ne': return nz; case 's': return sf; case 'ns': return nsf;
        case 'le': return `(i64.le_s ${sx(r,S)} (i64.const 0))`; case 'g': return `(i64.gt_s ${sx(r,S)} (i64.const 0))`;
        case 'l': return `(i64.lt_s ${sx(r,S)} (i64.const 0))`; case 'ge': return `(i64.ge_s ${sx(r,S)} (i64.const 0))`; }
      throw new Error('cond ' + cc + '/' + fs.kind);
    };
    const sx = (e, S) => S === 8 ? e : `(i64.shr_s (i64.shl ${e} (i64.const ${64-S*8})) (i64.const ${64-S*8}))`;
    const goto = (target) => { const i = bidx.get(target.toString());
      return i === undefined ? `(local.set $label (i32.const -1)) (br $exit)` : `(local.set $label (i32.const ${i})) (br $loop)`; };

    for (const insn of blk.insns) {
      const S = insn.size || 8, m = MASK[S], next = insn.next;
      switch (insn.mnem) {
        case 'nop': break;
        case 'mov':
          if (S === 4 && insn.dst.kind === 'reg') L.push(wr32reg(insn.dst.r, rd32(insn.src, next)));
          else L.push(wr(insn.dst, S, rd(insn.src, S, next), next));
          break;
        case 'movzx': L.push(wr(insn.dst, insn.size, rd(insn.src, insn.src.size, next), next)); break;
        case 'movsx': L.push(wr(insn.dst, insn.size, sx(rd(insn.src, insn.src.size, next), insn.src.size), next)); break;
        case 'lea': {  // operand-size semantics: 32-bit lea zero-extends, 16-bit merges
          const a = guestAddr(insn.src, next);
          if (insn.size === 8) L.push(`(local.set ${reg(insn.dst.r)} ${a})`);
          else L.push(wr({ kind: 'reg', r: insn.dst.r, size: insn.size }, insn.size,
                         `(i64.and ${a} (i64.const ${(1n << BigInt(insn.size*8)) - 1n}))`, next));
          break; }
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          const t = T(); const rexpr = `(i64.and (${ALU[insn.mnem]} ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)}) (i64.const ${m}))`;
          L.push(`(local.set ${t} ${rexpr})`);
          L.push(wr(insn.dst, S, `(local.get ${t})`, next));
          if (insn.mnem === 'sub') setFlags('sub', S, rd(insn.dst,S,next), rd(insn.src,S,next), `(local.get ${t})`);
          else setFlags('logic', S, null, null, `(local.get ${t})`);
          break; }
        case 'cmp': setFlags('sub', S, rd(insn.dst,S,next), rd(insn.src,S,next),
                      `(i64.and (i64.sub ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)}) (i64.const ${m}))`); break;
        case 'test': setFlags('logic', S, null, null, `(i64.and ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)})`); break;
        case 'inc': case 'dec': { const t = T();
          L.push(`(local.set ${t} (i64.and (${insn.mnem==='inc'?'i64.add':'i64.sub'} ${rd(insn.dst,S,next)} (i64.const 1)) (i64.const ${m})))`);
          L.push(wr(insn.dst, S, `(local.get ${t})`, next));
          setFlags(insn.mnem, S, null, null, `(local.get ${t})`); break; }
        case 'not': L.push(wr(insn.dst, S, `(i64.xor ${rd(insn.dst,S,next)} (i64.const ${m}))`, next)); break;
        case 'neg': { const t = T();
          L.push(`(local.set ${t} (i64.and (i64.sub (i64.const 0) ${rd(insn.dst,S,next)}) (i64.const ${m})))`);
          L.push(wr(insn.dst, S, `(local.get ${t})`, next));
          setFlags('sub', S, '(i64.const 0)', rd(insn.dst,S,next), `(local.get ${t})`); break; }
        case 'shl': case 'shr': case 'sar': {
          const c = `(i64.and ${rd(insn.src,1,next)} (i64.const ${S===8?63:31}))`;
          let e; const a = rd(insn.dst,S,next);
          if (insn.mnem==='shl') e = `(i64.shl ${a} ${c})`;
          else if (insn.mnem==='shr') e = `(i64.shr_u ${a} ${c})`;
          else e = `(i64.shr_s ${sx(a,S)} ${c})`;
          L.push(wr(insn.dst, S, `(i64.and ${e} (i64.const ${m}))`, next)); break; }
        case 'rol': case 'ror': {
          // rotate WITHIN the operand width: i32.rotl only fits S=4; byte and
          // word rotates need the manual (v<<c | v>>(W-c)) & mask form —
          // i32-rotating a 16-bit value threw expat's BOM bytes into bits 16+
          const a = rd(insn.dst,S,next);
          const craw = `${rd(insn.src,1,next) === '(i64.const 1)' ? '(i32.const 1)' : `(i32.wrap_i64 ${rd(insn.src,1,next)})`}`;
          const rot = insn.mnem === 'rol';
          let e;
          if (S === 8) e = `(i64.${rot?'rotl':'rotr'} ${a} (i64.extend_i32_u (i32.and ${craw} (i32.const 63))))`;
          else if (S === 4) e = `(i64.extend_i32_u (i32.${rot?'rotl':'rotr'} (i32.wrap_i64 ${a}) (i32.and ${craw} (i32.const 31))))`;
          else { const W = S*8;
            const v = `(i32.wrap_i64 ${a})`, cW = `(i32.and ${craw} (i32.const ${W-1}))`;
            const fwd = rot ? 'i32.shl' : 'i32.shr_u', back = rot ? 'i32.shr_u' : 'i32.shl';
            e = `(i64.extend_i32_u (i32.and (i32.or (${fwd} ${v} ${cW}) (${back} ${v} (i32.sub (i32.const ${W}) ${cW}))) (i32.const ${m})))`; }
          L.push(wr(insn.dst, S, S===8?e:`(i64.and ${e} (i64.const ${m}))`, next)); break; }
        case 'push': L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                            `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} ${rd(insn.src,8,next)})`); break;
        case 'pop': L.push(wr(insn.dst,8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next),
                           `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`); break;
        case 'jmp': L.push(goto((next+insn.rel)&MASK[8])); break;
        case 'jcc': { const tk = bidx.get(((next+insn.rel)&MASK[8]).toString()), fl = bidx.get(next.toString());
          L.push(`(if ${cond(insn.cond)} (then (local.set $label (i32.const ${tk}))) (else (local.set $label (i32.const ${fl})))) (br $loop)`); break; }
        case 'ret': case 'retn': case 'leave':
          if (insn.mnem === 'leave') L.push(`(local.set $r4 (local.get $r5))`, `(local.set $r5 (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})) (local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          L.push(`(local.set $label (i32.const -1)) (br $exit)`); break;
        default: throw new Error('AOT: unhandled ' + insn.mnem + ' @ ' + insn.rip.toString(16));
      }
    }
    const last = blk.insns[blk.insns.length-1].mnem;
    if (!['jmp','jcc','ret','retn','leave'].includes(last)) L.push(goto(blk.insns[blk.insns.length-1].next));
    return L.join('\n      ');
  }

  const bodies = blocks.map(block);
  // build dispatch
  let wat = '(module\n  (import "js" "mem" (memory 4096))\n  (func (export "run")\n';
  for (let r = 0; r < 16; r++) wat += `    (local $r${r} i64)\n`;
  wat += '    (local $label i32)\n    (local $fa i64) (local $fb i64) (local $fr i64)\n';
  for (const t of tmps) wat += `    (local ${t} i64)\n`;
  for (let r = 0; r < 16; r++) wat += `    (local.set $r${r} (i64.load (i32.const ${r*8})))\n`;
  wat += `    (local.set $label (i32.const ${bidx.get(entry.toString())}))\n`;
  wat += '    (block $exit\n      (loop $loop\n';
  for (let i = 0; i < N; i++) wat += `        (block $B${i}\n`;
  wat += `          (br_table ${blocks.map((_,i)=>'$B'+i).join(' ')} $exit (local.get $label))\n`;
  for (let i = N-1; i >= 0; i--) wat += `        ) ;; end $B${i}\n      ${bodies[i]}\n`;
  wat += '      )\n    )\n';
  for (let r = 0; r < 16; r++) wat += `    (i64.store (i32.const ${r*8}) (local.get $r${r}))\n`;
  wat += '  )\n)\n';
  return { wat, blocks: N };
}


// ---- shared CFG analysis (decode reachable code, split into blocks) ----
// One FUNCTION at a time: `call` is a mid-block instruction (fall-through
// successor) whose target is recorded in `calls` for the unit driver;
// `leave` is a plain epilogue instruction; ret/retn/jmpind end a block.
function analyze(mem, entry, { maxInsns = 20000, noJtab = false } = {}) {
  const M = 0xFFFFFFFFFFFFFFFFn;
  const insnAt = new Map(); const work = [entry]; const seen = new Set(); let count = 0;
  const calls = new Set();
  const byNext = new Map();       // insn.next -> insn: the straight-line chain above an address
  const jmpinds = [];             // `jmp *reg` sites awaiting jump-table discovery
  const jtabs = new Map();        // jmpind rip str -> BigInt[] targets read from its table
  let lo = entry, hi = entry;     // decoded range, the plausibility window for table entries
  const drain = () => { while (work.length) {
    const rip = work.pop(); const key = rip.toString();
    if (seen.has(key)) continue; seen.add(key);
    if (count++ > maxInsns) throw new Error('function too large');
    let insn;
    try { insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip); }
    catch (e) {
      // Undecodable bytes (padding, data, an unsupported encoding) become a
      // deopt point: if control ever actually reaches it, the engine resumes
      // in the interpreter and faults exactly as native would.
      insnAt.set(key, { mnem: 'udec', rip, next: rip + 1n, len: 1 });
      continue;
    }
    // Two kinds of instruction escape to the interpreter via a deopt point
    // rather than poisoning the whole function:
    //  - trap padding (hlt/ud2/int3): almost always unreachable bytes the
    //    analyzer walks into after a noreturn call (the `hlt` after
    //    `call __libc_start_main` in _start); if truly reached, the
    //    interpreter traps exactly as native would.
    //  - rare, cold instructions we don't translate but the interpreter models
    //    fully (cpuid — glibc's one-time ISA probe; fxsave/fxrstor and the
    //    mxcsr accesses — signal/setjmp-adjacent state save paths): deopt
    //    runs them and the frame's remainder in the interpreter, then returns.
    //  - x87 instructions (the decoder lumps them under one mnem): units
    //    never model the FPU stack — it lives solely in the interpreter's
    //    CPU state, which syncOut/syncIn do not touch, so escaping at every
    //    x87 instruction keeps that state exact while the integer/SSE parts
    //    of the same function still compile (strtod, printf float paths).
    if (['hlt','ud2','int3','int','cpuid','fxsave','fxrstor','stmxcsr','ldmxcsr','x87'].includes(insn.mnem)) {
      insnAt.set(key, { mnem: 'udec', rip, next: rip + BigInt(insn.len), len: insn.len });
      continue;
    }
    insn.rip = rip; insn.next = rip + BigInt(insn.len); insnAt.set(key, insn);
    byNext.set(insn.next.toString(), insn);
    if (rip < lo) lo = rip; if (rip > hi) hi = rip;
    if (insn.mnem === 'ret' || insn.mnem === 'retn') continue;
    if (insn.mnem === 'jmpind') {
      // discoverable forms: `jmp *R` (table load traced upward) and
      // `jmp *table(,%idx,8)` (table named right in the operand)
      if (!noJtab && (insn.src?.kind === 'reg'
          || (insn.src?.kind === 'mem' && insn.src.base < 0 && insn.src.index >= 0
              && insn.src.scale === 8 && !insn.src.ripRel && !insn.src.fs))) jmpinds.push(insn);
      continue;
    }
    if (insn.mnem === 'jmp') { work.push((insn.next + insn.rel) & M); continue; }
    if (insn.mnem === 'jcc') { work.push((insn.next + insn.rel) & M); work.push(insn.next); continue; }
    if (insn.mnem === 'call') calls.add(((insn.next + insn.rel) & M).toString());
    work.push(insn.next);
  } };
  drain();
  // ---- jump-table discovery (computed goto / switch dispatch) --------------
  // For each `jmp *R`, walk the straight-line chain of instructions laid out
  // immediately above it to find R's defining load `mov R,[B+idx*8]`, then
  // B's defining `lea B,[rip+d]` / absolute address. Reading the table from
  // GUEST memory at translation time yields post-relocation runtime addresses.
  // The chain walk is a heuristic (address order, not dominance) — that's
  // safe: discovery only decides which addresses get DECODED as blocks; at
  // runtime the resolver matches the actual computed address exactly and
  // anything unknown still deopts, so a wrong match can only waste space.
  const wrReg = (p, r) => p.dst && p.dst.kind === 'reg' && p.dst.r === r
    && !['cmp','test','bt'].includes(p.mnem);
  const defAbove = (from, r) => { let cur = from;
    for (let s = 0; s < 16; s++) {
      const p = byNext.get(cur.rip.toString());
      if (!p || p.mnem === 'udec') return null;
      if (wrReg(p, r)) return p;
      cur = p;
    } return null; };
  const tableOf = (j) => {
    if (j.src.kind === 'mem') return BigInt.asUintN(64, j.src.disp);
    const ld = defAbove(j, j.src.r);
    if (!ld || ld.mnem !== 'mov' || (ld.size||8) !== 8 || ld.src.kind !== 'mem'
        || ld.src.scale !== 8 || ld.src.index < 0 || ld.src.fs) return null;
    if (ld.src.base < 0) return ld.src.ripRel ? null : BigInt.asUintN(64, ld.src.disp);
    const lb = defAbove(ld, ld.src.base);
    if (!lb) return null;
    if (lb.mnem === 'lea' && lb.src.kind === 'mem' && lb.src.index < 0 && (lb.src.ripRel || lb.src.base < 0))
      return BigInt.asUintN(64, lb.src.disp + (lb.src.ripRel ? lb.next : 0n));
    if (lb.mnem === 'mov' && lb.src.kind === 'imm') return BigInt.asUintN(64, lb.src.v);
    return null;
  };
  let dbudget = 4096;             // total discovered targets across the function
  while (jmpinds.length && dbudget > 0) {
    const j = jmpinds.shift();
    const tbl = tableOf(j);
    if (tbl == null) continue;
    const targets = [];
    const min = lo > 0x100000n ? lo - 0x100000n : 0n, max = hi + 0x100000n;
    for (let i = 0; i < 1024; i++) {
      let t; try { t = mem.read((tbl + BigInt(i * 8)) & M, 8n); } catch { break; }
      if (t < min || t > max) break;   // first out-of-range entry = end of table
      targets.push(t);
    }
    if (targets.length < 2) continue;
    jtabs.set(j.rip.toString(), targets);
    for (const t of targets) if (!seen.has(t.toString()) && dbudget > 0) { dbudget--; work.push(t); }
    drain();                      // newly decoded handlers may end in more jmpinds
  }
  const addrs = [...insnAt.keys()].map(BigInt).sort((a,b)=>a<b?-1:1);
  const leaders = new Set([entry.toString()]);
  for (const a of addrs) { const insn = insnAt.get(a.toString());
    if (insn.mnem === 'jcc') { leaders.add(((insn.next+insn.rel)&M).toString()); leaders.add(insn.next.toString()); }
    if (insn.mnem === 'jmp') leaders.add(((insn.next+insn.rel)&M).toString()); }
  for (const [, ts] of jtabs) for (const t of ts) leaders.add(t.toString());
  const blocks = []; let cur = null;
  for (const a of addrs) { if (leaders.has(a.toString())) { cur = { start: a, insns: [] }; blocks.push(cur); } cur.insns.push(insnAt.get(a.toString())); }
  const bidx = new Map(blocks.map((b,i)=>[b.start.toString(), i]));
  return { blocks, bidx, M, calls, jtabs };
}

// ---- Stackifier: turn a reducible CFG into nested wasm loop/block scopes ----
// Returns { open:[[scope,...] per block], closeAfter:[[label,...] per block] }
// where scopes carry {type:'loop'|'block', label}. Throws on irreducible CFG.
function structure(N, succs) {
  // back edge i->j (j<=i): j is a loop header
  const loopEnd = new Map();  // header -> exclusive end index
  for (let i=0;i<N;i++) for (const j of succs[i]) if (j>=0 && j<=i)
    loopEnd.set(j, Math.max(loopEnd.get(j)||0, i+1));
  // forward branch to j (j>i+1, or j>i via jmp/jcc-taken not fallthrough): block scope ending at j
  const blkBegin = new Map(); // target -> min predecessor index
  for (let i=0;i<N;i++) for (const j of succs[i]) if (j>=0 && j>i+1)
    blkBegin.set(j, Math.min(blkBegin.has(j)?blkBegin.get(j):i, i));
  const scopes = [];
  for (const [h,e] of loopEnd)  scopes.push({ type:'loop',  b:h, e, label:'$loop_'+h });
  for (const [t,b] of blkBegin) scopes.push({ type:'block', b, e:t, label:'$blk_'+t });
  // Fix improper overlaps b1<b2<e1<e2 into proper nesting. A block scope's
  // END is its branch target (immovable); a loop scope's BEGIN is its header
  // (immovable). So widen only the movable side: grow a loop's end, or grow a
  // block's begin. If neither is movable, the CFG needs the dispatch fallback.
  let changed = true, guard = 0;
  while (changed) { changed = false;
    if (guard++ > 10000) throw new Error('AOT: scope nesting did not converge');
    for (const s of scopes) for (const t of scopes) {
      if (!(s.b < t.b && t.b < s.e && s.e < t.e)) continue;
      // Prefer growing a BLOCK's begin backward (always valid, and it never
      // engulfs a loop-exit target the way growing a loop's end would).
      if (t.type === 'block')      { t.b = s.b; changed = true; }    // grow later block's begin back
      else if (s.type === 'loop')  { s.e = t.e; changed = true; }    // grow earlier loop's end fwd
      else throw new Error('AOT: block/loop overlap needs dispatch fallback');
    }
  }
  // opening order at a position: larger range (outer) first
  const open = Array.from({length:N}, ()=>[]);
  const closeAfter = Array.from({length:N}, ()=>[]);
  const byBegin = Array.from({length:N}, ()=>[]);
  for (const s of scopes) byBegin[s.b].push(s);
  for (let i=0;i<N;i++) byBegin[i].sort((a,b)=> (b.e-a.e) || (a.type==='loop'?-1:1));
  // simulate a scope stack to record close points and validate nesting
  const stack = [];
  for (let i=0;i<N;i++) {
    for (const s of byBegin[i]) { open[i].push(s); stack.push(s); }
    while (stack.length && stack[stack.length-1].e === i+1) { closeAfter[i].push(stack.pop().label); }
  }
  if (stack.length) throw new Error('AOT: irreducible/unclosed scopes');
  return { open, closeAfter };
}

// ---- whole-program unit translator ----------------------------------------
// A translation unit is the call-graph closure of an entry function. Every
// guest function becomes one wasm function `(func $f_<hex> (result i64))`
// returning the frame-exit rip. The 128-byte register file at offset 0 is the
// inter-function ABI: a caller spills its locals before a call and reloads
// after; a callee loads at entry and spills at exit. The guest stack stays
// byte-exact (calls push return addresses, rets pop them), so the program
// cannot observe the translation. Three escapes make it total over any code:
//   env.syscall()              engine services a syscall from the regfile
//   env.callout(target)->rip   run code outside the unit (indirect targets,
//                              poisoned or over-budget callees) to completion
//   env.deopt(rip,rsp0)->rip   resume interpretation inside this frame until
//                              the frame exits (rsp rises above rsp0) — jmpind
function emitUnitFunction(a0, fnAddr, ctx) {
  const { guestBase, ramBase, canDirect } = ctx;
  const MM = a0.M;
  // successors (by address-order index) for each block
  const succAddrIdx = (i) => {
    const insns = a0.blocks[i].insns, last = insns[insns.length-1], next = last.next;
    const idx = (addr) => a0.bidx.has(addr.toString()) ? a0.bidx.get(addr.toString()) : -1;
    if (last.mnem === 'jcc') return [idx((next+last.rel)&MM), idx(next)];
    if (last.mnem === 'jmp') return [idx((next+last.rel)&MM)];
    if (last.mnem === 'jmpind') {
      const ts = a0.jtabs?.get(last.rip.toString());
      return ts ? ts.map(idx).filter(v => v >= 0) : [];
    }
    if (['ret','retn'].includes(last.mnem)) return [];
    return [idx(next)];
  };
  // reverse postorder from the ENTRY block — which is NOT necessarily the
  // lowest address: a unit rooted at a loop head can decode blocks below it.
  const An = a0.blocks.length; const order = []; const vis = new Uint8Array(An);
  const entryIdx = a0.bidx.get(fnAddr.toString());
  if (entryIdx === undefined) throw new Error('AOT: entry not a block leader');
  (function dfs(u) { vis[u] = 1;
    for (const v of succAddrIdx(u)) if (v >= 0 && !vis[v]) dfs(v);
    order.push(u);
  })(entryIdx);
  order.reverse();                                  // RPO in address-index space
  const rpoOf = new Array(An).fill(-1);
  order.forEach((addrIdx, r) => rpoOf[addrIdx] = r);
  const blocks = order.map(ai => a0.blocks[ai]);    // blocks laid out in RPO
  const N = blocks.length;
  const bidx = new Map(blocks.map((b,i)=>[b.start.toString(), i]));
  const MASKl = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
  const SIGNl = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };
  const andmask = (e, S) => S === 8 ? e : `(i64.and ${e} (i64.const ${MASKl[S]}))`;   // truncate to width; full 64 is a no-op

  // terminator descriptor + successors, all in RPO index space
  const term = [], succs = [];
  const idxOf = (addr) => bidx.has(addr.toString()) ? bidx.get(addr.toString()) : -1;
  // Jump-table resolution set: the union of every discovered table's in-unit
  // targets. One shared per-function resolver maps a computed address to its
  // RPO index; any jtab site can therefore land on any union member at
  // runtime, so every jtab site lists the whole union as successors — that
  // makes the cross-block flag analysis model exactly the edges the resolver
  // can take.
  const jtabUnion = new Set();
  if (a0.jtabs) for (const [, ts] of a0.jtabs) for (const t of ts) { const j = idxOf(t); if (j >= 0) jtabUnion.add(j); }
  const hasJtab = jtabUnion.size > 0;
  let hasDeopt = false;
  for (let i=0;i<N;i++) {
    const insns = blocks[i].insns, last = insns[insns.length-1], next = last.next;
    if (last.mnem === 'jcc') { const ta = (next+last.rel)&MM, fa = next, t = idxOf(ta), f = idxOf(fa);
      if (t < 0 || f < 0) hasDeopt = true;
      term.push({kind:'jcc', t, f, ta, fa}); succs.push([t, f]); }
    else if (last.mnem === 'jmp') { const ta = (next+last.rel)&MM, t = idxOf(ta);
      if (t < 0) hasDeopt = true;
      term.push({kind:'jmp', t, ta}); succs.push([t]); }
    else if (last.mnem === 'ret' || last.mnem === 'retn') { term.push({kind:'ret', pad: last.mnem==='retn' ? Number(last.n) : 0}); succs.push([]); }
    else if (last.mnem === 'jmpind') { hasDeopt = true;
      if (hasJtab && a0.jtabs.has(last.rip.toString())) { term.push({kind:'jtab', src:last.src}); succs.push([...jtabUnion]); }
      else { term.push({kind:'deopt', src:last.src}); succs.push([]); } }
    else if (last.mnem === 'udec')   { hasDeopt = true; term.push({kind:'deopt', src:null, at:last.rip}); succs.push([]); }
    else { const t = idxOf(next); if (t < 0) hasDeopt = true;
      term.push({kind:'fall', t, ta: next}); succs.push([t]); }
  }
  // Try the structured (scope-nesting) layout first — it yields tight wasm
  // loops. If the CFG is irreducible / has improper block-loop overlap, fall
  // back to a flat br_table dispatch loop (a relooper), which handles ANY CFG
  // at the cost of an indirect branch per non-fallthrough edge. Either way the
  // function compiles instead of poisoning the whole unit.
  // The dispatch (br_table) fallback is ON by default. The historical
  // miscompile that kept it gated (a counted loop in glibc's ctype init
  // hanging) was the unmasked-immediate flag bug: cmp imm8 on a sub-width
  // register compared against the sign-extended 64-bit value, so unsigned
  // jcc took the wrong side — fixed in rd(), regression-tested by
  // subwidthtest. Set globalThis.__disableDispatch to poison irreducible
  // CFGs back to the interpreter (see diff/disptest.mjs).
  let mode = 'structured', open = null, closeAfter = null;
  // A resolved jump table needs the dispatch loop's $pc/$L_disp machinery
  // (and its edge fan-in is irreducible anyway): go straight to dispatch.
  if (hasJtab) mode = 'dispatch';
  else try { ({ open, closeAfter } = structure(N, succs)); }
  catch (e) {
    if (!/overlap|irreducible|unclosed|converge/.test(e.message) || globalThis.__disableDispatch) throw e;
    // bisect aid: every dispatch-mode unit gets a global ordinal; a filter
    // can veto (unit poisons instead — interpreted, correct, uncompiled)
    const n = (globalThis.__dispN = (globalThis.__dispN || 0) + 1);
    if (globalThis.__dispFilter && !globalThis.__dispFilter(n, entry)) throw e;
    mode = 'dispatch';
  }
  const DISP = mode === 'dispatch';

  // Width inference. A register may live in an i32 local only when every
  // access is 32-bit-or-less AND it is written at least once here — a register
  // merely passed through (or only read) must keep its full caller value for
  // spills at calls and at exit, so it stays i64. A frame containing a deopt
  // point keeps everything i64: the interpreter needs exact 64-bit state and
  // an unwritten-yet i32 local would have already dropped the caller's high
  // half at entry.
  const any64 = new Array(16).fill(false), w32 = new Array(16).fill(false), seenR = new Array(16).fill(false);
  any64[4] = seenR[4] = true;                                        // rsp
  const noteRW = (op, isWrite) => { if (!op) return;
    if (op.kind === 'reg') { seenR[op.r] = true;
      // sub-word (byte/word) access needs the full 64-bit value for the
      // partial-write merge — an i32 local would drop the caller's high bits
      if ((op.size||8) === 8 || op.high || (op.size||8) < 4) any64[op.r] = true;
      else if (isWrite) w32[op.r] = true; }
    if (op.kind === 'mem') { if (op.base>=0) { seenR[op.base]=true; any64[op.base]=true; } if (op.index>=0) { seenR[op.index]=true; any64[op.index]=true; } } };
  const WRITES_DST = new Set(['mov','movzx','movsx','add','sub','and','or','xor','adc','sbb','inc','dec','not','neg','shl','shr','sar','rol','ror','cmov','setcc','imul2','imul3','xchg','bswap','bts','btr','btc','shld','shrd']);
  // SSE ops that name a GPR (not xmm) via xr or rm — see sseXrIsGpr/sseRmIsGpr below
  const sseGprXr = (insn) => [0x2C, 0x2D, 0xD7, 0x50].includes(insn.op);
  const sseGprRm = (insn) => insn.op === 0x6E || insn.op === 0x2A || (insn.op === 0x7E && !insn.pF3);
  for (const b of blocks) for (const insn of b.insns) {
    const S = insn.size || 8;
    switch (insn.mnem) {
      case 'push': noteRW(insn.src && insn.src.kind==='mem' ? insn.src : null, false); break;   // reg push/pop go via regfile
      case 'pop':  noteRW(insn.dst && insn.dst.kind==='mem' ? insn.dst : null, true); break;
      case 'lea':  seenR[insn.dst.r]=true; any64[insn.dst.r]=true; noteRW(insn.src, false); break;
      case 'call': case 'leave': case 'ret': case 'retn': break;
      case 'callind': case 'jmpind': noteRW(insn.src, false); break;
      case 'syscall': for (const r of [0,7,6,2,10,8,9]) { seenR[r]=true; any64[r]=true; } break;
      case 'div1': case 'idiv1': case 'mul1': case 'imul1':
        for (const r of (S===1 ? [0] : [0,2])) { seenR[r]=true; if (S===8) any64[r]=true; else w32[r]=true; }
        noteRW(insn.src, false); break;
      case 'xchg': noteRW(insn.dst, true); noteRW(insn.src, true); break;   // both operands written
      case 'cmpxchg': noteRW(insn.dst, false); noteRW(insn.src, false);
        // dst is only written on SUCCESS — an unwritten 32-bit dst must still
        // carry the caller's full value through, so it can't be an i32 local
        if (insn.dst.kind === 'reg') { seenR[insn.dst.r] = true; any64[insn.dst.r] = true; }
        seenR[0] = true; any64[0] = true; break;                            // implicit accumulator
      case 'xadd': noteRW(insn.dst, true); noteRW(insn.src, true); break;
      case 'rdtsc': seenR[0] = true; seenR[2] = true; any64[0] = true; any64[2] = true; break;
      case 'cwde': case 'cdq': { const r = insn.mnem==='cdq' ? 2 : 0; seenR[0]=true; seenR[r]=true;
        if (S===8) { any64[0]=true; any64[r]=true; } else w32[r]=true; break; }
      case 'stos': { seenR[7]=true; any64[7]=true; seenR[0]=true; any64[0]=true;
        if (insn.rep) { seenR[1]=true; any64[1]=true; } break; }
      case 'movs': { seenR[6]=true; any64[6]=true; seenR[7]=true; any64[7]=true;
        if (insn.rep) { seenR[1]=true; any64[1]=true; } break; }
      case 'cmps': case 'scas': {
        if (insn.mnem === 'cmps') { seenR[6]=true; any64[6]=true; } else { seenR[0]=true; any64[0]=true; }
        seenR[7]=true; any64[7]=true;
        if (insn.rep || insn.rep2) { seenR[1]=true; any64[1]=true; } break; }
      case 'cld': case 'std': break;
      case 'sse': {   // mark only the GPR side; xmm registers live in v128 locals
        const mark = (r) => { seenR[r]=true; any64[r]=true; };
        if (sseGprXr(insn)) mark(insn.xr);
        if (insn.rm?.kind === 'xmm' && sseGprRm(insn)) mark(insn.rm.r);
        if (insn.rm?.kind === 'mem') { if (insn.rm.base>=0) mark(insn.rm.base); if (insn.rm.index>=0) mark(insn.rm.index); }
        break; }
      case 'ssegrpshift': break;   // xmm only
      default:
        noteRW(insn.dst, WRITES_DST.has(insn.mnem)); noteRW(insn.src, false); noteRW(insn.src2, false);
    }
  }
  // An unpatterned 64-bit div/idiv compiles to a runtime guard that can deopt;
  // that deopt spills every register, so it must spill full 64-bit values.
  for (const b of blocks) for (let ii = 0; ii < b.insns.length; ii++) {
    const insn = b.insns[ii];
    if ((insn.mnem === 'div1' || insn.mnem === 'idiv1') && (insn.size || 8) === 8) {
      const prev = ii > 0 ? b.insns[ii-1] : null, sgn = insn.mnem === 'idiv1';
      const zeroed = prev && prev.mnem === 'xor' && prev.dst?.kind==='reg' && prev.dst.r===2 && prev.src?.kind==='reg' && prev.src.r===2;
      const cqo = prev && prev.mnem === 'cdq' && (prev.size||8) === 8;
      if (!(sgn ? cqo : zeroed)) hasDeopt = true;
    }
  }
  if (hasDeopt) any64.fill(true);
  // `rep movs/stos` translate to forward bulk-memory ops, valid only when
  // DF=0. The ABI keeps DF=0 except transiently around a std/cld pair; a
  // function that never executes `std` has DF=0 throughout, so bulk ops are
  // sound. If it does, poison (the interpreter honors DF exactly).
  let hasStd = false;
  for (const b of blocks) for (const insn of b.insns) if (insn.mnem === 'std') hasStd = true;
  const pushed = new Set();
  for (const b of blocks) for (const insn of b.insns) {
    if (insn.mnem === 'push' && insn.src && insn.src.kind === 'reg') pushed.add(insn.src.r);
    if (insn.mnem === 'pop' && insn.dst && insn.dst.kind === 'reg') pushed.add(insn.dst.r);
  }
  // A pushed register may keep a 32-bit working local ONLY under verified
  // prologue/epilogue discipline — real code also uses push/pop as data moves
  // (busybox: `push $8; pop %rdi`), where the regfile-routed save/restore
  // trick would corrupt the working value. The discipline is:
  //   every push of X: in the entry block, before any write to X and before
  //     any call/syscall (so the regfile still holds X's caller value), and
  //   every pop of X: in a ret-terminated block, with no access to X and no
  //     call/syscall between the pop and the ret (so the restored caller
  //     value survives in the regfile for the exit skip).
  const touchesReg = (insn, X) => {
    for (const op of [insn.dst, insn.src, insn.src2]) {
      if (!op) continue;
      if (op.kind === 'reg' && op.r === X) return true;
      if (op.kind === 'mem' && (op.base === X || op.index === X)) return true;
    }
    if ((insn.mnem === 'div1' || insn.mnem === 'idiv1' || insn.mnem === 'mul1' || insn.mnem === 'imul1' ||
         insn.mnem === 'cwde' || insn.mnem === 'cdq') && (X === 0 || X === 2)) return true;
    if (insn.mnem === 'syscall' && [0,7,6,2,10,8,9,1,11].includes(X)) return true;
    return false;
  };
  const CALLS = new Set(['call', 'callind', 'syscall']);
  // block 0 re-executes iff it is a loop header (some edge targets it): then a
  // prologue push would re-read the stale regfile slot every iteration.
  const entryIsLoopHeader = succs.some(sl => sl.includes(0));
  const disciplined = (X) => {
    if (entryIsLoopHeader) return false;
    // exactly one push of X, in the entry block, before any write to X or call
    let pushCount = 0;
    for (let bi = 0; bi < N; bi++) for (const insn of blocks[bi].insns)
      if (insn.mnem === 'push' && insn.src?.kind === 'reg' && insn.src.r === X) { if (bi !== 0) return false; pushCount++; }
    if (pushCount !== 1) return false;
    let sawBarrier = false, sawPush = false;
    for (const insn of blocks[0].insns) {
      if (insn.mnem === 'push' && insn.src?.kind === 'reg' && insn.src.r === X) { if (sawBarrier) return false; sawPush = true; continue; }
      if (CALLS.has(insn.mnem) || touchesReg(insn, X)) sawBarrier = true;
    }
    if (!sawPush) return false;
    // EVERY ret-terminated block must restore X via exactly one pop, with no
    // access to X and no call between that pop and the ret; a pop of X may
    // appear only in ret blocks. This is what makes the epilogue-skip sound:
    // regfile[X] holds the restored caller value on every exit path.
    for (let bi = 0; bi < N; bi++) {
      const insns = blocks[bi].insns;
      let poppedHere = 0;
      for (let k = 0; k < insns.length; k++) {
        const insn = insns[k];
        if (insn.mnem === 'pop' && insn.dst?.kind === 'reg' && insn.dst.r === X) {
          poppedHere++;
          if (term[bi].kind !== 'ret') return false;
          for (let j = k + 1; j < insns.length; j++)
            if (CALLS.has(insns[j].mnem) || touchesReg(insns[j], X) ||
                (insns[j].mnem === 'pop' && insns[j].dst?.kind === 'reg' && insns[j].dst.r === X)) return false;
        }
      }
      if (term[bi].kind === 'ret' && poppedHere !== 1) return false;
    }
    return true;
  };
  // An i32-classified register's entry reload truncates the incoming 64-bit
  // value. That is sound only if every path from entry writes the register
  // before any point that spills it back (a call/syscall boundary or a unit
  // exit) — otherwise the truncated entry value leaks into the regfile.
  // Units can be mid-function loop-head slices, so ABI scratch-register
  // reasoning does not apply: verify by dataflow and demote violators.
  {
    const predsL = Array.from({length:N}, ()=>[]);
    for (let b = 0; b < N; b++) for (const sx of succs[b]) if (sx >= 0) predsL[sx].push(b);
    const isWrite = (insn, X) => {
      if (insn.dst && insn.dst.kind === 'reg' && insn.dst.r === X &&
          !['cmp','test','push'].includes(insn.mnem)) return true;
      if (insn.mnem === 'pop' && insn.dst?.kind === 'reg' && insn.dst.r === X) return true;
      if ((insn.mnem === 'div1' || insn.mnem === 'idiv1' || insn.mnem === 'mul1' || insn.mnem === 'imul1') && (X === 0 || X === 2)) return true;
      if ((insn.mnem === 'cwde' || insn.mnem === 'cdq') && (X === 0 || X === 2)) return true;
      return false;
    };
    for (let r = 0; r < 16; r++) {
      const outW = new Array(N).fill(null);
      if (!(seenR[r] && !any64[r] && w32[r])) continue;
      // per-block: does the block write r before its first spill point, does it
      // contain a spill point before any write, does it write r at all
      let bad = false;
      // iterate to fixpoint over written-on-entry; entry block starts unwritten
      for (let pass = 0; pass < N + 2 && !bad; pass++) {
        let changed = false;
        for (let b = 0; b < N && !bad; b++) {
          const inW = b === 0 ? false : predsL[b].length > 0 && predsL[b].every(pb => outW[pb] ?? false);
          if (b !== 0 && predsL[b].length === 0) continue;      // unreachable
          let w = inW;
          for (const insn of blocks[b].insns) {
            if (CALLS.has(insn.mnem)) {
              if (!w) { bad = true; break; }
              w = false;                      // post-call reload re-truncates the slot
            }
            if (isWrite(insn, r)) w = true;
          }
          // any exit edge (ret, external jmp/jcc target, indirect jmp) spills
          if (!bad && !w && (term[b].kind === 'ret' || succs[b].some(x => x < 0))) bad = true;
          if ((outW[b] ?? null) !== w) { outW[b] = w; changed = true; }
        }
        if (!changed) break;
      }
      if (bad) any64[r] = true;
    }
  }
  const savedOK = new Set([...pushed].filter(r => seenR[r] && !any64[r] && w32[r] && disciplined(r)));
  const isI32 = (r) => seenR[r] && !any64[r] && w32[r] && (!pushed.has(r) || savedOK.has(r));
  const savedI32 = (r) => savedOK.has(r);

  // ---- xmm / SIMD: the 16 vector registers live in v128 locals, mirrored to
  // the engine's xmm memory region (256..511) at entry/exit and call boundaries
  // (all xmm are caller-saved in SysV). Only registers the function touches get
  // a local and participate in sync.
  const XMMOFF = 256;
  // Some SSE ops name a GPR via the xr (reg) or rm field, not an xmm: movd/movq
  // and cvtsi2sd read/write GPRs; pmovmskb/movmskps/cvt*2si write a GPR.
  const sseXrIsGpr = (insn) => [0x2C, 0x2D, 0xD7, 0x50].includes(insn.op);
  const sseRmIsGpr = (insn) => insn.op === 0x6E || insn.op === 0x2A || (insn.op === 0x7E && !insn.pF3);
  const xUsed = new Set();
  for (const b of blocks) for (const insn of b.insns) {
    if (insn.mnem === 'sse') {
      if (!sseXrIsGpr(insn)) xUsed.add(insn.xr);
      if (insn.rm?.kind === 'xmm' && !sseRmIsGpr(insn)) xUsed.add(insn.rm.r);
    }
    if (insn.mnem === 'ssegrpshift') xUsed.add(insn.xrm);
  }
  const xreg = (r) => '$x' + r;
  const xSpill  = (r) => `(v128.store (i32.const ${XMMOFF + r*16}) (local.get ${xreg(r)}))`;
  const xReload = (r) => `(local.set ${xreg(r)} (v128.load (i32.const ${XMMOFF + r*16})))`;
  const xSpillAll  = () => [...xUsed].map(xSpill);
  const xReloadAll = () => [...xUsed].map(xReload);

  // A register this function never touches keeps no local at all: its regfile
  // slot is already the live value (ours at entry, a callee's after calls), so
  // every sync — entry, call boundaries, exit — skips it. This keeps register
  // pressure proportional to what the function actually uses.
  const touched = (r) => r === 4 || seenR[r] || pushed.has(r);
  // regfile <-> locals sync. Spill writes each register's CURRENT working
  // value (an i32 local zero-extends). Reload refreshes locals from the
  // regfile — after a call this picks up whatever the callee left/restored.
  const spillR  = (r) => isI32(r) ? `(i64.store (i32.const ${r*8}) (i64.extend_i32_u (local.get $r${r})))`
                                  : `(i64.store (i32.const ${r*8}) (local.get $r${r}))`;
  const reloadR = (r) => isI32(r) ? `(local.set $r${r} (i32.load (i32.const ${r*8})))`
                                  : `(local.set $r${r} (i64.load (i32.const ${r*8})))`;
  const spillAll  = () => [...Array.from({length:16},(_,r)=>touched(r)?spillR(r):null).filter(Boolean), ...xSpillAll()];
  const reloadAll = () => [...Array.from({length:16},(_,r)=>touched(r)?reloadR(r):null).filter(Boolean), ...xReloadAll()];
  // Exit spill: a disciplined savedI32 reg's slot was just refreshed by its
  // epilogue pop (the full 64-bit caller value) — don't clobber it with the
  // truncated working value. All xmm are caller-saved: always write back.
  const spillExit = () => [...Array.from({length:16},(_,r)=>(touched(r)&&!savedI32(r))?spillR(r):null).filter(Boolean), ...xSpillAll()];

  // ---- operand / instruction emit (identical semantics to the dispatch version) ----
  const hexs = (v) => BigInt.asIntN(64, v).toString();
  let tmpN = 0; const tmps = new Set();
  const T = () => { const n = '$t' + (tmpN++); tmps.add(n); return n; };
  let vtmpN = 0; const vtmps = new Set();
  const VT = () => { const n = '$vt' + (vtmpN++); vtmps.add(n); return n; };
  const reg = (r) => '$r' + r;
  const sx = (e, S) => S === 8 ? e : `(i64.shr_s (i64.shl ${e} (i64.const ${64-S*8})) (i64.const ${64-S*8}))`;
  const guestAddr = (op, next) => {
    if (op.ripRel) return `(i64.const ${hexs(next + op.disp)})`;
    let e = `(i64.const ${hexs(op.disp)})`;
    if (op.base >= 0) e = `(i64.add ${e} (local.get ${reg(op.base)}))`;
    if (op.index >= 0) { let ix = `(local.get ${reg(op.index)})`;
      if (op.scale > 1) ix = `(i64.shl ${ix} (i64.const ${Math.log2(op.scale)}))`;
      e = `(i64.add ${e} ${ix})`; }
    return e;
  };
  const woff = BigInt.asIntN(64, -guestBase + BigInt(ramBase));
  // i32 wasm offset: fold (disp + woff) into one constant; wrap base/index once.
  // An fs-segment (TLS) access adds the live fs base, mirrored by the engine
  // into regfile slot 16 (byte offset 128).
  const wasmAddr = (op, next) => {
    if (op.ripRel) return `(i32.const ${Number(BigInt.asIntN(32, next + op.disp + woff))})`;
    const k = Number(BigInt.asIntN(32, op.disp + woff));
    let e = op.base >= 0 ? `(i32.wrap_i64 (local.get ${reg(op.base)}))` : `(i32.const 0)`;
    if (op.index >= 0) { let ix = `(i32.wrap_i64 (local.get ${reg(op.index)}))`;
      if (op.scale > 1) ix = `(i32.shl ${ix} (i32.const ${Math.log2(op.scale)}))`;
      e = `(i32.add ${e} ${ix})`; }
    if (op.fs) e = `(i32.add ${e} (i32.wrap_i64 (i64.load (i32.const 128))))`;
    return k === 0 ? e : `(i32.add ${e} (i32.const ${k}))`;
  };
  const LD = { 1:'i64.load8_u', 2:'i64.load16_u', 4:'i64.load32_u', 8:'i64.load' };
  const LD_S = { 1:'i64.load8_s', 2:'i64.load16_s', 4:'i64.load32_s' };
  const ST = { 1:'i64.store8', 2:'i64.store16', 4:'i64.store32', 8:'i64.store' };
  const rd = (op, size, next) => {
    // mask immediates to the operand width (decoded sign-extended) — see the
    // matching note in the function-mode rd() above
    if (op.kind === 'imm') return `(i64.const ${hexs(BigInt.asUintN((size || 8) * 8, op.v))})`;
    if (op.kind === 'reg') {
      if (isI32(op.r) && !op.high) { const e = `(i64.extend_i32_u (local.get ${reg(op.r)}))`; return size >= 4 ? e : `(i64.and ${e} (i64.const ${MASKl[size]}))`; }
      let e = `(local.get ${reg(op.r)})`;
      if (op.high) e = `(i64.shr_u ${e} (i64.const 8))`;
      return size === 8 && !op.high ? e : `(i64.and ${e} (i64.const ${MASKl[size]}))`; }
    return `(${LD[size]} ${wasmAddr(op, next)})`;
  };
  const wr = (op, size, expr, next) => {
    if (op.kind === 'reg') {
      if (isI32(op.r)) {
        if (size >= 4) return `(local.set ${reg(op.r)} (i32.wrap_i64 ${expr}))`;
        const m = MASKl[size];
        if (op.high) return `(local.set ${reg(op.r)} (i32.or (i32.and (local.get ${reg(op.r)}) (i32.const 0xFFFF00FF)) (i32.shl (i32.and (i32.wrap_i64 ${expr}) (i32.const 0xFF)) (i32.const 8))))`;
        return `(local.set ${reg(op.r)} (i32.or (i32.and (local.get ${reg(op.r)}) (i32.const ${Number((~m)&0xFFFFFFFFn)})) (i32.and (i32.wrap_i64 ${expr}) (i32.const ${Number(m)}))))`;
      }
      if (size === 8) return `(local.set ${reg(op.r)} ${expr})`;
      if (size === 4) return `(local.set ${reg(op.r)} (i64.and ${expr} (i64.const 0xFFFFFFFF)))`;
      const m = MASKl[size];
      if (op.high) return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~0xFF00n)&MASKl[8]})) (i64.shl (i64.and ${expr} (i64.const 0xFF)) (i64.const 8))))`;
      return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~m)&MASKl[8]})) (i64.and ${expr} (i64.const ${m}))))`;
    }
    return `(${ST[size]} ${wasmAddr(op, next)} ${expr})`;
  };
  const ALU = { add:'i64.add', sub:'i64.sub', and:'i64.and', or:'i64.or', xor:'i64.xor' };
  const ALU32 = { add:'i32.add', sub:'i32.sub', and:'i32.and', or:'i32.or', xor:'i32.xor' };
  const LD32 = { 1:'i32.load8_u', 2:'i32.load16_u', 4:'i32.load' };
  // operand as an i32 value (for 32-bit arithmetic)
  const rd32 = (op, next) => {
    if (op.kind === 'imm') return `(i32.const ${Number(BigInt.asIntN(32, op.v))})`;
    if (op.kind === 'reg') { if (isI32(op.r) && !op.high) return `(local.get ${reg(op.r)})`;
      let e = `(local.get ${reg(op.r)})`; if (op.high) e = `(i64.shr_u ${e} (i64.const 8))`; return `(i32.wrap_i64 ${e})`; }
    return `(${LD32[op.size]||'i32.load'} ${wasmAddr(op, next)})`;
  };
  // write an i32 expr to a register (zero-extends the full 64-bit local)
  const wr32reg = (r, e32) => isI32(r) ? `(local.set ${reg(r)} ${e32})` : `(local.set ${reg(r)} (i64.extend_i32_u ${e32}))`;

  // ---- SSE/SIMD -> wasm v128. xmm operands are v128 locals ($xN); memory
  // operands load/store v128 directly. Semantics match the BigInt interpreter
  // lane-for-lane; anything not handled throws, poisoning the function so the
  // interpreter runs it faithfully.
  const xv = (rm, next) => rm.kind === 'xmm' ? `(local.get ${xreg(rm.r)})` : `(v128.load ${wasmAddr(rm, next)})`;
  const setx = (r, e) => `(local.set ${xreg(r)} ${e})`;
  const ZERO = '(v128.const i64x2 0 0)';
  // low 64 bits of an xmm value as an i64 expr
  const xlo = (rm, next) => `(i64x2.extract_lane 0 ${xv(rm, next)})`;
  const xlo32 = (rm, next) => `(i32x4.extract_lane 0 ${xv(rm, next)})`;
  // punpck byte-shuffle indices (matches interp's interleave of low/high halves)
  const unpckIdx = (EB, high) => { const n = 8 / EB, base = high ? 8 : 0, idx = [];
    for (let k = 0; k < n; k++) { for (let bb = 0; bb < EB; bb++) idx.push(base + k*EB + bb);       // a elem k
                                  for (let bb = 0; bb < EB; bb++) idx.push(16 + base + k*EB + bb); } // b elem k
    return idx; };
  const pshufdIdx = (imm) => { const idx = [];
    for (let d = 0; d < 4; d++) { const sel = (imm >> (d*2)) & 3; for (let bb = 0; bb < 4; bb++) idx.push(sel*4 + bb); }
    return idx; };
  const pshufwIdx = (imm, high) => {   // pshuflw (high=0) / pshufhw (high=8): shuffle 4 words in one half, other half copied
    const idx = [];
    for (let b = 0; b < (high ? 8 : 0); b++) idx.push(b);
    for (let w = 0; w < 4; w++) { const sel = (imm >> (w*2)) & 3; idx.push(high + sel*2, high + sel*2 + 1); }
    for (let b = high + 8; b < 16; b++) idx.push(b);
    return idx; };
  const LANE_BIN = {  // op -> wasm lane binary op applied to (dst, src)
    0xFC:'i8x16.add', 0xFD:'i16x8.add', 0xFE:'i32x4.add', 0xD4:'i64x2.add',
    0xF8:'i8x16.sub', 0xF9:'i16x8.sub', 0xFA:'i32x4.sub', 0xFB:'i64x2.sub',
    0x74:'i8x16.eq',  0x75:'i16x8.eq',  0x76:'i32x4.eq',
    0x64:'i8x16.gt_s',0x65:'i16x8.gt_s',0x66:'i32x4.gt_s',
    0xDA:'i8x16.min_u',0xDE:'i8x16.max_u',0xEA:'i16x8.min_s',0xEE:'i16x8.max_s',
    0xD8:'i8x16.sub_sat_u',0xD9:'i16x8.sub_sat_u',0xDC:'i8x16.add_sat_u',0xDD:'i16x8.add_sat_u',
    0xE8:'i8x16.sub_sat_s',0xE9:'i16x8.sub_sat_s',0xEC:'i8x16.add_sat_s',0xED:'i16x8.add_sat_s',
    0xE0:'i8x16.avgr_u',0xE3:'i16x8.avgr_u',0xD5:'i16x8.mul',
    0xEF:'v128.xor',0xDB:'v128.and',0xEB:'v128.or',
    0x57:'v128.xor',0x54:'v128.and',0x56:'v128.or',
  };
  function emitSSE(insn, next, L, setFlags) {
    const op = insn.op, xr = insn.xr, rm = insn.rm;
    const dst = `(local.get ${xreg(xr)})`;
    const put = (e) => L.push(setx(xr, e));
    const storeRm = (bytes, e) => { if (rm.kind === 'xmm') L.push(setx(rm.r, e));
      else if (bytes === 16) L.push(`(v128.store ${wasmAddr(rm, next)} ${e})`);
      else L.push(`(${ {4:'v128.store32_lane',8:'v128.store64_lane'}[bytes] } 0 ${wasmAddr(rm, next)} ${e})`); };   // (storeN_lane LANE addr value)
    if (LANE_BIN[op] && op !== 0xEF && op !== 0xDB && op !== 0xEB && op !== 0x57 && op !== 0x54 && op !== 0x56) {
      put(`(${LANE_BIN[op]} ${dst} ${xv(rm, next)})`); return; }
    switch (op) {
      case 0xEF: case 0xDB: case 0xEB: case 0x57: case 0x54: case 0x56:
        put(`(${LANE_BIN[op]} ${dst} ${xv(rm, next)})`); break;
      case 0xDF: put(`(v128.andnot ${xv(rm, next)} ${dst})`); break;          // pandn: src & ~dst
      case 0x55: put(`(v128.andnot ${xv(rm, next)} ${dst})`); break;          // andnps
      case 0x6F: case 0x28:                                                    // movdqa/u, movaps (full 128 load/reg)
        put(xv(rm, next)); break;
      case 0x10:                                                              // movups / movss(F3) / movsd(F2)
        if (insn.pF3) put(`(i32x4.replace_lane 0 ${dst} ${rm.kind==='xmm'?`(i32x4.extract_lane 0 ${xv(rm,next)})`:`(i32.load ${wasmAddr(rm,next)})`})`);
        else if (insn.pF2) put(`(i64x2.replace_lane 0 ${dst} ${rm.kind==='xmm'?xlo(rm,next):`(i64.load ${wasmAddr(rm,next)})`})`);
        else put(xv(rm, next));
        break;
      case 0x7F: case 0x29: storeRm(16, dst); break;                          // movdqa/u, movaps store
      case 0xE7:                                                              // movntdq: non-temporal hint is a no-op here — plain store
        if (!insn.p66) throw new Error('AOT sse op e7 (MMX movntq) @ ' + insn.rip.toString(16));
        storeRm(16, dst); break;
      case 0x11:                                                              // movups/ss/sd store
        if (insn.pF3) storeRm(4, dst); else if (insn.pF2) storeRm(8, dst); else storeRm(16, dst);
        break;
      case 0x12: put(`(i64x2.replace_lane 0 ${dst} ${rm.kind==='xmm'?xlo(rm,next):`(i64.load ${wasmAddr(rm,next)})`})`); break;  // movlps load low
      case 0x13: storeRm(8, dst); break;                                      // movlps store low
      case 0x16: put(`(i64x2.replace_lane 1 ${dst} ${rm.kind==='xmm'?xlo(rm,next):`(i64.load ${wasmAddr(rm,next)})`})`); break;  // movhps load high
      case 0x17: L.push(`(v128.store64_lane 1 ${wasmAddr(rm, next)} ${dst})`); break;   // movhps store high (lane, addr, value)
      case 0x6E:                                                              // movd/movq gpr/mem -> xmm (zero upper)
        if (insn.W) put(`(i64x2.replace_lane 0 ${ZERO} ${rm.kind==='xmm'?rd({kind:'reg',r:rm.r,size:8},8,next):`(i64.load ${wasmAddr(rm,next)})`})`);
        else put(`(i32x4.replace_lane 0 ${ZERO} ${rm.kind==='xmm'?rd32({kind:'reg',r:rm.r,size:4},next):`(i32.load ${wasmAddr(rm,next)})`})`);
        break;
      case 0x7E:
        if (insn.pF3) put(`(i64x2.replace_lane 0 ${ZERO} ${xlo(rm, next)})`); // movq xmm<-xmm/m64, zero upper
        else if (rm.kind === 'xmm') L.push(insn.W ? wr({kind:'reg',r:rm.r,size:8},8,`(i64x2.extract_lane 0 ${dst})`,next)
                                                  : wr32reg(rm.r, `(i32x4.extract_lane 0 ${dst})`));
        else L.push(insn.W ? `(i64.store ${wasmAddr(rm,next)} (i64x2.extract_lane 0 ${dst}))`
                           : `(i32.store ${wasmAddr(rm,next)} (i32x4.extract_lane 0 ${dst}))`);
        break;
      case 0xC2: {                                                            // cmpps/pd/ss/sd: predicate -> lane masks
        const dbl = insn.pF2 || insn.p66, scalar = insn.pF3 || insn.pF2;
        const LN = dbl ? 'f64x2' : 'f32x4';
        const A = dst, B = xv(rm, next);
        let mexp;
        switch (Number(insn.imm8) & 7) {
          case 0: mexp = `(${LN}.eq ${A} ${B})`; break;
          case 1: mexp = `(${LN}.lt ${A} ${B})`; break;
          case 2: mexp = `(${LN}.le ${A} ${B})`; break;
          case 3: mexp = `(v128.or (${LN}.ne ${A} ${A}) (${LN}.ne ${B} ${B}))`; break;   // unord
          case 4: mexp = `(${LN}.ne ${A} ${B})`; break;                                  // neq (true on NaN)
          case 5: mexp = `(v128.not (${LN}.lt ${A} ${B}))`; break;                       // nlt
          case 6: mexp = `(v128.not (${LN}.le ${A} ${B}))`; break;                       // nle
          default: mexp = `(v128.and (${LN}.eq ${A} ${A}) (${LN}.eq ${B} ${B}))`; break; // ord
        }
        if (!scalar) { put(mexp); break; }
        put(dbl ? `(i64x2.replace_lane 0 ${dst} (i64x2.extract_lane 0 ${mexp}))`
                : `(i32x4.replace_lane 0 ${dst} (i32x4.extract_lane 0 ${mexp}))`);
        break; }
      case 0x2E: case 0x2F: {                                                 // ucomiss/sd, comiss/sd -> fcmp flags
        const isD = insn.p66;
        const aBits = isD ? `(i64x2.extract_lane 0 ${dst})`
                          : `(i64.reinterpret_f64 (f64.promote_f32 (f32x4.extract_lane 0 ${dst})))`;
        const bBits = rm.kind === 'xmm'
          ? (isD ? `(i64x2.extract_lane 0 ${xv(rm, next)})`
                 : `(i64.reinterpret_f64 (f64.promote_f32 (f32x4.extract_lane 0 ${xv(rm, next)})))`)
          : (isD ? `(i64.load ${wasmAddr(rm, next)})`
                 : `(i64.reinterpret_f64 (f64.promote_f32 (f32.load ${wasmAddr(rm, next)})))`);
        if (!setFlags) throw new Error('AOT sse fcmp without flag sink');
        setFlags('fcmp', 8, aBits, bBits, '(i64.const 0)');
        break; }
      case 0xD6: storeRm(8, dst); break;                                      // movq store low 64
      case 0xD7: L.push(wr32reg(xr, `(i8x16.bitmask ${xv(rm, next)})`)); break;   // pmovmskb -> GPR
      case 0x50: L.push(wr32reg(xr, `(${insn.p66?'i64x2.bitmask':'i32x4.bitmask'} ${xv(rm, next)})`)); break;  // movmskps/pd
      case 0x70: {                                                            // pshufd (66) / pshuflw (F2) / pshufhw (F3)
        const idx = insn.pF2 ? pshufwIdx(insn.imm8, 0) : insn.pF3 ? pshufwIdx(insn.imm8, 8) : pshufdIdx(insn.imm8);
        put(`(i8x16.shuffle ${idx.join(' ')} ${xv(rm, next)} ${xv(rm, next)})`); break; }
      case 0x60: case 0x61: case 0x62: case 0x68: case 0x69: case 0x6A: {     // punpck l/h bw/wd/dq
        const EB = { 0x60:1,0x61:2,0x62:4,0x68:1,0x69:2,0x6A:4 }[op], high = op >= 0x68;
        put(`(i8x16.shuffle ${unpckIdx(EB, high).join(' ')} ${dst} ${xv(rm, next)})`); break; }
      case 0x14: put(insn.p66 ? `(i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 ${dst} ${xv(rm, next)})`     // unpcklpd (= punpcklqdq)
                              : `(i8x16.shuffle 0 1 2 3 16 17 18 19 4 5 6 7 20 21 22 23 ${dst} ${xv(rm, next)})`); break;  // unpcklps
      case 0x15: put(insn.p66 ? `(i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 ${dst} ${xv(rm, next)})`   // unpckhpd (= punpckhqdq)
                              : `(i8x16.shuffle 8 9 10 11 24 25 26 27 12 13 14 15 28 29 30 31 ${dst} ${xv(rm, next)})`); break;  // unpckhps
      case 0x6C: put(`(i8x16.shuffle 0 1 2 3 4 5 6 7 16 17 18 19 20 21 22 23 ${dst} ${xv(rm, next)})`); break;  // punpcklqdq
      case 0x6D: put(`(i8x16.shuffle 8 9 10 11 12 13 14 15 24 25 26 27 28 29 30 31 ${dst} ${xv(rm, next)})`); break; // punpckhqdq
      case 0x67: put(`(i8x16.narrow_i16x8_u ${dst} ${xv(rm, next)})`); break; // packuswb
      case 0x63: put(`(i8x16.narrow_i16x8_s ${dst} ${xv(rm, next)})`); break; // packsswb
      case 0x6B: put(`(i16x8.narrow_i32x4_s ${dst} ${xv(rm, next)})`); break; // packssdw
      case 0xE4: case 0xE5: {                                                 // pmulhuw/pmulhw: high 16 of widened products
        const s = VT(); L.push(`(local.set ${s} ${xv(rm, next)})`);
        const sg = op === 0xE5 ? 's' : 'u';
        put(`(i8x16.shuffle 2 3 6 7 10 11 14 15 18 19 22 23 26 27 30 31 ` +
            `(i32x4.extmul_low_i16x8_${sg} ${dst} (local.get ${s})) ` +
            `(i32x4.extmul_high_i16x8_${sg} ${dst} (local.get ${s})))`);
        break; }
      case 0xF4: {                                                            // pmuludq: lanes 0,2 u32 -> u64
        const s = VT(); L.push(`(local.set ${s} ${xv(rm, next)})`);
        put(`(i64x2.mul (v128.and ${dst} (v128.const i64x2 0xFFFFFFFF 0xFFFFFFFF)) (v128.and (local.get ${s}) (v128.const i64x2 0xFFFFFFFF 0xFFFFFFFF)))`);
        break; }
      // ---- scalar float (low lane); high lane of dst preserved as x86 requires
      case 0x2A: {                                                            // cvtsi2sd/ss int -> float
        const iv = rm.kind==='xmm' ? rd({kind:'reg',r:rm.r,size:insn.W?8:4}, insn.W?8:4, next) : `(${insn.W?'i64.load':'i64.load32_s'} ${wasmAddr(rm,next)})`;
        const src = insn.W ? `(i64.and ${iv} (i64.const 0xFFFFFFFFFFFFFFFF))` : iv;
        const conv = insn.W ? (insn.pF2?'f64.convert_i64_s':'f32.convert_i64_s') : (insn.pF2?'f64.convert_i32_s':'f32.convert_i32_s');
        const arg = insn.W ? src : `(i32.wrap_i64 ${iv})`;
        if (insn.pF2) put(`(f64x2.replace_lane 0 ${dst} (${conv} ${arg}))`);
        else put(`(f32x4.replace_lane 0 ${dst} (${conv} ${arg}))`);
        break; }
      case 0x2C: case 0x2D: {                                                 // cvt(t)sd/ss2si -> GPR
        const f = insn.pF2 ? `(f64x2.extract_lane 0 ${xv(rm,next)})` : `(f32x4.extract_lane 0 ${xv(rm,next)})`;
        const trunc = insn.W ? (insn.pF2?'i64.trunc_sat_f64_s':'i64.trunc_sat_f32_s') : (insn.pF2?'i32.trunc_sat_f64_s':'i32.trunc_sat_f32_s');
        // 0x2D rounds-to-nearest; wasm trunc_sat truncates. Add nearest rounding via f*.nearest.
        const fr = insn.op===0x2D ? (insn.pF2?`(f64.nearest ${f})`:`(f32.nearest ${f})`) : f;
        L.push(insn.W ? wr({kind:'reg',r:xr,size:8},8,`(${trunc} ${fr})`,next) : wr32reg(xr, `(${trunc} ${fr})`));
        break; }
      case 0x51: case 0x58: case 0x59: case 0x5C: case 0x5D: case 0x5E: case 0x5F: {   // sqrt/add/mul/sub/min/max/div
        const F = insn.pF2 ? 'f64' : 'f32', LN = insn.pF2 ? 'f64x2' : 'f32x4';
        const ext = (v) => `(${LN}.extract_lane 0 ${v})`;
        const a = ext(dst), b = ext(xv(rm, next));
        const scalar = insn.pF3 || insn.pF2;
        if (!scalar) {  // packed
          const P = { 0x51:`${LN}.sqrt`, 0x58:`${LN}.add`, 0x59:`${LN}.mul`, 0x5C:`${LN}.sub`, 0x5D:`${LN}.pmin`, 0x5E:`${LN}.div`, 0x5F:`${LN}.pmax` }[op];
          put(op===0x51 ? `(${P} ${xv(rm,next)})` : `(${P} ${dst} ${xv(rm,next)})`); break;
        }
        const e = op===0x51 ? `(${F}.sqrt ${b})` : op===0x58 ? `(${F}.add ${a} ${b})` : op===0x59 ? `(${F}.mul ${a} ${b})`
                : op===0x5C ? `(${F}.sub ${a} ${b})` : op===0x5D ? `(${F}.min ${a} ${b})` : op===0x5E ? `(${F}.div ${a} ${b})` : `(${F}.max ${a} ${b})`;
        put(`(${LN}.replace_lane 0 ${dst} ${e})`); break; }
      case 0x5A: {                                                            // cvtss2sd / cvtsd2ss (scalar low lane)
        if (insn.pF3) put(`(f64x2.replace_lane 0 ${dst} (f64.promote_f32 (f32x4.extract_lane 0 ${xv(rm,next)})))`);
        else if (insn.pF2) put(`(f32x4.replace_lane 0 ${dst} (f32.demote_f64 (f64x2.extract_lane 0 ${xv(rm,next)})))`);
        else throw new Error('AOT sse 5a packed');
        break; }
      case 0x2B: storeRm(16, dst); break;                                     // movntps/pd
      // comis/ucomis (0x2E/0x2F) write RFLAGS from a float compare; the
      // lazy-flag machinery would need a float-compare producer kind. Not yet
      // modeled -> poison so the interpreter runs the whole function.
      default: throw new Error('AOT sse op ' + op.toString(16) + ' @ ' + insn.rip.toString(16));
    }
  }
  function emitSSEShift(insn, L) {
    // psll/psrl/psra by immediate (grpshift op 0x71/0x72/0x73)
    const EB = insn.op === 0x71 ? 2 : insn.op === 0x72 ? 4 : 8;
    const LN = { 2:'i16x8', 4:'i32x4', 8:'i64x2' }[EB];
    const x = `(local.get ${xreg(insn.xrm)})`, c = insn.imm8 & 0xff;
    let e;
    if (insn.sub === 2) e = `(${LN}.shr_u ${x} (i32.const ${c}))`;            // psrl
    else if (insn.sub === 6) e = `(${LN}.shl ${x} (i32.const ${c}))`;         // psll
    else if (insn.sub === 4) e = `(${LN==='i64x2'?'i64x2.shr_s':LN+'.shr_s'} ${x} (i32.const ${c}))`;  // psra
    else if (insn.sub === 3) {                                               // psrldq: whole-reg byte shift right
      const idx = []; for (let k=0;k<16;k++){ const s=k+c; idx.push(s<16?s:16); }  // 16 -> zero lane
      e = `(i8x16.shuffle ${idx.join(' ')} ${x} ${ZERO})`;
    } else if (insn.sub === 7) {                                             // pslldq: byte shift left
      const idx = []; for (let k=0;k<16;k++){ const s=k-c; idx.push(s>=0?s:16); }
      e = `(i8x16.shuffle ${idx.join(' ')} ${x} ${ZERO})`;
    } else throw new Error('AOT ssegrpshift sub ' + insn.sub);
    L.push(setx(insn.xrm, e));
  }

  const FLAGSET = new Set(['add','sub','and','or','xor','inc','dec','cmp','test','neg','cmpxchg','xadd','cmps','scas']);
  // A modeled flag producer is one whose flags we can reconstruct lazily.
  const modeled = (insn) => {
    if (FLAGSET.has(insn.mnem)) return true;
    if (insn.mnem === 'sse' && (insn.op === 0x2E || insn.op === 0x2F)) return true;   // ucomis/comis
    if (insn.mnem === 'adc' || insn.mnem === 'sbb') return true;   // produce CF/OF/SF/ZF via $cf + operands
    if ((insn.mnem === 'shl' || insn.mnem === 'shr' || insn.mnem === 'sar') &&
        insn.src.kind === 'imm' && (insn.src.v & (BigInt((insn.size||8)===8?63:31))) !== 0n) return true;
    if (insn.mnem === 'bt' || insn.mnem === 'bts' || insn.mnem === 'btr' || insn.mnem === 'btc') return true;
    if (insn.mnem === 'mul1' || insn.mnem === 'imul1') return true;   // CF=OF = widening overflow, in $fr
    if (insn.mnem === 'bsf' || insn.mnem === 'bsr') return true;   // ZF <- (src==0)
    return false;
  };
  // Instructions that write flags in a way we DON'T model: a nearest such
  // writer before a consumer means the lazy flags are unrecoverable.
  const CLOBBER = new Set(['shl','shr','sar','rol','ror','imul2','imul3','mul1','imul1','div1','idiv1',
                           'bt','bts','btr','btc','shld','shrd','call','callind','syscall',
                           'clc','stc','x87']);
  // Static (kind,size) a modeled producer yields — MUST match the setFlags
  // calls in emitBlock so cross-block consumers pick the right cond() form.
  const flagKind = (insn) => { const S = insn.size || 8;
    switch (insn.mnem) {
      case 'sse': return (insn.op === 0x2E || insn.op === 0x2F) ? { kind:'fcmp', size:8 } : null;
      case 'sub': case 'cmp': case 'neg': case 'cmpxchg': case 'cmps': case 'scas': return { kind:'sub', size:S };
      case 'add': case 'xadd': return { kind:'add', size:S };
      case 'adc': return { kind:'adc', size:S };
      case 'sbb': return { kind:'sbb', size:S };
      case 'or': case 'and': case 'xor': case 'test':
      case 'shl': case 'shr': case 'sar': case 'bsf': case 'bsr': return { kind:'logic', size:S };
      case 'inc': return { kind:'inc', size:S };
      case 'dec': return { kind:'dec', size:S };
      case 'bt': case 'bts': case 'btr': case 'btc': return { kind:'cf', size:S };
      case 'mul1': case 'imul1': return { kind:'cf', size:S };
      default: return null;
    } };

  // ---- lazy-flag liveness + cross-block reaching-definition analysis --------
  // A flag write is live only if some consumer (a terminating jcc or a
  // mid-block cmov/setcc) reads it before it is overwritten. The producer may
  // live in a *predecessor* block, so we solve reaching-definitions over the
  // CFG: each producer that reaches a consumer is materialized ($fa/$fb/$fr),
  // and every block records the unique (kind,size) of flags flowing into it so
  // a cross-block consumer knows which cond() form to emit. If the reaching
  // producers disagree on (kind,size) — or an unmodeled writer sits between a
  // producer and its consumer — the function is poisoned (interpreter runs it).
  const defKind = new Map();                        // 'b:idx' -> {kind,size}
  const localDef = new Array(N).fill(null);         // last modeled producer key per block (null if clobbered after / none)
  const killsFlags = new Array(N).fill(false);      // block ends with flags clobbered
  for (let b = 0; b < N; b++) {
    const insns = blocks[b].insns; let cur = null;  // null=passthrough, {key}=def, 'kill'
    for (let idx = 0; idx < insns.length; idx++) {
      const insn = insns[idx];
      if (modeled(insn)) { const key = b+':'+idx; defKind.set(key, flagKind(insn)); cur = { key }; }
      else if (CLOBBER.has(insn.mnem)) cur = 'kill';
    }
    if (cur && cur !== 'kill') localDef[b] = cur.key;
    if (cur === 'kill') killsFlags[b] = true;
  }
  const preds = Array.from({length:N}, ()=>[]);
  for (let b = 0; b < N; b++) for (const s of succs[b]) if (s >= 0) preds[s].push(b);
  const inDefs = Array.from({length:N}, ()=>new Set());
  const outDefs = Array.from({length:N}, ()=>new Set());
  { let changed = true, guard = 0;
    while (changed) { changed = false;
      if (++guard > 100000) throw new Error('AOT: flag dataflow diverged');
      for (let b = 0; b < N; b++) {
        const nin = new Set(); for (const p of preds[b]) for (const k of outDefs[p]) nin.add(k);
        // the unit's entry is also reachable from OUTSIDE (interp dispatch, a
        // call, a loop-head slice's first iteration): flags there are unknown.
        // Model that as a sentinel def so any consumer it can reach poisons
        // the unit instead of silently reading uninitialized flag locals.
        if (b === 0) nin.add('EXT');
        const nout = killsFlags[b] ? new Set() : localDef[b] ? new Set([localDef[b]]) : nin;
        const diff = (a, c) => a.size !== c.size || [...c].some(k=>!a.has(k));
        if (diff(inDefs[b], nin)) { inDefs[b] = nin; changed = true; }
        if (diff(outDefs[b], nout)) { outDefs[b] = new Set(nout); changed = true; }
      }
    } }
  const blkFlagIn = new Array(N).fill(null);        // uniform (kind,size) entering a block, or null
  for (let b = 0; b < N; b++) {
    let k = null, ok = true;
    for (const key of inDefs[b]) { const dk = defKind.get(key);
      if (!dk) { ok = false; break; }               // 'EXT': external/unknown flags reach here
      if (!k) k = dk; else if (k.kind!==dk.kind || k.size!==dk.size) { ok = false; break; } }
    if (ok && k) blkFlagIn[b] = k;
  }
  const matProducers = new Set();                   // producer keys that must materialize
  for (let b = 0; b < N; b++) {
    const insns = blocks[b].insns, consumers = [];
    // adc/sbb also CONSUME CF (from the nearest preceding flag producer)
    for (let j = 0; j < insns.length; j++) if (['cmov','setcc','adc','sbb'].includes(insns[j].mnem)) consumers.push(j);
    if (term[b].kind === 'jcc') consumers.push(insns.length - 1);
    for (const j of consumers) {
      let p = -1, clob = null;
      for (let kk = j - 1; kk >= 0; kk--) { const insn = insns[kk];
        if (modeled(insn)) { p = kk; break; } if (CLOBBER.has(insn.mnem)) { clob = insn; p = -2; break; } }
      if (p >= 0) matProducers.add(b+':'+p);
      else if (p === -2) throw new Error('AOT: unmodeled flag producer '+clob.mnem+' @ '+clob.rip.toString(16));
      else {                                        // producer is cross-block
        if (!blkFlagIn[b]) throw new Error('AOT: cross-block flags for '+(insns[j].mnem==='jcc'?'jcc':insns[j].mnem)+' @ '+insns[j].rip.toString(16));
        for (const key of inDefs[b]) if (key !== 'EXT') matProducers.add(key);
      }
    }
  }

  // indirect TAIL call ($rex holds the computed target, regfile spilled): if
  // the target is a registered compiled function, run it wasm-to-wasm — the
  // callee's ret pops OUR caller's return address, so its frame-exit rip is
  // exactly this frame's exit value.
  let usesFtr = false, usesFts = false;
  // Stack accounting is entry-tax-only: a function bumps FTDEPTH by its
  // weight (frame size grows with function size — V8 spill slots) and NEVER
  // decrements; instead every call site snapshots the word and restores it
  // absolutely after the callee returns, which also erases whatever a TAIL
  // chain under the callee accumulated (tail frames stay physically live
  // under their successor, so a counted dec there would let mutual tail
  // recursion pile real frames at net-zero depth — the bug this replaces).
  const ftW = Math.min(96, Math.max(1, blocks.reduce((s, b) => s + b.insns.length, 0) >> 9));
  const ftOk  = `(i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT})) (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0)))`;
  const ftHit = `(i32.and (i32.ge_s (local.get $fti) (i32.const 0)) ${ftOk})`;
  const ftBurn = `(i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))`;
  const ftInc = `(i32.store (i32.const ${FTDEPTH}) (i32.add (i32.load (i32.const ${FTDEPTH})) (i32.const ${ftW})))`;
  const ftSave = () => { usesFts = true; return `(local.set $fts (i32.load (i32.const ${FTDEPTH})))`; };
  const ftRestore = `(i32.store (i32.const ${FTDEPTH}) (local.get $fts))`;
  const tailJmp = () => { usesFtr = true; return [
    `(local.set $fti (call $ftr (local.get $rex)))`,
    `(if ${ftHit}`,
    // this frame's tax intentionally stays: it remains live under the callee
    `  (then ${ftBurn} (return (call_indirect $ft (type $uft) (local.get $fti)))))`,
  ]; };

  function emitBlock(i) {
    const blk = blocks[i]; const L = [];
    const producers = new Set();
    for (let idx = 0; idx < blk.insns.length; idx++) if (matProducers.has(i+':'+idx)) producers.add(idx);
    let flagState = blkFlagIn[i] || null, ii = 0;
    const setFlags = (kind, size, aE, bE, rE) => {
      if (!producers.has(ii)) return;              // dead flags: skip
      if (aE) L.push(`(local.set $fa ${aE})`); if (bE) L.push(`(local.set $fb ${bE})`); L.push(`(local.set $fr ${rE})`);
      flagState = { kind, size };
    };
    const cond = (cc) => {
      const fs = flagState, S = fs.size, sgn = SIGNl[S];
      const a='(local.get $fa)', b='(local.get $fb)', r='(local.get $fr)';
      const zf=`(i64.eqz ${r})`, nz=`(i64.ne ${r} (i64.const 0))`;
      const sf=`(i64.ne (i64.and ${r} (i64.const ${sgn})) (i64.const 0))`, nsf=`(i64.eq (i64.and ${r} (i64.const ${sgn})) (i64.const 0))`;
      // OF for sub (a-b=r) and add (a+b=r), matching the interpreter's flag rules
      const ofSub=`(i64.ne (i64.and (i64.and (i64.xor ${a} ${b}) (i64.xor ${a} ${r})) (i64.const ${sgn})) (i64.const 0))`;
      const ofAdd=`(i64.ne (i64.and (i64.and (i64.xor ${a} ${r}) (i64.xor ${b} ${r})) (i64.const ${sgn})) (i64.const 0))`;
      const cfAdd=`(i64.lt_u ${r} ${a})`;             // add carry: result wrapped below an operand
      if (fs.kind === 'sub') switch (cc) {
        case 'e':return zf; case 'ne':return nz;
        case 'b':return `(i64.lt_u ${a} ${b})`; case 'ae':return `(i64.ge_u ${a} ${b})`;
        case 'be':return `(i64.le_u ${a} ${b})`; case 'a':return `(i64.gt_u ${a} ${b})`;
        case 'l':return `(i64.lt_s ${sx(a,S)} ${sx(b,S)})`; case 'ge':return `(i64.ge_s ${sx(a,S)} ${sx(b,S)})`;
        case 'le':return `(i64.le_s ${sx(a,S)} ${sx(b,S)})`; case 'g':return `(i64.gt_s ${sx(a,S)} ${sx(b,S)})`;
        case 'o':return ofSub; case 'no':return `(i32.eqz ${ofSub})`;
        case 's':return sf; case 'ns':return nsf; }
      else if (fs.kind === 'add') switch (cc) {
        case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
        case 'b':return cfAdd; case 'ae':return `(i32.eqz ${cfAdd})`;
        case 'be':return `(i32.or ${cfAdd} ${zf})`; case 'a':return `(i32.and (i32.eqz ${cfAdd}) (i32.eqz ${zf}))`;
        case 'o':return ofAdd; case 'no':return `(i32.eqz ${ofAdd})`;
        case 'l':return `(i32.ne ${sf} ${ofAdd})`; case 'ge':return `(i32.eq ${sf} ${ofAdd})`;
        case 'le':return `(i32.or ${zf} (i32.ne ${sf} ${ofAdd}))`; case 'g':return `(i32.and (i32.eqz ${zf}) (i32.eq ${sf} ${ofAdd}))`; }
      else if (fs.kind === 'adc' || fs.kind === 'sbb') {   // CF authoritative in $cf; OF from operands
        const CF = `(i32.wrap_i64 (local.get $cf))`, OF = fs.kind === 'adc' ? ofAdd : ofSub;
        switch (cc) {
          case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
          case 'b':return CF; case 'ae':return `(i32.eqz ${CF})`;
          case 'be':return `(i32.or ${CF} ${zf})`; case 'a':return `(i32.and (i32.eqz ${CF}) (i32.eqz ${zf}))`;
          case 'o':return OF; case 'no':return `(i32.eqz ${OF})`;
          case 'l':return `(i32.ne ${sf} ${OF})`; case 'ge':return `(i32.eq ${sf} ${OF})`;
          case 'le':return `(i32.or ${zf} (i32.ne ${sf} ${OF}))`; case 'g':return `(i32.and (i32.eqz ${zf}) (i32.eq ${sf} ${OF}))`; }
      }
      else if (fs.kind === 'cf') switch (cc) {      // fr holds the CF bit (bt family, mul overflow: CF==OF)
        case 'b': case 'o': return nz; case 'ae': case 'no': return zf; }
      else if (fs.kind === 'fcmp') {                // ucomis: ZF/PF/CF from an f64 compare; OF/SF cleared
        const A = `(f64.reinterpret_i64 ${a})`, B = `(f64.reinterpret_i64 ${b})`;
        const unord = `(i32.or (f64.ne ${A} ${A}) (f64.ne ${B} ${B}))`;
        switch (cc) {
          case 'a': return `(f64.gt ${A} ${B})`;
          case 'ae': return `(f64.ge ${A} ${B})`;
          case 'b': return `(i32.eqz (f64.ge ${A} ${B}))`;
          case 'be': return `(i32.eqz (f64.gt ${A} ${B}))`;
          case 'e': case 'le': return `(i32.or (f64.eq ${A} ${B}) ${unord})`;
          case 'ne': case 'g': return `(i32.and (i32.eqz (f64.eq ${A} ${B})) (i32.eqz ${unord}))`;
          case 'p': return unord; case 'np': return `(i32.eqz ${unord})`;
          case 's': case 'o': case 'l': return `(i32.const 0)`;
          case 'ns': case 'no': case 'ge': return `(i32.const 1)`;
        }
      }

      else switch (cc) {
        case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
        case 'le':return `(i64.le_s ${sx(r,S)} (i64.const 0))`; case 'g':return `(i64.gt_s ${sx(r,S)} (i64.const 0))`;
        case 'l':return `(i64.lt_s ${sx(r,S)} (i64.const 0))`; case 'ge':return `(i64.ge_s ${sx(r,S)} (i64.const 0))`; }
      throw new Error('cond '+cc+'/'+fs.kind);
    };
    // CF-in for adc/sbb, reconstructed from the live flag producer (as an i64 0/1)
    const getCF = () => {
      const fs = flagState;
      if (!fs) throw new Error('AOT: adc/sbb with no live flag producer');
      const a='(local.get $fa)', b='(local.get $fb)', r='(local.get $fr)';
      if (fs.kind === 'sub') return `(i64.extend_i32_u (i64.lt_u ${a} ${b}))`;
      if (fs.kind === 'add') return `(i64.extend_i32_u (i64.lt_u ${r} ${a}))`;
      if (fs.kind === 'adc' || fs.kind === 'sbb') return `(local.get $cf)`;
      if (fs.kind === 'cf') return r;
      if (fs.kind === 'logic') return `(i64.const 0)`;
      throw new Error('AOT: adc/sbb CF-in from kind '+fs.kind);
    };
    for (ii = 0; ii < blk.insns.length; ii++) {
      const insn = blk.insns[ii];
      const S = insn.size || 8, m = MASKl[S], next = insn.next;
      // dead cmp/test (never consumed) can be dropped entirely
      if ((insn.mnem === 'cmp' || insn.mnem === 'test') && !producers.has(ii)) continue;
      switch (insn.mnem) {
        case 'nop': break;
        case 'mov': L.push(wr(insn.dst,S,rd(insn.src,S,next),next)); break;
        case 'movzx': L.push(wr(insn.dst,insn.size,rd(insn.src,insn.src.size,next),next)); break;
        case 'movsx': {   // sign-extend; for a memory source use a single sign-extending load
          const e = insn.src.kind === 'mem' ? `(${LD_S[insn.src.size]} ${wasmAddr(insn.src,next)})`
                                            : sx(rd(insn.src,insn.src.size,next), insn.src.size);
          L.push(wr(insn.dst,insn.size,e,next)); break; }
        case 'lea': {  // operand-size semantics: 32-bit lea zero-extends, 16-bit merges
          const a = guestAddr(insn.src, next);
          if (insn.size === 8) L.push(`(local.set ${reg(insn.dst.r)} ${a})`);
          else L.push(wr({ kind: 'reg', r: insn.dst.r, size: insn.size }, insn.size,
                         `(i64.and ${a} (i64.const ${(1n << BigInt(insn.size*8)) - 1n}))`, next));
          break; }
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          const prod = (producers.has(ii));
          const akind = insn.mnem==='sub'?'sub':insn.mnem==='add'?'add':'logic';
          // add/sub/cmp flags (CF/OF) need the ORIGINAL operands: capture before writing dst
          if (prod && (insn.mnem === 'sub' || insn.mnem === 'add')) { L.push(`(local.set $fa ${rd(insn.dst,S,next)})`, `(local.set $fb ${rd(insn.src,S,next)})`); }
          let expr;
          let i32expr = null;
          if (S === 4 && insn.dst.kind === 'reg') { i32expr = `(${ALU32[insn.mnem]} ${rd32(insn.dst,next)} ${rd32(insn.src,next)})`; expr = `(i64.extend_i32_u ${i32expr})`; }
          else if (S === 8) expr = `(${ALU[insn.mnem]} ${rd(insn.dst,8,next)} ${rd(insn.src,8,next)})`;
          else expr = `(i64.and (${ALU[insn.mnem]} ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)}) (i64.const ${m}))`;
          if (insn.dst.kind === 'reg') {
            if (i32expr && isI32(insn.dst.r)) L.push(`(local.set ${reg(insn.dst.r)} ${i32expr})`);
            else if (S >= 4 && !isI32(insn.dst.r)) L.push(`(local.set ${reg(insn.dst.r)} ${expr})`);
            else L.push(wr(insn.dst, S, expr, next));    // sub-width or i32-local: partial write
            if (prod) { L.push(`(local.set $fr ${rd(insn.dst,S,next)})`); flagState = { kind: akind, size: S }; }
          } else { const t=T(); L.push(`(local.set ${t} ${expr})`); L.push(wr(insn.dst,S,`(local.get ${t})`,next));
            if (prod) { L.push(`(local.set $fr (local.get ${t}))`); flagState = { kind: akind, size: S }; } }
          break; }
        case 'adc': case 'sbb': {
          // add/sub with carry: read CF-in from the live producer, compute the
          // result and the new carry-out, then (if consumed) materialize the
          // full flags — $fa/$fb/$fr for OF/SF/ZF and $cf for the carry.
          const prod = (producers.has(ii));
          const isSub = insn.mnem === 'sbb';
          const av = T(), bv = T(), cfv = T();
          L.push(`(local.set ${av} ${rd(insn.dst,S,next)})`);
          L.push(`(local.set ${bv} ${rd(insn.src,S,next)})`);
          L.push(`(local.set ${cfv} ${getCF()})`);
          const res = T(), cfout = T();
          if (!isSub) {
            if (S === 8) { const s1 = T();
              L.push(`(local.set ${s1} (i64.add (local.get ${av}) (local.get ${bv})))`);
              L.push(`(local.set ${res} (i64.add (local.get ${s1}) (local.get ${cfv})))`);
              L.push(`(local.set ${cfout} (i64.extend_i32_u (i32.or (i64.lt_u (local.get ${s1}) (local.get ${av})) (i64.lt_u (local.get ${res}) (local.get ${s1})))))`);
            } else { const sum = T();
              L.push(`(local.set ${sum} (i64.add (i64.add (local.get ${av}) (local.get ${bv})) (local.get ${cfv})))`);
              L.push(`(local.set ${res} (i64.and (local.get ${sum}) (i64.const ${m})))`);
              L.push(`(local.set ${cfout} (i64.and (i64.shr_u (local.get ${sum}) (i64.const ${S*8})) (i64.const 1)))`);
            }
          } else {
            if (S === 8) { const t = T();
              L.push(`(local.set ${res} (i64.sub (i64.sub (local.get ${av}) (local.get ${bv})) (local.get ${cfv})))`);
              L.push(`(local.set ${t} (i64.add (local.get ${bv}) (local.get ${cfv})))`);
              L.push(`(local.set ${cfout} (i64.extend_i32_u (i32.or (i64.lt_u (local.get ${t}) (local.get ${bv})) (i64.gt_u (local.get ${t}) (local.get ${av})))))`);
            } else {
              L.push(`(local.set ${res} (i64.and (i64.sub (i64.sub (local.get ${av}) (local.get ${bv})) (local.get ${cfv})) (i64.const ${m})))`);
              L.push(`(local.set ${cfout} (i64.extend_i32_u (i64.gt_u (i64.add (local.get ${bv}) (local.get ${cfv})) (local.get ${av}))))`);
            }
          }
          L.push(wr(insn.dst, S, `(local.get ${res})`, next));
          if (prod) {
            L.push(`(local.set $fa (local.get ${av}))`, `(local.set $fb (local.get ${bv}))`,
                   `(local.set $fr (local.get ${res}))`, `(local.set $cf (local.get ${cfout}))`);
            flagState = { kind: isSub ? 'sbb' : 'adc', size: S };
          }
          break; }
        case 'cmp': setFlags('sub',S,rd(insn.dst,S,next),rd(insn.src,S,next),`(i64.and (i64.sub ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)}) (i64.const ${m}))`); break;
        case 'test': setFlags('logic',S,null,null,`(i64.and ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)})`); break;
        case 'inc': case 'dec': {
          const prod = (producers.has(ii));
          let expr;
          let i32e = null;
          if (S === 4 && insn.dst.kind === 'reg') { i32e = `(${insn.mnem==='inc'?'i32.add':'i32.sub'} ${rd32(insn.dst,next)} (i32.const 1))`; expr = `(i64.extend_i32_u ${i32e})`; }
          else expr = `(i64.and (${insn.mnem==='inc'?'i64.add':'i64.sub'} ${rd(insn.dst,S,next)} (i64.const 1)) (i64.const ${m}))`;
          if (insn.dst.kind === 'reg') {
            if (i32e && isI32(insn.dst.r)) L.push(`(local.set ${reg(insn.dst.r)} ${i32e})`);
            else if (S >= 4 && !isI32(insn.dst.r)) L.push(`(local.set ${reg(insn.dst.r)} ${expr})`);
            else L.push(wr(insn.dst, S, expr, next));    // sub-width or i32-local: partial write
            if (prod) { L.push(`(local.set $fr ${rd(insn.dst,S,next)})`); flagState = { kind: insn.mnem, size: S }; } }
          else { const t=T(); L.push(`(local.set ${t} ${expr})`); L.push(wr(insn.dst,S,`(local.get ${t})`,next));
            if (prod) { L.push(`(local.set $fr (local.get ${t}))`); flagState = { kind: insn.mnem, size: S }; } }
          break; }
        case 'not': L.push(wr(insn.dst,S,`(i64.xor ${rd(insn.dst,S,next)} (i64.const ${m}))`,next)); break;
        case 'neg': { const t=T(), orig=T();
          // neg computes flags as (0 - old); capture the ORIGINAL operand
          // before the destructive write, or signed conditions after neg
          // (cmovl-based abs) invert.
          L.push(`(local.set ${orig} ${rd(insn.dst,S,next)})`);
          L.push(`(local.set ${t} (i64.and (i64.sub (i64.const 0) (local.get ${orig})) (i64.const ${m})))`);
          L.push(wr(insn.dst,S,`(local.get ${t})`,next));
          setFlags('sub',S,'(i64.const 0)',`(local.get ${orig})`,`(local.get ${t})`); break; }
        case 'shl': case 'shr': case 'sar': {
          if (S === 4 && insn.dst.kind === 'reg') {
            const c=`(i32.and ${rd32(insn.src,next)} (i32.const 31))`; const a=rd32(insn.dst,next); let e;
            if (insn.mnem==='shl') e=`(i32.shl ${a} ${c})`; else if (insn.mnem==='shr') e=`(i32.shr_u ${a} ${c})`; else e=`(i32.shr_s ${a} ${c})`;
            L.push(wr32reg(insn.dst.r, e));
            setFlags('logic', S, null, null, rd(insn.dst,S,next));   // nonzero-imm counts only (modeled() gates)
            break;
          }
          const c=`(i64.and ${rd(insn.src,1,next)} (i64.const ${S===8?63:31}))`; const a=rd(insn.dst,S,next); let e;
          if (insn.mnem==='shl') e=`(i64.shl ${a} ${c})`; else if (insn.mnem==='shr') e=`(i64.shr_u ${a} ${c})`; else e=`(i64.shr_s ${sx(a,S)} ${c})`;
          L.push(wr(insn.dst,S,`(i64.and ${e} (i64.const ${m}))`,next));
          setFlags('logic', S, null, null, rd(insn.dst,S,next));
          break; }
        case 'bsf': case 'bsr': {
          // dst = index of lowest (bsf) / highest (bsr) set bit; ZF <- src==0.
          // For src==0 the result is architecturally undefined — wasm ctz/clz
          // give the width, harmless since the consumer branches on ZF.
          const S8 = S === 8;
          const s = rd(insn.src, S, next);
          const e = insn.mnem === 'bsf'
            ? (S8 ? `(i64.ctz ${s})` : `(i64.extend_i32_u (i32.ctz ${rd32(insn.src,next)}))`)
            : (S8 ? `(i64.sub (i64.const 63) (i64.clz ${s}))` : `(i64.extend_i32_u (i32.sub (i32.const 31) (i32.clz ${rd32(insn.src,next)})))`);
          if (producers.has(ii)) { L.push(`(local.set $fr ${s})`); flagState = { kind: 'logic', size: S }; }
          L.push(wr(insn.dst, S, e, next));
          break; }
        case 'bswap': {
          const bs32 = (e) => `(i32.or (i32.or (i32.shl ${e} (i32.const 24)) (i32.and (i32.shl ${e} (i32.const 8)) (i32.const 16711680))) (i32.or (i32.and (i32.shr_u ${e} (i32.const 8)) (i32.const 65280)) (i32.shr_u ${e} (i32.const 24))))`;
          if (S === 4) L.push(wr32reg(insn.dst.r, bs32(rd32(insn.dst,next))));
          else { const t = T(); L.push(`(local.set ${t} ${rd(insn.dst,8,next)})`);
            L.push(`(local.set ${reg(insn.dst.r)} (i64.or (i64.shl (i64.extend_i32_u ${bs32(`(i32.wrap_i64 (local.get ${t}))`)}) (i64.const 32)) (i64.extend_i32_u ${bs32(`(i32.wrap_i64 (i64.shr_u (local.get ${t}) (i64.const 32)))`)})))`); }
          break; }
        case 'bt': case 'bts': case 'btr': case 'btc': {
          if (insn.dst.kind === 'reg') {
            const b = insn.src.kind === 'imm'
              ? `(i64.const ${(insn.src.v % BigInt(S*8)).toString()})`
              : `(i64.and ${rd(insn.src,S,next)} (i64.const ${S*8-1}))`;
            const tb = T(); L.push(`(local.set ${tb} ${b})`);
            setFlags('cf', S, null, null, `(i64.and (i64.shr_u ${rd(insn.dst,S,next)} (local.get ${tb})) (i64.const 1))`);
            if (insn.mnem === 'bts') L.push(wr(insn.dst,S,`(i64.or ${rd(insn.dst,S,next)} (i64.shl (i64.const 1) (local.get ${tb})))`,next));
            else if (insn.mnem === 'btr') L.push(wr(insn.dst,S,`(i64.and ${rd(insn.dst,S,next)} (i64.xor (i64.shl (i64.const 1) (local.get ${tb})) (i64.const -1)))`,next));
            else if (insn.mnem === 'btc') L.push(wr(insn.dst,S,`(i64.xor ${rd(insn.dst,S,next)} (i64.shl (i64.const 1) (local.get ${tb})))`,next));
            break;
          }
          // memory bit base: bit-string addressing — a register offset selects
          // the word S*(bitoff div S*8) beyond the effective address (signed,
          // flooring: arithmetic shift); an imm8 offset is just masked.
          const w = BigInt(S*8), lg = Math.log2(S*8);
          const ta = T(), tb = T();
          if (insn.src.kind === 'imm') {
            L.push(`(local.set ${tb} (i64.const ${(insn.src.v % w).toString()}))`);
            L.push(`(local.set ${ta} (i64.extend_i32_u ${wasmAddr(insn.dst, next)}))`);
          } else {
            const to = T();
            L.push(`(local.set ${to} ${sx(rd(insn.src,S,next),S)})`);
            L.push(`(local.set ${tb} (i64.and (local.get ${to}) (i64.const ${S*8-1})))`);
            L.push(`(local.set ${ta} (i64.extend_i32_u (i32.add ${wasmAddr(insn.dst, next)} ` +
                   `(i32.wrap_i64 (i64.mul (i64.shr_s (local.get ${to}) (i64.const ${lg})) (i64.const ${S}))))))`);
          }
          const A = `(i32.wrap_i64 (local.get ${ta}))`;
          const tv = T();
          L.push(`(local.set ${tv} (${LD[S]} ${A}))`);
          setFlags('cf', S, null, null, `(i64.and (i64.shr_u (local.get ${tv}) (local.get ${tb})) (i64.const 1))`);
          const bitm = `(i64.shl (i64.const 1) (local.get ${tb}))`;
          if (insn.mnem === 'bts') L.push(`(${ST[S]} ${A} (i64.or (local.get ${tv}) ${bitm}))`);
          else if (insn.mnem === 'btr') L.push(`(${ST[S]} ${A} (i64.and (local.get ${tv}) (i64.xor ${bitm} (i64.const -1))))`);
          else if (insn.mnem === 'btc') L.push(`(${ST[S]} ${A} (i64.xor (local.get ${tv}) ${bitm}))`);
          break; }
        case 'shld': case 'shrd': {
          // double shift; a zero count must leave dst untouched, so route
          // through a select. Flags are unmodeled (nearestProd poisons if used).
          const w = BigInt(S*8);
          const tc = T(); L.push(`(local.set ${tc} (i64.and ${rd(insn.src2,1,next)} (i64.const ${S===8?63:31})))`);
          const a = rd(insn.dst,S,next), b2 = rd(insn.src,S,next);
          const e = insn.mnem === 'shld'
            ? `(i64.or (i64.shl ${a} (local.get ${tc})) (i64.shr_u ${b2} (i64.sub (i64.const ${w}) (local.get ${tc}))))`
            : `(i64.or (i64.shr_u ${a} (local.get ${tc})) (i64.shl ${b2} (i64.sub (i64.const ${w}) (local.get ${tc}))))`;
          L.push(wr(insn.dst,S,`(select ${andmask(e,S)} ${a} (i64.ne (local.get ${tc}) (i64.const 0)))`,next));
          break; }
        case 'rol': case 'ror': {
          // see the function-mode note: byte/word rotates must wrap within W bits
          const rot = insn.mnem === 'rol';
          if (S === 8) { const a=rd(insn.dst,8,next);
            const c=`(i32.and ${rd32(insn.src,next)} (i32.const 63))`;
            L.push(`(local.set ${reg(insn.dst.r)} (i64.${rot?'rotl':'rotr'} ${a} (i64.extend_i32_u ${c})))`); }
          else if (S === 4) { const c=`(i32.and ${rd32(insn.src,next)} (i32.const 31))`;
            if (insn.dst.kind === 'reg') L.push(wr32reg(insn.dst.r, `(i32.${rot?'rotl':'rotr'} ${rd32(insn.dst,next)} ${c})`));
            else L.push(wr(insn.dst,4,`(i64.and (i64.extend_i32_u (i32.${rot?'rotl':'rotr'} ${rd32(insn.dst,next)} ${c})) (i64.const ${m}))`,next)); }
          else { const W = S*8;
            const v = `(i32.and ${rd32(insn.dst,next)} (i32.const ${m}))`;
            const cW = `(i32.and ${rd32(insn.src,next)} (i32.const ${W-1}))`;
            const fwd = rot ? 'i32.shl' : 'i32.shr_u', back = rot ? 'i32.shr_u' : 'i32.shl';
            const e = `(i64.extend_i32_u (i32.and (i32.or (${fwd} ${v} ${cW}) (${back} ${v} (i32.sub (i32.const ${W}) ${cW}))) (i32.const ${m})))`;
            L.push(wr(insn.dst,S,e,next)); }
          break; }
        case 'cmov':   // dst = cond ? src : dst; cond() is an i32 boolean, exactly what select wants
          L.push(wr(insn.dst, S, `(select ${rd(insn.src,S,next)} ${rd(insn.dst,S,next)} ${cond(insn.cond)})`, next)); break;
        case 'setcc': L.push(wr(insn.dst, 1, `(i64.extend_i32_u ${cond(insn.cond)})`, next)); break;
        case 'imul2': case 'imul3': {
          // low-half product; identical bits for signed/unsigned, so a plain mul suffices.
          const bExpr = insn.mnem === 'imul3' ? insn.src2 : insn.src;
          if (S === 4 && insn.dst.kind === 'reg') {
            const a = insn.mnem === 'imul3' ? rd32(insn.src,next) : rd32(insn.dst,next);
            L.push(wr32reg(insn.dst.r, `(i32.mul ${a} ${rd32(bExpr,next)})`));
          } else {
            const a = insn.mnem === 'imul3' ? rd(insn.src,S,next) : rd(insn.dst,S,next);
            L.push(wr(insn.dst,S,andmask(`(i64.mul ${a} ${rd(bExpr,S,next)})`,S),next));
          }
          break; }
        case 'mul1': case 'imul1': {
          // one-operand widening multiply: rdx:rax = rax * src.
          const sgn = insn.mnem === 'imul1';
          if (S <= 4) {                    // widths <= 32 fit in one i64 product
            const ext = sgn ? 'i64.extend_i32_s' : 'i64.extend_i32_u';
            const a = `(${ext} ${rd32({kind:'reg',r:0,size:S},next)})`;
            const b = `(${ext} ${rd32(insn.src,next)})`;
            const t = T(); L.push(`(local.set ${t} (i64.mul ${a} ${b}))`);
            L.push(wr32reg(0, `(i32.wrap_i64 ${andmask(`(local.get ${t})`,S)})`));       // rax = low
            L.push(wr32reg(2, `(i32.wrap_i64 (i64.shr_u (local.get ${t}) (i64.const ${S*8})))`)); // rdx = high
            // CF=OF: product does not fit the low half
            setFlags('cf', S, null, null, sgn
              ? `(i64.extend_i32_u (i64.ne (local.get ${t}) ${sx(andmask(`(local.get ${t})`,S),S)}))`
              : `(i64.extend_i32_u (i64.ne (i64.shr_u (local.get ${t}) (i64.const ${S*8})) (i64.const 0)))`);
            break;
          }
          // 64x64 -> 128. WASM has no mulhi, so build the high word from the
          // four 32-bit half-products; the low word is the wrapping i64 product.
          const a = T(), b = T(), al = T(), ah = T(), bl = T(), bh = T(),
                lh = T(), hl = T(), mid = T(), hi = T(), lo = T();
          L.push(`(local.set ${a} ${rd({kind:'reg',r:0,size:8},8,next)})`);
          L.push(`(local.set ${b} ${rd(insn.src,8,next)})`);
          L.push(`(local.set ${lo} (i64.mul (local.get ${a}) (local.get ${b})))`);
          L.push(`(local.set ${al} (i64.and (local.get ${a}) (i64.const 0xFFFFFFFF)))`);
          L.push(`(local.set ${ah} (i64.shr_u (local.get ${a}) (i64.const 32)))`);
          L.push(`(local.set ${bl} (i64.and (local.get ${b}) (i64.const 0xFFFFFFFF)))`);
          L.push(`(local.set ${bh} (i64.shr_u (local.get ${b}) (i64.const 32)))`);
          L.push(`(local.set ${lh} (i64.mul (local.get ${al}) (local.get ${bh})))`);
          L.push(`(local.set ${hl} (i64.mul (local.get ${ah}) (local.get ${bl})))`);
          // mid = (al*bl >> 32) + (lh & 0xffffffff) + (hl & 0xffffffff)
          L.push(`(local.set ${mid} (i64.add (i64.add ` +
                 `(i64.shr_u (i64.mul (local.get ${al}) (local.get ${bl})) (i64.const 32)) ` +
                 `(i64.and (local.get ${lh}) (i64.const 0xFFFFFFFF))) ` +
                 `(i64.and (local.get ${hl}) (i64.const 0xFFFFFFFF))))`);
          // hi = ah*bh + (lh>>32) + (hl>>32) + (mid>>32)
          L.push(`(local.set ${hi} (i64.add (i64.add (i64.add ` +
                 `(i64.mul (local.get ${ah}) (local.get ${bh})) ` +
                 `(i64.shr_u (local.get ${lh}) (i64.const 32))) ` +
                 `(i64.shr_u (local.get ${hl}) (i64.const 32))) ` +
                 `(i64.shr_u (local.get ${mid}) (i64.const 32))))`);
          if (sgn) {   // signed correction: hi -= (a<0?b:0) + (b<0?a:0)
            L.push(`(local.set ${hi} (i64.sub (local.get ${hi}) ` +
                   `(i64.and (i64.shr_s (local.get ${a}) (i64.const 63)) (local.get ${b}))))`);
            L.push(`(local.set ${hi} (i64.sub (local.get ${hi}) ` +
                   `(i64.and (i64.shr_s (local.get ${b}) (i64.const 63)) (local.get ${a}))))`);
          }
          L.push(wr({kind:'reg',r:0,size:8},8,`(local.get ${lo})`,next));   // rax = low 64
          L.push(wr({kind:'reg',r:2,size:8},8,`(local.get ${hi})`,next));   // rdx = high 64
          // CF=OF: high half is not the zero/sign extension of the low half
          setFlags('cf', 8, null, null, sgn
            ? `(i64.extend_i32_u (i64.ne (local.get ${hi}) (i64.shr_s (local.get ${lo}) (i64.const 63))))`
            : `(i64.extend_i32_u (i64.ne (local.get ${hi}) (i64.const 0)))`);
          break; }
        case 'cwde': {   // sign-extend the low half of rax into the full width (cbw/cwde/cdqe)
          const half = S === 8 ? 4 : S === 4 ? 2 : 1;
          L.push(wr({kind:'reg',r:0,size:S}, S, sx(rd({kind:'reg',r:0,size:half},half,next),half), next)); break; }
        case 'cdq': {    // sign of rax fills rdx (cwd/cdq/cqo)
          L.push(wr({kind:'reg',r:2,size:S}, S, andmask(`(i64.shr_s ${sx(rd({kind:'reg',r:0,size:S},S,next),S)} (i64.const 63))`,S), next)); break; }
        case 'div1': case 'idiv1': {
          const sgn = insn.mnem === 'idiv1';
          const rax = {kind:'reg',r:0,size:S}, rdx = {kind:'reg',r:2,size:S};
          let q, rm;
          if (S === 8) {
            // The dividend is the 128-bit rdx:rax, but it fits in 64 bits iff
            // rdx is the zero/sign-extension of rax — the case every compiler
            // actually emits. When the preceding insn provably sets that up
            // (xor rdx,rdx / cqo) we skip the check; otherwise guard at
            // runtime and deopt to the interpreter for a true 128-bit divide.
            const prev = ii > 0 ? blk.insns[ii-1] : null;
            const zeroed = prev && prev.mnem === 'xor' && prev.dst?.kind==='reg' && prev.dst.r===2 && prev.src?.kind==='reg' && prev.src.r===2;
            const cqo = prev && prev.mnem === 'cdq' && (prev.size||8) === 8;
            const patterned = sgn ? cqo : zeroed;
            if (!patterned) {
              const bad = sgn
                ? `(i64.ne ${rd(rdx,8,next)} (i64.shr_s ${rd(rax,8,next)} (i64.const 63)))`
                : `(i64.ne ${rd(rdx,8,next)} (i64.const 0))`;
              L.push(`(if ${bad} (then`, ...spillAll(),
                     `(return (call $x_deopt (i64.const ${hexs(insn.rip)}) (local.get $rsp0)))))`);
            }
            const d = rd(insn.src,8,next), n = rd(rax,8,next);
            q = `(${sgn?'i64.div_s':'i64.div_u'} ${n} ${d})`; rm = `(${sgn?'i64.rem_s':'i64.rem_u'} ${n} ${d})`;
          } else if (S === 1) {
            // dividend is AX; quotient -> AL, remainder -> AH
            const num0 = rd({kind:'reg',r:0,size:2},2,next);
            const num = sgn ? sx(num0,2) : num0;
            const d = sgn ? sx(rd(insn.src,1,next),1) : rd(insn.src,1,next);
            q = `(${sgn?'i64.div_s':'i64.div_u'} ${num} ${d})`; rm = `(${sgn?'i64.rem_s':'i64.rem_u'} ${num} ${d})`;
          } else {
            // dividend = rdx:rax at 2S*8 bits, fits in i64
            const num0 = `(i64.or (i64.shl ${rd(rdx,S,next)} (i64.const ${S*8})) ${rd(rax,S,next)})`;
            const num = sgn ? sx(num0, S*2) : num0;
            const d = sgn ? sx(rd(insn.src,S,next),S) : rd(insn.src,S,next);
            q = `(${sgn?'i64.div_s':'i64.div_u'} ${num} ${d})`; rm = `(${sgn?'i64.rem_s':'i64.rem_u'} ${num} ${d})`;
          }
          const tq = T(), tr = T();          // capture both before any write clobbers rax/rdx
          L.push(`(local.set ${tq} ${q})`, `(local.set ${tr} ${rm})`);
          if (S === 1) { L.push(wr({kind:'reg',r:0,size:1},1,`(local.get ${tq})`,next)); L.push(wr({kind:'reg',r:0,size:1,high:true},1,`(local.get ${tr})`,next)); }
          else { L.push(wr(rax,S,`(local.get ${tq})`,next)); L.push(wr(rdx,S,`(local.get ${tr})`,next)); }
          break; }
        case 'xchg': {   // swap dst and src (LOCK is a no-op single-threaded); no flags
          const ta = T(), tb = T();
          L.push(`(local.set ${ta} ${rd(insn.dst,S,next)})`);
          L.push(`(local.set ${tb} ${rd(insn.src,S,next)})`);
          L.push(wr(insn.dst,S,`(local.get ${tb})`,next));
          L.push(wr(insn.src,S,`(local.get ${ta})`,next));
          break; }
        case 'cmpxchg': {   // glib atomics: threads never preempt inside a unit, so LOCK is free
          const tv = T(), ta = T(), tr = T();
          L.push(`(local.set ${tv} ${rd(insn.dst,S,next)})`);
          L.push(`(local.set ${ta} ${rd({kind:'reg',r:0,size:S},S,next)})`);
          L.push(`(local.set ${tr} (i64.and (i64.sub (local.get ${ta}) (local.get ${tv})) (i64.const ${m})))`);
          setFlags('sub', S, `(local.get ${ta})`, `(local.get ${tv})`, `(local.get ${tr})`);
          L.push(`(if (i64.eq (local.get ${ta}) (local.get ${tv}))`,
                 `(then ${wr(insn.dst,S,rd(insn.src,S,next),next)})`,
                 `(else ${wr({kind:'reg',r:0,size:S},S,`(local.get ${tv})`,next)}))`);
          break; }
        case 'xadd': {   // dst+src -> dst, old dst -> src; add flags
          const ta = T(), tb = T(), tr = T();
          L.push(`(local.set ${ta} ${rd(insn.dst,S,next)})`);
          L.push(`(local.set ${tb} ${rd(insn.src,S,next)})`);
          L.push(`(local.set ${tr} (i64.and (i64.add (local.get ${ta}) (local.get ${tb})) (i64.const ${m})))`);
          setFlags('add', S, `(local.get ${ta})`, `(local.get ${tb})`, `(local.get ${tr})`);
          L.push(wr(insn.src,S,`(local.get ${ta})`,next));
          L.push(wr(insn.dst,S,`(local.get ${tr})`,next));
          break; }
        case 'rdtsc':   // synthetic timestamp lives in the interpreter: deopt to it
          L.push(...spillAll(), `(return (call $x_deopt (i64.const ${hexs(insn.rip)}) (local.get $rsp0)))`);
          break;
        case 'leave':    // mov rsp,rbp ; pop rbp
          L.push(`(local.set $r4 ${rd({kind:'reg',r:5,size:8},8,next)})`);
          L.push(wr({kind:'reg',r:5,size:8},8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next));
          L.push(`(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          break;
        case 'call': {   // push return address, spill, direct wasm call (or callout), reload
          const target = (next + insn.rel) & MM;
          L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (i64.const ${hexs(next)}))`);
          L.push(...spillAll());
          if (canDirect(target.toString()))
            // stack-budget check even on direct calls: past it, x_callout
            // interprets the callee instead of nesting another wasm frame
            L.push(ftSave(),
                   `(if ${ftOk}`,
                   `  (then ${ftBurn} (drop (call $f_${target.toString(16)})) ${ftRestore})`,
                   `  (else (drop (call $x_callout (i64.const ${hexs(target)})))))`);
          else {
            // out-of-unit target: it may be compiled in ANOTHER unit — chain
            // through the global dispatch table without a JS round-trip
            usesFtr = true;
            L.push(`(local.set $fti (call $ftr (i64.const ${hexs(target)})))`,
                   ftSave(),
                   `(if ${ftHit}`,
                   `  (then ${ftBurn} (drop (call_indirect $ft (type $uft) (local.get $fti))) ${ftRestore})`,
                   `  (else (drop (call $x_callout (i64.const ${hexs(target)})))))`);
          }
          L.push(...reloadAll());
          break; }
        case 'callind': {   // compute target BEFORE the push moves rsp
          const t = T(); L.push(`(local.set ${t} ${rd(insn.src,8,next)})`);
          L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (i64.const ${hexs(next)}))`);
          L.push(...spillAll());
          usesFtr = true;
          L.push(`(local.set $fti (call $ftr (local.get ${t})))`,
                 ftSave(),
                 `(if ${ftHit}`,
                 `  (then ${ftBurn} (drop (call_indirect $ft (type $uft) (local.get $fti))) ${ftRestore})`,
                 `  (else (drop (call $x_callout (local.get ${t})))))`);
          L.push(...reloadAll());
          break; }
        case 'syscall':
          // pass this syscall's guest rip: a BLOCKING syscall (poll/select/
          // read) suspends the whole engine by unwinding the wasm frames and
          // recording this rip so resume re-executes the syscall exactly here
          L.push(...spillAll(), `(call $x_syscall (i64.const ${hexs(insn.rip)}))`, ...reloadAll());
          break;
        case 'cld': break;                                                    // DF stays 0 (bulk ops assume it)
        case 'stos': {
          const woffc = Number(BigInt.asIntN(32, woff));
          const rdiOff = `(i32.add (i32.wrap_i64 (local.get $r7)) (i32.const ${woffc}))`;
          if (insn.rep && hasStd) throw new Error('AOT: rep stos with std @ '+insn.rip.toString(16));
          if (insn.rep && S === 1) {                                          // byte fill: one bulk op
            L.push(`(memory.fill ${rdiOff} (i32.wrap_i64 (i64.and (local.get $r0) (i64.const 0xFF))) (i32.wrap_i64 (local.get $r1)))`);
            L.push(`(local.set $r7 (i64.add (local.get $r7) (local.get $r1)))`, `(local.set $r1 (i64.const 0))`);
          } else if (insn.rep) {                                             // strided: forward wasm loop
            const e = '$se_'+insn.rip.toString(16), lp = '$sl_'+insn.rip.toString(16);
            L.push(`(block ${e} (loop ${lp} (br_if ${e} (i64.eqz (local.get $r1)))`,
                   `(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} ${rd({kind:'reg',r:0,size:S},S,next)})`,
                   `(local.set $r7 (i64.add (local.get $r7) (i64.const ${S}))) (local.set $r1 (i64.sub (local.get $r1) (i64.const 1))) (br ${lp})))`);
          } else {
            L.push(`(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} ${rd({kind:'reg',r:0,size:S},S,next)})`,
                   `(local.set $r7 (i64.add (local.get $r7) (i64.const ${S})))`);
          }
          break; }
        case 'movs': {
          const woffc = Number(BigInt.asIntN(32, woff));
          if (insn.rep && hasStd) throw new Error('AOT: rep movs with std @ '+insn.rip.toString(16));
          if (insn.rep && S === 1) {                                          // byte copy: one bulk op
            L.push(`(memory.copy (i32.add (i32.wrap_i64 (local.get $r7)) (i32.const ${woffc})) (i32.add (i32.wrap_i64 (local.get $r6)) (i32.const ${woffc})) (i32.wrap_i64 (local.get $r1)))`);
            L.push(`(local.set $r6 (i64.add (local.get $r6) (local.get $r1)))`, `(local.set $r7 (i64.add (local.get $r7) (local.get $r1)))`, `(local.set $r1 (i64.const 0))`);
          } else if (insn.rep) {
            const e = '$me_'+insn.rip.toString(16), lp = '$ml_'+insn.rip.toString(16);
            L.push(`(block ${e} (loop ${lp} (br_if ${e} (i64.eqz (local.get $r1)))`,
                   `(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} (${LD[S]} ${wasmAddr({base:6,index:-1,disp:0n},next)}))`,
                   `(local.set $r6 (i64.add (local.get $r6) (i64.const ${S}))) (local.set $r7 (i64.add (local.get $r7) (i64.const ${S}))) (local.set $r1 (i64.sub (local.get $r1) (i64.const 1))) (br ${lp})))`);
          } else {
            L.push(`(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} (${LD[S]} ${wasmAddr({base:6,index:-1,disp:0n},next)}))`,
                   `(local.set $r6 (i64.add (local.get $r6) (i64.const ${S})))`, `(local.set $r7 (i64.add (local.get $r7) (i64.const ${S})))`);
          }
          break; }
        case 'cmps': case 'scas': {
          // repe/repne string compare; flags ('sub' kind) come from the LAST
          // element pair, stored into $fa/$fb/$fr every iteration
          if (hasStd) throw new Error('AOT: cmps/scas with std @ '+insn.rip.toString(16));
          const isCmps = insn.mnem === 'cmps';
          const ldA = isCmps ? `(${LD[S]} ${wasmAddr({base:6,index:-1,disp:0n},next)})`
                             : (S === 8 ? `(local.get $r0)` : `(i64.and (local.get $r0) (i64.const ${m}))`);
          const ldB = `(${LD[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)})`;
          const body = [
            `(local.set $fa ${ldA})`,
            `(local.set $fb ${ldB})`,
            `(local.set $fr (i64.and (i64.sub (local.get $fa) (local.get $fb)) (i64.const ${m})))`,
            ...(isCmps ? [`(local.set $r6 (i64.add (local.get $r6) (i64.const ${S})))`] : []),
            `(local.set $r7 (i64.add (local.get $r7) (i64.const ${S})))`,
          ];
          if (insn.rep || insn.rep2) {
            const e = '$ce_'+insn.rip.toString(16), lp = '$cl_'+insn.rip.toString(16);
            // repe (rep): stop when fr != 0; repne (rep2): stop when fr == 0
            const stop = insn.rep2 ? `(i64.eqz (local.get $fr))` : `(i64.ne (local.get $fr) (i64.const 0))`;
            L.push(`(block ${e} (loop ${lp} (br_if ${e} (i64.eqz (local.get $r1)))`,
                   ...body,
                   `(local.set $r1 (i64.sub (local.get $r1) (i64.const 1)))`,
                   `(br_if ${e} ${stop}) (br ${lp})))`);
          } else L.push(...body);
          flagState = { kind: 'sub', size: S };
          break; }
        case 'push': {
          // a disciplined savedI32 reg's prologue push reads its regfile slot,
          // which still holds the caller's full 64-bit value at that point.
          // The operand is read BEFORE rsp moves: `push 0x68(%rsp)` (stack
          // argument forwarding — glib's g_signal_new_valist) must see the
          // OLD rsp, so evaluate into a temp first.
          const srcExpr = (insn.src.kind === 'reg' && savedI32(insn.src.r))
            ? `(i64.load (i32.const ${insn.src.r*8}))` : rd(insn.src,8,next);
          const t = T();
          L.push(`(local.set ${t} ${srcExpr})`,
                 `(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (local.get ${t}))`); break; }
        case 'pop': {
          if (insn.dst.kind === 'reg' && savedI32(insn.dst.r))   // epilogue restore straight to the regfile
            L.push(`(i64.store (i32.const ${insn.dst.r*8}) (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)}))`, `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          else
            L.push(wr(insn.dst,8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next),`(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          break; }
        case 'sse':          emitSSE(insn, next, L, setFlags); break;
        case 'ssegrpshift':  emitSSEShift(insn, L); break;
        case 'jmp': case 'jcc': case 'ret': case 'retn': case 'jmpind': case 'udec': break;  // terminator handled below
        default: throw new Error('AOT: unhandled '+insn.mnem+' @ '+insn.rip.toString(16));
      }
    }
    // terminator as label-based branches (RPO indices). In dispatch mode a
    // non-fallthrough edge sets $pc and re-enters the dispatch loop instead of
    // branching to a scope label; natural fall-through (j===i+1) is identical
    // in both layouts since block i+1's body immediately follows block i's.
    const t = term[i];
    const last = blk.insns[blk.insns.length-1], lnext = last.next;
    const labelFor = (j) => j <= i ? '$loop_'+j : '$blk_'+j;
    const goto = (j) => { if (j < 0) throw new Error('AOT: branch into undecoded code');
      // forward edges break straight to the target block ($b{j} closes just
      // before body j, so `br $b{j}` lands at its start); only backward
      // edges pay the $pc + br_table dispatcher round-trip. Measured before:
      // 3044 of 3248 edges in a hot unit went through the dispatcher.
      if (DISP) return j > i ? `(br $b${j})` : j === i ? `(br $l${i})` : `(local.set $pc (i32.const ${j})) (br $L_disp)`;
      return `(br ${labelFor(j)})`; };
    const brTo = (j) => j === i+1 ? '' : goto(j);
    // A branch TARGET the analyzer couldn't decode (an address past a decode
    // failure, a cut-off jump-table row) becomes a cold deopt edge instead of
    // poisoning the function: if control actually goes there, the engine
    // resumes in the interpreter at that address, which faults exactly as
    // native would if the bytes are truly garbage.
    const deoptTo = (addr) => [`(local.set $rex (i64.const ${hexs(addr)}))`,
      ...spillAll(), `(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`];
    if (t.kind === 'jcc') {
      const c = cond(last.cond);
      const T = t.t, F = t.f;
      if (T < 0 || F < 0) {
        if (T < 0 && F < 0) { L.push(`(if ${c} (then ${deoptTo(t.ta).join('\n')}))`); L.push(...deoptTo(t.fa)); }
        else if (T < 0) { L.push(`(if ${c} (then ${deoptTo(t.ta).join('\n')}))`); const b = brTo(F); if (b) L.push(b); }
        else { L.push(`(if (i32.eqz ${c}) (then ${deoptTo(t.fa).join('\n')}))`); const b = brTo(T); if (b) L.push(b); }
      } else if (DISP) {
        if (T === i+1 && F === i+1) { /* both fall through */ }
        else if (F === i+1) L.push(`(if ${c} (then ${goto(T)}))`);
        else if (T === i+1) L.push(`(if (i32.eqz ${c}) (then ${goto(F)}))`);
        else L.push(`(if ${c} (then ${goto(T)}) (else ${goto(F)}))`);
      } else {
        const lbl = (j) => labelFor(j);
        if (T === i+1 && F === i+1) { /* both fall through */ }
        else if (T !== i+1 && F === i+1) L.push(`(br_if ${lbl(T)} ${c})`);
        else if (T === i+1 && F !== i+1) L.push(`(br_if ${lbl(F)} (i32.eqz ${c}))`);
        else { L.push(`(br_if ${lbl(T)} ${c})`); L.push(`(br ${lbl(F)})`); }
      }
    } else if (t.kind === 'jmp') {
      if (t.t < 0) L.push(...deoptTo(t.ta));
      else { const b = brTo(t.t); if (b) L.push(b); }
    } else if (t.kind === 'ret') {
      // pop the return address, retire the frame, hand the exit rip back
      L.push(`(local.set $rex (i64.load ${wasmAddr({base:4,index:-1,disp:0n},lnext)}))`);
      L.push(`(local.set $r4 (i64.add (local.get $r4) (i64.const ${8 + t.pad})))`);
      L.push(...spillExit());
      L.push(`(return (local.get $rex))`);
    } else if (t.kind === 'jtab') {
      // indirect jump through a discovered jump table: resolve the COMPUTED
      // address against this function's block map and re-enter the dispatch
      // loop — one in-wasm branch per computed goto instead of a JS deopt
      // round-trip. An unknown address (tail call, an undecoded table row)
      // still deopts, so resolution is exact by construction.
      L.push(`(local.set $rex ${rd(t.src,8,lnext)})`);
      L.push(`(local.set $pc (call $jtr_${fnAddr.toString(16)} (local.get $rex)))`);
      L.push(`(br_if $L_disp (i32.ge_s (local.get $pc) (i32.const 0)))`);
      L.push(...spillAll());
      L.push(...tailJmp());
      L.push(`(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`);
    } else if (t.kind === 'deopt') {
      // indirect jump (jump table / tail call) or undecodable byte:
      // hand the frame to the engine at the computed target / that rip
      L.push(`(local.set $rex ${t.src ? rd(t.src,8,lnext) : `(i64.const ${hexs(t.at)})`})`);
      L.push(...spillAll());
      if (t.src) L.push(...tailJmp());
      L.push(`(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`);
    } else {                                              // fall-through
      if (t.t < 0) L.push(...deoptTo(t.ta));
      else { const b = brTo(t.t); if (b) L.push(b); }
    }
    return L.join('\n      ');
  }

  const bodies = []; for (let i=0;i<N;i++) bodies.push(emitBlock(i));

  const name = 'f_' + fnAddr.toString(16);
  let wat = `  (func $${name} (export "${name}") (result i64)\n`;
  for (let r=0;r<16;r++) wat += `    (local $r${r} ${isI32(r)?'i32':'i64'})\n`;
  wat += '    (local $fa i64) (local $fb i64) (local $fr i64) (local $cf i64) (local $rsp0 i64) (local $rex i64)\n';
  if (DISP) wat += '    (local $pc i32)\n';
  if (usesFtr) wat += '    (local $fti i32)\n';
  if (usesFts) wat += '    (local $fts i32)\n';
  for (const r of xUsed) wat += `    (local ${xreg(r)} v128)\n`;
  for (const t of tmps) wat += `    (local ${t} i64)\n`;
  for (const t of vtmps) wat += `    (local ${t} v128)\n`;
  for (let r=0;r<16;r++) if (touched(r)) wat += '    ' + reloadR(r) + '\n';
  for (const r of xUsed) wat += '    ' + xReload(r) + '\n';
  wat += '    (local.set $rsp0 (local.get $r4))\n';
  wat += '    ' + ftInc + '\n';       // entry tax: this frame\'s stack weight
  if (DISP) {
    // flat br_table dispatch: $pc holds the current block's RPO index. Block
    // bodies run in order; a non-fallthrough edge sets $pc and br's $L_disp.
    wat += '    (block $exit_disp\n    (loop $L_disp\n';
    for (let k = N-1; k >= 0; k--) wat += `      (block $b${k}\n`;
    const tab = Array.from({length:N}, (_,k)=>'$b'+k).join(' ');
    wat += `      (br_table ${tab} $exit_disp (local.get $pc)))\n`;   // closes $b0
    for (let i=0;i<N;i++) {
      // every body gets a free loop label so a self-edge (tight single-block
      // loop — the hottest backward-edge kind) branches directly instead of
      // paying the $pc + br_table dispatcher round-trip
      wat += `      (loop $l${i}\n      ` + bodies[i] + ')\n';
      if (i < N-1) wat += `      )\n`;                                 // close $b${i+1}
    }
    wat += '    ))\n';                                                 // close loop + exit block
    wat += '    (unreachable)\n  )\n';
    if (hasJtab) {
      // address -> RPO index for every jump-table target, as a balanced
      // binary-search tree of ifs: log2(n) compares per computed goto
      const pairs = [...jtabUnion].map(j => [blocks[j].start, j]).sort((x,y) => x[0] < y[0] ? -1 : 1);
      const bs = (lo, hi) => {
        if (hi - lo === 1) return `(if (result i32) (i64.eq (local.get $a) (i64.const ${hexs(pairs[lo][0])})) (then (i32.const ${pairs[lo][1]})) (else (i32.const -1)))`;
        const mid = (lo + hi) >> 1;
        return `(if (result i32) (i64.lt_u (local.get $a) (i64.const ${hexs(pairs[mid][0])}))\n      (then ${bs(lo, mid)})\n      (else ${bs(mid, hi)}))`;
      };
      wat += `  (func $jtr_${fnAddr.toString(16)} (param $a i64) (result i32)\n    ${bs(0, pairs.length)}\n  )\n`;
    }
    return wat;
  }
  for (let i=0;i<N;i++) {
    for (const s of open[i]) wat += s.type==='loop' ? `      (loop ${s.label}\n` : `      (block ${s.label}\n`;
    wat += '      ' + bodies[i] + '\n';
    for (const _ of closeAfter[i]) wat += '      )\n';
  }
  wat += '    (unreachable)\n  )\n';        // every path leaves via ret/deopt
  return wat;
}

// ---- unit driver -----------------------------------------------------------
export function compileUnitWat(mem, entry, opts = {}) {
  const { guestBase, ramBase, maxFuncs = 96, maxInsns = 20000 } = opts;
  const funcs = new Map();                       // addrStr -> analysis
  const poisoned = new Set();                    // addrStr -> engine-only (callout)
  const pending = [entry];
  while (pending.length && funcs.size < maxFuncs) {
    const a = pending.shift(); const k = a.toString();
    if (funcs.has(k) || poisoned.has(k)) continue;
    try {
      let an;
      try { an = analyze(mem, a, { maxInsns, noJtab: !!globalThis.__noJtab }); }
      catch (e) {
        // jump-table discovery can push a function over the size budget;
        // it compiled before the feature, so retry without it
        if (!/function too large/.test(e.message) || globalThis.__noJtab) throw e;
        an = analyze(mem, a, { maxInsns, noJtab: true });
      }
      // a body that starts undecodable compiles to a pure deopt — worse than
      // useless: dispatching it can ping-pong with the engine. Poison instead
      // so control reaches the interpreter, which faults faithfully.
      if (an.blocks[0].insns[0].mnem === 'udec') throw new Error('entry undecodable');
      // A PLT/IFUNC trampoline (endbr64/nops then `jmp *GOT`) must stay a
      // callout, not a direct wasm call: a direct call would run its indirect
      // jump in wasm, deopt, and unwind the CALLER's live frame every time.
      // Poisoning it makes callers reach it via x_callout, which runs it to
      // completion (dispatching the real target) and returns — frame intact.
      { const b0 = an.blocks[0].insns; let tramp = false;
        for (const insn of b0) { if (insn.mnem === 'nop') continue; tramp = insn.mnem === 'jmpind'; break; }
        if (tramp && an.blocks.length === 1) throw new Error('trampoline -> callout'); }
      funcs.set(k, an);
      for (const c of an.calls) if (!funcs.has(c) && !poisoned.has(c)) pending.push(BigInt(c));
    } catch (e) { poisoned.add(k); if (k === entry.toString()) throw e; }
  }
  const canDirect = (k) => funcs.has(k) && !poisoned.has(k);
  const ctx = { guestBase, ramBase, canDirect };
  // emit; a failure poisons that function and re-emits — its callers switch
  // from direct wasm calls to callout escapes
  const texts = new Map();
  for (let round = 0; ; round++) {
    if (round > 16) throw new Error('AOT: poison did not converge');
    texts.clear(); let repoison = false;
    for (const [k, an] of funcs) {
      if (poisoned.has(k)) continue;
      try { texts.set(k, emitUnitFunction(an, BigInt(k), ctx)); }
      catch (e) {
        if (k === entry.toString()) throw e;
        poisoned.add(k); repoison = true;
      }
    }
    if (!repoison) break;
  }
  let wat = '(module\n  (import "js" "mem" (memory 4096))\n';
  wat += '  (import "env" "syscall" (func $x_syscall (param i64)))\n';
  wat += '  (import "env" "callout" (func $x_callout (param i64) (result i64)))\n';
  wat += '  (import "env" "deopt" (func $x_deopt (param i64 i64) (result i64)))\n';
  // the global dispatch table + its in-wasm resolver, iff some site chains
  // through it (indirect call, out-of-unit static call, indirect tail jump)
  if ([...texts.values()].some(t => t.includes('(call $ftr '))) {
    wat += '  (import "js" "ftab" (table $ft 0 funcref))\n';
    wat += '  (type $uft (func (result i64)))\n';
    wat += `  (func $ftr (param $a i64) (result i32)
    (local $lo i32) (local $hi i32) (local $mid i32) (local $p i32) (local $v i64)
    (local.set $hi (i32.load (i32.const ${FTMAP})))
    (block $miss
      (loop $l
        (br_if $miss (i32.ge_u (local.get $lo) (local.get $hi)))
        (local.set $mid (i32.shr_u (i32.add (local.get $lo) (local.get $hi)) (i32.const 1)))
        (local.set $p (i32.add (i32.const ${FTMAP + 16}) (i32.shl (local.get $mid) (i32.const 4))))
        (local.set $v (i64.load (local.get $p)))
        (if (i64.eq (local.get $v) (local.get $a))
          (then (return (i32.load (i32.add (local.get $p) (i32.const 8))))))
        (if (i64.lt_u (local.get $a) (local.get $v))
          (then (local.set $hi (local.get $mid)))
          (else (local.set $lo (i32.add (local.get $mid) (i32.const 1)))))
        (br $l)))
    (i32.const -1))\n`;
  }
  let blocks = 0;
  for (const [k, t] of texts) { wat += t; blocks += funcs.get(k).blocks.length; }
  wat += ')\n';
  return { wat,
           entryName: 'f_' + entry.toString(16),
           funcs: [...texts.keys()].map(k => BigInt(k)),
           poisoned: [...poisoned].map(k => BigInt(k)),
           blocks };
}

// Back-compat name: a single-entry compile is just a unit rooted there.
export function compileFunctionWat(mem, entry, opts = {}) {
  return compileUnitWat(mem, entry, opts);
}
