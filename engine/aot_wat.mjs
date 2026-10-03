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
// an open-addressed hash table of (guest address i64, funcref-table index
// i32) 16-byte slots living in wasm-memory scratch below the guest RAM base
// (RAMOFF is 1MB; the regfile ends at 512). The engine inserts a slot per
// registered compiled function; every unit's $ftr hashes into it and
// call_indirect's through the shared imported table — so indirect calls,
// cross-unit static calls, and indirect tail jumps chain wasm-to-wasm with no
// JS boundary and no regfile sync. A miss falls back to x_callout / x_deopt.
//
// This was a sorted array with a binary search, which is what a resolver
// looks like until you measure it: at 1,226 registered units a lookup cost
// 15.5ns even with 90% of lookups hitting a 24-entry hot set (21.3ns at
// GIMP's 7,684 units), against 3.6-4.2ns for the hash. CPython's loop30M
// resolves 297M times in an 11s run, so the ~12ns is seconds. Insertion
// drops from an O(n) memmove to a store, which also cuts tier-up time.
// The hash REPLACES the sorted array that used to live at FTMAP+16; nothing
// writes that region any more. A unit built before the hash binary-searches
// it and would therefore misresolve against this engine, so a packed page
// must be repacked when the resolver changes (demo/gimp is). FTMAP+16 up to
// FTHASH is dead space, reclaimable together with the 8-byte-slot change
// that would lift the unit ceiling — both need a repack, so they belong in
// one step.
export const FTMAP = 0x10000;        // u32 count at +0, u32 chain depth at +8, u32 fuel at +12
export const FTHASH = 0x60000;       // hash slots: i64 key (guest addr, 0 = empty), i32 table slot, pad
export const FTHBITS = 15, FTSLOTS = 1 << FTHBITS;   // 32768 slots * 16B = 512KB, ends below RAMOFF
export const FTHMASK = FTSLOTS * 16 - 1;
export const FTHBYTES = FTSLOTS * 16;
// registered entries, capped to keep the load factor (here 61%) low enough
// that linear probing stays short
export const FTMAP_MAX = 20000;
export const MXCSR_SLOT = 144;   // regfile slot: the SSE control word, kept inert (see the stmxcsr/ldmxcsr emit)
export const DF_SLOT = 152;      // regfile slot: the direction flag, so std/cld survive the unit boundary
export const ESTICKY_SLOT = 160;  // regfile slot: the AC/ID bits popf stored, which pushf reads back
// The SSSE3 / SSE4.1 forms (decoded as mnem 'sse4') the compiled tier emits; the rest stay escapes.
const SSE4_AOT = new Set([
  0x3800, 0x3829, 0x3837, 0x3838, 0x3839, 0x383a, 0x383b, 0x383c, 0x383d, 0x383e, 0x383f, 0x3840, 0x381c, 0x381d, 0x381e,
  0x3820, 0x3821, 0x3822, 0x3823, 0x3824, 0x3825, 0x3830, 0x3831, 0x3832, 0x3833, 0x3834, 0x3835,
  0x3810, 0x3814, 0x3815,
  0x3a08, 0x3a09, 0x3a0a, 0x3a0b, 0x3a0c, 0x3a0d, 0x3a0e, 0x3a0f, 0x3a20, 0x3a22]);
export const sse4Compiled = (insn) => insn.mnem === 'sse4' && SSE4_AOT.has((insn.map === 0x38 ? 0x3800 : 0x3a00) | insn.op);
// the regs these forms read as a GPR (rm field) rather than an xmm
const sse4RmIsGpr = (insn) => insn.map === 0x3a && (insn.op === 0x20 || insn.op === 0x22);
export const FCW_SLOT = 164;      // regfile slot: the x87 control word, so fnstcw/fldcw need not escape
// MEASUREMENT ONLY (OXWASM_STOREGUARD=1): what would it cost to make compiled
// code's stores observable? Two of the three largest interpretation costs in
// the sweep are the same missing mechanism - a JIT patching its own generated
// code, and a forked child whose writes must be journaled - and both need the
// engine to see a store that compiled code makes. This emits the check and
// nothing else, so the price can be measured before the mechanism is designed.
// Slots: the guarded window's base and length, and where a hit is recorded.
export const CWLO_SLOT = 168, CWLEN_SLOT = 172;
// One byte per 4K page of the guarded window, in the dead space between the
// dispatch hash and guest RAM. A single interval could not say "this page is
// volatile, stop watching it" without dropping its neighbours too, and a page
// that is patched over and over is exactly what has to leave the set.
export const CWMAP = 0xE0000, CWMAP_PAGES = 0x20000;   // 128KB: 512MB of window span
const STOREGUARD = typeof process !== 'undefined' && process.env?.OXWASM_STOREGUARD === '1';
// Largest wat text this emitter will hand the runtime for ONE function; see
// the refusal at the end of the function emitter for the two measurements
// that bracket it.
const MAXWAT = 5_000_000;
export const EFLAGS_SLOT = 136;   // regfile slot: EFLAGS handed to the interpreter at an escape (bit 63 = valid; syncIn applies and clears it)
export const FNPROF_BASE = 0x20000, FNPROF_SLOTS = 1 << 14;   // OXWASM_FNPROF counters: 16384 x i64, in the dead space below FTHASH
export const fnprofSlot = (a) => FNPROF_BASE + ((Number((BigInt(a) >> 4n) & 0x3fffn)) * 8);
// OXWASM_BLKPROF=hexfn[,hexfn]: a per-BLOCK entry counter for the named
// functions (which blocks of a hot function are hot; V8's profile stops at
// the function). Same scheme, the upper half of the dead space.
export const BLKPROF_BASE = 0x40000, BLKPROF_SLOTS = 1 << 14;
export const blkprofSlot = (a) => BLKPROF_BASE + ((Number((BigInt(a) >> 2n) & 0x3fffn)) * 8);
export const BLKPROF = new Set(((typeof process !== 'undefined' && process.env?.OXWASM_BLKPROF) || '').split(',').filter(Boolean).map(h => BigInt('0x' + h).toString()));
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
// Loop yield budget (u32 at FTMAP+16, dead space since the hash replaced the
// sorted map). V8 compiles a unit function with Liftoff first and tiers it
// up in the background, but a FRAME already running baseline code keeps it
// until it returns: a long-running loop entered once (a kernel's main loop,
// a program's read-process-write loop) ran at Liftoff speed for the whole
// run - the scan kernel measured 3.80x native in the engine against 0.86x
// for the same loop as a small standalone function, and --liftoff-only
// read the same 3.65x. Every backward edge burns one unit of this budget;
// at zero the frame spills its registers and RETURNS the loop head's
// address as its exit rip, exactly the contract a guest ret uses. The
// engine re-dispatches at that rip: the loop head becomes a profiled entry
// (its own unit after a few interpreted iterations), and every re-entry
// picks up whatever tier V8 has by then. dispatchAot fills the budget per
// dispatch from eng.loopYield; OXWASM_LOOPYIELD=0 disables the emission.
export const FTLOOP = FTMAP + 16;
// Nesting depth of in-unit calls (u32 at FTMAP+20). An in-unit call site
// DROPS its callee's returned rip and continues after the call, so a callee
// that yielded mid-frame would leave its frame abandoned on the guest stack
// - m4 on 200k lines diverged exactly so. Every such site bumps this word
// around the call; the yield fires only at zero, i.e. in a frame whose
// returned rip is honoured (dispatchAot's f(), the in-wasm drive loop, a
// nested dispatch from a callout - each zeroes the word for its dispatch).
export const FTNEST = FTMAP + 20;
// yield counters, bumped in the $yield tail: top-level returns at +24, nested deopts at +28
export const FTYTOP = FTMAP + 24, FTYNEST = FTMAP + 28;

// The in-wasm resolver over the sorted (addr, table-slot) map at FTMAP —
// shared by every unit module and by generated PLT stubs.
const FTR_WAT = `  (func $ftr (param $a i64) (result i32)
    (local $p i32) (local $k i64)
    (local.set $p (i32.add (i32.const ${FTHASH})
      (i32.shl (i32.shr_u (i32.mul (i32.wrap_i64 (local.get $a)) (i32.const 0x9E3779B1))
                          (i32.const ${32 - FTHBITS})) (i32.const 4))))
    (block $done
      (loop $probe
        (local.set $k (i64.load (local.get $p)))
        (br_if $done (i64.eq (local.get $k) (local.get $a)))
        (br_if $done (i64.eqz (local.get $k)))
        (local.set $p (i32.add (i32.const ${FTHASH})
          (i32.and (i32.add (i32.sub (local.get $p) (i32.const ${FTHASH})) (i32.const 16))
                   (i32.const ${FTHMASK}))))
        (br $probe)))
    (if (result i32) (i64.eq (i64.load (local.get $p)) (local.get $a))
      (then (i32.load (i32.add (local.get $p) (i32.const 8))))
      (else (i32.const -1))))\n`;

// A PLT/IFUNC stub as a WASM function: read the GOT slot LIVE from guest
// memory (so ld.so rebinding the slot — even re-relocating itself — is
// always honored), resolve the value through the shared map, and tail-call
// the compiled callee entirely in wasm; x_callout keeps the JS fallback for
// an uncompiled target. Registered in the funcref table under the stub's
// own address, this lets translated call sites, tail jumps, and the
// dispatch driver route through PLT indirection with no JS boundary — the
// JS-closure version of this stub was 23M callout round-trips in one
// CPython benchmark run.
export function pltStubWat(entry, gotOff) {
  const wat = '(module\n  (import "js" "mem" (memory 4096))\n'
    + '  (import "env" "callout" (func $x_callout (param i64) (result i64)))\n'
    + '  (import "js" "ftab" (table $ft 0 funcref))\n'
    + '  (type $uft (func (result i64)))\n'
    + FTR_WAT
    + `  (func (export "f_${entry.toString(16)}") (result i64)
    (local $v i64) (local $fti i32)
    (local.set $v (i64.load (i32.const ${gotOff})))
    (local.set $fti (call $ftr (local.get $v)))
    (if (i32.and (i32.ge_s (local.get $fti) (i32.const 0))
          (i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT}))
                   (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0))))
      (then (i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))
            (return_call_indirect $ft (type $uft) (local.get $fti))))
    (return (call $x_callout (local.get $v))))\n)\n`;
  return { wat, entryName: 'f_' + entry.toString(16) };
}

export function compileFunctionWatDispatch(mem, entry, { guestBase, ramBase, maxInsns = 8000 } = {}) {
  // ---- decode reachable code ----
  const insnAt = new Map(); const work = [entry]; const seen = new Set(); let count = 0;
  while (work.length) {
    const rip = work.pop(); const key = rip.toString();
    // the visited set is keyed by Number: a guest address fits 2^53, and a
    // Set of numbers inserts at ~165 ns against ~600 ns for strings or
    // BigInts (rustc-asm walks 9.5M instructions)
    const kn = Number(rip);
    if (seen.has(kn)) continue; seen.add(kn);
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
        case 'pop': {
          // `pop [mem]` with an rsp-based address computes the address AFTER
          // the increment (Intel grp1a). Confirmed against this CPU rather
          // than assumed: `pop qword [rsp]` writes the popped value to the
          // slot ABOVE the one it came from. So pop into a temp, move rsp,
          // then store - the emitter used to write first, which is why this
          // shape was refused outright and cost node-net a function called
          // 11,967 times.
          if (insn.dst.kind === 'mem' && (insn.dst.base === 4 || insn.dst.index === 4)) {
            const t = T();
            L.push(`(local.set ${t} (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)}))`,
                   `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`,
                   wr(insn.dst,8,`(local.get ${t})`,next));
            break;
          }
          L.push(wr(insn.dst,8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next),
                 `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`); break; }
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
    return L.join('\n');
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
export function analyze(mem, entry, { maxInsns = 20000, noJtab = false, entries = null, callTargets = null } = {}) {
  const M = 0xFFFFFFFFFFFFFFFFn;
  const insnAt = new Map(); const work = [entry]; const seen = new Set(); let count = 0;
  const calls = new Set();
  const byNext = new Map();       // insn.next -> insn: the straight-line chain above an address
  const jmpinds = [];             // `jmp *reg` sites awaiting jump-table discovery
  const jtabs = new Map();        // jmpind rip str -> BigInt[] targets read from its table
  let lo = entry, hi = entry;     // decoded range, the plausibility window for table entries
  // Byte fetch for the decoder. mem.read per byte cost a BigInt add, a
  // region lookup and a DataView per byte, 5 us an instruction across every
  // function size (clang: 6.8 M instructions analysed at that rate). One
  // region lookup per instruction and plain indexing after; the slow path
  // stays for a page-arrival guard (streamed restore) or a fetch that leaves
  // the region.
  let fr = null;
  const fetcher = (rip) => {
    if (mem.pend !== null || typeof mem.find !== 'function') return (i) => Number(mem.read(rip + BigInt(i), 1n));
    if (fr === null || rip < fr.base || rip >= fr.end) fr = mem.find(rip);   // throws on a fault, as read did
    const off = Number(rip - fr.base), b = fr.bytes, end = b.length;
    return (i) => { const o = off + i; return o < end ? b[o] : Number(mem.read(rip + BigInt(i), 1n)); };
  };
  const drain = () => { while (work.length) {
    const rip = work.pop(); const key = rip.toString();
    // the visited set is keyed by Number: a guest address fits 2^53, and a
    // Set of numbers inserts at ~165 ns against ~600 ns for strings or
    // BigInts (rustc-asm walks 9.5M instructions)
    const kn = Number(rip);
    if (seen.has(kn)) continue; seen.add(kn);
    if (count++ > maxInsns) throw new Error('function too large');
    let insn;
    try { insn = decode(fetcher(rip), rip); }
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
    // fnstcw/fldcw (D9 /7 and D9 /5 with a memory operand) are the x87
    // CONTROL WORD, not the FPU stack: 16 bits of rounding and precision
    // mode, exactly the shape stmxcsr/ldmxcsr already have. Nothing about
    // them needs the register stack, so they get their own mnem before the
    // blanket x87 escape below claims them. glibc's float formatting opens
    // with `fnstcw; movzx; and; cmp; jcc` to dispatch on the rounding mode,
    // and that fnstcw being an escape made it an `entry undecodable`
    // refusal - mawk ran the whole function interpreted 1,996 times.
    if (insn.mnem === 'x87' && insn.op === 0xD9 && (insn.sub === 5 || insn.sub === 7) && insn.rm) insn.mnem = 'fcw';
    if (['hlt','ud2','int3','int','cpuid','loopx','fxsave','fxrstor','x87','rcl','rcr','emms','popf'].includes(insn.mnem)) {   // rcl/rcr: rare, interpreter-only
      insnAt.set(key, { mnem: 'udec', rip, next: rip + BigInt(insn.len), len: insn.len });
      continue;
    }
    if (insn.mnem === 'sse4' && !sse4Compiled(insn)) {
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
    if (insn.mnem === 'jmp') {
      // A direct jmp to another KNOWN function entry is a tail call (gcc's
      // sibling-call optimisation): walking into it swallowed the callee and
      // everything it reaches. Cut like the noreturn call: the target is not
      // decoded, and the emitter chains to it through the funcref table (a
      // compiled callee runs in wasm) or deopts to the real address.
      const tgt = (insn.next + insn.rel) & M;
      // only an address the profile has seen CALLED counts as a function
      // entry here: the wider `entries` set also holds compiled loop heads
      // and resolver-probed labels, and a forward jmp to a loop's condition
      // block (gcc's loop layout) was cut as a tail call - ten sweep cases
      // died on wild addresses
      if (TAILCUT && tgt !== entry && callTargets && callTargets.has(tgt.toString()) && !insnAt.has(tgt.toString()) && (!globalThis.__tailCutAllow || globalThis.__tailCutAllow(globalThis.__tailCutN = (globalThis.__tailCutN | 0) + 1))) { insn.tailCut = true; if (globalThis.__tailTrace) console.error(`<tailcut fn=${entry.toString(16)} at=${rip.toString(16)} -> ${tgt.toString(16)}>`); continue; }
      work.push(tgt); continue; }
    if (insn.mnem === 'jcc') { work.push((insn.next + insn.rel) & M); work.push(insn.next); continue; }
    if (insn.mnem === 'call') {
      calls.add(((insn.next + insn.rel) & M).toString());
      // A call to a noreturn function (abort, exit, __stack_chk_fail, error)
      // is followed by the NEXT function, and following the fall-through
      // swallowed it whole - m4's 40-instruction peek_input compiled to 4,700
      // lines and its unit to 27MB. The fall-through is cut when the next
      // address is a known function entry - one the tiering profile has seen
      // called or one already compiled (a static marker such as endbr64 is
      // not used: CET also marks jump-table case labels, and a switch case
      // falling through a call into the next case would be cut). Cut, the
      // block ends in the call and its (never taken) continuation is a deopt
      // to the real address, so a wrong guess costs a frame's interpretation,
      // never correctness.
      if (insn.next !== entry && entries && entries.has(insn.next.toString())) { insn.noretCut = true; continue; }
    }
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
  // A table descriptor: {tbl, width, rel}. Absolute tables hold 8-byte
  // targets; the PIC form every -fPIC/PIE binary emits (glibc's mutex
  // kind switch, any Ubuntu binary's switch) holds int32 offsets relative
  // to the table itself:
  //   lea    table(%rip), %rdx
  //   movslq (%rdx,%rax,4), %rax
  //   add    %rdx, %rax
  //   jmp    *%rax
  // Unrecognised, that switch fell to the chain/deopt form at every case.
  const tableOf = (j) => { const t = tableOfAbs(j); return t == null ? tableOfPic(j) : { tbl: t, width: 8, rel: false }; };
  const tableOfPic = (j) => {
    if (j.src.kind !== 'reg') return null;
    const add = defAbove(j, j.src.r);
    if (!add || add.mnem !== 'add' || (add.size||8) !== 8 || add.src.kind !== 'reg' || add.dst.r !== j.src.r) return null;
    const baseR = add.src.r, sumR = add.dst.r;
    const ld = defAbove(add, sumR);
    if (!ld || ld.mnem !== 'movsx' || ld.srcSize !== 4 || ld.src.kind !== 'mem' || ld.src.scale !== 4
        || ld.src.index < 0 || ld.src.base !== baseR || ld.src.fs || ld.src.disp !== 0n) return null;
    const lb = defAbove(ld, baseR);
    if (!lb || lb.mnem !== 'lea' || lb.src.kind !== 'mem' || lb.src.index >= 0 || !(lb.src.ripRel || lb.src.base < 0)) return null;
    // the lea must still hold at the add (nothing between rewrote the base)
    if (defAbove(add, baseR) !== lb) return null;
    // Entry count from the bounds check the compiler always emits just
    // before the load (`cmp $N, %idx; ja default`): int32 offsets past a
    // table's end are small numbers that land inside the plausibility
    // window and would become phantom block leaders splitting real
    // instructions (perl and awk faulted that way). No guard, no table.
    // The guard is the compare an UNSIGNED branch consumes (`ja`/`jae`
    // to the default, `jb`/`jbe` into the switch): a `cmp $K, %idx; je`
    // between the guard and the load is a case test, not a bound. LLVM
    // put one there (FindRoots in libLLVM: `cmp $0x1f, %eax; je` after
    // bounds-checking a copy of the index in %cl), the table was read
    // with 32 entries instead of 11, two of them landed inside real
    // instructions, and the misaligned stream swallowed a `jmp` at a
    // deopt target: rustc's compile died on a wild address.
    const idx = ld.src.index; let cur = ld, n = -1;
    for (let s = 0; s < 12 && n < 0; s++) {
      const q = byNext.get(cur.rip.toString()); if (!q || q.mnem === 'udec') break;
      if (q.mnem === 'cmp' && q.dst?.kind === 'reg' && q.dst.r === idx && q.src?.kind === 'imm') {
        const br = insnAt.get(q.next.toString());
        if (br?.mnem === 'jcc' && (br.cond === 'a' || br.cond === 'ae' || br.cond === 'b' || br.cond === 'be'))
          n = Number(q.src.v) + (br.cond === 'a' || br.cond === 'be' ? 1 : 0);   // ja/jbe: K is the last index; jae/jb: K is the count
        else break;                                          // a case test on the index: no guard between here and the load
      }
      else if (wrReg(q, idx) && q.mnem !== 'movzx' && q.mnem !== 'mov' && q.mnem !== 'sub' && q.mnem !== 'add' && q.mnem !== 'lea') break;
      cur = q;
    }
    if (n < 2 || n > 1024) return null;
    return { tbl: BigInt.asUintN(64, lb.src.disp + (lb.src.ripRel ? lb.next : 0n)), width: 4, rel: true, count: n };
  };
  const tableOfAbs = (j) => {
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
    const td = tableOf(j);
    if (td == null) continue;
    const { tbl, width, rel, count } = td;
    const targets = [];
    const min = lo > 0x100000n ? lo - 0x100000n : 0n, max = hi + 0x100000n;
    for (let i = 0; i < (count ?? 1024); i++) {
      let t; try { t = mem.read((tbl + BigInt(i * width)) & M, BigInt(width)); } catch { break; }
      if (rel) t = (tbl + BigInt.asIntN(32, t)) & M;     // int32 offset from the table base
      if (t < min || t > max) break;   // first out-of-range entry = end of table
      targets.push(t);
    }
    if (targets.length < 2) continue;
    jtabs.set(j.rip.toString(), targets);
    for (const t of targets) if (!seen.has(Number(t)) && dbudget > 0) { dbudget--; work.push(t); }
    drain();                      // newly decoded handlers may end in more jmpinds
  }
  const addrs = [...insnAt.keys()].map(BigInt).sort((a,b)=>a<b?-1:1);
  const leaders = new Set([entry.toString()]);
  for (const a of addrs) { const insn = insnAt.get(a.toString());
    if (insn.mnem === 'jcc') { leaders.add(((insn.next+insn.rel)&M).toString()); leaders.add(insn.next.toString()); }
    if (insn.mnem === 'jmp') leaders.add(((insn.next+insn.rel)&M).toString()); }
  for (const [, ts] of jtabs) for (const t of ts) leaders.add(t.toString());
  // a deopt point ends its block; whatever was decoded right after it (a
  // label some other path reaches) starts a new one, it is never a
  // fall-through of the escape
  for (const a of addrs) { const insn = insnAt.get(a.toString()); if (insn.mnem === 'udec') leaders.add(insn.next.toString()); }
  // Decode integrity. Two instructions may not overlap, and a jmp/ret/
  // indirect jump may only end a block: the emitter handles those as a
  // block's last instruction, so one in the middle would be dropped and
  // the bytes after it run as if it were not there. Both shapes are what
  // a phantom leader inside a real instruction produces (a jump table
  // read past its end): refusing the function keeps it interpreted,
  // which is slow and right, where the emitted unit was fast and wrong.
  // The one legitimate overlap is a skipped prefix: glibc's malloc branches
  // one byte into `lock cmpxchg` to run the plain `cmpxchg` when the process
  // is single-threaded. Both instructions end at the same address, so that
  // address becomes a leader and the two blocks rejoin there (before, the
  // lock path fell through into the middle of a block and deopted).
  for (let i = 1; i < addrs.length; i++) {
    const p = insnAt.get(addrs[i - 1].toString()), q = insnAt.get(addrs[i].toString());
    if (addrs[i] < addrs[i - 1] + BigInt(p.len)) {
      if (q.next === p.next) leaders.add(p.next.toString());
      else throw new Error(`overlapping decode: ${addrs[i].toString(16)} inside ${addrs[i - 1].toString(16)}`);
    }
  }
  const blocks = []; let cur = null;
  for (const a of addrs) { if (leaders.has(a.toString())) { cur = { start: a, insns: [] }; blocks.push(cur); } cur.insns.push(insnAt.get(a.toString())); }
  for (const b of blocks) for (let i = 0; i < b.insns.length - 1; i++) {
    const m = b.insns[i].mnem;
    if (m === 'jmp' || m === 'jcc' || m === 'ret' || m === 'retn' || m === 'jmpind') throw new Error(`terminator inside a block: ${m} at ${b.insns[i].rip.toString(16)}`);
  }
  const bidx = new Map(blocks.map((b,i)=>[b.start.toString(), i]));
  return { blocks, bidx, M, calls, jtabs };
}

// Blocks that lie on a cycle in this function's CFG.
//
// This pass is not incidental: measured by running it with the inline budget
// set to zero, so it chooses and nothing is spliced, it is about 90ms of
// gzip's 122ms tier-up penalty - more than the duplicated code it selects.
// A looser, cheaper criterion was tried (backward-branch intervals) and lost,
// because it selected twice as many sites and the extra duplication cost more
// than the analysis saved. So: the same answer, computed without the garbage.
//
// Successors in CSR form (one flat Int32Array plus offsets) rather than an
// array of arrays, and an iterative Tarjan over parallel typed arrays rather
// than a stack of [node, childIndex] tuples. Iterative because a
// 20,000-instruction function would blow the JS stack on the recursive one.
// Call edges are deliberately not followed: the question is whether the CALL
// SITE repeats, not whether the callee does.
function cyclicBlocks(a0) {
  const M = a0.M, N = a0.blocks.length;
  const idx = (addr) => a0.bidx.has(addr.toString()) ? a0.bidx.get(addr.toString()) : -1;
  const ide = (e) => e == null ? -1 : (a0.bidx.has(e) ? a0.bidx.get(e) : -1);
  // successors of block i, written straight into `flat` at off[i]
  const succOf = (i, emit) => {
    const insns = a0.blocks[i].insns, last = insns[insns.length - 1], next = last.next;
    if (last.inlineTo !== undefined) return emit(ide(last.inlineTo));
    if (last.inlineRet !== undefined) return emit(ide(last.inlineRet));
    if (last.inlineTailRet !== undefined) return emit(ide(last.inlineTailRet));
    if (last.edgeT !== undefined) {
      emit(ide(last.edgeT));
      if (last.edgeF !== undefined) emit(ide(last.edgeF));
      return;
    }
    if (last.edgeN !== undefined) return emit(ide(last.edgeN));
    if (last.mnem === 'jcc') { emit(idx((next + last.rel) & M)); emit(idx(next)); return; }
    if (last.mnem === 'jmp') return emit(idx((next + last.rel) & M));
    if (last.mnem === 'jmpind') {
      const ts = a0.jtabs?.get(last.rip.toString());
      if (ts) for (const t of ts) emit(idx(t));
      return;
    }
    if (last.mnem === 'ret' || last.mnem === 'retn' || last.mnem === 'udec') return;
    return emit(idx(next));
  };
  const off = new Int32Array(N + 1);
  for (let i = 0; i < N; i++) { let n = 0; succOf(i, (v) => { if (v >= 0) n++; }); off[i + 1] = off[i] + n; }
  const flat = new Int32Array(off[N]);
  for (let i = 0, w = 0; i < N; i++) succOf(i, (v) => { if (v >= 0) flat[w++] = v; });

  const index = new Int32Array(N).fill(-1), low = new Int32Array(N);
  const onStack = new Uint8Array(N), stack = new Int32Array(N);
  const wNode = new Int32Array(N), wEdge = new Int32Array(N);
  const cyclic = new Set();
  let counter = 0, sp = 0;
  for (let root = 0; root < N; root++) {
    if (index[root] >= 0) continue;
    let wp = 0;
    index[root] = low[root] = counter++; stack[sp++] = root; onStack[root] = 1;
    wNode[wp] = root; wEdge[wp] = off[root]; wp++;
    while (wp) {
      const v = wNode[wp - 1];
      if (wEdge[wp - 1] < off[v + 1]) {
        const w = flat[wEdge[wp - 1]++];
        if (index[w] < 0) {
          index[w] = low[w] = counter++; stack[sp++] = w; onStack[w] = 1;
          wNode[wp] = w; wEdge[wp] = off[w]; wp++;
        } else if (onStack[w] && index[w] < low[v]) low[v] = index[w];
      } else {
        wp--;
        if (wp) { const u = wNode[wp - 1]; if (low[v] < low[u]) low[u] = low[v]; }
        if (low[v] === index[v]) {
          // a component is cyclic if it has more than one member, or one
          // member with an edge to itself
          let selfLoop = false;
          for (let e = off[v]; e < off[v + 1]; e++) if (flat[e] === v) { selfLoop = true; break; }
          const base = sp;
          let w2; do { w2 = stack[--sp]; onStack[w2] = 0; } while (w2 !== v);
          if (base - sp > 1 || selfLoop) for (let k = sp; k < base; k++) cyclic.add(stack[k]);
        }
      }
    }
  }
  return cyclic;
}

// ---- inlining: splice a callee's blocks into the caller's analysis ---------
// Why this exists, measured rather than assumed: the per-call charge is FIXED
// at roughly 22 native instruction-times, and none of its three candidate
// mechanisms turned out to be ours - not the funcref table, not the register
// spill/reload, not the stack-budget check. What is left is the wasm frame and
// V8's cost to enter a generated function, neither of which the translator
// emits. So the only lever left is to emit fewer calls.
//
// What that is worth is entirely program-dependent: sha256sum's steady state
// is 184,000 instructions per call and inlining would move it by nothing,
// while gzip's is 77 and the charge is ~20% of its engine time. gzip's three
// hot callees - 98.4% of every call it makes - are 66, 88 and 114 instructions
// across 9, 19 and 32 BLOCKS. That last number is why this is a graph merge
// and not a paste: splicing single-block leaf callees, the version that needs
// no control-flow fixup, captures none of them.
//
// The merge produces a new analysis for ONE function's emission. The callee's
// own standalone wasm function is untouched and still emitted, because callers
// in other units reach it through the funcref table.
//
// Restriction that makes this safe rather than clever: a callee is spliced
// only where it has exactly ONE call site in this function. Guest addresses
// are block identity here, so a callee inlined twice would collide with
// itself in bidx. One site also means the duplication cost is bounded by the
// callee's size, which is the case the measurement actually found.
export function inlineCallees(a0, fnAddr, resolve, opts = {}) {
  const budget = opts.budget ?? 160;      // per-callee size cap, in instructions
  const total  = opts.total  ?? 640;      // per-function cap on duplicated code
  const only = opts.only ?? null;         // OXWASM_INLINE_ONLY, for diagnosis
  const rej = opts.rej || null;
  const no = (t, why) => { if (rej) rej(t, why); };
  const M = a0.M;

  // Every call site, in program order. A callee with several sites gets a
  // COPY PER SITE: v1 spliced only single-site callees, to keep guest
  // addresses usable as block identity, and that excluded every callee that
  // mattered - gzip's four hot ones have 8, 5, 3 and 2 sites in one caller.
  // Hot callees are called from many places; that is part of why they are hot.
  const sites = [];
  a0.blocks.forEach((b, bi) => b.insns.forEach((insn, ii) => {
    if (insn.mnem !== 'call') return;
    sites.push({ t: ((insn.next + insn.rel) & M).toString(), retTo: insn.next, bi, ii });
  }));

  const cand = new Map();                 // targetStr -> { an, size }
  for (const site of sites) {
    const t = site.t;
    if (cand.has(t)) continue;
    if (only && !only.has(t)) continue;
    if (t === fnAddr.toString()) { no(t, 'self'); continue; }   // recursion has no fixed point
    const c = resolve(t);
    if (!c) { no(t, 'not-in-unit'); continue; }
    if (c.jtabs && c.jtabs.size) { no(t, 'jtab'); continue; }   // needs the callee's own resolver
    let size = 0, bad = false;
    for (const b of c.blocks) for (const i of b.insns) {
      size++;
      // an undecodable byte or an indirect jump compiles to a deopt that
      // unwinds THIS frame; spliced in, it would unwind the caller's. A
      // tail-cut jmp (a sibling call to another known entry) is the same
      // kind of terminator - inlined, bash died on a wild rsp at the next
      // function entry (bisected to `jmp free@plt` at the end of a callee)
      // A tail-cut jmp (a sibling call to another known entry) used to be
      // refused too; it is now spliced as a call to the sibling followed by
      // the copy's return (see inlinetail) - m4's hottest callee ends in one.
      if (i.mnem === 'udec' || i.mnem === 'jmpind') bad = true;
    }
    if (bad || size === 0 || size > budget) { no(t, bad ? 'deopt-insn' : 'size=' + size); continue; }
    cand.set(t, { an: c, size });
  }
  if (!cand.size) return null;

  // Choose call sites INSIDE LOOPS.
  //
  // The obvious idea was to rank by the engine's own call profile. It does
  // not work, and the reason is worth writing down: aotCalls is a threshold
  // detector, not a histogram. profileTarget stops counting at
  // aotCallThreshold and stops entirely once a target is compiled - after
  // which its calls run inside wasm where the interpreter never sees them.
  // Dumped on gzip, every one of the top ten targets reads exactly 4. There
  // is no ranking in it to use.
  //
  // A call site on a cycle in the caller's own CFG needs no profile at all,
  // and it is the same population: gzip's hot callees are hot because they
  // are called from the compression loop.
  const inLoop = cyclicBlocks(a0);
  const heat = (bi) => inLoop.has(bi) ? 1 : 0;
  const pick = new Map();                 // "bi:ii" -> { t, copy, retTo }
  let spent = 0, copyN = 0;
  const loopOnly = opts.loopOnly !== false;
  const ranked = sites.filter(x => cand.has(x.t) && (!loopOnly || heat(x.bi)))
                      .sort((x, y) => (heat(y.bi) - heat(x.bi)) ||
                                      (cand.get(x.t).size - cand.get(y.t).size));
  for (const site of ranked) {
    const sz = cand.get(site.t).size;
    if (spent + sz > total) { no(site.t, 'over-total'); continue; }
    spent += sz;
    pick.set(site.bi + ':' + site.ii, { t: site.t, copy: copyN++, retTo: site.retTo });
  }
  if (!pick.size) return null;

  const cid = (copy, addr) => 'i' + copy + ':' + addr.toString();
  const blocks = [];
  a0.blocks.forEach((b, bi) => {
    let cur = { start: b.start, insns: [] };
    b.insns.forEach((insn, ii) => {
      const p = pick.get(bi + ':' + ii);
      if (p) {
        // the call still pushes its return address - the guest stack stays
        // byte-exact - but terminates its block and branches into the copy
        // the copy's ENTRY is the call target, not blocks[0]: analyze() lays
        // blocks out by address and a function's entry is not necessarily its
        // lowest address (a unit rooted at a loop head decodes blocks below it)
        cur.insns.push({ ...insn, inlineTo: cid(p.copy, BigInt(p.t)) });
        blocks.push(cur);
        cur = { start: insn.next, insns: [] };
        return;
      }
      cur.insns.push(insn);
    });
    // an empty tail means the call was already last in its block, so a0
    // already carries the continuation as a leader - do not duplicate it
    if (cur.insns.length) blocks.push(cur);
  });

  for (const [, p] of pick) {
    const c = cand.get(p.t).an;
    const inCallee = (addr) => c.bidx.has(addr.toString());
    for (const b of c.blocks) {
      const insns = b.insns.slice();
      const last = { ...insns[insns.length - 1] };
      const nx = last.next;
      if (last.mnem === 'ret' || last.mnem === 'retn') last.inlineRet = p.retTo.toString();
      else if (last.mnem === 'jcc') {
        const ta = (nx + last.rel) & M;
        last.edgeT = inCallee(ta) ? cid(p.copy, ta) : null;
        last.edgeF = inCallee(nx) ? cid(p.copy, nx) : null;
      } else if (last.mnem === 'jmp') {
        const ta = (nx + last.rel) & M;
        last.edgeT = inCallee(ta) ? cid(p.copy, ta) : null;
        // the callee's sibling call: call the sibling, then return to the
        // inlined site's continuation. The inlined `call` still pushed the
        // return address, so the sibling's `ret` pops exactly what a call
        // from here would have pushed.
        if (last.tailCut && !inCallee(ta)) last.inlineTailRet = p.retTo.toString();
      } else {
        last.edgeN = inCallee(nx) ? cid(p.copy, nx) : null;
      }
      insns[insns.length - 1] = last;
      blocks.push({ start: b.start, id: cid(p.copy, b.start), insns });
    }
  }

  const bidx = new Map(blocks.map((b, i) => [b.id ?? b.start.toString(), i]));
  if (bidx.size !== blocks.length) return null;            // duplicate identity: refuse
  const calls = new Set(a0.calls);
  for (const [, { an }] of cand) for (const c of an.calls) calls.add(c);
  return { blocks, bidx, M, calls, jtabs: a0.jtabs,
           inlined: [...pick.values()].map(p => p.t), dup: spent };
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
  // Every pass visits the scopes sorted by begin, so a scope only meets the
  // later-beginning scopes that start inside it: the all-pairs form was
  // quadratic in the scope count and 6 s of a rustc run. The rules are
  // monotone (begins only move back, ends only forward), so the fixpoint
  // and the overlap it cannot fix are the same whatever the visiting order;
  // a begin moved back mid-pass is re-sorted by the next pass.
  let changed = true, guard = 0;
  while (changed) { changed = false;
    if (guard++ > 10000) throw new Error('AOT: scope nesting did not converge');
    const order = scopes.slice().sort((x, y) => (x.b - y.b) || (y.e - x.e));
    for (let i = 0; i < order.length; i++) { const s = order[i];
      for (let j = i + 1; j < order.length; j++) { const t = order[j];
        if (t.b >= s.e) break;
        if (!(s.b < t.b && s.e < t.e)) continue;
        // Prefer growing a BLOCK's begin backward (always valid, and it never
        // engulfs a loop-exit target the way growing a loop's end would).
        if (t.type === 'block')      { t.b = s.b; changed = true; }    // grow later block's begin back
        else if (s.type === 'loop')  { s.e = t.e; changed = true; }    // grow earlier loop's end fwd
        else throw new Error(`AOT: block/loop overlap needs dispatch fallback: ${s.type}[${s.b},${s.e}) vs ${t.type}[${t.b},${t.e})`);
      }
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
  // Fast dispatch: inline the $ftr hash's FIRST probe at each resolution
  // site. idealdisp priced the out-of-line $ftr call at 7.6x native per call
  // against 4.9x for the same probe inlined - the wasm call boundary itself
  // is the largest single cost - and unlike a per-site inline cache (5.6x,
  // and 10% WORSE than no cache on perl's megamorphic runloop site before
  // demotion) the inline probe carries no per-site state, needs no
  // invalidation, and behaves identically for polymorphic sites. A first-
  // probe miss (chain collision or unregistered target, the hash is 40%
  // loaded) falls back to the full $ftr walk, whose result is bit-identical
  // by construction: same hash, same table, same sentinel.
  // On by default: full gate green with it on (suite both states, breadth
  // 31/31), and perl steady state measured 0.934x/0.871x across two
  // independent A/B runs - a 7-13% win on call-dense code. Opt out with
  // OXWASM_FASTDISP=0 or globalThis.__fastDisp = false.
  const fastDisp = globalThis.__fastDisp ??
    !(typeof process !== 'undefined' && process.env?.OXWASM_FASTDISP === '0');
  let usesIcp = false;
  const icResolve = (keyExpr) => {
    if (!fastDisp) return `(local.set $fti (call $ftr ${keyExpr}))`;
    usesIcp = true;
    return `(local.set $icp (i32.add (i32.const ${FTHASH})
        (i32.shl (i32.shr_u (i32.mul (i32.wrap_i64 ${keyExpr}) (i32.const 0x9E3779B1))
                            (i32.const ${32 - FTHBITS})) (i32.const 4))))
      (if (i64.eq (i64.load (local.get $icp)) ${keyExpr})
        (then (local.set $fti (i32.load (i32.add (local.get $icp) (i32.const 8)))))
        (else (local.set $fti (call $ftr ${keyExpr}))))`;
  };
  const MM = a0.M;
  // successors (by address-order index) for each block
  const succAddrIdx = (i) => {
    const insns = a0.blocks[i].insns, last = insns[insns.length-1], next = last.next;
    const idx = (addr) => a0.bidx.has(addr.toString()) ? a0.bidx.get(addr.toString()) : -1;
    const ide = (e) => e == null ? -1 : (a0.bidx.has(e) ? a0.bidx.get(e) : -1);
    // an inlined call site and an inlined callee's ret are both plain edges
    // inside this function now, not frame transitions
    if (last.inlineTo !== undefined) return [ide(last.inlineTo)];
    if (last.inlineRet !== undefined) return [ide(last.inlineRet)];
    if (last.inlineTailRet !== undefined) return [ide(last.inlineTailRet)];
    // a spliced block resolves its own branches by copy-local id, never by
    // address - `next + rel` would land on the ORIGINAL callee block
    if (last.edgeT !== undefined) return last.edgeF !== undefined
      ? [ide(last.edgeT), ide(last.edgeF)] : [ide(last.edgeT)];
    if (last.edgeN !== undefined) return [ide(last.edgeN)];
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
  const An = a0.blocks.length;
  const entryIdx = a0.bidx.get(fnAddr.toString());
  if (entryIdx === undefined) throw new Error('AOT: entry not a block leader');
  // layoutOrder(count, succOf, entry): reachable blocks in RPO from the
  // entry, then loop-compacted (below). Applied once in address-index space
  // and again after node splitting widens the CFG in RPO-index space.
  // layoutOrder also answers whether the CFG is reducible: a retreating edge
  // u->h (pos[h] <= pos[u]) is a back edge iff h dominates u, i.e. iff no
  // path from the entry reaches u without passing h - and "reaches a
  // back-edge source without passing h" is exactly the natural-loop set the
  // compaction below already computes, so the entry being in it is the
  // irreducibility witness. Node splitting (a fresh SCC walk per round, its
  // own Tarjan per nesting level) ran on every function before this gate and
  // cost rustc-asm 15 s of 189; it now runs only where the witness is found.
  let irreducible = false;
  const layoutOrder = (An, succOf, entryIdx) => {
  irreducible = false;
  const order = []; const vis = new Uint8Array(An);
  (function dfs(u) { vis[u] = 1;
    for (const v of succOf(u)) if (v >= 0 && !vis[v]) dfs(v);
    order.push(u);
  })(entryIdx);
  order.reverse();                                  // RPO
  // Loop-aware layout. Plain RPO can interleave a block that is NOT part of
  // a loop between the loop's blocks (an exit path laid out before a later
  // body block). structure() then sees a forward branch into the loop's
  // index range - "block/loop overlap" - and the whole function fell back
  // to the dispatch layout: m4's next_token and every other hot m4
  // function (216 of 683) ran with a br_table round-trip per edge. For each
  // back edge u->h the natural loop is h plus every block that reaches a
  // back-edge source without passing h; those blocks are compacted to sit
  // contiguously from h, and the interleaved non-members move after the
  // loop's last member. A non-member inside the range cannot branch to a
  // member or to h (either would make it a member or a back-edge source),
  // so its edges stay forward. Outer loops first: an inner compaction only
  // moves blocks that already sit inside the outer range.
  if (!(typeof process !== 'undefined' && process.env?.OXWASM_LOOPLAYOUT === '0')) {
    const pos = new Array(An).fill(-1); order.forEach((a, r) => pos[a] = r);
    const preds = Array.from({ length: An }, () => []);
    for (const u of order) for (const v of succOf(u)) if (v >= 0) preds[v].push(u);
    const heads = new Map();                        // header addrIdx -> back-edge sources
    for (const u of order) for (const v of succOf(u)) if (v >= 0 && pos[v] <= pos[u]) (heads.get(v) ?? heads.set(v, []).get(v)).push(u);
    const loops = [...heads].sort((a, b) => pos[a[0]] - pos[b[0]]);
    for (const [h, srcs] of loops) {
      const mem = new Set([h]); const st = srcs.filter(u => u !== h); for (const u of st) mem.add(u);
      while (st.length) { const u = st.pop(); for (const p of preds[u]) if (!mem.has(p)) { mem.add(p); st.push(p); } }
      if (h !== entryIdx && mem.has(entryIdx)) irreducible = true;
      const hp = pos[h]; let last = hp; for (const m of mem) if (pos[m] > last) last = pos[m];
      const range = order.slice(hp, last + 1), inL = range.filter(a => mem.has(a)), outL = range.filter(a => !mem.has(a));
      if (!outL.length) continue;
      order.splice(hp, range.length, ...inL, ...outL);
      order.forEach((a, r) => pos[a] = r);
      (globalThis.__layoutStats ??= { compacted: 0, moved: 0 }).compacted++; globalThis.__layoutStats.moved += outL.length;
    }
  }
  return order;
  };
  const order = layoutOrder(An, succAddrIdx, entryIdx);
  const rpoOf = new Array(An).fill(-1);
  order.forEach((addrIdx, r) => rpoOf[addrIdx] = r);
  const blocks = order.map(ai => a0.blocks[ai]);    // blocks laid out in RPO
  // A block's IDENTITY is its guest address, except for a block spliced in by
  // the inliner: the same callee inlined at two call sites appears twice, so
  // each copy carries its own id and its cloned branches carry copy-local
  // edge ids. Everything downstream works on indices and is unaffected.
  const bId = (b) => b.id ?? b.start.toString();
  let N = blocks.length;
  const bidx = new Map(blocks.map((b,i)=>[bId(b), i]));
  const MASKl = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
  const SIGNl = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };
  const andmask = (e, S) => S === 8 ? e : `(i64.and ${e} (i64.const ${MASKl[S]}))`;   // truncate to width; full 64 is a no-op

  // terminator descriptor + successors, all in RPO index space
  const term = [], succs = [];
  const idxOf = (addr) => bidx.has(addr.toString()) ? bidx.get(addr.toString()) : -1;
  // an explicit edge from a spliced block: null means the target is outside
  // the callee, which must deopt rather than resolve to some other function's
  // block that happens to sit at the same address
  const idxOfEdge = (e) => e == null ? -1 : (bidx.has(e) ? bidx.get(e) : -1);
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
    if (last.inlineTo !== undefined) { const t = idxOfEdge(last.inlineTo);
      if (t < 0) throw new Error('AOT: inlined callee entry not a block');
      term.push({kind:'inlinecall', t, ta: last.next}); succs.push([t]); }
    else if (last.inlineRet !== undefined) { const t = idxOfEdge(last.inlineRet);
      if (t < 0) throw new Error('AOT: inlined return site not a block');
      term.push({kind:'inlineret', t, ta: last.next,
                 pad: last.mnem === 'retn' ? Number(last.n) : 0}); succs.push([t]); }
    else if (last.inlineTailRet !== undefined) { const t = idxOfEdge(last.inlineTailRet);
      if (t < 0) throw new Error('AOT: inlined tail-call return site not a block');
      term.push({kind:'inlinetail', t, ta: (next+last.rel)&MM}); succs.push([t]); }
    // a spliced block's own branches, resolved by copy-local id. `ta`/`fa`
    // stay the REAL guest addresses so a target outside the callee still has
    // somewhere real to deopt to.
    else if (last.edgeT !== undefined && last.mnem === 'jcc') {
      const ta = (next+last.rel)&MM, fa = next;
      const t = idxOfEdge(last.edgeT), f = idxOfEdge(last.edgeF);
      if (t < 0 || f < 0) hasDeopt = true;
      term.push({kind:'jcc', t, f, ta, fa}); succs.push([t, f]); }
    else if (last.edgeT !== undefined) {
      const ta = (next+last.rel)&MM, t = idxOfEdge(last.edgeT);
      if (t < 0) hasDeopt = true;
      term.push({kind:'jmp', t, ta, tail: !!last.tailCut}); succs.push([t]); }
    else if (last.edgeN !== undefined) {
      const t = idxOfEdge(last.edgeN);
      if (t < 0) hasDeopt = true;
      term.push({kind:'fall', t, ta: next}); succs.push([t]); }
    else if (last.mnem === 'jcc') { const ta = (next+last.rel)&MM, fa = next, t = idxOf(ta), f = idxOf(fa);
      if (t < 0 || f < 0) hasDeopt = true;
      term.push({kind:'jcc', t, f, ta, fa}); succs.push([t, f]); }
    else if (last.mnem === 'jmp') { const ta = (next+last.rel)&MM, t = idxOf(ta);
      if (t < 0) hasDeopt = true;
      term.push({kind:'jmp', t, ta, tail: !!last.tailCut}); succs.push([t]); }
    else if (last.mnem === 'ret' || last.mnem === 'retn') { term.push({kind:'ret', pad: last.mnem==='retn' ? Number(last.n) : 0}); succs.push([]); }
    else if (last.mnem === 'jmpind') { hasDeopt = true;
      if (hasJtab && a0.jtabs.has(last.rip.toString())) { term.push({kind:'jtab', src:last.src}); succs.push([...jtabUnion]); }
      else { term.push({kind:'deopt', src:last.src}); succs.push([]); } }
    else if (last.mnem === 'udec')   { hasDeopt = true; term.push({kind:'deopt', src:null, at:last.rip}); succs.push([]); }
    else { const t = idxOf(next); if (t < 0) hasDeopt = true;
      term.push({kind:'fall', t, ta: next}); succs.push([t]); }
  }
  // ---- node splitting: make every loop single-entry -----------------------
  // gcc's tail duplication leaves m4's tokenizer (next_token, 16% of the
  // profile) and three more of its six hottest functions with loops that
  // have two to seven entry blocks - genuinely irreducible, so structure()
  // could only ever hand them to the br_table dispatch layout (a dispatcher
  // round-trip per edge, 4 of 6 hot functions). Classic node splitting
  // repairs that at the CFG level: for a strongly connected component with
  // several entries pick the header h whose alternative is cheapest, copy
  // the members reachable from the OTHER entries without passing h, and
  // point the entering edges at the copies. Copies are the same block
  // objects (same instructions, same address; the unroller relies on the
  // same fact), their internal edges stay inside the copy and every other
  // edge goes to the original - so the copied path now enters the loop only
  // through h. Nested loops are found by removing the header and repeating
  // inside; the whole thing iterates to a fixpoint (a copy can itself hold
  // an irreducible sub-loop) under a duplication cap, after which the
  // layout is recomputed (RPO + loop compaction) over the widened CFG. A
  // component holding a jump-table site is left alone: its copies would
  // still branch to the original case blocks. OXWASM_NODESPLIT=0 disables.
  const NODESPLIT = !(typeof process !== 'undefined' && process.env?.OXWASM_NODESPLIT === '0');
  if (NODESPLIT && irreducible) {
    const findIrreducible = (capLeft) => {
      // Tarjan SCCs over a node subset; returns [members[]] (size>1 or self-loop)
      const sccs = (nodes) => {
        const idx = new Int32Array(N).fill(-1), low = new Int32Array(N), on = new Uint8Array(N);
        const st = [], out = []; let c = 0;
        const go = (v) => { idx[v] = low[v] = c++; st.push(v); on[v] = 1;
          for (const w of succs[v]) { if (w < 0 || !nodes.has(w)) continue;
            if (idx[w] < 0) { go(w); if (low[w] < low[v]) low[v] = low[w]; }
            else if (on[w] && idx[w] < low[v]) low[v] = idx[w]; }
          if (low[v] === idx[v]) { const comp = []; let w;
            do { w = st.pop(); on[w] = 0; comp.push(w); } while (w !== v);
            if (comp.length > 1 || succs[v].includes(v)) out.push(comp); } };
        for (const v of nodes) if (idx[v] < 0) go(v);
        return out;
      };
      const preds = Array.from({ length: N }, () => []);
      for (let u = 0; u < N; u++) for (const v of succs[u]) if (v >= 0) preds[v].push(u);
      const walk = (nodes) => {
        for (const comp of sccs(nodes)) {
          const cs = new Set(comp);
          const entries = comp.filter(v => v === 0 || preds[v].some(p => !cs.has(p))).sort((a, b) => a - b);
          if (entries.length > 1) {
            // Header choice is a walk of the component per candidate entry,
            // and a tangled component (LLVM's jump threading leaves rustc
            // functions with dozens of entries) made that quadratic - 8 s of
            // a rustc run spent choosing headers for splits the cap then
            // refused. More than 12 entries is hopeless under any cap; each
            // candidate's walk stops as soon as it passes the cap.
            if (entries.length > 12) return { hopeless: true };
            let best = null;
            for (const h of (cs.has(0) ? [0] : entries)) {
              const seen = new Set(); const stk = entries.filter(e => e !== h);
              const limit = best ? best.dup.size : capLeft + 1;
              let over = false;
              while (stk.length) { const u = stk.pop(); if (seen.has(u) || u === h) continue; seen.add(u);
                if (seen.size >= limit) { over = true; break; }
                for (const w of succs[u]) if (w >= 0 && cs.has(w)) stk.push(w); }
              if (!over && (!best || seen.size < best.dup.size)) best = { h, dup: seen, cs };
            }
            return best ?? { hopeless: true };
          }
          const h = entries.length ? entries[0] : comp[0];
          const inner = new Set(cs); inner.delete(h);
          if (inner.size) { const r = walk(inner); if (r) return r; }
        }
        return null;
      };
      return walk(new Set(Array.from({ length: N }, (_, i) => i)));
    };
    const st = (globalThis.__splitStats ??= { fns: 0, loops: 0, blocks: 0, capped: 0, jtab: 0 });
    // duplication cap per function: half its size (the hot m4 functions
    // needed 0.18-0.41x), at least 48 blocks, at most 512; past it the
    // function keeps the dispatch layout it had before
    let dupTotal = 0, rounds = 0, did = false; const cap = Math.min(512, Math.max(48, N >> 1));
    // a function that runs past the cap keeps the dispatch layout it would
    // have had anyway: its partial copies are discarded, not emitted (rustc:
    // 875 of 1,367 split functions capped, 100k duplicated blocks)
    const snap = { blocks: blocks.slice(), term: term.slice(), succs: succs.slice(), N };
    const giveUp = () => { st.capped++; (st.cappedN ??= []).push(snap.N); blocks.length = 0; blocks.push(...snap.blocks); term.length = 0; term.push(...snap.term); succs.length = 0; succs.push(...snap.succs); N = snap.N; did = false; };
    for (;;) {
      if (rounds++ > 64) { giveUp(); break; }
      const pick = findIrreducible(cap - dupTotal);
      if (!pick) break;
      if (pick.hopeless) { giveUp(); break; }
      const dup = [...pick.dup].sort((a, b) => a - b);
      if (dupTotal + dup.length > cap) { giveUp(); break; }
      // a jump-table site branches by REPRESENTATIVE index (the resolver
      // maps a computed address to the one member of jtabUnion at that
      // address); a site whose case block was duplicated carries a remap
      // from that representative to the copy it must branch to instead, and
      // the emitter applies it to the site's br_table (structured) or $pc
      // (dispatch). m4's expand loop is entered by the same switch twice - once
      // from before the loop, once from inside it - at two different blocks.
      const cmap = new Map(); dup.forEach((q, k) => cmap.set(q, N + k));
      const re = (j) => (j >= 0 && cmap.has(j)) ? cmap.get(j) : j;
      const reTerm = (t, f) => { const u = { ...t };
        if (typeof u.t === 'number') u.t = f(u.t);
        if (typeof u.f === 'number') u.f = f(u.f);
        if (u.kind === 'jtab') { const m = new Map();
          for (const r of jtabUnion) { const cur = t.remap?.get(r) ?? r, nv = f(cur); if (nv !== r) m.set(r, nv); }
          u.remap = m.size ? m : undefined; }
        return u; };
      for (const q of dup) { blocks.push(blocks[q]); term.push(reTerm(term[q], re)); succs.push(succs[q].map(re)); }
      // entering edges: from outside the component into a duplicated block
      for (let u = 0; u < N; u++) { if (pick.cs.has(u)) continue;
        if (!succs[u].some(j => j >= 0 && cmap.has(j))) continue;
        term[u] = reTerm(term[u], re); succs[u] = succs[u].map(re); }
      N = blocks.length; dupTotal += dup.length; st.loops++; st.blocks += dup.length; did = true;
    }
    if (did) {
      st.fns++; (st.okN ??= []).push([snap.N, dupTotal]);
      const order = layoutOrder(N, (i) => succs[i], 0);
      const inv = new Int32Array(N).fill(-1); order.forEach((o, r) => inv[o] = r);
      const re = (j) => j < 0 ? j : inv[j];
      // a representative that the layout dropped (its original became
      // unreachable once every entering edge went to a copy) is replaced by
      // a reachable copy of the same block, and every site's remap re-keyed
      const rep = new Map();
      if (hasJtab) for (const r of jtabUnion) { let v = inv[r];
        if (v < 0) for (let j = 0; j < N && v < 0; j++) if (blocks[j] === blocks[r] && inv[j] >= 0) v = inv[j];
        if (v >= 0) rep.set(r, v); }
      const nb = order.map(o => blocks[o]);
      const nt = order.map(o => { const u = { ...term[o] };
        if (typeof u.t === 'number') u.t = re(u.t);
        if (typeof u.f === 'number') u.f = re(u.f);
        if (u.kind === 'jtab') { const m = new Map();
          for (const [r, k] of rep) { const cur = term[o].remap?.get(r) ?? r, v = inv[cur]; if (v >= 0 && v !== k) m.set(k, v); }
          u.remap = m.size ? m : undefined; }
        return u; });
      const ns = order.map(o => succs[o].map(re));
      blocks.length = 0; blocks.push(...nb); term.length = 0; term.push(...nt); succs.length = 0; succs.push(...ns);
      for (const [id, ix] of bidx) { if (inv[ix] >= 0) bidx.set(id, inv[ix]); else bidx.delete(id); }
      if (hasJtab) { jtabUnion.clear(); for (const [, v] of rep) jtabUnion.add(v); }
      N = blocks.length;
    }
  }
  // ---- loop unrolling, at the CFG level -------------------------------------
  // The loop yield's burn (a read-modify-write of the budget word at every
  // back edge) was 40% of alu, 80% of subw and 28% of scan under forced
  // TurboFan (yield off: 1.01x, 1.93x, 1.23x native); it cannot be made
  // cheaper per iteration, so it is made rarer. A natural loop [h, e) whose
  // blocks are short and plain (no call, syscall, indirect jump, undecodable
  // byte or inlined splice; no nested loop; no other loop overlapping) is
  // duplicated UNROLL-1 times right after itself: copy c's internal edges
  // stay inside copy c, its back edge to h goes FORWARD to copy c+1's head,
  // and only the last copy's back edge returns to h - the one backward edge
  // left, so structure() sees one loop and goto() emits one burn per UNROLL
  // iterations. Exits keep their targets (shifted with the insertion), so a
  // copy's exit is still a forward edge. Copies are the same block objects
  // (same instructions, same address), so every address-keyed fact (deopt
  // targets, the probe's head address, jump tables) is unchanged; the flag
  // and liveness analyses run afterwards on the widened CFG. OXWASM_UNROLL
  // sets k (1 disables), default 8. Not applied to a jump-table function
  // (the dispatch layout keeps address-indexed rows).
  const UNROLL = (typeof process !== 'undefined' && +process.env?.OXWASM_UNROLL) || 8;
  if (LOOPYIELD && UNROLL > 1 && !hasJtab) {
    const BAD = new Set(['call','callind','syscall','udec','jmpind','int','hlt','ud2','int3','x87']);
    const plain = (b) => { const last = b.insns[b.insns.length-1];
      if (last.edgeT !== undefined || last.edgeN !== undefined || last.tailCut) return false;
      for (const x of b.insns) if (BAD.has(x.mnem) || x.inlineTo) return false;
      return true; };
    const loopEnd = new Map();
    for (let i = 0; i < N; i++) for (const j of succs[i]) if (j >= 0 && j <= i) loopEnd.set(j, Math.max(loopEnd.get(j) || 0, i + 1));
    // loops that share blocks (a tokenizer loop whose continue paths land on
    // two adjacent headers; a while loop nested in a for) form one cluster
    // [H, E), unrolled as a whole: inside a copy every back edge - to any
    // header of the cluster - goes forward to the next copy's image of that
    // header, so a copy has no backward edge at all
    const hs = [...loopEnd].sort((a, b) => a[0] - b[0]);
    const clusters = [];
    for (const [h, e] of hs) { const c = clusters[clusters.length - 1];
      if (c && h < c[1]) c[1] = Math.max(c[1], e); else clusters.push([h, e]); }
    const cands = [];
    for (const [h, e] of clusters) {
      if (e - h > 12) continue;
      let ok = true, insns = 0;
      for (let q = h; q < e && ok; q++) {
        if (!plain(blocks[q])) { ok = false; break; }
        insns += blocks[q].insns.length;
        for (const j of succs[q]) if (j >= 0 && j < h) ok = false;         // a back edge below the cluster: not a loop of its own
      }
      if (ok && insns <= 80) cands.push([h, e]);
    }
    cands.sort((a, b) => b[0] - a[0]);                 // highest first: an insertion never shifts a lower range
    for (const [h, e] of cands) {
      const len = e - h, k = UNROLL, add = (k - 1) * len;
      const sh = (j) => j >= e ? j + add : j;           // an index at or past the range moves past the copies
      const inCopy = (c, q) => e + (c - 1) * len + (q - h);   // copy c (1..k-1) of block q; copy 0 is the original
      // target j of block q's edge, in copy c: a back edge (j <= q, inside)
      // goes to the next copy's image of j, the last copy's back home; an
      // internal forward edge stays in the copy; anything else is shifted
      const mapEdge = (q, j, c) => { if (j < 0) return j;
        if (j >= h && j < e) {
          if (j <= q) return c === k - 1 ? j : inCopy(c + 1, j);
          return c === 0 ? j : inCopy(c, j); }
        return sh(j); };
      const remapTerm = (q, t, c) => { const u = { ...t };
        if ('t' in u && typeof u.t === 'number') u.t = mapEdge(q, u.t, c);
        if ('f' in u && typeof u.f === 'number') u.f = mapEdge(q, u.f, c);
        return u; };
      const shiftTerm = (t) => { const u = { ...t };
        if ('t' in u && typeof u.t === 'number') u.t = sh(u.t);
        if ('f' in u && typeof u.f === 'number') u.f = sh(u.f);
        return u; };
      const nb = [], nt = [], ns = [];
      const copies = () => { for (let c = 1; c < k; c++) for (let r = h; r < e; r++) {
          nb.push(blocks[r]); nt.push(remapTerm(r, term[r], c)); ns.push(succs[r].map(j => mapEdge(r, j, c)));
        } };
      for (let q = 0; q < N; q++) {
        if (q === e) copies();
        const inRange = q >= h && q < e;
        nb.push(blocks[q]);
        nt.push(inRange ? remapTerm(q, term[q], 0) : shiftTerm(term[q]));
        ns.push(succs[q].map(j => inRange ? mapEdge(q, j, 0) : (j < 0 ? j : sh(j))));
      }
      // a loop that is the LAST range (a unit rooted at its head with the
      // exit block laid out before it: e === N) never met q === e - its
      // edges were remapped onto copies that were never appended, and the
      // emitter indexed past N (found by pumptest's loop-head unit)
      if (e === N) copies();
      blocks.length = 0; blocks.push(...nb); term.length = 0; term.push(...nt); succs.length = 0; succs.push(...ns);
      for (const [id, ix] of bidx) bidx.set(id, sh(ix));
      N = blocks.length;
      (globalThis.__unrollStats ??= { loops: 0, blocks: 0 }).loops++; globalThis.__unrollStats.blocks += add;
    }
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
  // A resolved jump table used to force the dispatch layout (its $pc /
  // $L_disp machinery). It no longer has to: in the structured layout the
  // computed goto becomes a br_table over the case blocks' labels - every
  // jump-table target is in succs, so structure() has given each one a
  // scope label that is in view at the jump - and m4's tokenizer, a switch
  // over the character class inside a loop, paid a dispatcher round-trip
  // per character for it (next_token: 5.3s of a 2.5s native run). Where
  // structure() still cannot nest the fan-in, dispatch remains the fallback.
  if (typeof process !== 'undefined' && process.env?.OXWASM_FORCEDISP === '1') mode = 'dispatch';   // A/B: price the dispatch layout
  else try { ({ open, closeAfter } = structure(N, succs)); }
  catch (e) {
    if (globalThis.__cfgDump && globalThis.__cfgDump === fnAddr.toString(16)) globalThis.__cfgDumped = { N, succs: succs.map(s => [...s]), starts: blocks.map(b => b.start.toString(16)), err: e.message };
    if (!/overlap|irreducible|unclosed|converge/.test(e.message) || globalThis.__disableDispatch) throw e;
    if (hasJtab && globalThis.__jtabStats) { const fb = (globalThis.__jtabStats.fallback ??= {}); const k = e.message.slice(0, 60); fb[k] = (fb[k] || 0) + 1; }
    globalThis.__lastStructErr = e.message.slice(0, 120);
    // bisect aid: every dispatch-mode unit gets a global ordinal; a filter
    // can veto (unit poisons instead — interpreted, correct, uncompiled)
    const n = (globalThis.__dispN = (globalThis.__dispN || 0) + 1);
    if (globalThis.__dispFilter && !globalThis.__dispFilter(n, entry)) throw e;
    mode = 'dispatch';
  }
  const DISP = mode === 'dispatch';
  if (globalThis.__layoutOf) globalThis.__layoutOf.set(fnAddr.toString(16), mode + (hasJtab ? '+jtab' : '') + ' N=' + N + (globalThis.__lastStructErr ? ' (' + globalThis.__lastStructErr + ')' : ''));
  globalThis.__lastStructErr = null;
  { const st = globalThis.__inlStats = globalThis.__inlStats || { fns: 0, callees: 0 };
    st[DISP ? 'disp' : 'struct'] = (st[DISP ? 'disp' : 'struct'] || 0) + 1; }

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
  const sseGprXr = (insn) => [0x2C, 0x2D, 0xD7, 0x50, 0xC5].includes(insn.op);   // 0xC5 pextrw writes a GPR
  const sseGprRm = (insn) => insn.op === 0x6E || insn.op === 0x2A || insn.op === 0xC4 || (insn.op === 0x7E && !insn.pF3);   // 0xC4 pinsrw reads a GPR/m16
  for (const b of blocks) for (const insn of b.insns) {
    const S = insn.size || 8;
    switch (insn.mnem) {
      case 'push': noteRW(insn.src && insn.src.kind==='mem' ? insn.src : null, false); break;   // reg push/pop go via regfile
      case 'pop':  noteRW(insn.dst && insn.dst.kind==='mem' ? insn.dst : null, true); break;
      case 'lea':  seenR[insn.dst.r]=true; any64[insn.dst.r]=true; noteRW(insn.src, false); break;
      case 'call': case 'ret': case 'retn': break;          // implicit r4 only, always seen
      // leave reads AND writes rbp with no explicit operand. A unit whose
      // entry is the bare `leave; ret` tail of a computed-goto function (jq's
      // jv_free) never saw r5 anywhere else, got no entry reload for it, and
      // set rsp from a zero-initialised local - the pop then walked off the
      // wasm memory. Every other implicit-register mnem below already marks
      // its registers; this one was lumped in with call/ret.
      case 'leave': seenR[5] = true; any64[5] = true; break;
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
      case 'sse4': {
        const mark = (r) => { seenR[r]=true; any64[r]=true; };
        if (insn.rm?.kind === 'xmm' && sse4RmIsGpr(insn)) mark(insn.rm.r);
        if (insn.rm?.kind === 'mem') { if (insn.rm.base>=0) mark(insn.rm.base); if (insn.rm.index>=0) mark(insn.rm.index); }
        break; }
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
  // Whether the string ops need a runtime direction. The ABI keeps DF=0 except
  // transiently around a std/cld pair, so a function that never executes `std`
  // steps forward throughout and gets the constant step it always got. One that
  // does reads DF_SLOT per string op instead (see strDir) — it used to be
  // refused whole, which took every string op in it interpreted along with
  // everything the function called.
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
  const sseXrIsGpr = (insn) => [0x2C, 0x2D, 0xD7, 0x50, 0xC5].includes(insn.op);
  const sseRmIsGpr = (insn) => insn.op === 0x6E || insn.op === 0x2A || insn.op === 0xC4 || (insn.op === 0x7E && !insn.pF3);
  const xUsed = new Set();
  for (const b of blocks) for (const insn of b.insns) {
    if (insn.mnem === 'sse') {
      if (!sseXrIsGpr(insn)) xUsed.add(insn.xr);
      if (insn.rm?.kind === 'xmm' && !sseRmIsGpr(insn)) xUsed.add(insn.rm.r);
    }
    if (insn.mnem === 'ssegrpshift') xUsed.add(insn.xrm);
    if (insn.mnem === 'sse4') {
      xUsed.add(insn.xr);
      if (insn.rm?.kind === 'xmm' && !sse4RmIsGpr(insn)) xUsed.add(insn.rm.r);
      if (insn.map === 0x38 && (insn.op === 0x10 || insn.op === 0x14 || insn.op === 0x15)) xUsed.add(0);   // the blend mask is xmm0
    }
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
  // Spill and reload sites are emitted as markers and expanded by the
  // narrowing pass after all blocks exist (it needs whole-CFG dataflow).
  // SA is the full spill (every touched reg + used xmm); SX is the exit
  // spill, which skips disciplined savedI32 regs — their slot was just
  // refreshed by the epilogue pop (the full 64-bit caller value), and the
  // truncated working value must not clobber it. RL is the post-call/
  // post-syscall reload of every synced register. With the lever off the
  // expansion is the full list, identical to the pre-narrowing emitter's
  // output up to whitespace.
  const SA_MARK = '\x00SA\x00', SX_MARK = '\x00SX\x00', RL_MARK = '\x00RL\x00';
  // RC: the reload after a CALL. The SysV ABI makes rbx, rbp, r12-r15
  // callee-saved, and the guest's own compiler already relies on that at
  // every call site it emitted, so their memory copies after the callee
  // returns equal what this frame spilled - which is what the locals still
  // hold. Skipping their reload is free of new assumptions: a callee that
  // clobbers them breaks the native program the same way. rsp stays
  // reloaded (the local holds the post-push value; the callee's ret popped
  // it). Syscalls keep the full RL (the kernel path is not a guest callee).
  // OPT-IN (OXWASM_ABIRELOAD=1), not the default: hand-written asm may pass
  // values back in callee-saved registers - the suite's call-mem test does
  // (its callee accumulates in rbx) and read exit 8 for 100 with this on.
  // "Any unmodified program" includes such code, so the default stays exact.
  // Measured: call kernel 4.94x -> 4.17x, m4 steady state 8.93x -> 8.65x.
  const RC_MARK = (typeof process !== 'undefined' && process.env?.OXWASM_ABIRELOAD === '1') ? '\x00RC\x00' : RL_MARK;
  const CS_MASK = (1 << 3) | (1 << 5) | (1 << 12) | (1 << 13) | (1 << 14) | (1 << 15);

  // ---- operand / instruction emit (identical semantics to the dispatch version) ----
  const hexs = (v) => BigInt.asIntN(64, v).toString();
  let tmpN = 0; const tmps = new Set();
  const T = () => { const n = '$t' + (tmpN++); tmps.add(n); return n; };
  let vtmpN = 0; const vtmps = new Set();
  const VT = () => { const n = '$vt' + (vtmpN++); vtmps.add(n); return n; };
  const reg = (r) => '$r' + r;
  // Direction for the string ops. A function with no `std` in it has DF=0
  // throughout — the ABI guarantees DF=0 at entry and exit and only a std/cld
  // pair breaks it — so the step is the constant +S and the emitted wat is
  // exactly what it was before DF became a runtime value. A function that does
  // contain `std` reads the flag at run time, which is what lets it compile at
  // all: it used to be refused whole, taking every string op in it interpreted.
  //
  // `lo(r)` is the LOW address of the range a bulk op covers, which is the
  // register going forward and rN-(rcx-1) going backward, since x86 names the
  // FIRST element touched and backward that is the range's top.
  // `away(a, b)` is how far a runs into b, positive when the copy overwrites
  // source it has not read yet: it is the overlap test in whichever direction
  // the copy is going.
  const strDir = (S, L) => {
    if (!hasStd) return { step: `(i64.const ${S})`, lo: (r) => `(local.get $r${r})`,
                          away: (a, b) => `(i64.sub (local.get $r${a}) (local.get $r${b}))` };
    const st = T();
    L.push(`(local.set ${st} (select (i64.const ${-S}) (i64.const ${S}) (i32.load (i32.const ${DF_SLOT}))))`);
    const back = `(i64.lt_s (local.get ${st}) (i64.const 0))`;
    return {
      step: `(local.get ${st})`,
      lo: (r) => `(select (i64.sub (local.get $r${r}) (i64.mul (i64.sub (local.get $r1) (i64.const 1)) (i64.const ${S}))) (local.get $r${r}) ${back})`,
      away: (a, b) => `(select (i64.sub (local.get $r${b}) (local.get $r${a})) (i64.sub (local.get $r${a}) (local.get $r${b})) ${back})`,
    };
  };
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
  // Peephole: how many low bits an emitted expression is already known to
  // occupy. Lets the width masks that x86 semantics demand be skipped when
  // the value provably fits — a movzbl's result does not need a second
  // & 0xFFFFFFFF. Purely a code-size/compile-time win (7MB of wat for one
  // CPython unit is wat2wasm time, wabt.js time in the page, and V8 compile
  // time); the differential suite proves the semantics are unchanged.
  const cleanBits = (e) => {
    e = e.trim();
    if (e.startsWith('(i64.load8_u')) return 8;
    if (e.startsWith('(i64.load16_u')) return 16;
    if (e.startsWith('(i64.load32_u')) return 32;
    if (e.startsWith('(i64.extend_i32_u')) return 32;
    let m = /^\(i64\.const (0x[0-9a-fA-F]+|\d+)\)$/.exec(e);
    if (m) { try { const v = BigInt(m[1]); return v === 0n ? 1 : v.toString(2).length; } catch {} }
    m = /^\(i64\.and .* \(i64\.const (0x[0-9a-fA-F]+|\d+)\)\)$/.exec(e);
    if (m) { try { const v = BigInt(m[1]);
      if (v > 0n && (v & (v + 1n)) === 0n) return v.toString(2).length; } catch {} }
    return 64;
  };
  // a constant shift count folds against its & 31 / & 63 mask
  const shmask32 = (e, mask) => {
    const m = /^\(i32\.const (-?\d+)\)$/.exec(e.trim());
    return m ? `(i32.const ${Number(m[1]) & mask})` : `(i32.and ${e} (i32.const ${mask}))`;
  };
  // mask expr to `bits`, unless it is already that narrow
  const nmask = (e, bits) => cleanBits(e) <= bits
    ? e : `(i64.and ${e} (i64.const 0x${((1n << BigInt(bits)) - 1n).toString(16).toUpperCase()}))`;
  let usesGa = false;                 // a guarded store needs an i32 local for the address
  const wr = (op, size, expr, next) => {
    if (op.kind === 'reg') {
      if (isI32(op.r)) {
        if (size >= 4) return `(local.set ${reg(op.r)} (i32.wrap_i64 ${expr}))`;
        const m = MASKl[size];
        if (op.high) return `(local.set ${reg(op.r)} (i32.or (i32.and (local.get ${reg(op.r)}) (i32.const 0xFFFF00FF)) (i32.shl (i32.and (i32.wrap_i64 ${expr}) (i32.const 0xFF)) (i32.const 8))))`;
        return `(local.set ${reg(op.r)} (i32.or (i32.and (local.get ${reg(op.r)}) (i32.const ${Number((~m)&0xFFFFFFFFn)})) (i32.and (i32.wrap_i64 ${expr}) (i32.const ${Number(m)}))))`;
      }
      if (size === 8) return `(local.set ${reg(op.r)} ${expr})`;
      if (size === 4) return `(local.set ${reg(op.r)} ${nmask(expr, 32)})`;
      const m = MASKl[size];
      if (op.high) return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~0xFF00n)&MASKl[8]})) (i64.shl (i64.and ${expr} (i64.const 0xFF)) (i64.const 8))))`;
      return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~m)&MASKl[8]})) ${nmask(expr, size * 8)}))`;
    }
    if (!STOREGUARD) return `(${ST[size]} ${wasmAddr(op, next)} ${expr})`;
    // One unsigned subtract and compare against a window the engine owns. The
    // address is computed once into a local so the guard and the store share
    // it, which keeps the evaluation order the unguarded form already has:
    // address first, then the value.
    usesGa = true;
    // Outer test first and alone: with an empty window the page index would
    // be enormous and the byte load would trap rather than answer false.
    return `(local.set $ga ${wasmAddr(op, next)}) ` +
           `(local.set $gp (i32.sub (local.get $ga) (i32.load (i32.const ${CWLO_SLOT})))) ` +
           `(if (i32.lt_u (local.get $gp) (i32.load (i32.const ${CWLEN_SLOT}))) ` +
           `(then (if (i32.load8_u (i32.add (i32.const ${CWMAP}) (i32.shr_u (local.get $gp) (i32.const 12)))) ` +
           `(then (call $x_cw (local.get $ga)))))) ` +
           `(${ST[size]} (local.get $ga) ${expr})`;
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
  const xhi = (rm, next) => `(i64x2.extract_lane 1 ${xv(rm, next)})`;
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
  function emitSSE4(insn, next, L) {
    const map = insn.map, op = insn.op, im = insn.imm8, xr = insn.xr, rm = insn.rm;
    const dst = `(local.get ${xreg(xr)})`;
    const put = (e) => L.push(setx(xr, e));
    const key = (map === 0x38 ? 0x3800 : 0x3a00) | op;
    // source xmm/m128, or the narrower memory forms of pmovsx/zx
    const memLoad = { 0x3820: 'v128.load64_zero', 0x3821: 'v128.load32_zero', 0x3823: 'v128.load64_zero', 0x3824: 'v128.load32_zero', 0x3825: 'v128.load64_zero',
                      0x3830: 'v128.load64_zero', 0x3831: 'v128.load32_zero', 0x3833: 'v128.load64_zero', 0x3834: 'v128.load32_zero', 0x3835: 'v128.load64_zero' }[key];
    const src = () => rm.kind === 'xmm' ? `(local.get ${xreg(rm.r)})`
      : key === 0x3822 || key === 0x3832 ? `(v128.load16_lane 0 ${wasmAddr(rm, next)} ${ZERO})`
      : `(${memLoad ?? 'v128.load'} ${wasmAddr(rm, next)})`;
    const MINMAX = { 0x38: 'i8x16.min_s', 0x39: 'i32x4.min_s', 0x3a: 'i16x8.min_u', 0x3b: 'i32x4.min_u', 0x3c: 'i8x16.max_s', 0x3d: 'i32x4.max_s', 0x3e: 'i16x8.max_u', 0x3f: 'i32x4.max_u' };
    if (map === 0x38) {
      if (MINMAX[op]) { put(`(${MINMAX[op]} ${dst} ${src()})`); return; }
      if ((op >= 0x20 && op <= 0x25) || (op >= 0x30 && op <= 0x35)) {
        const sx = op < 0x30 ? 's' : 'u', k = op & 7, v = src();
        const w8 = (x) => `(i16x8.extend_low_i8x16_${sx} ${x})`, w16 = (x) => `(i32x4.extend_low_i16x8_${sx} ${x})`, w32 = (x) => `(i64x2.extend_low_i32x4_${sx} ${x})`;
        put([w8(v), w16(w8(v)), w32(w16(w8(v))), w16(v), w32(w16(v)), w32(v)][k]); return; }
      switch (op) {
        case 0x00: put(`(i8x16.swizzle ${dst} (v128.and ${src()} (v128.const i8x16 ${Array(16).fill(0x8f).join(' ')})))`); return;
        case 0x29: put(`(i64x2.eq ${dst} ${src()})`); return;
        case 0x37: put(`(i64x2.gt_s ${dst} ${src()})`); return;
        case 0x40: put(`(i32x4.mul ${dst} ${src()})`); return;
        case 0x1c: put(`(i8x16.abs ${src()})`); return;
        case 0x1d: put(`(i16x8.abs ${src()})`); return;
        case 0x1e: put(`(i32x4.abs ${src()})`); return;
        case 0x10: put(`(v128.bitselect ${src()} ${dst} (i8x16.shr_s (local.get ${xreg(0)}) (i32.const 7)))`); return;     // pblendvb
        case 0x14: put(`(v128.bitselect ${src()} ${dst} (i32x4.shr_s (local.get ${xreg(0)}) (i32.const 31)))`); return;    // blendvps
        case 0x15: put(`(v128.bitselect ${src()} ${dst} (i64x2.shr_s (local.get ${xreg(0)}) (i32.const 63)))`); return;    // blendvpd
      }
      throw new Error('AOT sse4 0f38 ' + op.toString(16));
    }
    switch (op) {
      case 0x08: case 0x09: case 0x0a: case 0x0b: {      // roundps / roundpd / roundss / roundsd
        const mode = (im & 4) ? 0 : (im & 3), nm = ['nearest', 'floor', 'ceil', 'trunc'][mode];
        const v = src();
        if (op === 0x08) put(`(f32x4.${nm} ${v})`);
        else if (op === 0x09) put(`(f64x2.${nm} ${v})`);
        else if (op === 0x0a) put(`(f32x4.replace_lane 0 ${dst} (f32.${nm} (f32x4.extract_lane 0 ${v})))`);
        else put(`(f64x2.replace_lane 0 ${dst} (f64.${nm} (f64x2.extract_lane 0 ${v})))`);
        return; }
      case 0x0c: case 0x0d: case 0x0e: {                 // blendps / blendpd / pblendw: lane i from the source when imm bit i is set
        const eb = op === 0x0c ? 4 : op === 0x0d ? 8 : 2, n = 16 / eb, idx = [];
        for (let i = 0; i < n; i++) for (let b = 0; b < eb; b++) idx.push(((im >> i) & 1 ? 16 : 0) + i * eb + b);
        put(`(i8x16.shuffle ${idx.join(' ')} ${dst} ${src()})`); return; }
      case 0x0f: {                                       // palignr: (dst:src) >> (imm*8)
        const idx = [];
        if (im < 16) { for (let i = 0; i < 16; i++) idx.push(i + im); put(`(i8x16.shuffle ${idx.join(' ')} ${src()} ${dst})`); }
        else if (im < 32) { for (let i = 0; i < 16; i++) idx.push(i + im - 16); put(`(i8x16.shuffle ${idx.join(' ')} ${dst} ${ZERO})`); }
        else put(ZERO);
        return; }
      case 0x20: { const g = rm.kind === 'xmm' ? rd({ kind: 'reg', r: rm.r, size: 4 }, 4, next) : `(i64.load8_u ${wasmAddr(rm, next)})`;
        put(`(i8x16.replace_lane ${im & 15} ${dst} (i32.wrap_i64 ${g}))`); return; }
      case 0x22: {
        if (insn.W) { const g = rm.kind === 'xmm' ? rd({ kind: 'reg', r: rm.r, size: 8 }, 8, next) : `(i64.load ${wasmAddr(rm, next)})`;
          put(`(i64x2.replace_lane ${im & 1} ${dst} ${g})`); }
        else { const g = rm.kind === 'xmm' ? rd({ kind: 'reg', r: rm.r, size: 4 }, 4, next) : `(i64.load32_u ${wasmAddr(rm, next)})`;
          put(`(i32x4.replace_lane ${im & 3} ${dst} (i32.wrap_i64 ${g}))`); }
        return; }
    }
    throw new Error('AOT sse4 0f3a ' + op.toString(16));
  }

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
      // register operand = MOVHLPS (dst low <- src HIGH), memory = movlps
      // (dst low <- [mem]). Taking the low half in both cases is a silent
      // wrong-pointer bug wherever gcc unpacks an xmm-returned pair.
      case 0x12: put(`(i64x2.replace_lane 0 ${dst} ${rm.kind==='xmm'?xhi(rm,next):`(i64.load ${wasmAddr(rm,next)})`})`); break;  // movhlps / movlps
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
      // psadbw: per 8-byte half, the sum of |a-b| over its bytes, landing in
      // that half's low 16 bits. wasm has no such op, but it has the two
      // pieces: saturating subtraction both ways ORed together is the unsigned
      // absolute difference (one side is always zero), and two rounds of
      // extadd_pairwise fold 16 bytes down to four 32-bit lane sums - lanes
      // 0+1 are the low half, 2+3 the high. The maximum per half is 8*255 =
      // 2040, so nothing can overflow on the way.
      case 0xF6: {
        const d = VT(), q = VT();
        L.push(`(local.set ${d} (v128.or (i8x16.sub_sat_u ${dst} ${xv(rm, next)}) (i8x16.sub_sat_u ${xv(rm, next)} ${dst})))`);
        L.push(`(local.set ${q} (i32x4.extadd_pairwise_i16x8_u (i16x8.extadd_pairwise_i8x16_u (local.get ${d}))))`);
        const half = (a, b) => `(i64.extend_i32_u (i32.add (i32x4.extract_lane ${a} (local.get ${q})) (i32x4.extract_lane ${b} (local.get ${q}))))`;
        put(`(i64x2.replace_lane 1 (i64x2.replace_lane 0 ${ZERO} ${half(0, 1)}) ${half(2, 3)})`);
        break; }
      // pinsrw/pextrw: one 16-bit lane in or out. The interpreter has had both
      // for a long time; the emitter refused them, and since a unit whose
      // ENTRY is unsupported is refused whole, that put real functions in the
      // interpreter - 10 of the sweep's remaining hot refusals were this.
      case 0xC4:                                                              // pinsrw xmm[imm3] <- r/m16
        put(`(i16x8.replace_lane ${insn.imm8 & 7} ${dst} ${rm.kind === 'xmm'
          ? rd32({ kind:'reg', r: rm.r, size: 4 }, next)
          : `(i32.load16_u ${wasmAddr(rm, next)})`})`);
        break;
      case 0xC5:                                                              // pextrw r32 <- xmm[imm3], zero-extended
        L.push(wr32reg(xr, `(i16x8.extract_lane_u ${insn.imm8 & 7} ${xv(rm, next)})`));
        break;
      case 0xC6: {                                                            // shufps (ps) / shufpd (66): low half from dst, high half from src
        const im = insn.imm8, idx = [];
        if (insn.p66) { for (let i = 0; i < 8; i++) idx.push((im & 1) * 8 + i); for (let i = 0; i < 8; i++) idx.push(16 + ((im >> 1) & 1) * 8 + i); }
        else { for (const [sel, from] of [[im & 3, 0], [(im >> 2) & 3, 0], [(im >> 4) & 3, 16], [(im >> 6) & 3, 16]]) for (let i = 0; i < 4; i++) idx.push(from + sel * 4 + i); }
        put(`(i8x16.shuffle ${idx.join(' ')} ${dst} ${xv(rm, next)})`); break; }
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
        // Which prefix means "double" depends on whether the form is scalar or
        // packed, and one variable was doing both jobs. F2 is scalar double
        // (mulsd); 66 is PACKED double (mulpd). Selecting the lane type from
        // F2 alone meant every packed-double op - addpd, subpd, mulpd, divpd,
        // minpd, maxpd, sqrtpd - was emitted as f32x4 and computed four
        // single-precision lanes where the guest asked for two doubles.
        const F = insn.pF2 ? 'f64' : 'f32', LN = insn.pF2 ? 'f64x2' : 'f32x4';
        const ext = (v) => `(${LN}.extract_lane 0 ${v})`;
        const a = ext(dst), b = ext(xv(rm, next));
        const scalar = insn.pF3 || insn.pF2;
        if (!scalar) {  // packed
          const LN = insn.p66 ? 'f64x2' : 'f32x4';
          const P = { 0x51:`${LN}.sqrt`, 0x58:`${LN}.add`, 0x59:`${LN}.mul`, 0x5C:`${LN}.sub`, 0x5D:`${LN}.pmin`, 0x5E:`${LN}.div`, 0x5F:`${LN}.pmax` }[op];
          // pmin/pmax take their operands the other way round from the rest.
          // wasm's pmin(x,y) is `y < x ? y : x`, so on a NaN or a tie it yields
          // x - and x86's MIN/MAX yield the SECOND source there. Passing
          // (src, dst) rather than (dst, src) makes the tie go the guest's way
          // and carries the source's NaN payload through unchanged.
          const swap = op === 0x5D || op === 0x5F;
          put(op===0x51 ? `(${P} ${xv(rm,next)})`
                        : swap ? `(${P} ${xv(rm,next)} ${dst})` : `(${P} ${dst} ${xv(rm,next)})`); break;
        }
        // the scalar pair has the same rule, and wasm's f64.min/max cannot
        // express it: they return a canonical NaN and prefer -0. A select on
        // the ordered comparison is exact - false on a NaN or a tie, which
        // lands on the second source, operand bits and all.
        const e = op===0x51 ? `(${F}.sqrt ${b})` : op===0x58 ? `(${F}.add ${a} ${b})` : op===0x59 ? `(${F}.mul ${a} ${b})`
                : op===0x5C ? `(${F}.sub ${a} ${b})` : op===0x5D ? `(select ${a} ${b} (${F}.lt ${a} ${b}))`
                : op===0x5E ? `(${F}.div ${a} ${b})` : `(select ${a} ${b} (${F}.gt ${a} ${b}))`;
        put(`(${LN}.replace_lane 0 ${dst} ${e})`); break; }
      // pmaddwd: multiply signed 16-bit lanes and add adjacent pairs into
      // 32-bit lanes. wasm has exactly this instruction and the emitter did
      // not use it - i32x4.dot_i16x8_s IS pmaddwd, wrapping included.
      case 0xF5: put(`(i32x4.dot_i16x8_s ${dst} ${xv(rm, next)})`); break;
      // cvtdq2ps, the unprefixed form of 0F 5B: four signed i32 lanes to f32,
      // which is one wasm instruction. The 66 and F3 forms go the other way
      // and are NOT this - x86 hands back 0x80000000 for anything out of range
      // or NaN, where wasm's trunc_sat saturates to INT_MAX or gives 0, so
      // they stay refused rather than be lowered to something close.
      case 0x5B: {
        if (!insn.p66 && !insn.pF3) { put(`(f32x4.convert_i32x4_s ${xv(rm, next)})`); break; }
        // The to-integer forms. x86 hands back 0x80000000 - the "integer
        // indefinite" - for a NaN or anything that will not fit, where wasm's
        // trunc_sat gives 0 for a NaN and clamps to INT_MAX or INT_MIN. So
        // compute the saturating conversion, work out per lane whether the
        // value was actually in range, and choose.
        //
        // 66 rounds to nearest-EVEN first (f32x4.nearest is exactly that, and
        // is the default MXCSR mode this engine keeps); F3 truncates. The
        // range test runs on the ROUNDED value, so 2147483647.5 rounds up out
        // of range and yields the indefinite rather than a clamp.
        const t = VT();
        L.push(`(local.set ${t} ${insn.p66 ? `(f32x4.nearest ${xv(rm, next)})` : xv(rm, next)})`);
        const v = `(local.get ${t})`;
        const LIM = '(v128.const f32x4 2147483648 2147483648 2147483648 2147483648)';
        const NEG = '(v128.const f32x4 -2147483648 -2147483648 -2147483648 -2147483648)';
        const inRange = `(v128.and (f32x4.eq ${v} ${v}) (v128.and (f32x4.lt ${v} ${LIM}) (f32x4.ge ${v} ${NEG})))`;
        put(`(v128.bitselect (i32x4.trunc_sat_f32x4_s ${v}) (i32x4.splat (i32.const -2147483648)) ${inRange})`);
        break; }
      // 0F E6: cvtdq2pd (F3), cvttpd2dq (66), cvtpd2dq (F2). The first is one
      // wasm instruction. The other two narrow two f64 to the LOW two i32
      // lanes and zero the rest; like 0F 5B they answer 0x80000000 for a NaN
      // or an out-of-range value where trunc_sat gives 0 or clamps, so the
      // range test runs on the rounded value and picks the indefinite.
      case 0xE6: {
        if (insn.pF3) { put(`(f64x2.convert_low_i32x4_s ${xv(rm, next)})`); break; }
        const t = VT();
        L.push(`(local.set ${t} ${insn.p66 ? `(f64x2.trunc ${xv(rm, next)})` : `(f64x2.nearest ${xv(rm, next)})`})`);
        const v = `(local.get ${t})`;
        const LIM = '(v128.const f64x2 2147483648 2147483648)', NEG = '(v128.const f64x2 -2147483648 -2147483648)';
        const m = `(v128.and (f64x2.eq ${v} ${v}) (v128.and (f64x2.lt ${v} ${LIM}) (f64x2.ge ${v} ${NEG})))`;
        const mask = `(i8x16.shuffle 0 1 2 3 8 9 10 11 16 17 18 19 16 17 18 19 ${m} (v128.const i32x4 0 0 0 0))`;
        put(`(v128.bitselect (i32x4.trunc_sat_f64x2_s_zero ${v}) (v128.const i32x4 -2147483648 -2147483648 0 0) ${mask})`);
        break; }
      case 0x5A: {                                            // cvtss2sd / cvtsd2ss / cvtps2pd / cvtpd2ps
        if (insn.pF3) put(`(f64x2.replace_lane 0 ${dst} (f64.promote_f32 (f32x4.extract_lane 0 ${xv(rm,next)})))`);
        else if (insn.pF2) put(`(f32x4.replace_lane 0 ${dst} (f32.demote_f64 (f64x2.extract_lane 0 ${xv(rm,next)})))`);
        // The PACKED forms, which were refused for want of two opcodes that
        // wasm happens to have exactly. cvtps2pd widens the low two f32 lanes
        // to f64 and replaces the whole register; cvtpd2ps narrows two f64 to
        // the low two f32 lanes and ZEROES the upper half, which is what the
        // `_zero` in the wasm name means. Both match the interpreter's rule
        // without any lane fixing around them.
        else if (insn.p66) put(`(f32x4.demote_f64x2_zero ${xv(rm, next)})`);
        else put(`(f64x2.promote_low_f32x4 ${xv(rm, next)})`);
        break; }
      case 0x2B: storeRm(16, dst); break;                                     // movntps/pd
      // p{srl,sra,sll}{w,d,q} with the count in a REGISTER or memory rather
      // than an immediate. The immediate forms have been here for a while and
      // these were not, so any function using one stayed interpreted.
      //
      // x86 takes the whole low quadword of the source as the count and
      // answers zero for a shift at or past the lane width; wasm takes the
      // count modulo the lane width, so a count of 16 on i16x8 is a shift of
      // nothing rather than a wipe. The arithmetic form clamps to width-1
      // instead, because shifting a signed lane out entirely leaves the sign.
      case 0xD1: case 0xD2: case 0xD3: case 0xE1: case 0xE2: case 0xF1: case 0xF2: case 0xF3: {
        const EB = { 0xD1:2, 0xE1:2, 0xF1:2, 0xD2:4, 0xE2:4, 0xF2:4, 0xD3:8, 0xF3:8 }[op], W = EB * 8;
        const LN = { 2:'i16x8', 4:'i32x4', 8:'i64x2' }[EB];
        const c = T();
        L.push(`(local.set ${c} ${rm.kind === 'xmm' ? `(i64x2.extract_lane 0 ${xv(rm, next)})`
                                                    : `(i64.load ${wasmAddr(rm, next)})`})`);
        const inR = `(i64.lt_u (local.get ${c}) (i64.const ${W}))`;
        if (op >= 0xE1 && op <= 0xE2)
          put(`(${LN}.shr_s ${dst} (i32.wrap_i64 (select (local.get ${c}) (i64.const ${W - 1}) ${inR})))`);
        else {
          const keep = `(i64x2.splat (i64.sub (i64.const 0) (i64.extend_i32_u ${inR})))`;
          const sh = op >= 0xF1 ? `${LN}.shl` : `${LN}.shr_u`;
          put(`(v128.and (${sh} ${dst} (i32.wrap_i64 (local.get ${c}))) ${keep})`);
        }
        break; }
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
    // A count AT OR BEYOND the lane width is where the two machines part.
    // x86 saturates: the logical shifts give zero and the arithmetic one gives
    // each lane's sign bit repeated. wasm MASKS the count modulo the lane
    // width, so `psrld xmm, 32` became a shift by 0 and returned the operand
    // unchanged, and `psraw xmm, 17` became a shift by 1.
    //
    // 46 of 104 immediate-shift results were wrong across the eight forms and
    // thirteen counts - every count from the lane width up. The interpreter
    // had it right the whole time, which is what makes it a translator bug
    // rather than a modelling gap, and what kept it invisible: no directed
    // test shifted past a lane.
    const W = EB * 8, over = c >= W;
    let e;
    if (insn.sub === 2) e = over ? ZERO : `(${LN}.shr_u ${x} (i32.const ${c}))`;   // psrl
    else if (insn.sub === 6) e = over ? ZERO : `(${LN}.shl ${x} (i32.const ${c}))`; // psll
    else if (insn.sub === 4) e = `(${LN}.shr_s ${x} (i32.const ${over ? W - 1 : c}))`;  // psra: saturates to the sign
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
    if (insn.mnem === 'imul2' || insn.mnem === 'imul3') return true;   // same: CF=OF = the product did not fit
    if (insn.mnem === 'bsf' || insn.mnem === 'bsr' || insn.mnem === 'popcnt' || insn.mnem === 'cmpxchgdq') return true;   // ZF <- (src==0), ZF <- equal
    return false;
  };
  // Instructions that write flags in a way we DON'T model: a nearest such
  // writer before a consumer means the lazy flags are unrecoverable.
  const CLOBBER = new Set(['shl','shr','sar','rol','ror','mul1','imul1','div1','idiv1',
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
      // CF and OF are CLEARED by these, which is what 'logic' means. This
      // return is not decoration: the case list used to share one return with
      // the shift line below, and splitting the shifts off left and/or/xor/test
      // falling through into them - so the ANALYSIS called an `and` a shift
      // while the emitter called it logic. Single-block consumers read the
      // emitter's state and looked correct; a cross-block consumer took the
      // analysis's kind and read $fa/$fb that no `and` had written.
      case 'or': case 'and': case 'xor': case 'test': return { kind:'logic', size:S };
      // 'logic' means CF and OF are CLEARED, which is true of and/or/xor/test
      // and NOT of a shift (CF is the last bit shifted out) or bsf/bsr (CF
      // undefined). Sharing one kind made `shr rax,1; adc rbx,0` compile with
      // CF=0 and return the wrong answer, so they get a kind of their own that
      // carries only the result-derived conditions.
      // an immediate count materializes CF and OF both ('shiftf'); a register
      // count is not a modeled producer at all, so it never reaches a consumer
      case 'shl': case 'shr': case 'sar': return { kind: insn.src.kind === 'imm' ? 'shiftf' : 'shift', size:S };
      // bsf/bsr define ZF and nothing else - SF, CF and OF are architecturally
      // undefined - and $fr holds the SOURCE, so reading a sign off it is
      // reading the operand, not a result.
      case 'bsf': case 'bsr': case 'popcnt': return { kind:'zf', size:S };
      case 'cmpxchgdq': return { kind:'zf', size:8 };
      case 'inc': return { kind:'inc', size:S };
      case 'dec': return { kind:'dec', size:S };
      // 'cf' is CF alone (bt family leaves OF undefined); 'cfof' is the
      // multiply case where CF and OF are the same bit. Sharing one kind made
      // `bt rax,rsi; jo` answer with CF.
      case 'bt': case 'bts': case 'btr': case 'btc': return { kind:'cf', size:S };
      case 'mul1': case 'imul1': case 'imul2': case 'imul3': return { kind:'cfof', size:S };
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
        // A block that ends with the flags clobbered by an unmodeled writer
        // (a variable-count shift, say) must hand its successors a sentinel,
        // not an EMPTY set: empty meant "no producer reaches from here" and a
        // consumer reached both through the clobber and through a real
        // producer compiled against the real one alone. Go's memeqbody ends
        // in `sub; shl %cl; sete` with a `je` from an earlier cmp into the
        // sete block: the sete read the cmp's flags on the shl path and
        // runtime.memequal answered false for any 1-7 byte string, which
        // took the whole go tool down ("invalid Getenv GOOS").
        const nout = killsFlags[b] ? new Set(['KILL']) : localDef[b] ? new Set([localDef[b]]) : nin;
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
  // Producer keys that must ALSO materialize the real EFLAGS word into $fbits.
  // A consumer whose flags come from another block needs one uniform lazy kind
  // on every path in, and two predecessors ending in `cmp` and `test` do not
  // have one - that is the single biggest refusal class the fuzzer reports.
  // The kinds below carry all six flags exactly (see flagWord), so a join over
  // them can hand the consumer a WORD instead of a shared kind, and it reads
  // the bit it wants. Kinds that leave a flag undefined stay out: inc/dec do
  // not touch CF, a shift without the count-1 rule has no OF, bsf/bsr define
  // only ZF, and a word with a made-up bit in it is worse than a refusal.
  const bitsProducers = new Set();
  const BITSOK = new Set(['sub', 'add', 'logic', 'shiftf', 'adc', 'sbb', 'fcmp']);
  // Soft consumers read the flags too, but an unknown producer must not
  // poison the function - they just get no flags:
  //  - an escape to the interpreter (udec terminator: pushf, x87, cpuid ...)
  //    hands the interpreter the lazily kept flags, or nothing if unknown
  //    (before this, cpu.f stayed stale across every escape: `repne scasq;
  //    pushfq` read the flags of whatever ran last in the interpreter);
  //  - a rep-prefixed cmps/scas leaves the flags UNTOUCHED when rcx is 0,
  //    so it is a consumer of the incoming flags as well as a producer.
  // softFlags: 'b:idx' -> {kind,size} of the flags reaching the consumer, or null.
  const softFlags = new Map();
  for (let b = 0; b < N; b++) {
    const insns = blocks[b].insns, consumers = [], soft = new Set();
    // adc/sbb also CONSUME CF (from the nearest preceding flag producer)
    for (let j = 0; j < insns.length; j++) {
      if (['cmov','setcc','adc','sbb'].includes(insns[j].mnem)) consumers.push(j);
      else if ((insns[j].mnem === 'cmps' || insns[j].mnem === 'scas') && (insns[j].rep || insns[j].rep2)) { consumers.push(j); soft.add(j); }
      // pushf reads every arithmetic flag and produces none, so it is a soft
      // consumer exactly like a zero-count rep scan. It was one only by
      // accident before - as a deopt it ended the block, and the deopt
      // terminator was the thing registered.
      else if (insns[j].mnem === 'pushf') { consumers.push(j); soft.add(j); }
    }
    if (term[b].kind === 'jcc') consumers.push(insns.length - 1);
    else if (term[b].kind === 'deopt' && !term[b].src) { consumers.push(insns.length - 1); soft.add(insns.length - 1); }
    const from = new Map();                         // consumer index -> nearest producer, or -1/-2
    for (const j of consumers) {
      let p = -1, clob = null;
      for (let kk = j - 1; kk >= 0; kk--) { const insn = insns[kk];
        if (modeled(insn)) { p = kk; break; } if (CLOBBER.has(insn.mnem)) { clob = insn; p = -2; break; } }
      from.set(j, { p, clob });
    }
    // Promote the block's incoming state to a materialized word BEFORE any
    // consumer is answered, not while walking them. Deciding per consumer made
    // the answer depend on the ORDER: a pushf ahead of the setcc that forced
    // the promotion recorded "no flags reach here" and escaped handing the
    // interpreter nothing, in a function that now compiles instead of being
    // refused outright - which is a worse trade than the refusal was.
    // Every reaching definition must be a real producer of a buildable kind.
    // 'KILL' is not one and must NOT be filtered out of the set: it marks a
    // path that reached here with the flags destroyed by an unmodeled writer,
    // and a word materialized on the OTHER path is exactly the stale answer
    // the sentinel exists to prevent. Dropping it put Go's memeqbody
    // (`sub; shl %cl; sete`, entered by a `je` from an earlier `cmp`) back to
    // answering false for every 1-7 byte string, and the go tool back to
    // "invalid Getenv GOOS" - the same failure this sentinel was added for.
    if (!blkFlagIn[b] && [...from.values()].some((f) => f.p === -1)) {
      const keys = [...inDefs[b]];
      if (keys.length && keys.every((k) => BITSOK.has(defKind.get(k)?.kind))) {
        blkFlagIn[b] = { kind: 'bits', size: 8 };
        for (const key of keys) bitsProducers.add(key);
      }
    }
    for (const j of consumers) {
      const { p, clob } = from.get(j);
      if (soft.has(j)) {
        if (p >= 0) { matProducers.add(b+':'+p); softFlags.set(b+':'+j, flagKind(insns[p])); }
        else if (p === -1 && blkFlagIn[b]) { for (const key of inDefs[b]) if (key !== 'EXT' && key !== 'KILL') matProducers.add(key); softFlags.set(b+':'+j, blkFlagIn[b]); }
        else softFlags.set(b+':'+j, null);
        continue;
      }
      if (p >= 0) matProducers.add(b+':'+p);
      else if (p === -2) throw new Error('AOT: unmodeled flag producer '+clob.mnem+' @ '+clob.rip.toString(16));
      else {                                        // producer is cross-block
        if (!blkFlagIn[b]) throw new Error('AOT: cross-block flags for '+(insns[j].mnem==='jcc'?'jcc':insns[j].mnem)+' @ '+insns[j].rip.toString(16));
        for (const key of inDefs[b]) if (key !== 'EXT' && key !== 'KILL') matProducers.add(key);
      }
    }
  }

  if (typeof process !== 'undefined' && process.env.OXBITS && bitsProducers.size)
    console.error(`<bits fn=${fnAddr.toString(16)} n=${bitsProducers.size} blocks=${N}>`);
  // indirect TAIL call ($rex holds the computed target, regfile spilled): if
  // the target is a registered compiled function, run it wasm-to-wasm — the
  // callee's ret pops OUR caller's return address, so its frame-exit rip is
  // exactly this frame's exit value.
  let usesFtr = false, usesFts = false, usesYield = false;
  // in-unit call sites bump the nesting word only when the yield is on (it is
  // what the yield's nested-frame rule reads); off, the call site is as before
  // OXWASM_NOACCT=1 is a PRICING PROBE: drops the nest counter and the chain
  // fuel from every call site (unsound for slicing; node-only measurement)
  const NOACCT = typeof process !== 'undefined' && process.env?.OXWASM_NOACCT === '1';
  const nestUp = (LOOPYIELD && !NOACCT) ? `(i32.store (i32.const ${FTNEST}) (i32.add (i32.load (i32.const ${FTNEST})) (i32.const 1))) ` : '';
  const nestDn = (LOOPYIELD && !NOACCT) ? ` (i32.store (i32.const ${FTNEST}) (i32.sub (i32.load (i32.const ${FTNEST})) (i32.const 1)))` : '';
  // Stack accounting is entry-tax-only: a function bumps FTDEPTH by its
  // weight (frame size grows with function size — V8 spill slots) and never
  // decrements on ret; instead every call site snapshots the word and
  // restores it absolutely after the callee returns. Tail jumps are REAL
  // wasm tail calls (return_call_indirect — the frame is physically
  // replaced), so a tail site hands back exactly its own tax and the callee
  // re-taxes at its own weight: an unbounded computed-goto chain (CPython's
  // bytecode dispatch) holds constant real stack AND constant counted depth.
  // With core-wasm `(return (call_indirect))` each hop kept its frame live,
  // the word ratcheted to FTDLIMIT within one bytecode loop, and every
  // dispatch thereafter was refused — 99.5% of residual interp ran with the
  // budget word saturated (measured).
  const ftW = Math.min(96, Math.max(1, blocks.reduce((s, b) => s + b.insns.length, 0) >> 9));
  const ftOk  = NOACCT ? `(i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT}))`
    : `(i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT})) (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0)))`;
  const ftHit = `(i32.and (i32.ge_s (local.get $fti) (i32.const 0)) ${ftOk})`;
  const ftBurn = NOACCT ? '' : `(i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))`;
  const ftInc = `(i32.store (i32.const ${FTDEPTH}) (i32.add (i32.load (i32.const ${FTDEPTH})) (i32.const ${ftW})))`;
  const ftDec = `(i32.store (i32.const ${FTDEPTH}) (i32.sub (i32.load (i32.const ${FTDEPTH})) (i32.const ${ftW})))`;
  const ftSave = () => { usesFts = true; return `(local.set $fts (i32.load (i32.const ${FTDEPTH})))`; };
  const ftRestore = `(i32.store (i32.const ${FTDEPTH}) (local.get $fts))`;
  // A tail jump chains only while the guest stack is still within this
  // frame (rsp <= the entry rsp). A longjmp restores a caller's rsp before
  // its `jmp *%rdx`; chaining that would splice the landing's continuation
  // into THIS wasm frame, and when the landing later returned, the wasm
  // return would resume the function the guest had abandoned (ld.so's
  // _dl_signal_exception ran its post-longjmp code with rsi=1 and trapped;
  // javac hit it on every failed dlsym). Above the frame it deopts instead,
  // and the engine unwinds the stale frames.
  // A TOP-LEVEL frame (nesting word zero: dispatched from the run loop, no
  // translated call site waiting on its return) may chain regardless of rsp:
  // its exit rip is honoured, so whatever the chain eventually returns to is
  // simply where the guest goes next. HotSpot's template interpreter uses rsp
  // as the Java operand stack and dispatches every bytecode with rsp above the
  // template's entry rsp; guarding those cost javac 41M deopts in 400 s.
  const tailJmp = () => { usesFtr = true; return [
    icResolve('(local.get $rex)'),
    `(if (i32.and ${ftHit} (i32.or (i64.le_u (local.get $r4) (local.get $rsp0)) (i32.eqz (i32.load (i32.const ${FTNEST})))))`,
    `  (then ${ftBurn} ${ftDec} (return_call_indirect $ft (type $uft) (local.get $fti))))`,
  ]; };

  function emitBlock(i) {
    const blk = blocks[i]; const L = [];
    if (BLKPROF.size && BLKPROF.has(fnAddr.toString())) { const sl = blkprofSlot(blk.start); L.push(`(i64.store (i32.const ${sl}) (i64.add (i64.load (i32.const ${sl})) (i64.const 1)))`); }
    const producers = new Set();
    for (let idx = 0; idx < blk.insns.length; idx++) if (matProducers.has(i+':'+idx)) producers.add(idx);
    let flagState = blkFlagIn[i] || null, ii = 0;
    // EFLAGS from the lazy state, stored (bit 63 set as the marker) in the
    // regfile's flag slot for syncIn to apply; kinds whose CF the lazy model
    // does not carry (inc/dec/adc/sbb/cf/fcmp) hand nothing over.
    const eflagsStore = (fs, want) => {
      // 'shiftf' and 'zf' belong here because shifts and bsf/bsr USED to be
      // the 'logic' kind and so handed flags over. Splitting them out without
      // adding them here made a unit hand over NOTHING at an escape, and the
      // interpreter then resumed on whatever flags it had last computed
      // itself - which is the exact bug the flag slot exists to prevent. It
      // cost javac: the JVM escapes constantly (cpuid, x87, fxsave), and it
      // died with an AbstractMethodError while every differential still
      // passed, because the differentials never escape.
      // 'bits' IS the word already - a join materialized it (see flagWord).
      if (fs && fs.kind === 'bits')
        return want === 'value' ? '(local.get $fbits)'
          : `(i64.store (i32.const ${EFLAGS_SLOT}) (i64.or (local.get $fbits) (i64.const -9223372036854775808)))`;
      if (!fs || !['sub', 'add', 'logic', 'shiftf', 'zf'].includes(fs.kind)) return '';
      return want === 'value' ? flagWord(fs, '514')      // 0x202: bit 1 reserved-set, IF set
                              : `(i64.store (i32.const ${EFLAGS_SLOT}) ${flagWord(fs, '-9223372036854775296')})`;   // marker | 0x202
    };
    // The EFLAGS word the lazy state implies, as one expression. Two callers
    // want it: an escape, which hands it to the interpreter, and a control-flow
    // JOIN, which stores it in $fbits so a consumer in a later block can read
    // real flag bits instead of re-deriving them from operands it cannot see.
    const flagWord = (fs, base) => {
      // ucomis/comis is the one kind whose flags do not come from a result:
      // $fa and $fb hold the two f64 bit patterns and $fr is nothing. x86
      // writes ZF, PF and CF from the compare and clears OF, SF and AF -
      // unordered sets all three, below sets CF alone, equal sets ZF alone.
      if (fs.kind === 'fcmp') {
        const A = '(f64.reinterpret_i64 (local.get $fa))', B = '(f64.reinterpret_i64 (local.get $fb))';
        const un = `(i64.extend_i32_u (i32.or (f64.ne ${A} ${A}) (f64.ne ${B} ${B})))`;
        const zf = `(i64.extend_i32_u (i32.or (f64.eq ${A} ${B}) (i32.wrap_i64 ${un})))`;
        const cf = `(i64.extend_i32_u (i32.eqz (f64.ge ${A} ${B})))`;   // below OR unordered
        return `(i64.or (i64.or (i64.const ${base}) ${cf}) (i64.or (i64.shl ${un} (i64.const 2)) (i64.shl ${zf} (i64.const 6))))`;
      }
      const S = fs.size, sgn = SIGNl[S], m = MASK[S];
      const a = '(local.get $fa)', b = '(local.get $fb)', r = '(local.get $fr)';
      const zf = `(i64.extend_i32_u (i64.eqz ${r}))`, sf = `(i64.extend_i32_u (i64.ne (i64.and ${r} (i64.const ${sgn})) (i64.const 0)))`;
      let cf = '(i64.const 0)', of = '(i64.const 0)';
      if (fs.kind === 'sub') { cf = `(i64.extend_i32_u (i64.lt_u ${a} ${b}))`; of = `(i64.extend_i32_u (i64.ne (i64.and (i64.and (i64.xor ${a} ${b}) (i64.xor ${a} ${r})) (i64.const ${sgn})) (i64.const 0)))`; }
      else if (fs.kind === 'add') { cf = `(i64.extend_i32_u (i64.lt_u ${r} (i64.and ${a} (i64.const ${m}))))`; of = `(i64.extend_i32_u (i64.ne (i64.and (i64.and (i64.xor ${a} ${r}) (i64.xor ${b} ${r})) (i64.const ${sgn})) (i64.const 0)))`; }
      // a shift materialized both: CF is the last bit out ($fb), OF the
      // count-independent rule ($fa). 'logic' and 'zf' keep CF=OF=0, which is
      // exact for and/or/xor/test and is what bsf/bsr handed over before.
      else if (fs.kind === 'shiftf') { cf = `(i64.and ${b} (i64.const 1))`; of = `(i64.and ${a} (i64.const 1))`; }
      // adc/sbb carry their CF in $cf rather than deriving it, and their OF is
      // the add or subtract rule over the same operands. Every flag is exact,
      // so a join over them is as sound as one over a plain add.
      else if (fs.kind === 'adc' || fs.kind === 'sbb') {
        cf = '(local.get $cf)';
        of = fs.kind === 'adc'
          ? `(i64.extend_i32_u (i64.ne (i64.and (i64.and (i64.xor ${a} ${r}) (i64.xor ${b} ${r})) (i64.const ${sgn})) (i64.const 0)))`
          : `(i64.extend_i32_u (i64.ne (i64.and (i64.and (i64.xor ${a} ${b}) (i64.xor ${a} ${r})) (i64.const ${sgn})) (i64.const 0)))`;
      }
      // PF and AF. syncIn assigns all six flags unconditionally, so a word
      // that omits these does not leave them alone - it forces them to zero,
      // and the interpreter then runs `pushf`, `jp` or `lahf` on a flag the
      // unit silently cleared. No bare-unit differential can see it, because a
      // bare unit never escapes.
      //
      // PF is the parity of the result's low byte for every kind that derives
      // flags from a result, which is what the interpreter's szp() computes.
      // AF is defined only for add and sub - a carry or borrow across bit 3 -
      // and the interpreter zeroes it for logic. After a shift or bsf/bsr the
      // architecture leaves AF undefined and the interpreter leaves it stale,
      // which is not a value the lazy model can reproduce; zero stays the
      // answer there, and a guest reading AF after a shift is reading garbage
      // on hardware too.
      const pf = `(i64.and (i64.xor (i64.popcnt (i64.and ${r} (i64.const 255))) (i64.const 1)) (i64.const 1))`;
      const af = ['sub', 'add', 'adc', 'sbb'].includes(fs.kind)
        ? `(i64.and (i64.shr_u (i64.xor (i64.xor ${a} ${b}) ${r}) (i64.const 4)) (i64.const 1))` : '(i64.const 0)';
      // 0x202 | CF | PF<<2 | AF<<4 | ZF<<6 | SF<<7 | OF<<11, with `base` on top.
      // Folded rather than written out: the hand-nested version of this had one
      // paren too many and produced a wat that closed the function early.
      const orAll = (xs) => xs.reduce((acc, x) => `(i64.or ${acc} ${x})`);
      return orAll([`(i64.const ${base})`, cf,
        `(i64.shl ${pf} (i64.const 2))`, `(i64.shl ${af} (i64.const 4))`,
        `(i64.shl ${zf} (i64.const 6))`, `(i64.shl ${sf} (i64.const 7))`,
        `(i64.shl ${of} (i64.const 11))`]);
    };
    const setFlags = (kind, size, aE, bE, rE) => {
      if (!producers.has(ii)) return;              // dead flags: skip
      if (aE) L.push(`(local.set $fa ${aE})`); if (bE) L.push(`(local.set $fb ${bE})`); L.push(`(local.set $fr ${rE})`);
      flagState = { kind, size };
    };
    const cond = (cc) => {
      const fs = flagState, S = fs.size, sgn = SIGNl[S];
      const a='(local.get $fa)', b='(local.get $fb)', r='(local.get $fr)';
      // A JOIN: two paths reach this consumer with different lazy kinds, so
      // each of them materialized the real EFLAGS word into $fbits and the
      // condition is read out of it. Every bit is a plain test here - the
      // derivation happened where the flags were produced, which is the only
      // place that still had the operands.
      if (fs.kind === 'bits') {
        const B = (n) => `(i32.wrap_i64 (i64.and (i64.shr_u (local.get $fbits) (i64.const ${n})) (i64.const 1)))`;
        const CF = B(0), PF = B(2), ZF = B(6), SF = B(7), OF = B(11);
        switch (cc) {
          case 'e':return ZF; case 'ne':return `(i32.eqz ${ZF})`;
          case 'b':return CF; case 'ae':return `(i32.eqz ${CF})`;
          case 'be':return `(i32.or ${CF} ${ZF})`; case 'a':return `(i32.eqz (i32.or ${CF} ${ZF}))`;
          case 's':return SF; case 'ns':return `(i32.eqz ${SF})`;
          case 'o':return OF; case 'no':return `(i32.eqz ${OF})`;
          case 'p':return PF; case 'np':return `(i32.eqz ${PF})`;
          case 'l':return `(i32.ne ${SF} ${OF})`; case 'ge':return `(i32.eq ${SF} ${OF})`;
          case 'le':return `(i32.or ${ZF} (i32.ne ${SF} ${OF}))`;
          case 'g':return `(i32.and (i32.eqz ${ZF}) (i32.eq ${SF} ${OF}))`; }
        throw new Error('cond '+cc+'/bits');
      }
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
      // fr holds the CF BIT here, not a result (bt family, mul overflow where
      // CF==OF), so only the CF/OF conditions mean anything. This branch has
      // to be terminal: falling through to the result-derived cases below read
      // that single bit as if it were the value, which made `imul rax,rsi; jz`
      // test CF instead of the product. Latent for bt and mul1 before
      // imul2/imul3 started producing this kind and made it reachable.
      else if (fs.kind === 'cf' || fs.kind === 'cfof') {
        switch (cc) {
          case 'b': return nz; case 'ae': return zf;
          case 'o': if (fs.kind === 'cfof') return nz; break;
          case 'no': if (fs.kind === 'cfof') return zf; break;
        }
        throw new Error('cond '+cc+'/'+fs.kind);
      }
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

      // inc/dec leave CF UNTOUCHED and set OF on signed overflow, which for
      // these two is an exact function of the result alone: inc overflows only
      // into the sign bit, dec only out of it. Without this they fell through
      // to the result-derived comparisons below, which read jl as "result is
      // negative" and got `dec` of 0x8000000000000000 backwards - OF is set
      // there, so jl is taken and the AOT did not take it. CF is not
      // materialized, so b/ae/be/a still refuse.
      else if (fs.kind === 'inc' || fs.kind === 'dec') {
        const OF = fs.kind === 'inc' ? `(i64.eq ${r} (i64.const ${sgn}))`
                                     : `(i64.eq ${r} (i64.const ${sgn - 1n}))`;
        switch (cc) {
          case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
          case 'o':return OF; case 'no':return `(i32.eqz ${OF})`;
          case 'l':return `(i32.ne ${sf} ${OF})`; case 'ge':return `(i32.eq ${sf} ${OF})`;
          case 'le':return `(i32.or ${zf} (i32.ne ${sf} ${OF}))`;
          case 'g':return `(i32.and (i32.eqz ${zf}) (i32.eq ${sf} ${OF}))`; }
      }

      // and/or/xor/test clear CF and OF, so those conditions are constants -
      // exact, not an approximation. Leaving them out refused any function
      // with `test`/`and` followed by jbe/ja, which is 11,967 calls in one
      // node case alone.
      else if (fs.kind === 'logic') switch (cc) {
        case 'b': case 'o': return `(i32.const 0)`;
        case 'ae': case 'no': return `(i32.const 1)`;
        case 'be': return zf; case 'a': return nz; }

      // A shift materializes only its result, so ZF and SF are available and
      // CF and OF are not. The signed comparisons need OF: `shl rax,1` of
      // 0x8000000000000000 leaves a zero result with OF set, so jl is taken
      // and reading it as "result is negative" gets it backwards. Answer the
      // two that are exact and refuse the rest.
      if (fs.kind === 'zf') {                       // bsf/bsr: ZF is the only defined flag
        switch (cc) { case 'e':return zf; case 'ne':return nz; }
        throw new Error('cond '+cc+'/'+fs.kind);
      }
      if (fs.kind === 'shift' || fs.kind === 'shiftf') {
        const CF = `(i64.ne ${b} (i64.const 0))`, OF = `(i64.ne ${a} (i64.const 0))`;
        switch (cc) {
          case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
          case 'b':return CF; case 'ae':return `(i32.eqz ${CF})`;
          case 'be':return `(i32.or ${CF} ${zf})`; case 'a':return `(i32.and (i32.eqz ${CF}) (i32.eqz ${zf}))`; }
        // OF only exists for a count of 1; for any other count x86 leaves it
        // undefined and the interpreter leaves it untouched, so refuse.
        if (fs.kind === 'shiftf') switch (cc) {
          case 'o':return OF; case 'no':return `(i32.eqz ${OF})`;
          case 'l':return `(i32.ne ${sf} ${OF})`; case 'ge':return `(i32.eq ${sf} ${OF})`;
          case 'le':return `(i32.or ${zf} (i32.ne ${sf} ${OF}))`;
          case 'g':return `(i32.and (i32.eqz ${zf}) (i32.eq ${sf} ${OF}))`; }
        throw new Error('cond '+cc+'/'+fs.kind);
      }
      else switch (cc) {   // result-derived; correct where OF is known clear
        case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
        case 'le':return `(i64.le_s ${sx(r,S)} (i64.const 0))`; case 'g':return `(i64.gt_s ${sx(r,S)} (i64.const 0))`;
        case 'l':return `(i64.lt_s ${sx(r,S)} (i64.const 0))`; case 'ge':return `(i64.ge_s ${sx(r,S)} (i64.const 0))`; }
      // anything left wants a flag that was never materialized: refuse rather
      // than answer with a value that is right for some producers only.
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
      if (fs.kind === 'bits') return `(i64.and (local.get $fbits) (i64.const 1))`;
      if (fs.kind === 'cf') return r;
      if (fs.kind === 'logic') return `(i64.const 0)`;   // and/or/xor/test clear CF
      if (fs.kind === 'shift' || fs.kind === 'shiftf') return `(local.get $fb)`;
      // comis sets CF when the compare is BELOW or unordered, which is the
      // negation of one wasm f64.ge - and a NaN makes ge false, so the
      // unordered case comes out right without a separate test. glibc's
      // long-double formatting reaches an `adc` two instructions after a
      // `ucomisd`, and the whole function was refused for the want of this.
      if (fs.kind === 'fcmp')
        return `(i64.extend_i32_u (i32.eqz (f64.ge (f64.reinterpret_i64 ${a}) (f64.reinterpret_i64 ${b}))))`;
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
          // xor r,r and sub r,r are the idiomatic zeroing forms; emitting the
          // read twice (and its masks) is pure noise in the hottest blocks
          const zeroing = (insn.mnem === 'xor' || insn.mnem === 'sub') &&
                          insn.dst.kind === 'reg' && insn.src.kind === 'reg' &&
                          insn.dst.r === insn.src.r && !insn.dst.high && !insn.src.high;
          if (zeroing) { expr = '(i64.const 0)'; i32expr = '(i32.const 0)'; }
          else if (S === 4 && insn.dst.kind === 'reg') { i32expr = `(${ALU32[insn.mnem]} ${rd32(insn.dst,next)} ${rd32(insn.src,next)})`; expr = `(i64.extend_i32_u ${i32expr})`; }
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
        case 'test': {                                  // test r,r (the ZF/SF probe) is just the value
          const ta = rd(insn.dst,S,next), tb = rd(insn.src,S,next);
          setFlags('logic',S,null,null, ta === tb ? ta : `(i64.and ${ta} ${tb})`); break; }
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
          // Materialize CF, and OF where x86 defines it, instead of leaving a
          // consumer to poison the function. modeled() only accepts a nonzero
          // IMMEDIATE count, so the count is known here and the two cases are
          // static: CF is always the last bit shifted out, and OF is defined
          // only for a count of 1 (the interpreter leaves it untouched
          // otherwise, so anything else must still refuse). $fb carries CF and
          // $fa carries OF, which is what the 'shiftf' kind means.
          const W = S * 8;
          const cImm = insn.src.kind === 'imm' ? Number(insn.src.v & BigInt(S === 8 ? 63 : 31)) : null;
          const orig = (cImm !== null && cImm !== 0) ? T() : null;
          if (orig) L.push(`(local.set ${orig} ${rd(insn.dst,S,next)})`);   // before the write: the destination is about to change
          if (S === 4 && insn.dst.kind === 'reg') {
            const c=shmask32(rd32(insn.src,next), 31); const a=rd32(insn.dst,next); let e;
            if (insn.mnem==='shl') e=`(i32.shl ${a} ${c})`; else if (insn.mnem==='shr') e=`(i32.shr_u ${a} ${c})`; else e=`(i32.shr_s ${a} ${c})`;
            L.push(wr32reg(insn.dst.r, e));
          } else {
            const c=`(i64.and ${rd(insn.src,1,next)} (i64.const ${S===8?63:31}))`; const a=rd(insn.dst,S,next); let e;
            if (insn.mnem==='shl') e=`(i64.shl ${a} ${c})`; else if (insn.mnem==='shr') e=`(i64.shr_u ${a} ${c})`; else e=`(i64.shr_s ${sx(a,S)} ${c})`;
            L.push(wr(insn.dst,S,`(i64.and ${e} (i64.const ${m}))`,next));
          }
          const res = rd(insn.dst,S,next);
          if (!orig) { setFlags('shift', S, null, null, res); break; }   // register count: not a modeled producer anyway
          const O = `(local.get ${orig})`;
          const cf = insn.mnem === 'shl'
            ? `(i64.and (i64.shr_u ${O} (i64.const ${W - cImm})) (i64.const 1))`
            : `(i64.and (i64.shr_u ${O} (i64.const ${cImm - 1})) (i64.const 1))`;
          // OF, for EVERY count, not just 1. The interpreter used to leave it
          // untouched past a count of 1 and now computes it, because that is
          // what the hardware does (engine/diff/shiftoftest.mjs asks the CPU).
          // The rule is the count-1 rule applied to the ORIGINAL operand and
          // is independent of the count: shl -> top two bits differ, shr ->
          // top bit, sar -> 0. Note this is NOT `MSB(result) xor CF`, which
          // uses the shifted result and only coincides at a count of 1.
          const of = insn.mnem === 'shl'
            ? `(i64.and (i64.xor (i64.shr_u ${O} (i64.const ${W - 1})) (i64.shr_u ${O} (i64.const ${W - 2}))) (i64.const 1))`
            : insn.mnem === 'shr'
            ? `(i64.and (i64.shr_u ${O} (i64.const ${W - 1})) (i64.const 1))`
            : `(i64.const 0)`;
          setFlags('shiftf', S, of, cf, res);
          break; }
        case 'bsf': case 'bsr': {
          // dst = index of lowest (bsf) / highest (bsr) set bit; ZF <- src==0.
          // For src==0 Intel documents the destination as undefined, but real
          // Intel and AMD hardware LEAVE IT UNMODIFIED — and glibc's
          // hand-written string asm relies on that: __memrchr does
          // `bsr %eax,%eax; je ret`, returning the untouched rax as its
          // not-found NULL. Writing 31-clz(0) = -1 here instead sent
          // 0xffffffff back as a "found" pointer, str.rpartition computed a
          // negative length from it, and CPython could not import a module
          // under the AOT tier. The interpreter already guarded this write;
          // the emitter must too: skip the write entirely when src is zero,
          // which also preserves the full 64-bit destination exactly as the
          // hardware does.
          const t = T();
          L.push(`(local.set ${t} ${rd(insn.src, S, next)})`);
          const S8 = S === 8;
          const e = insn.mnem === 'bsf'
            ? (S8 ? `(i64.ctz (local.get ${t}))` : `(i64.extend_i32_u (i32.ctz (i32.wrap_i64 (local.get ${t}))))`)
            : (S8 ? `(i64.sub (i64.const 63) (i64.clz (local.get ${t})))` : `(i64.extend_i32_u (i32.sub (i32.const 31) (i32.clz (i32.wrap_i64 (local.get ${t})))))`);
          if (producers.has(ii)) { L.push(`(local.set $fr (local.get ${t}))`); flagState = { kind: 'zf', size: S }; }
          L.push(`(if (i64.ne (local.get ${t}) (i64.const 0)) (then ${wr(insn.dst, S, e, next)}))`);
          break; }
        case 'popcnt': {
          // dst = number of set bits in src; ZF <- (src==0). CF/OF/SF/PF are
          // cleared, which the 'zf' flag kind (as for bsf) never lets a consumer read.
          const t = T();
          L.push(`(local.set ${t} ${rd(insn.src, S, next)})`);
          if (producers.has(ii)) { L.push(`(local.set $fr (local.get ${t}))`); flagState = { kind: 'zf', size: S }; }
          L.push(wr(insn.dst, S, `(i64.popcnt (local.get ${t}))`, next));
          break; }
        case 'cmpxchgdq': {
          // cmpxchg8b / cmpxchg16b: compare RDX:RAX with the memory pair; equal ->
          // store RCX:RBX and ZF=1, else load the pair into RDX:RAX and ZF=0.
          // Threads never preempt inside a unit, so LOCK is free. $fr holds
          // (lo^rax)|(hi^rdx), zero exactly when equal: the 'zf' flag kind.
          const n = insn.wide ? 8 : 4, ld = insn.wide ? 'i64.load' : 'i64.load32_u', st = insn.wide ? 'i64.store' : 'i64.store32';
          const ta = T(), tl = T(), th = T(), tx = T();
          L.push(`(local.set ${ta} (i64.extend_i32_u ${wasmAddr(insn.rm, next)}))`);
          const A0 = `(i32.wrap_i64 (local.get ${ta}))`, A1 = `(i32.wrap_i64 (i64.add (local.get ${ta}) (i64.const ${n})))`;
          L.push(`(local.set ${tl} (${ld} ${A0}))`, `(local.set ${th} (${ld} ${A1}))`);
          const raxv = rd({ kind: 'reg', r: 0, size: 8 }, insn.wide ? 8 : 4, next), rdxv = rd({ kind: 'reg', r: 2, size: 8 }, insn.wide ? 8 : 4, next);
          L.push(`(local.set ${tx} (i64.or (i64.xor (local.get ${tl}) ${raxv}) (i64.xor (local.get ${th}) ${rdxv})))`);
          L.push(`(if (i64.eqz (local.get ${tx}))`,
                 `(then (${st} ${A0} ${rd({ kind: 'reg', r: 3, size: 8 }, insn.wide ? 8 : 4, next)}) (${st} ${A1} ${rd({ kind: 'reg', r: 1, size: 8 }, insn.wide ? 8 : 4, next)}))`,
                 `(else ${wr({ kind: 'reg', r: 0, size: 8 }, 8, `(local.get ${tl})`, next)} ${wr({ kind: 'reg', r: 2, size: 8 }, 8, `(local.get ${th})`, next)}))`);
          if (producers.has(ii)) { L.push(`(local.set $fr (local.get ${tx}))`); flagState = { kind: 'zf', size: 8 }; }
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
            // wr, not a hardcoded local.set: rol/ror qword [mem], n has a
            // memory destination (dst.r is undefined -> $rundefined), which
            // wat2wasm rejects, dropping the whole unit to interp. cc1's
            // switch dispatch rotates jump-table words in place.
            L.push(wr(insn.dst, 8, `(i64.${rot?'rotl':'rotr'} ${a} (i64.extend_i32_u ${c}))`, next)); }
          else if (S === 4) { const c=shmask32(rd32(insn.src,next), 31);
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
          // CF=OF is the overflow of the SIGNED product out of the destination
          // width, which is the only flag x86 defines here (SF/ZF/AF/PF are
          // architecturally undefined and the differential harness masks them).
          // Modelling it matters out of proportion to its size: an unmodelled
          // flag producer poisons the whole function, and `imul r,r/m,imm` is
          // what a compiler emits for a struct-index multiply, so it sits in
          // the middle of hot code. 13 of grep's 15 translation failures were
          // this one instruction, and its hot matcher then ran interpreted.
          const bExpr = insn.mnem === 'imul3' ? insn.src2 : insn.src;
          const sa = insn.mnem === 'imul3' ? insn.src : insn.dst;
          if (S <= 4) {
            // 32x32 -> 64 is exact in an i64, so the check is a comparison
            // against the sign-extension of the truncated result.
            const av = T(), bv = T(), full = T();
            L.push(`(local.set ${av} ${sx(rd(sa,S,next),S)})`);
            L.push(`(local.set ${bv} ${sx(rd(bExpr,S,next),S)})`);
            L.push(`(local.set ${full} (i64.mul (local.get ${av}) (local.get ${bv})))`);
            if (S === 4 && insn.dst.kind === 'reg') L.push(wr32reg(insn.dst.r, `(i32.wrap_i64 (local.get ${full}))`));
            else L.push(wr(insn.dst,S,andmask(`(local.get ${full})`,S),next));
            setFlags('cfof', S, null, null,
              `(i64.extend_i32_u (i64.ne (local.get ${full}) ${sx(andmask(`(local.get ${full})`,S),S)}))`);
          } else {
            // 64x64 -> 128: no mulhi in wasm, so build the high word from the
            // four 32-bit half-products, same construction as imul1.
            const a = T(), b = T(), al = T(), ah = T(), bl = T(), bh = T(),
                  lh = T(), hl = T(), mid = T(), hi = T(), lo = T();
            L.push(`(local.set ${a} ${rd(sa,8,next)})`);
            L.push(`(local.set ${b} ${rd(bExpr,8,next)})`);
            L.push(`(local.set ${lo} (i64.mul (local.get ${a}) (local.get ${b})))`);
            L.push(`(local.set ${al} (i64.and (local.get ${a}) (i64.const 0xFFFFFFFF)))`);
            L.push(`(local.set ${ah} (i64.shr_u (local.get ${a}) (i64.const 32)))`);
            L.push(`(local.set ${bl} (i64.and (local.get ${b}) (i64.const 0xFFFFFFFF)))`);
            L.push(`(local.set ${bh} (i64.shr_u (local.get ${b}) (i64.const 32)))`);
            L.push(`(local.set ${lh} (i64.mul (local.get ${al}) (local.get ${bh})))`);
            L.push(`(local.set ${hl} (i64.mul (local.get ${ah}) (local.get ${bl})))`);
            L.push(`(local.set ${mid} (i64.add (i64.add ` +
                   `(i64.shr_u (i64.mul (local.get ${al}) (local.get ${bl})) (i64.const 32)) ` +
                   `(i64.and (local.get ${lh}) (i64.const 0xFFFFFFFF))) ` +
                   `(i64.and (local.get ${hl}) (i64.const 0xFFFFFFFF))))`);
            L.push(`(local.set ${hi} (i64.add (i64.add (i64.add ` +
                   `(i64.mul (local.get ${ah}) (local.get ${bh})) ` +
                   `(i64.shr_u (local.get ${lh}) (i64.const 32))) ` +
                   `(i64.shr_u (local.get ${hl}) (i64.const 32))) ` +
                   `(i64.shr_u (local.get ${mid}) (i64.const 32))))`);
            L.push(`(local.set ${hi} (i64.sub (local.get ${hi}) ` +
                   `(i64.and (i64.shr_s (local.get ${a}) (i64.const 63)) (local.get ${b}))))`);
            L.push(`(local.set ${hi} (i64.sub (local.get ${hi}) ` +
                   `(i64.and (i64.shr_s (local.get ${b}) (i64.const 63)) (local.get ${a}))))`);
            L.push(wr(insn.dst,8,`(local.get ${lo})`,next));
            setFlags('cfof', 8, null, null,
              `(i64.extend_i32_u (i64.ne (local.get ${hi}) (i64.shr_s (local.get ${lo}) (i64.const 63))))`);
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
            setFlags('cfof', S, null, null, sgn
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
          setFlags('cfof', 8, null, null, sgn
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
              L.push(`(if ${bad} (then`, SA_MARK,
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
          L.push(SA_MARK, `(return (call $x_deopt (i64.const ${hexs(insn.rip)}) (local.get $rsp0)))`);
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
          // An inlined call keeps the guest-visible push - the callee's body
          // may read its own return address, and `ret` must pop something -
          // but there is no wasm call, so no spill, no reload, no stack-budget
          // check, and no frame. Removing the frame IS the optimisation; the
          // three things around it were each measured to cost nothing.
          if (insn.inlineTo !== undefined) break;
          L.push(SA_MARK);
          if (canDirect(target.toString()))
            // stack-budget check even on direct calls: past it, x_callout
            // interprets the callee instead of nesting another wasm frame
            L.push(ftSave(),
                   `(if ${ftOk}`,
                   `  (then ${ftBurn} ${nestUp}(drop (call $f_${target.toString(16)}))${nestDn} ${ftRestore})`,
                   `  (else (drop (call $x_callout (i64.const ${hexs(target)})))))`);
          else {
            // out-of-unit target: it may be compiled in ANOTHER unit — chain
            // through the global dispatch table without a JS round-trip
            usesFtr = true;
            L.push(icResolve(`(i64.const ${hexs(target)})`),
                   ftSave(),
                   `(if ${ftHit}`,
                   `  (then ${ftBurn} ${nestUp}(drop (call_indirect $ft (type $uft) (local.get $fti)))${nestDn} ${ftRestore})`,
                   `  (else (drop (call $x_callout (i64.const ${hexs(target)})))))`);
          }
          L.push(RC_MARK);
          break; }
        case 'callind': {   // compute target BEFORE the push moves rsp
          const t = T(); L.push(`(local.set ${t} ${rd(insn.src,8,next)})`);
          L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (i64.const ${hexs(next)}))`);
          L.push(SA_MARK);
          usesFtr = true;
          L.push(icResolve(`(local.get ${t})`),
                 ftSave(),
                 `(if ${ftHit}`,
                 `  (then ${ftBurn} ${nestUp}(drop (call_indirect $ft (type $uft) (local.get $fti)))${nestDn} ${ftRestore})`,
                 `  (else (drop (call $x_callout (local.get ${t})))))`);
          L.push(RC_MARK);
          break; }
        case 'syscall':
          // pass this syscall's guest rip: a BLOCKING syscall (poll/select/
          // read) suspends the whole engine by unwinding the wasm frames and
          // recording this rip so resume re-executes the syscall exactly here
          L.push(SA_MARK, `(call $x_syscall (i64.const ${hexs(insn.rip)}))`, RL_MARK);
          break;
        // std/cld have to reach the interpreter: a unit that sets DF and then
        // returns or escapes leaves the guest expecting DF=1, and a `cld` that
        // was a no-op here would fail to clear a DF the caller had set. The
        // string ops still refuse in any function containing `std` (see
        // hasStd) - this is about the flag crossing the boundary, not about
        // running the bulk ops backwards.
        case 'cld': L.push(`(i32.store (i32.const ${DF_SLOT}) (i32.const 0))`); break;
        case 'std': L.push(`(i32.store (i32.const ${DF_SLOT}) (i32.const 1))`); break;
        case 'stos': {
          const woffc = Number(BigInt.asIntN(32, woff));
          const { step, lo } = strDir(S, L);
          if (insn.rep && S === 1) {
            // Byte fill: one bulk op. Direction cannot change WHICH bytes end
            // up written - the value is a constant from al, not memory - so
            // backward only moves the range's base and the sign of the rdi
            // update.
            L.push(`(memory.fill (i32.add (i32.wrap_i64 ${lo(7)}) (i32.const ${woffc})) (i32.wrap_i64 (i64.and (local.get $r0) (i64.const 0xFF))) (i32.wrap_i64 (local.get $r1)))`);
            L.push(`(local.set $r7 (i64.add (local.get $r7) (i64.mul (local.get $r1) ${step})))`, `(local.set $r1 (i64.const 0))`);
          } else if (insn.rep) {                                             // strided: wasm loop
            const e = '$se_'+insn.rip.toString(16), lp = '$sl_'+insn.rip.toString(16);
            L.push(`(block ${e} (loop ${lp} (br_if ${e} (i64.eqz (local.get $r1)))`,
                   `(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} ${rd({kind:'reg',r:0,size:S},S,next)})`,
                   `(local.set $r7 (i64.add (local.get $r7) ${step})) (local.set $r1 (i64.sub (local.get $r1) (i64.const 1))) (br ${lp})))`);
          } else {
            L.push(`(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} ${rd({kind:'reg',r:0,size:S},S,next)})`,
                   `(local.set $r7 (i64.add (local.get $r7) ${step}))`);
          }
          break; }
        case 'movs': {
          const woffc = Number(BigInt.asIntN(32, woff));
          const { step, lo, away } = strDir(S, L);
          if (insn.rep && S === 1) {
            // Byte copy: one bulk op, but memory.copy is MEMMOVE and rep movsb
            // is an element-at-a-time copy. Those agree unless the ranges
            // overlap and the copy runs INTO the source: going forward that is
            // rdi above rsi, going backward it is rsi above rdi. Iteration k
            // then reads a byte iteration k-d already wrote, so x86 replicates
            // the first d bytes as a pattern where memmove reads the original.
            // (`rep movsb` with rsi = rdi-1 is exactly that idiom.) Test it at
            // run time and take the exact loop when it holds; the interpreter
            // has always made the same distinction.
            const d = T(), e = '$moe_'+insn.rip.toString(16), lp = '$mol_'+insn.rip.toString(16);
            L.push(`(local.set ${d} ${away(7, 6)})`);
            L.push(`(if (i32.and (i64.ne (local.get ${d}) (i64.const 0)) (i64.lt_u (local.get ${d}) (local.get $r1)))`,
                   `  (then (block ${e} (loop ${lp} (br_if ${e} (i64.eqz (local.get $r1)))`,
                   `    (i32.store8 ${wasmAddr({base:7,index:-1,disp:0n},next)} (i32.load8_u ${wasmAddr({base:6,index:-1,disp:0n},next)}))`,
                   `    (local.set $r6 (i64.add (local.get $r6) ${step})) (local.set $r7 (i64.add (local.get $r7) ${step}))`,
                   `    (local.set $r1 (i64.sub (local.get $r1) (i64.const 1))) (br ${lp}))))`,
                   `  (else (memory.copy (i32.add (i32.wrap_i64 ${lo(7)}) (i32.const ${woffc})) (i32.add (i32.wrap_i64 ${lo(6)}) (i32.const ${woffc})) (i32.wrap_i64 (local.get $r1)))`,
                   `        (local.set $r6 (i64.add (local.get $r6) (i64.mul (local.get $r1) ${step}))) (local.set $r7 (i64.add (local.get $r7) (i64.mul (local.get $r1) ${step})))`,
                   `        (local.set $r1 (i64.const 0))))`);
          } else if (insn.rep) {
            const e = '$me_'+insn.rip.toString(16), lp = '$ml_'+insn.rip.toString(16);
            L.push(`(block ${e} (loop ${lp} (br_if ${e} (i64.eqz (local.get $r1)))`,
                   `(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} (${LD[S]} ${wasmAddr({base:6,index:-1,disp:0n},next)}))`,
                   `(local.set $r6 (i64.add (local.get $r6) ${step})) (local.set $r7 (i64.add (local.get $r7) ${step})) (local.set $r1 (i64.sub (local.get $r1) (i64.const 1))) (br ${lp})))`);
          } else {
            L.push(`(${ST[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)} (${LD[S]} ${wasmAddr({base:6,index:-1,disp:0n},next)}))`,
                   `(local.set $r6 (i64.add (local.get $r6) ${step}))`, `(local.set $r7 (i64.add (local.get $r7) ${step}))`);
          }
          break; }
        case 'cmps': case 'scas': {
          // repe/repne string compare; flags ('sub' kind) come from the LAST
          // element pair, stored into $fa/$fb/$fr every iteration
          const { step } = strDir(S, L);
          const isCmps = insn.mnem === 'cmps';
          const ldA = isCmps ? `(${LD[S]} ${wasmAddr({base:6,index:-1,disp:0n},next)})`
                             : (S === 8 ? `(local.get $r0)` : `(i64.and (local.get $r0) (i64.const ${m}))`);
          const ldB = `(${LD[S]} ${wasmAddr({base:7,index:-1,disp:0n},next)})`;
          const body = [
            `(local.set $fa ${ldA})`,
            `(local.set $fb ${ldB})`,
            `(local.set $fr (i64.and (i64.sub (local.get $fa) (local.get $fb)) (i64.const ${m})))`,
            ...(isCmps ? [`(local.set $r6 (i64.add (local.get $r6) ${step}))`] : []),
            `(local.set $r7 (i64.add (local.get $r7) ${step}))`,
          ];
          if (insn.rep || insn.rep2) {
            // rcx == 0: hardware leaves the flags alone. The incoming flags
            // were materialized for us (soft consumer); when they are the
            // same (kind,size) the untouched $fa/$fb/$fr ARE the right state,
            // otherwise escape to the interpreter with them handed over.
            const inF = softFlags.get(i+':'+ii);
            if (!(inF && inF.kind === 'sub' && inF.size === S))
              L.push(`(if (i64.eqz (local.get $r1)) (then ${eflagsStore(inF)} (local.set $rex (i64.const ${hexs(insn.rip)})) ${SA_MARK} (return (call $x_deopt (local.get $rex) (local.get $rsp0)))))`);
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
        case 'pushf': {
          // The whole RFLAGS word, which is why this was a deopt for so long:
          // the lazy model carried CF/ZF/SF/OF and nothing else. It now has PF
          // and AF too (see eflagsStore), DF lives in DF_SLOT, and the sticky
          // AC/ID bits popf stored live in ESTICKY_SLOT - so for the kinds
          // eflagsStore can build, pushf is expressible inline.
          //
          // Where it is not, this still deopts. The interpreter is the correct
          // answer there and the point of compiling this at all is the CALLER:
          // repscan's `repnz scas; pushf` escaped on every call and ran the
          // rest of the function interpreted from the pushf on.
          const inF = softFlags.get(i+':'+ii);
          const v = eflagsStore(inF, 'value');
          if (!v) { hasDeopt = true; L.push(`${eflagsStore(inF)} (local.set $rex (i64.const ${hexs(insn.rip)}))`, SA_MARK,
                                            `(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`); break; }
          const t = T();
          L.push(`(local.set ${t} (i64.or ${v} (i64.or (i64.shl (i64.load32_u (i32.const ${DF_SLOT})) (i64.const 10)) (i64.load32_u (i32.const ${ESTICKY_SLOT})))))`,
                 `(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (local.get ${t}))`);
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
          // `pop [mem]` with an rsp-based address computes the address AFTER
          // the increment (Intel grp1a). Confirmed against this CPU rather
          // than assumed: `pop qword [rsp]` writes the popped value to the
          // slot ABOVE the one it came from. So pop into a temp, move rsp,
          // then store - the emitter used to write first, which is why this
          // shape was refused outright and cost node-net a function called
          // 11,967 times.
          if (insn.dst.kind === 'mem' && (insn.dst.base === 4 || insn.dst.index === 4)) {
            const t = T();
            L.push(`(local.set ${t} (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)}))`,
                   `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`,
                   wr(insn.dst,8,`(local.get ${t})`,next));
            break;
          }
          if (insn.dst.kind === 'reg' && savedI32(insn.dst.r))   // epilogue restore straight to the regfile
            L.push(`(i64.store (i32.const ${insn.dst.r*8}) (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)}))`, `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          else
            L.push(wr(insn.dst,8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next),`(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          break; }
        // MXCSR is inert in this engine: the interpreter stores and loads it
        // and no arithmetic anywhere consults it, so translating the round
        // trip is exactly interpreter-equivalent and not an approximation.
        // Deopting instead cost more than it looks: a unit whose ENTRY is a
        // deopt is refused outright, and glibc's libm opens several math
        // functions with `stmxcsr`, so one of them ran 31,307 times
        // interpreted in the ffprobe case while the sweep called it exact.
        // fnstcw stores the control word, fldcw loads it. Both are 16 bit and
        // both round-trip through FCW_SLOT, which syncOut/syncIn carry - so
        // the interpreter's rounding mode and a unit's agree without either
        // one owning it.
        case 'fcw':
          if (insn.sub === 7) L.push(`(i32.store16 ${wasmAddr(insn.rm, next)} (i32.load (i32.const ${FCW_SLOT})))`);
          else L.push(`(i32.store (i32.const ${FCW_SLOT}) (i32.load16_u ${wasmAddr(insn.rm, next)}))`);
          break;
        case 'stmxcsr': L.push(wr(insn.dst, 4, `(i64.extend_i32_u (i32.load (i32.const ${MXCSR_SLOT})))`, next)); break;
        case 'ldmxcsr': L.push(`(i32.store (i32.const ${MXCSR_SLOT}) (i32.wrap_i64 ${rd(insn.dst, 4, next)}))`); break;
        case 'sse':          emitSSE(insn, next, L, setFlags); break;
        case 'sse4':         emitSSE4(insn, next, L); break;
        case 'ssegrpshift':  emitSSEShift(insn, L); break;
        case 'jmp': case 'jcc': case 'ret': case 'retn': case 'jmpind': case 'udec': break;  // terminator handled below
        default: throw new Error('AOT: unhandled '+insn.mnem+' @ '+insn.rip.toString(16));
      }
      // this producer's flags are read from another block, where the operands
      // are gone: freeze them into the word now, while $fa/$fb/$fr still hold
      // what made them
      if (bitsProducers.has(i+':'+ii)) {
        // the dataflow pass promised this kind was buildable. If it is not,
        // the two disagree - refuse, rather than leave the consumer reading
        // the word some earlier join happened to leave in $fbits.
        if (!flagState || !BITSOK.has(flagState.kind))
          throw new Error('AOT: flag join over '+(flagState ? flagState.kind : 'nothing')+' @ '+insn.rip.toString(16));
        L.push(`(local.set $fbits ${flagWord(flagState, '514')})`);
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
      // backward edge: burn one loop-yield unit; at zero, hand the loop head
      // back to the engine as this frame's exit rip (see FTLOOP)
      // Burn first, then test for exactly zero: a budget nobody armed (the
      // word is 0 when a unit function is called outside dispatchAot - the
      // differential tests do that) wraps to 2^32-1 and never yields, and
      // an armed budget yields once, at its last edge. disptest read 10/400
      // with test-then-burn: every first back edge "exited" the function.
      // ... and only to a loop head that already RESOLVES in the funcref
      // table, so the hand-off is a wasm-to-wasm chain through $drive. A
      // yield to an uncompiled head sent the interpreter there, which then
      // tiered a whole new unit per hot loop, rooted at the head, and the
      // sweep ran past its 90-minute cap (that cap has since also been
      // traced to a cold wat cache, see LOOPYIELD; the extra units per
      // head were real and are gone with the probe). Hot loops
      // the interpreter ever ran already have their loop-head unit (the
      // back-edge profile tiers one at 12 iterations); a head without one
      // just refills the budget and keeps running.
      if (LOOPYIELD && j <= i) usesFtr = true;
      const yieldAt = (LOOPYIELD && j <= i)
        ? `(i32.store (i32.const ${FTLOOP}) (i32.sub (i32.load (i32.const ${FTLOOP})) (i32.const 1))) ` +
          `(if (i32.eqz (i32.load (i32.const ${FTLOOP}))) (then ` +
          `(if (i32.ge_s (call $ftr (i64.const ${hexs(blocks[j].start)})) (i32.const 0)) ` +
          // hit: record the head and leave through the ONE yield exit this
          // function has (spill, refill, return or deopt) - the exit was
          // inlined at every back edge at first, a full register spill per
          // edge, and the emitted units grew enough that every big sweep case
          // ran 4-7x slower with zero yields taken (compile time and code)
          `(then (local.set $rex (i64.const ${hexs(blocks[j].start)})) (br $yield)) ` +
          `(else (call $x_loophot (i64.const ${hexs(blocks[j].start)})) (i32.store (i32.const ${FTLOOP}) (i32.const ${LOOPYIELD_N})))))) `
        : '';
      if (yieldAt) usesYield = true;
      if (DISP) return yieldAt + (j > i ? `(br $b${j})` : j === i ? `(br $l${i})` : `(local.set $pc (i32.const ${j})) (br $L_disp)`);
      return yieldAt + `(br ${labelFor(j)})`; };
    const brTo = (j) => j === i+1 ? '' : goto(j);
    // A branch TARGET the analyzer couldn't decode (an address past a decode
    // failure, a cut-off jump-table row) becomes a cold deopt edge instead of
    // poisoning the function: if control actually goes there, the engine
    // resumes in the interpreter at that address, which faults exactly as
    // native would if the bytes are truly garbage.
    const deoptTo = (addr) => [`(local.set $rex (i64.const ${hexs(addr)}))`,
      SA_MARK, `(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`];
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
        // a BACKWARD conditional edge goes through goto() so it burns the
        // loop-yield budget like an unconditional one: the br_if form
        // skipped the burn, and since gcc closes nearly every loop with
        // cmp/jcc, only jmp-closed loops (scan) ever yielded - alu ran
        // 600M iterations in Liftoff at 5.6ns/iter with TurboFan at 1.15
        const bj = (j, cc) => (LOOPYIELD && j <= i) ? `(if ${cc} (then ${goto(j)}))` : `(br_if ${lbl(j)} ${cc})`;
        if (T === i+1 && F === i+1) { /* both fall through */ }
        else if (T !== i+1 && F === i+1) L.push(bj(T, c));
        else if (T === i+1 && F !== i+1) L.push(bj(F, `(i32.eqz ${c})`));
        else { L.push(bj(T, c)); L.push(goto(F)); }
      }
    } else if (t.kind === 'jmp' || t.kind === 'inlinecall') {
      if (t.t < 0 && t.tail) {                            // tail call to a known entry: chain in wasm, else deopt
        L.push(`(local.set $rex (i64.const ${hexs(t.ta)}))`, SA_MARK, ...tailJmp(),
               `(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`); }
      else if (t.t < 0) L.push(...deoptTo(t.ta));
      else { const b = brTo(t.t); if (b) L.push(b); }
    } else if (t.kind === 'inlinetail') {
      // a sibling call inside an inlined copy: the call protocol of a normal
      // call site (spill, chain or direct call, reload), then on to the
      // inlined site's continuation. The sibling's ret popped the return
      // address the inlined call pushed, so rsp needs no adjustment here.
      const target = t.ta;
      L.push(SA_MARK);
      if (canDirect(target.toString()))
        L.push(ftSave(),
               `(if ${ftOk}`,
               `  (then ${ftBurn} ${nestUp}(drop (call $f_${target.toString(16)}))${nestDn} ${ftRestore})`,
               `  (else (drop (call $x_callout (i64.const ${hexs(target)})))))`);
      else {
        usesFtr = true;
        L.push(icResolve(`(i64.const ${hexs(target)})`),
               ftSave(),
               `(if ${ftHit}`,
               `  (then ${ftBurn} ${nestUp}(drop (call_indirect $ft (type $uft) (local.get $fti)))${nestDn} ${ftRestore})`,
               `  (else (drop (call $x_callout (i64.const ${hexs(target)})))))`);
      }
      L.push(RC_MARK);
      const b = brTo(t.t); if (b) L.push(b);
    } else if (t.kind === 'inlineret') {
      // pop what the inlined call pushed. The continuation is known
      // statically, so the popped address is discarded rather than returned:
      // rsp moves exactly as it would natively, and control just falls on.
      L.push(`(local.set $r4 (i64.add (local.get $r4) (i64.const ${8 + t.pad})))`);
      const b = brTo(t.t); if (b) L.push(b);
    } else if (t.kind === 'ret') {
      // pop the return address, retire the frame, hand the exit rip back
      L.push(`(local.set $rex (i64.load ${wasmAddr({base:4,index:-1,disp:0n},lnext)}))`);
      L.push(`(local.set $r4 (i64.add (local.get $r4) (i64.const ${8 + t.pad})))`);
      L.push(SX_MARK);
      L.push(`(return (local.get $rex))`);
    } else if (t.kind === 'jtab') {
      // indirect jump through a discovered jump table: resolve the COMPUTED
      // address against this function's block map and re-enter the dispatch
      // loop — one in-wasm branch per computed goto instead of a JS deopt
      // round-trip. An unknown address (tail call, an undecoded table row)
      // still deopts, so resolution is exact by construction.
      L.push(`(local.set $rex ${rd(t.src,8,lnext)})`);
      L.push(`(local.set $pc (call $jtr_${fnAddr.toString(16)} (local.get $rex)))`);
      const jmap = (r) => t.remap?.get(r) ?? r;          // node splitting: this site's copy of a case block
      if (DISP) {
        if (t.remap) for (const [r, v] of t.remap) L.push(`(if (i32.eq (local.get $pc) (i32.const ${r})) (then (local.set $pc (i32.const ${v}))))`);
        L.push(`(br_if $L_disp (i32.ge_s (local.get $pc) (i32.const 0)))`);
        L.push(SA_MARK);
        L.push(...tailJmp());
        L.push(`(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`);
      } else {
        // structured: br_table over RPO index -> the target block's label.
        // A target that is the next block has no label of its own (it is
        // reached by falling through), so it gets $jt_next_i, which lands
        // just past the deopt tail; everything else (an unknown address,
        // $pc = -1, or a block that is not a table target) takes the
        // default and deopts at the computed address.
        const vec = []; for (let r = 0; r < N; r++) { const x = jmap(r); vec.push(jtabUnion.has(r) ? (x === i + 1 ? `$jt_next_${i}` : (x <= i ? '$loop_' + x : '$blk_' + x)) : `$jt_dflt_${i}`); }
        L.push(`(block $jt_next_${i} (block $jt_dflt_${i} (br_table ${vec.join(' ')} $jt_dflt_${i} (local.get $pc)))`);
        L.push(SA_MARK);
        L.push(...tailJmp());
        L.push(`(return (call $x_deopt (local.get $rex) (local.get $rsp0))))`);
        if (globalThis.__jtabStats) globalThis.__jtabStats.structured++;
      }
    } else if (t.kind === 'deopt') {
      // indirect jump (jump table / tail call) or undecodable byte:
      // hand the frame to the engine at the computed target / that rip
      L.push(`(local.set $rex ${t.src ? rd(t.src,8,lnext) : `(i64.const ${hexs(t.at)})`})`);
      if (!t.src) { const st = eflagsStore(softFlags.get(i+':'+(blk.insns.length-1))); if (st) L.push(st); }   // escape: the interpreter continues with these flags
      L.push(SA_MARK);
      if (t.src) L.push(...tailJmp());
      L.push(`(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`);
    } else {                                              // fall-through
      if (t.t < 0) L.push(...deoptTo(t.ta));
      else { const b = brTo(t.t); if (b) L.push(b); }
    }
    return L.join('\n');
  }

  const bodies = []; for (let i=0;i<N;i++) bodies.push(emitBlock(i));

  // ---- spill/reload narrowing ------------------------------------------------
  // Two dataflow passes over the emitted text shrink the register protocol.
  //
  // Forward (spills): a register whose local provably equals its regfile slot
  // ("clean") need not be written back at a spill site. Any (local.set $rN/$xN)
  // dirties the register; a reload marker cleans everything — mechanical, so
  // soundness does not rest on hand-listing which instructions write which
  // registers, and a write inside a conditional only over-dirties.
  //
  // Backward (reloads): a post-call/post-syscall reload of a register that is
  // never read again before being fully redefined is elided. Order matters:
  // spills are expanded FIRST, so an expanded spill's (local.get $rN) counts
  // as a use and forces the reload on any path that might later spill it —
  // which is why an elided reload never needs a third "stale" state: elision
  // proves the local is dead until a real def, and post-call "clean" remains
  // exactly right (the slot is authoritative, so skipping its spills is
  // correct). A (local.set) at paren depth > 0 is conditional and does not
  // kill liveness; uses count at any depth, and a local.set's def fires at
  // its CLOSING paren, after its expression's uses — a read-modify-write like
  // (local.set $r7 (i64.and (local.get $r7) …)) must order use before def, or
  // the walk kills the register's own entry liveness (that exact bug cost
  // ld.so its incoming rdi). The entry prologue reload is narrowed with
  // liveIn(entry) the same way (an elided entry load leaves the wasm-zero-
  // initialised local, sound by the same death-until-def argument).
  //
  // Both fixpoints run over succs (jump-table edges present via jtabUnion;
  // the entry block joins an all-clean function-entry state with its back
  // edges, since the prologue runs once, not per re-entry). With the lever
  // off every marker expands to the full list, identical to the unnarrowed
  // emitter up to whitespace, with no dataflow cost.
  let entryKeep = null;                         // null: keep every prologue reload
  {
    // OXWASM_NARROW_ONLY=hexaddr,hexaddr narrows just those functions - the
    // bisect lever for attributing a narrowing miscompile inside one unit
    const onlyN = typeof process !== 'undefined' && process.env?.OXWASM_NARROW_ONLY;
    // On by default since the yield fix below: call kernel 9.3x -> 6.5x, m4
    // 7.38x -> 6.95x on 514M calls. OXWASM_NARROW=0 / globalThis.__narrow =
    // false turns it off for A/B.
    const narrowOn = (globalThis.__narrow ??
      !(typeof process !== 'undefined' && process.env?.OXWASM_NARROW === '0')) &&
      (!onlyN || onlyN.split(',').includes(fnAddr.toString(16)));
    const regs16 = Array.from({length: 16}, (_, r) => r);
    // OXWASM_NOXMMCALL=1 is a PRICING PROBE, not a mode: it drops the xmm
    // half of every spill/reload site (8 v128 stores and loads each way per
    // call). Unsound for any call passing or returning floats in xmm - the
    // A/B checks the output hash - but it bounds what narrowing that half
    // could ever be worth.
    const noXmm = typeof process !== 'undefined' && process.env?.OXWASM_NOXMMCALL === '1';
    const xS = noXmm ? [] : [...xUsed];
    const expandFull = (sx) => [
      ...regs16.filter(r => touched(r) && !(sx && savedI32(r))).map(spillR),
      ...xS.map(xSpill),
    ].join('\n');
    const rlFull = [...regs16.filter(touched).map(reloadR), ...xS.map(xReload)].join('\n');
    const rlCall = [...regs16.filter(r => touched(r) && !(CS_MASK & (1 << r))).map(reloadR), ...xS.map(xReload)].join('\n');
    if (!narrowOn) {
      // off: every marker becomes the full list; no scan, no dataflow
      const sa = expandFull(false), sX = expandFull(true);
      for (let b = 0; b < N; b++) if (bodies[b].indexOf('\x00') !== -1)
        bodies[b] = bodies[b].replaceAll(SA_MARK, sa).replaceAll(SX_MARK, sX).replaceAll(RL_MARK, rlFull).replaceAll('\x00RC\x00', rlCall);
    } else {
    const bit = new Map();                      // '$rN'/'$xN' -> dataflow bit
    for (let r = 0; r < 16; r++) if (touched(r)) bit.set('$r'+r, 1 << r);
    for (const x of xUsed) bit.set('$x'+x, (0x10000 << x) | 0);
    let ALLBITS = 0; for (const v of bit.values()) ALLBITS |= v;
    const predsN = Array.from({length: N}, () => []);
    for (let b = 0; b < N; b++) for (const s of succs[b]) if (s >= 0) predsN[s].push(b);
    const stats = globalThis.__narrowStats ??=
      { sites: 0, spills: 0, skipped: 0, rlSites: 0, rlLoads: 0, rlSkipped: 0 };
    const nOps = (s, op) => { let n = 0, i = -1; while ((i = s.indexOf(op, i + 1)) !== -1) n++; return n; };

    // ---- forward: dirty bits -> spill expansion
    // per-block transfer as (kill, gen): OUT = (IN & ~kill) | gen, and every
    // spill marker's mask as a snapshot of (kill, gen) at its position
    {
      const RE = /\x00(?:S[AX]|R[LC])\x00|\(local\.set (\$[rx]\d+)/g;
      const kills = new Array(N).fill(0), gens = new Array(N).fill(0);
      const marks = Array.from({length: N}, () => []);
      for (let b = 0; b < N; b++) {
        let kill = 0, gen = 0, m;
        RE.lastIndex = 0;
        while ((m = RE.exec(bodies[b])) !== null) {
          if (m[0][0] === '\x00') {
            if (m[0][1] === 'R') { kill = ALLBITS; gen = 0; }     // reload site: all clean after
            else marks[b].push({ at: m.index, sx: m[0][2] === 'X', kill, gen });
            continue;
          }
          const bb = bit.get(m[1]);
          if (bb !== undefined) gen |= bb;
        }
        kills[b] = kill; gens[b] = gen;
      }
      const IN = new Array(N).fill(0), OUT = new Array(N).fill(0);
      for (let pass = 0, changed = true; changed && pass < 33 * N + 2; pass++) {
        changed = false;
        for (let b = 0; b < N; b++) {
          let inm = 0; for (const p of predsN[b]) inm |= OUT[p];
          const o = (inm & ~kills[b]) | gens[b];
          if (inm !== IN[b] || o !== OUT[b]) { IN[b] = inm; OUT[b] = o; changed = true; }
        }
      }
      const expand = (sx, mask) => [
        ...regs16.filter(r => touched(r) && !(sx && savedI32(r)) && (mask & (1 << r))).map(spillR),
        ...[...xUsed].filter(x => mask & ((0x10000 << x) | 0)).map(xSpill),
      ].join('\n');
      const fullStores = [nOps(expandFull(false), '.store'), nOps(expandFull(true), '.store')];   // once, not per marker (it was rebuilt at every site for a statistic)
      for (let b = 0; b < N; b++) {
        if (!marks[b].length) continue;
        let out = '', last = 0;
        for (const mk of marks[b]) {
          const mask = (IN[b] & ~mk.kill) | mk.gen;
          const txt = expand(mk.sx, mask);
          stats.sites++; const k = nOps(txt, '.store');
          stats.spills += k; stats.skipped += fullStores[mk.sx ? 1 : 0] - k;
          out += bodies[b].slice(last, mk.at) + txt;
          last = mk.at + 4;                     // marker is 4 chars
        }
        bodies[b] = out + bodies[b].slice(last);
      }
    }

    // ---- backward: liveness -> reload expansion (on the spill-expanded text)
    {
      const evRE = /\x00R[LC]\x00|\(local\.(get|set) (\$[rx]\d+)/g;
      const events = Array.from({length: N}, () => []);   // {use|def|rl, bit, at}
      for (let b = 0; b < N; b++) {
        const body = bodies[b], ev = events[b];
        // A local.set's WRITE happens at its closing paren, after the uses
        // inside its value expression — track open sets on a stack and emit
        // each def where it closes, or a read-modify-write orders def first.
        let depth = 0, pos = 0, m;
        const pend = [];                                   // {bit, depth} of open local.sets
        const gap = (from, to) => {
          for (let i = from; i < to; i++) {
            const c = body.charCodeAt(i);
            if (c === 40) depth++;
            else if (c === 41) {
              depth--;
              while (pend.length && depth <= pend[pend.length - 1].depth) {
                const p = pend.pop(); ev.push({ k: 1, bit: p.bit, d: p.depth });
              }
            }
          }
        };
        evRE.lastIndex = 0;
        while ((m = evRE.exec(body)) !== null) {
          gap(pos, m.index); pos = m.index;
          if (m[0][0] === '\x00') { ev.push({ k: 2, at: m.index, cs: m[0][2] === 'C' }); continue; }
          const bb = bit.get(m[2]);
          if (bb === undefined) continue;
          if (m[1] === 'get') ev.push({ k: 0, bit: bb });
          else pend.push({ bit: bb, depth });
        }
        gap(pos, body.length);
        while (pend.length) { const p = pend.pop(); ev.push({ k: 1, bit: p.bit, d: p.depth }); }
      }
      // liveIn via reverse walk of each block's events from liveOut
      const walk = (b, liveOut, rec) => {
        let live = liveOut;
        const ev = events[b];
        for (let i = ev.length - 1; i >= 0; i--) {
          const e = ev[i];
          if (e.k === 0) live |= e.bit;
          else if (e.k === 1) { if (e.d === 0) live &= ~e.bit; }     // conditional defs don't kill
          else { if (rec) rec.push({ at: e.at, live, cs: e.cs });
                 live = e.cs ? (live & CS_MASK) : 0; }               // reload defines all it keeps; callee-saved live through a call
        }
        return live;
      };
      const liveIn = new Array(N).fill(0);
      for (let pass = 0, changed = true; changed && pass < 33 * N + 2; pass++) {
        changed = false;
        for (let b = N - 1; b >= 0; b--) {
          let lo = 0; for (const s of succs[b]) if (s >= 0) lo |= liveIn[s];
          const li = walk(b, lo, null);
          if (li !== liveIn[b]) { liveIn[b] = li; changed = true; }
        }
      }
      const rlFullLoads = nOps(rlFull, '.load');
      const rlExpand = (mask) => [
        ...regs16.filter(r => touched(r) && (mask & (1 << r))).map(reloadR),
        ...[...xUsed].filter(x => mask & ((0x10000 << x) | 0)).map(xReload),
      ].join('\n');
      for (let b = 0; b < N; b++) {
        if (!events[b].some(e => e.k === 2)) continue;
        let lo = 0; for (const s of succs[b]) if (s >= 0) lo |= liveIn[s];
        const rec = []; walk(b, lo, rec);
        rec.sort((a, c) => a.at - c.at);        // reverse walk recorded back-to-front
        let out = '', last = 0;
        for (const mk of rec) {
          const txt = rlExpand(mk.cs ? (mk.live & ~CS_MASK) : mk.live);
          stats.rlSites++; const k = nOps(txt, '.load');
          stats.rlLoads += k; stats.rlSkipped += rlFullLoads - k;
          out += bodies[b].slice(last, mk.at) + txt;
          last = mk.at + 4;
        }
        bodies[b] = out + bodies[b].slice(last);
      }
      // the prologue reload runs once at function entry: keep what is live
      // into the entry block, plus r4 ($rsp0 and the frame setup read it)
      // ... unless this function can yield: the shared $yield tail spills every
      // touched register, and a register the narrowed prologue did not
      // reload holds an uninitialised local until the path writes it - the
      // tail would store that zero over the caller's value (m4 with the
      // narrowing on died on a wild address; with the yield off it was
      // exact). A yielding function reloads everything it touches; the
      // caller-side spill, the exit spill and the post-call reload stay
      // narrowed.
      entryKeep = usesYield ? null : (liveIn[0] | (1 << 4));
    }
    }
    // a marker that survives would poison the unit at wat2wasm; fail loudly
    for (let b = 0; b < N; b++) if (bodies[b].indexOf('\x00') !== -1)
      throw new Error('AOT: unexpanded spill/reload marker in block ' + b + ' of ' + fnAddr.toString(16));
  }

  const name = 'f_' + fnAddr.toString(16);
  // A function the RUNTIME cannot compile is as useless as one this emitter
  // cannot translate, and until now nothing checked. rustc's biggest function
  // reaches 5.9 MB of text; V8 compiles it fine at baseline and then dies
  // inside its optimizing compiler when the function tiers up - a hard process
  // abort (Check failed: IdField::is_valid(id)), not an exception, so there is
  // nothing to catch and the whole run is lost. The largest function the same
  // run compiles and tiers up without complaint is 4.2 MB, so the limit sits
  // between the two measurements rather than at a guess. Refusing is the safe
  // answer: the function stays interpreted, which is where it was before the
  // flag join let it translate at all. Both layouts exit through here - the
  // dispatch one returns early, and a cap on the other alone caught nothing,
  // because a function big enough to worry about is exactly the kind that
  // gets the dispatch layout.
  const finish = (w) => {
    if (w.length > MAXWAT) throw new Error('emitted function exceeds the runtime limit: ' + w.length + ' bytes of wat');
    return w;
  };
  let wat = `  (func $${name} (export "${name}") (result i64)\n`;
  for (let r=0;r<16;r++) wat += `    (local $r${r} ${isI32(r)?'i32':'i64'})\n`;
  wat += '    (local $fa i64) (local $fb i64) (local $fr i64) (local $cf i64) (local $fbits i64) (local $rsp0 i64) (local $rex i64)\n';
  if (DISP || hasJtab) wat += '    (local $pc i32)\n';
  if (usesFtr) wat += '    (local $fti i32)\n';
  if (usesFts) wat += '    (local $fts i32)\n';
  if (usesGa) wat += '    (local $ga i32) (local $gp i32)\n';
  if (usesIcp) wat += '    (local $icp i32)\n';
  for (const r of xUsed) wat += `    (local ${xreg(r)} v128)\n`;
  for (const t of tmps) wat += `    (local ${t} i64)\n`;
  for (const t of vtmps) wat += `    (local ${t} v128)\n`;
  for (let r=0;r<16;r++) if (touched(r) && (entryKeep === null || (entryKeep & (1<<r)))) wat += '    ' + reloadR(r) + '\n';
  for (const r of xUsed) if (entryKeep === null || (entryKeep & ((0x10000<<r)|0))) wat += '    ' + xReload(r) + '\n';
  wat += '    (local.set $rsp0 (local.get $r4))\n';
  wat += '    ' + ftInc + '\n';       // entry tax: this frame\'s stack weight
  if (typeof process !== 'undefined' && process.env?.OXWASM_COUNTCALLS === '1') wat += `    (i64.store (i32.const ${FTMAP + 32}) (i64.add (i64.load (i32.const ${FTMAP + 32})) (i64.const 1)))\n`;
  // OXWASM_FNPROF=1: a per-function entry counter (diagnosis only). aotCalls
  // is a threshold detector that stops at tier-up, so it cannot rank callees;
  // this counts every prologue entry, compiled-to-compiled calls included.
  // Slots hash the function address into the dead space above FTMAP;
  // runbin reads them back per compiled entry and flags slot collisions.
  if (typeof process !== 'undefined' && process.env?.OXWASM_FNPROF === '1') { const sl = fnprofSlot(fnAddr); wat += `    (i64.store (i32.const ${sl}) (i64.add (i64.load (i32.const ${sl})) (i64.const 1)))\n`; }   // measurement: function entries
  // one yield exit per function (see FTLOOP): a back edge whose budget is
  // spent and whose head resolves sets $rex and br's here; the spill and the
  // return-or-deopt are emitted once, not per edge
  const regs16y = Array.from({length: 16}, (_, r) => r);
  const noXmmY = typeof process !== 'undefined' && process.env?.OXWASM_NOXMMCALL === '1';
  const yieldSpill = () => [...regs16y.filter(touched).map(spillR), ...(noXmmY ? [] : [...xUsed]).map(xSpill)].join('\n    ');   // the full spill, as expandFull(false) builds it
  const yieldTail = () => !usesYield ? '' :
    `    ${yieldSpill()}\n    (i32.store (i32.const ${FTLOOP}) (i32.const ${LOOPYIELD_N}))\n` +
    `    (if (i32.eqz (i32.load (i32.const ${FTNEST}))) (then (i32.store (i32.const ${FTYTOP}) (i32.add (i32.load (i32.const ${FTYTOP})) (i32.const 1))) (return (local.get $rex))))\n` +
    `    (i32.store (i32.const ${FTYNEST}) (i32.add (i32.load (i32.const ${FTYNEST})) (i32.const 1)))\n` +
    `    (return (call $x_deopt (local.get $rex) (local.get $rsp0)))\n`;
  if (usesYield) wat += '    (block $yield\n';
  // The jump-table resolver: address -> RPO index for every table target, a
  // balanced binary-search tree of ifs (log2(n) compares per computed
  // goto). Both layouts call it; it was emitted by the dispatch epilogue
  // only, so every structured function with a jump table referenced an
  // undefined $jtr_ and the whole unit failed to assemble (18k such errors
  // in one breadth sweep - the units fell back to the interpreter).
  const jtrFunc = () => {
    if (!hasJtab) return '';
    const pairs = [...jtabUnion].map(j => [blocks[j].start, j]).sort((x,y) => x[0] < y[0] ? -1 : 1);
    const bs = (lo, hi) => {
      if (hi - lo === 1) return `(if (result i32) (i64.eq (local.get $a) (i64.const ${hexs(pairs[lo][0])})) (then (i32.const ${pairs[lo][1]})) (else (i32.const -1)))`;
      const mid = (lo + hi) >> 1;
      return `(if (result i32) (i64.lt_u (local.get $a) (i64.const ${hexs(pairs[mid][0])}))\n      (then ${bs(lo, mid)})\n      (else ${bs(mid, hi)}))`;
    };
    return `  (func $jtr_${fnAddr.toString(16)} (param $a i64) (result i32)\n    ${bs(0, pairs.length)}\n  )\n`;
  };
  if (DISP) {
    // flat br_table dispatch: $pc holds the current block's RPO index. Block
    // bodies run in order; a non-fallthrough edge sets $pc and br's $L_disp.
    wat += '    (block $exit_disp\n    (loop $L_disp\n';
    for (let k = N-1; k >= 0; k--) wat += `      (block $b${k}\n`;
    const tab = Array.from({length:N}, (_,k)=>'$b'+k).join(' ');
    wat += `      (br_table ${tab} $exit_disp (local.get $pc)))\n`;   // closes $b0
    for (let i=0;i<N;i++) {
      // a block with a SELF-EDGE (tight single-block loop - the hottest
      // backward-edge kind) gets a loop label so it branches directly instead
      // of paying the $pc + br_table dispatcher round-trip. Only those: V8
      // places a stack check at every wasm loop header, and wrapping every
      // body in a loop (12,000 of them in one m4 unit, 112 ever branched to)
      // cost a quarter of m4's steady state (--no-wasm-stack-checks: -28%).
      // OXWASM_BLOCKLOOPS=1 restores the old shape for A/B.
      const selfLoop = BLOCKLOOPS || succs[i].includes(i);
      wat += (selfLoop ? `      (loop $l${i}\n      ` : '      ') + bodies[i] + (selfLoop ? ')\n' : '\n');
      if (i < N-1) wat += `      )\n`;                                 // close $b${i+1}
    }
    wat += '    ))\n';                                                 // close loop + exit block
    if (usesYield) wat += '    (unreachable))\n' + yieldTail();          // close $yield; its tail follows
    wat += '    (unreachable)\n  )\n';
    return finish(wat + jtrFunc());
  }
  for (let i=0;i<N;i++) {
    for (const s of open[i]) wat += s.type==='loop' ? `      (loop ${s.label}\n` : `      (block ${s.label}\n`;
    wat += '      ' + bodies[i] + '\n';
    for (const _ of closeAfter[i]) wat += '      )\n';
  }
  if (usesYield) wat += '    (unreachable))\n' + yieldTail();            // close $yield; its tail follows
  wat += '    (unreachable)\n  )\n';        // every path leaves via ret/deopt
  return finish(wat + jtrFunc());
}

// ---- unit driver -----------------------------------------------------------
// On by default: suite + breadth (31/31 byte-identical, incl. two-tier
// CPython) pass with it, steady-state on call-dense code is 6-11% faster,
// and the tier-up cost objection is halved by the assembler worker.
const BLOCKLOOPS = typeof process !== 'undefined' && process.env?.OXWASM_BLOCKLOOPS === '1';
// On by default; OXWASM_LOOPYIELD=0 or globalThis.__loopYield = false turns
// the whole mechanism off for A/B: no back edge burns the budget, no call
// site touches FTNEST, no $yield exit is emitted. The words, the env.loophot
// import and the counters stay either way. It was shipped off for one
// commit while its cost was bisected: two full sweeps with it on had died
// at the harness's 90-minute cap with zero yields taken - and so did the
// sweep with it OFF (gdb-batch 1081s, python-mp 600s). Every unit's text had
// changed (the new import line), the wat cache was cold for all 20,983 of
// them, and a cold sweep is 2-7x a warm one (m4's case 39.8s vs 6.7s). With
// it on the sweep is 130/130 byte-identical and no sweep case ever reaches
// a yield (none runs one loop 4M back edges); the effect is on long loops:
// the scan kernel 3.86x -> 1.56x native, branch 1.94x -> 1.35x.
// OXWASM_TAILCUT=0 follows tail jumps into other functions again (A/B)
const TAILCUT = !(typeof process !== 'undefined' && process.env?.OXWASM_TAILCUT === '0');
const LOOPYIELD = !((typeof process !== 'undefined' && process.env?.OXWASM_LOOPYIELD === '0') || globalThis.__loopYield === false);
export const LOOPYIELD_N = (typeof process !== 'undefined' && +process.env?.OXWASM_LOOPYIELD_N) || 4000000;   // backward edges per yield; dispatchAot's fill and the in-wasm refill agree
// Opt out with OXWASM_INLINE=0 or globalThis.__inline = false.
// OXWASM_INLINE_BUDGET caps the callee size in instructions - the default is
// in the low hundreds because gzip's three hot callees are 66, 88 and 114,
// and a 64-instruction cutoff excludes all of them.
const inlineEnabled = () => globalThis.__inline ??
  !(typeof process !== 'undefined' && process.env?.OXWASM_INLINE === '0');
const inlineBudget = () => Number(
  (typeof process !== 'undefined' && process.env?.OXWASM_INLINE_BUDGET) || 160);
// Per-function cap on duplicated instructions. A callee at 8 sites is 8
// copies, so the interesting limit is the total, not the per-callee size.
const inlineTotal = () => Number(
  (typeof process !== 'undefined' && process.env?.OXWASM_INLINE_TOTAL) || 640);

export function compileUnitWat(mem, entry, opts = {}) {
  const INLINE = inlineEnabled(), INLINE_BUDGET = inlineBudget(), INLINE_TOTAL = inlineTotal();
  // OXWASM_PHASE=1 attributes tier-up time to the phases that spend it. The
  // inlining tier-up cost is +116ms and unexplained; guessing at it from A/B
  // wall clock has already produced one withdrawn conclusion.
  const PHASE = typeof process !== 'undefined' && process.env?.OXWASM_PHASE === '1';
  const PH = PHASE ? (globalThis.__aotPhase ??= { analyze: 0, inline: 0, emit: 0, ftscan: 0,
                                                  chars: 0, rounds: 0, units: 0, reemit: 0, analyzed: 0, analyzedInsns: 0, seen: new Set() }) : null;
  // Note on what inlining can NOT reach. Closure pruning drops a callee the
  // host already has compiled and mapped, so a callee that tiered up before
  // its caller is invisible to the inliner. Un-pruning small callees to get
  // them back was tried and is far too expensive: it duplicates them into
  // every unit that calls them, taking gzip from 380 emitted functions to 715
  // and tier-up from 877ms to 4018ms. Pruning is worth more than inlining.
  // The inliner works with what is in the closure.
  const ONLY = (typeof process !== 'undefined' && process.env?.OXWASM_INLINE_ONLY) || '';
  const INLINE_ONLY = ONLY ? new Set(ONLY.split(',').map(h => BigInt('0x' + h.trim()).toString())) : null;
  const { guestBase, ramBase, maxFuncs = 96, maxInsns = 20000, skip } = opts;
  const TINY = opts.tiny ?? Number((typeof process !== 'undefined' && process.env?.OXWASM_UNPRUNE_TINY) ?? 16);
  const tinyMemo = opts.tinyMemo || new Map();
  const isTiny = (a) => {
    if (!(TINY > 0)) return false;
    const k = a.toString(); if (tinyMemo.has(k)) return tinyMemo.get(k);
    let ok = false;
    try { const t = analyze(mem, a, { maxInsns: TINY, noJtab: true, entries: opts.entries ?? null, callTargets: opts.callTargets ?? null });
          ok = t.blocks.every(b => b.insns.every(i => i.mnem !== 'udec' && i.mnem !== 'jmpind')); }
    catch { ok = false; }
    tinyMemo.set(k, ok); return ok;
  };
  // Hot-site un-prune: a callee called from a CYCLE of a function already
  // in this closure is on that function's hot path. Pruned (already compiled
  // elsewhere), every such call pays the $ftr chain - hash probe,
  // call_indirect, budget save/restore - and next_char in m4 was paid per
  // character from six tokenizer loops that way: un-pruning it by hand
  // (OXWASM_UNPRUNE=409e80) took m4 from 6.95x to 6.47x native. The engine's
  // call profile cannot rank it (see inlineCallees: a threshold detector
  // that stops at the first tier-up), the caller's own CFG can. Such a
  // callee stays in the closure when its body is at most HOTSIZE
  // instructions (bigger ones amortise the chain) and this unit has HOTUN
  // instructions of such duplication left; direct wasm calls result, and
  // the inliner gets a candidate. OXWASM_UNPRUNE_HOT=0 turns it off.
  // Default OFF: on m4 it bought 4.5% of steady state (9582 -> 9146 ms) for
  // +2 s of translation per run (567 callees, 67k instructions analysed and
  // emitted again at a 1024 budget) - a net loss below a minute of runtime.
  // The version that pays needs a call counter on the chained-call path so
  // only callees that are ACTUALLY called hot get re-homed (a re-tier).
  const HOTUN = opts.hotUnprune ?? Number((typeof process !== 'undefined' && process.env?.OXWASM_UNPRUNE_HOT) ?? 0);
  const HOTSIZE = Number((typeof process !== 'undefined' && process.env?.OXWASM_UNPRUNE_HOTSIZE) ?? 640);
  const hotSites = new Set(); let hotSpent = 0;
  const noteHotSites = (an) => {
    if (!(HOTUN > 0)) return;
    let cyc; try { cyc = cyclicBlocks(an); } catch { return; }
    for (const bi of cyc) for (const insn of an.blocks[bi].insns)
      if (insn.mnem === 'call') hotSites.add(((insn.next + insn.rel) & an.M).toString());
  };
  const funcs = new Map();                       // addrStr -> analysis
  const poisoned = new Set();                    // addrStr -> engine-only (callout)
  const pending = [entry];
  const ta0 = PHASE ? performance.now() : 0;
  while (pending.length && funcs.size < maxFuncs) {
    const a = pending.shift(); const k = a.toString();
    if (funcs.has(k) || poisoned.has(k)) continue;
    // Closure pruning: a call target the host already has compiled and
    // mapped is reachable through $ftr chaining at full speed — including
    // it again would duplicate its whole body in this unit (CPython's eval
    // loop compiled 7 overlapping 5.9MB closures, one per hot loop head).
    // Not poisoned: call sites emit the $ftr chain, not a callout.
    // Tiny callees are the exception to pruning: a hot leaf that tiered up
    // before its caller is otherwise reached through the $ftr chain (hash
    // probe, call_indirect, budget save/restore) at every site, and the call
    // kernel measured that chain as its WHOLE gap - 4.42x chained against
    // 0.56x with the 4-instruction leaf in the unit (V8 inlines a direct
    // call to it). The earlier "un-prune small callees" experiment doubled
    // gzip's unit and quadrupled its tier-up because "small" was the
    // inliner's 160-instruction budget; at TINY (default 16) instructions
    // the duplication is a few lines per site. OXWASM_UNPRUNE_TINY=0 turns
    // it off; the per-address verdict is memoised across units in opts.tinyMemo.
    if (opts.veto && k !== entry.toString() && opts.veto(k)) continue;   // bisect aid: an explicit veto beats the tiny exception
    let hotOnly = false;                       // admitted by the hot-site rule alone: sized after analysis
    if (skip && k !== entry.toString() && skip(k) && !isTiny(a)) {
      if (!(HOTUN > 0 && hotSites.has(k) && hotSpent < HOTUN)) continue;
      hotOnly = true;
    }
    // A callee whose analysis or emit failed in an earlier unit fails the
    // same way in this one (the bytes have not changed; the engine clears the
    // memo when they do): poison it without analysing again. rustc-asm
    // re-analysed 2.58M instructions of such callees, 9.8 s of a 152 s run.
    // Roots are never memoised - a root that fails must throw to its caller.
    if (opts.failMemo && k !== entry.toString() && opts.failMemo.has(k)) { poisoned.add(k); if (PHASE) PH.memoFail = (PH.memoFail ?? 0) + 1; continue; }
    // a callee the size gate refused before is refused again without analysis
    // while its call count is still short (its size is remembered)
    if (opts.sizeMemo && opts.sizeGate && k !== entry.toString() && opts.sizeMemo.has(k) && opts.sizeGate(k, opts.sizeMemo.get(k), false)) { if (PHASE) PH.memoSize = (PH.memoSize ?? 0) + 1; continue; }
    try {
      let an;
      try { const tA = PHASE ? performance.now() : 0;
            an = analyze(mem, a, { maxInsns, noJtab: !!globalThis.__noJtab, entries: opts.entries ?? null, callTargets: opts.callTargets ?? null });
            if (PHASE) { PH.analyzed++; let n = 0; for (const b of an.blocks) n += b.insns.length; PH.analyzedInsns += n;
              if (PH.seen.has(k)) { PH.dup = (PH.dup ?? 0) + 1; PH.dupInsns = (PH.dupInsns ?? 0) + n; PH.dupMs = (PH.dupMs ?? 0) + performance.now() - tA; } else PH.seen.add(k);
              const bk = n < 100 ? '<100' : n < 500 ? '<500' : n < 2000 ? '<2000' : n < 8000 ? '<8000' : '>=8000';   // per-size buckets: [analyses, ms, insns]
              const h = (PH.hist ??= {})[bk] ??= [0, 0, 0]; h[0]++; h[1] += performance.now() - tA; h[2] += n;
              if (n >= 2000) (PH.big ??= new Map()).set(k, n); } }   // giant functions by address, joined with OXWASM_FNPROF entry counts in runbin
      catch (e) {
        // jump-table discovery can push a function over the size budget;
        // it compiled before the feature, so retry without it
        if (!/function too large/.test(e.message) || globalThis.__noJtab) throw e;
        an = analyze(mem, a, { maxInsns, noJtab: true, entries: opts.entries ?? null, callTargets: opts.callTargets ?? null });
      }
      // a body that starts undecodable compiles to a pure deopt — worse than
      // useless: dispatching it can ping-pong with the engine. Poison instead
      // so control reaches the interpreter, which faults faithfully.
      // blocks[] is sorted by address; the ENTRY block is the one at `a`.
      // A function whose CFG reaches a lower-address block - a tail jump into
      // a PLT stub below it - had blocks[0] be that stub, and the two checks
      // below refused every such function as "a trampoline": m4's input
      // reader and 30 of its neighbours stayed interpreted forever, 250x
      // native on a macro-heavy input.
      const eb = an.blocks[an.bidx.get(a.toString())] ?? an.blocks[0];
      if (eb.insns[0].mnem === 'udec') throw new Error('entry undecodable');
      // A PLT/IFUNC trampoline (endbr64/nops then `jmp *GOT`) must stay a
      // callout, not a direct wasm call: a direct call would run its indirect
      // jump in wasm, deopt, and unwind the CALLER's live frame every time.
      // Poisoning it makes callers reach it via x_callout, which runs it to
      // completion (dispatching the real target) and returns — frame intact.
      // A rip-relative jmpind at entry is a trampoline REGARDLESS of block
      // count: when the analyzer manages to follow the slot's current value
      // (target not pruned), the compile would bake a MUTABLE GOT binding in
      // as static control flow — repacking the GIMP container did exactly
      // that to stub 0x7dbbec0 and the page's stroke path died on the stale
      // binding. Register/indexed jmpind (a computed goto) keeps the
      // single-block rule, since a jtab-resolved entry is a real function.
      { const b0 = eb.insns; let t0 = null;
        for (const insn of b0) { if (insn.mnem === 'nop') continue; t0 = insn; break; }
        if (t0?.mnem === 'jmpind' &&
            ((t0.src?.kind === 'mem' && t0.src.ripRel) || an.blocks.length === 1))
          throw new Error('trampoline -> callout'); }
      // Size gate: a giant function costs its instruction count to emit and
      // assemble, and on rustc-asm 76% of the giant instructions translated
      // belonged to functions entered fewer than 16 times afterwards. The
      // engine's gate asks for more observed calls the bigger the function;
      // a root that fails it is deferred (the engine re-tiers it at the
      // count the gate names), a callee simply stays out of this closure.
      if (opts.sizeGate) { let n = 0; for (const b of an.blocks) n += b.insns.length;
        const need = opts.sizeGate(k, n, k === entry.toString());
        if (need) { if (k === entry.toString()) throw Object.assign(new Error('size gate: ' + n + ' insns, ' + need + ' calls needed'), { deferred: need }); if (opts.sizeMemo) opts.sizeMemo.set(k, n); continue; } }
      if (hotOnly) { let n = 0; for (const b of an.blocks) n += b.insns.length;
        const st = (globalThis.__hotUnpruneStats ??= { kept: 0, insns: 0, refused: 0 });
        if (n > HOTSIZE || hotSpent + n > HOTUN) { st.refused++; continue; }   // stays pruned: its sites chain through $ftr
        hotSpent += n; st.kept++; st.insns += n; }
      funcs.set(k, an);
      // the ROOT's cycles only: noting every member's cycles cascaded (m4:
      // 862 callees, 116k instructions kept over one run, +2 s of startup)
      if (k === entry.toString()) noteHotSites(an);
      for (const c of an.calls) if (!funcs.has(c) && !poisoned.has(c)) pending.push(BigInt(c));
    } catch (e) { poisoned.add(k); if (k === entry.toString()) throw e; if (opts.failMemo && !e.deferred) opts.failMemo.set(k, e.message); }
  }
  if (PHASE) { PH.analyze += performance.now() - ta0; PH.units++; }
  // Emitting records which callees a text reaches directly (a wasm `call`,
  // or an inlined body), so that when a callee poisons only the texts that
  // named it are emitted again. The whole unit used to be re-emitted per
  // round: in a rustc compile (LLVM functions with unsupported SSE forms
  // poisoning routinely) that re-emitted 13,176 functions on top of the
  // 20,464 the run needed, a third of the emit phase.
  let emitting = null; const uses = new Map();
  const canDirect = (k) => { const ok = funcs.has(k) && !poisoned.has(k); if (ok && emitting !== null) uses.get(emitting).add(k); return ok; };
  const ctx = { guestBase, ramBase, canDirect };
  // emit; a failure poisons that function and re-emits its direct callers -
  // they switch from direct wasm calls to callout escapes
  const texts = new Map();
  for (let round = 0; ; round++) {
    if (round > 16) throw new Error('AOT: poison did not converge');
    let repoison = false;
    for (const [k, an] of funcs) {
      if (poisoned.has(k) || texts.has(k)) continue;
      emitting = k; uses.set(k, new Set());
      try {
        // Inlining is opt-in while it is being measured. It never changes what
        // the unit CONTAINS - the callee keeps its own standalone function for
        // callers in other units - only how this one function reaches it.
        let use = an;
        if (INLINE) {
          const tp0 = PHASE ? performance.now() : 0;
          try {
            const m = inlineCallees(an, BigInt(k), (t) =>
              (funcs.has(t) && !poisoned.has(t)) ? funcs.get(t) : null,
              { budget: INLINE_BUDGET, total: INLINE_TOTAL, only: INLINE_ONLY,
                rej: INLINE_ONLY ? (t, why) => {
                  const st = globalThis.__inlStats = globalThis.__inlStats || { fns: 0, callees: 0 };
                  (st.rej = st.rej || []).push(BigInt(t).toString(16) + ':' + why + ' in ' + k);
                } : null });
            if (m) { use = m;
              for (const t of m.inlined) uses.get(k).add(typeof t === 'string' ? t : BigInt(t).toString());   // an inlined body is a use too
              globalThis.__inlStats = globalThis.__inlStats || { fns: 0, callees: 0 };
              globalThis.__inlStats.fns++; globalThis.__inlStats.callees += m.inlined.length; }
          } catch { /* a merge that does not hold: emit the function unmodified */ }
          if (PHASE) PH.inline += performance.now() - tp0;
        }
        const te0 = PHASE ? performance.now() : 0;
        try { texts.set(k, emitUnitFunction(use, BigInt(k), ctx)); }
        catch (e) {
          // an inlined body that fails to emit must not poison a function that
          // compiles perfectly well on its own
          if (use === an) throw e;
          texts.set(k, emitUnitFunction(an, BigInt(k), ctx));
        }
        if (PHASE) { PH.emit += performance.now() - te0; PH.chars += (texts.get(k) || '').length; }
      }
      catch (e) {
        if (k === entry.toString()) throw e;
        poisoned.add(k); repoison = true;
        // an emit failure is a property of the function's own instructions
        // (the inlining retry above already ran): remember it, so the next
        // unit that reaches this callee poisons it without analysing it
        if (opts.failMemo) opts.failMemo.set(k, e.message);
      }
    }
    emitting = null;
    if (PHASE) PH.rounds++;
    if (!repoison) break;
    // only the texts that reach a poisoned function directly are stale
    let stale = 0;
    for (const [k, u] of uses) if (texts.has(k)) { for (const c of u) if (poisoned.has(c)) { texts.delete(k); stale++; break; } }
    if (PHASE) PH.reemit += stale;
    if (!stale) break;                     // nothing named the poisoned function: the texts stand
  }
  let wat = '(module\n  (import "js" "mem" (memory 4096))\n';
  wat += '  (import "env" "syscall" (func $x_syscall (param i64)))\n';
  wat += '  (import "env" "callout" (func $x_callout (param i64) (result i64)))\n';
  wat += '  (import "env" "deopt" (func $x_deopt (param i64 i64) (result i64)))\n';
  wat += '  (import "env" "loophot" (func $x_loophot (param i64)))\n';   // a loop head that ran long without a unit of its own (see FTLOOP)
  // Only when the guard is on, so a module built without it keeps exactly the
  // imports every existing consumer supplies.
  if (STOREGUARD) wat += '  (import "env" "codewrite" (func $x_cw (param i32)))\n';
  // the global dispatch table + its in-wasm resolver, iff some site chains
  // through it (indirect call, out-of-unit static call, indirect tail jump)
  const tf0 = PHASE ? performance.now() : 0;
  const needsFtr = [...texts.values()].some(t => t.includes('(call $ftr '));
  if (PHASE) PH.ftscan += performance.now() - tf0;
  if (needsFtr) {
    wat += '  (import "js" "ftab" (table $ft 0 funcref))\n';
    wat += '  (type $uft (func (result i64)))\n';
    wat += FTR_WAT;
    // In-wasm dispatch driver: after a top frame's guest ret exits its wasm
    // function, resolve the exit rip and chain to the next compiled function
    // without returning to JS — the JS dispatch loop paid a full regfile
    // syncOut/syncIn per top-frame ret (23M round-trips in one CPython
    // benchmark run). Exits to JS only on a resolver miss or exhausted
    // budget; the same FTDEPTH/FTFUEL words gate it, so host slice deadlines
    // and stack limits behave exactly as for in-unit chains.
    wat += `  (func (export "drive") (param $rip i64) (result i64)
    (local $fti i32)
    (block $out
      (loop $l
        (local.set $fti (call $ftr (local.get $rip)))
        (br_if $out (i32.lt_s (local.get $fti) (i32.const 0)))
        (br_if $out (i32.eqz (i32.and (i32.lt_u (i32.load (i32.const ${FTDEPTH})) (i32.const ${FTDLIMIT})) (i32.ne (i32.load (i32.const ${FTFUEL})) (i32.const 0)))))
        (i32.store (i32.const ${FTFUEL}) (i32.sub (i32.load (i32.const ${FTFUEL})) (i32.const 1)))
        (local.set $rip (call_indirect $ft (type $uft) (local.get $fti)))
        (br $l)))
    (local.get $rip))\n`;
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
