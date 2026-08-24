// oxwasm M3 — AOT whole-function translator, x86-64 machine code -> WAT.
// Recovers the function CFG and emits ONE wasm function: all 16 GPRs in
// i64 locals for the function's lifetime, any control flow via the
// universal br_table dispatch loop, lazy flags (a flag op stashes inputs,
// the consuming jcc recomputes just the needed bit). Input is unmodified
// compiled machine code. Text backend, assembled by wat2wasm.
import { decode } from './decode.mjs';

const MASK = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
const SIGN = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };

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
    if (op.kind === 'imm') return `(i64.const ${hexs(op.v)})`;
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
        case 'lea': L.push(`(local.set ${reg(insn.dst.r)} ${guestAddr(insn.src, next)})`); break;
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
          const a = rd(insn.dst,S,next); const c = `(i32.and ${rd(insn.src,1,next) === '(i64.const 1)' ? '(i32.const 1)' : `(i32.wrap_i64 ${rd(insn.src,1,next)})`} (i32.const ${S===8?63:31}))`;
          let e;
          if (S === 8) e = `(i64.${insn.mnem==='rol'?'rotl':'rotr'} ${a} (i64.extend_i32_u ${c}))`;
          else e = `(i64.extend_i32_u (i32.${insn.mnem==='rol'?'rotl':'rotr'} (i32.wrap_i64 ${a}) ${c}))`;
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
function analyze(mem, entry, { maxInsns = 20000 } = {}) {
  const M = 0xFFFFFFFFFFFFFFFFn;
  const insnAt = new Map(); const work = [entry]; const seen = new Set(); let count = 0;
  const calls = new Set();
  while (work.length) {
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
    insn.rip = rip; insn.next = rip + BigInt(insn.len); insnAt.set(key, insn);
    if (insn.mnem === 'ret' || insn.mnem === 'retn' || insn.mnem === 'jmpind') continue;
    if (insn.mnem === 'jmp') { work.push((insn.next + insn.rel) & M); continue; }
    if (insn.mnem === 'jcc') { work.push((insn.next + insn.rel) & M); work.push(insn.next); continue; }
    if (insn.mnem === 'call') calls.add(((insn.next + insn.rel) & M).toString());
    work.push(insn.next);
  }
  const addrs = [...insnAt.keys()].map(BigInt).sort((a,b)=>a<b?-1:1);
  const leaders = new Set([entry.toString()]);
  for (const a of addrs) { const insn = insnAt.get(a.toString());
    if (insn.mnem === 'jcc') { leaders.add(((insn.next+insn.rel)&M).toString()); leaders.add(insn.next.toString()); }
    if (insn.mnem === 'jmp') leaders.add(((insn.next+insn.rel)&M).toString()); }
  const blocks = []; let cur = null;
  for (const a of addrs) { if (leaders.has(a.toString())) { cur = { start: a, insns: [] }; blocks.push(cur); } cur.insns.push(insnAt.get(a.toString())); }
  const bidx = new Map(blocks.map((b,i)=>[b.start.toString(), i]));
  return { blocks, bidx, M, calls };
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
    if (['ret','retn','jmpind'].includes(last.mnem)) return [];
    return [idx(next)];
  };
  // reverse postorder from entry (entry is address-order block 0)
  const An = a0.blocks.length; const order = []; const vis = new Uint8Array(An);
  (function dfs(u) { vis[u] = 1;
    for (const v of succAddrIdx(u)) if (v >= 0 && !vis[v]) dfs(v);
    order.push(u);
  })(0);
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
  let hasDeopt = false;
  for (let i=0;i<N;i++) {
    const insns = blocks[i].insns, last = insns[insns.length-1], next = last.next;
    if (last.mnem === 'jcc') { const t = idxOf((next+last.rel)&MM), f = idxOf(next); term.push({kind:'jcc', t, f}); succs.push([t, f]); }
    else if (last.mnem === 'jmp') { const t = idxOf((next+last.rel)&MM); term.push({kind:'jmp', t}); succs.push([t]); }
    else if (last.mnem === 'ret' || last.mnem === 'retn') { term.push({kind:'ret', pad: last.mnem==='retn' ? Number(last.n) : 0}); succs.push([]); }
    else if (last.mnem === 'jmpind') { hasDeopt = true; term.push({kind:'deopt', src:last.src}); succs.push([]); }
    else if (last.mnem === 'udec')   { hasDeopt = true; term.push({kind:'deopt', src:null, at:last.rip}); succs.push([]); }
    else { const t = idxOf(next); term.push({kind:'fall', t}); succs.push([t]); }
  }
  const { open, closeAfter } = structure(N, succs);

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
      if ((op.size||8) === 8 || op.high) any64[op.r] = true; else if (isWrite) w32[op.r] = true; }
    if (op.kind === 'mem') { if (op.base>=0) { seenR[op.base]=true; any64[op.base]=true; } if (op.index>=0) { seenR[op.index]=true; any64[op.index]=true; } } };
  const WRITES_DST = new Set(['mov','movzx','movsx','add','sub','and','or','xor','inc','dec','not','neg','shl','shr','sar','rol','ror','cmov','setcc','imul2','imul3','xchg']);
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
      case 'cwde': case 'cdq': { const r = insn.mnem==='cdq' ? 2 : 0; seenR[0]=true; seenR[r]=true;
        if (S===8) { any64[0]=true; any64[r]=true; } else w32[r]=true; break; }
      default:
        noteRW(insn.dst, WRITES_DST.has(insn.mnem)); noteRW(insn.src, false); noteRW(insn.src2, false);
    }
  }
  if (hasDeopt) any64.fill(true);
  const isI32 = (r) => seenR[r] && !any64[r] && w32[r];
  const pushed = new Set();
  for (const b of blocks) for (const insn of b.insns) {
    if (insn.mnem === 'push' && insn.src && insn.src.kind === 'reg') pushed.add(insn.src.r);
    if (insn.mnem === 'pop' && insn.dst && insn.dst.kind === 'reg') pushed.add(insn.dst.r);
  }
  const savedI32 = (r) => isI32(r) && pushed.has(r);   // callee-saved, 32-bit working

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
  const spillAll  = () => Array.from({length:16},(_,r)=>touched(r)?spillR(r):null).filter(Boolean);
  const reloadAll = () => Array.from({length:16},(_,r)=>touched(r)?reloadR(r):null).filter(Boolean);
  // Exit spill: savedI32 regs' slots were just refreshed by their epilogue
  // pops (full 64-bit caller values) — do not clobber them with the truncated
  // working value.
  const spillExit = () => Array.from({length:16},(_,r)=>(touched(r)&&!savedI32(r))?spillR(r):null).filter(Boolean);

  // ---- operand / instruction emit (identical semantics to the dispatch version) ----
  const hexs = (v) => BigInt.asIntN(64, v).toString();
  let tmpN = 0; const tmps = new Set();
  const T = () => { const n = '$t' + (tmpN++); tmps.add(n); return n; };
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
  const wasmAddr = (op, next) => {
    if (op.ripRel) return `(i32.const ${Number(BigInt.asIntN(32, next + op.disp + woff))})`;
    const k = Number(BigInt.asIntN(32, op.disp + woff));
    let e = op.base >= 0 ? `(i32.wrap_i64 (local.get ${reg(op.base)}))` : `(i32.const 0)`;
    if (op.index >= 0) { let ix = `(i32.wrap_i64 (local.get ${reg(op.index)}))`;
      if (op.scale > 1) ix = `(i32.shl ${ix} (i32.const ${Math.log2(op.scale)}))`;
      e = `(i32.add ${e} ${ix})`; }
    return k === 0 ? e : `(i32.add ${e} (i32.const ${k}))`;
  };
  const LD = { 1:'i64.load8_u', 2:'i64.load16_u', 4:'i64.load32_u', 8:'i64.load' };
  const LD_S = { 1:'i64.load8_s', 2:'i64.load16_s', 4:'i64.load32_s' };
  const ST = { 1:'i64.store8', 2:'i64.store16', 4:'i64.store32', 8:'i64.store' };
  const rd = (op, size, next) => {
    if (op.kind === 'imm') return `(i64.const ${hexs(op.v)})`;
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

  const FLAGSET = new Set(['add','sub','and','or','xor','inc','dec','cmp','test','neg']);
  function emitBlock(i) {
    const blk = blocks[i]; const L = [];
    // A flag write is live only if some later consumer reads it before it is
    // overwritten. Consumers are the terminating jcc and any mid-block cmov/setcc;
    // each consumes the nearest preceding flag-setter. Everything else is dead.
    const producers = new Set();
    const nearestProd = (from) => { for (let k = from; k >= 0; k--) if (FLAGSET.has(blk.insns[k].mnem)) return k; return -1; };
    for (let j = 0; j < blk.insns.length; j++)
      if (blk.insns[j].mnem === 'cmov' || blk.insns[j].mnem === 'setcc') { const p = nearestProd(j - 1); if (p >= 0) producers.add(p); }
    if (term[i].kind === 'jcc') { const p = nearestProd(blk.insns.length - 1); if (p >= 0) producers.add(p); }
    let flagState = null, ii = 0;
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
      if (fs.kind === 'sub') switch (cc) {
        case 'e':return zf; case 'ne':return nz;
        case 'b':return `(i64.lt_u ${a} ${b})`; case 'ae':return `(i64.ge_u ${a} ${b})`;
        case 'be':return `(i64.le_u ${a} ${b})`; case 'a':return `(i64.gt_u ${a} ${b})`;
        case 'l':return `(i64.lt_s ${sx(a,S)} ${sx(b,S)})`; case 'ge':return `(i64.ge_s ${sx(a,S)} ${sx(b,S)})`;
        case 'le':return `(i64.le_s ${sx(a,S)} ${sx(b,S)})`; case 'g':return `(i64.gt_s ${sx(a,S)} ${sx(b,S)})`;
        case 's':return sf; case 'ns':return nsf; }
      else switch (cc) {
        case 'e':return zf; case 'ne':return nz; case 's':return sf; case 'ns':return nsf;
        case 'le':return `(i64.le_s ${sx(r,S)} (i64.const 0))`; case 'g':return `(i64.gt_s ${sx(r,S)} (i64.const 0))`;
        case 'l':return `(i64.lt_s ${sx(r,S)} (i64.const 0))`; case 'ge':return `(i64.ge_s ${sx(r,S)} (i64.const 0))`; }
      throw new Error('cond '+cc+'/'+fs.kind);
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
        case 'lea': L.push(`(local.set ${reg(insn.dst.r)} ${guestAddr(insn.src,next)})`); break;
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          const prod = (producers.has(ii));
          // sub/cmp flags need the ORIGINAL operands: capture before writing dst
          if (prod && insn.mnem === 'sub') { L.push(`(local.set $fa ${rd(insn.dst,S,next)})`, `(local.set $fb ${rd(insn.src,S,next)})`); }
          let expr;
          let i32expr = null;
          if (S === 4 && insn.dst.kind === 'reg') { i32expr = `(${ALU32[insn.mnem]} ${rd32(insn.dst,next)} ${rd32(insn.src,next)})`; expr = `(i64.extend_i32_u ${i32expr})`; }
          else if (S === 8) expr = `(${ALU[insn.mnem]} ${rd(insn.dst,8,next)} ${rd(insn.src,8,next)})`;
          else expr = `(i64.and (${ALU[insn.mnem]} ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)}) (i64.const ${m}))`;
          if (insn.dst.kind === 'reg') {
            L.push(i32expr && isI32(insn.dst.r) ? `(local.set ${reg(insn.dst.r)} ${i32expr})` : `(local.set ${reg(insn.dst.r)} ${expr})`);
            if (prod) { L.push(`(local.set $fr ${rd(insn.dst,S,next)})`); flagState = { kind: insn.mnem==='sub'?'sub':'logic', size: S }; }
          } else { const t=T(); L.push(`(local.set ${t} ${expr})`); L.push(wr(insn.dst,S,`(local.get ${t})`,next));
            if (prod) { L.push(`(local.set $fr (local.get ${t}))`); flagState = { kind: insn.mnem==='sub'?'sub':'logic', size: S }; } }
          break; }
        case 'cmp': setFlags('sub',S,rd(insn.dst,S,next),rd(insn.src,S,next),`(i64.and (i64.sub ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)}) (i64.const ${m}))`); break;
        case 'test': setFlags('logic',S,null,null,`(i64.and ${rd(insn.dst,S,next)} ${rd(insn.src,S,next)})`); break;
        case 'inc': case 'dec': {
          const prod = (producers.has(ii));
          let expr;
          let i32e = null;
          if (S === 4 && insn.dst.kind === 'reg') { i32e = `(${insn.mnem==='inc'?'i32.add':'i32.sub'} ${rd32(insn.dst,next)} (i32.const 1))`; expr = `(i64.extend_i32_u ${i32e})`; }
          else expr = `(i64.and (${insn.mnem==='inc'?'i64.add':'i64.sub'} ${rd(insn.dst,S,next)} (i64.const 1)) (i64.const ${m}))`;
          if (insn.dst.kind === 'reg') { L.push(i32e && isI32(insn.dst.r) ? `(local.set ${reg(insn.dst.r)} ${i32e})` : `(local.set ${reg(insn.dst.r)} ${expr})`);
            if (prod) { L.push(`(local.set $fr ${rd(insn.dst,S,next)})`); flagState = { kind: insn.mnem, size: S }; } }
          else { const t=T(); L.push(`(local.set ${t} ${expr})`); L.push(wr(insn.dst,S,`(local.get ${t})`,next));
            if (prod) { L.push(`(local.set $fr (local.get ${t}))`); flagState = { kind: insn.mnem, size: S }; } }
          break; }
        case 'not': L.push(wr(insn.dst,S,`(i64.xor ${rd(insn.dst,S,next)} (i64.const ${m}))`,next)); break;
        case 'neg': { const t=T(); L.push(`(local.set ${t} (i64.and (i64.sub (i64.const 0) ${rd(insn.dst,S,next)}) (i64.const ${m})))`);
          L.push(wr(insn.dst,S,`(local.get ${t})`,next)); setFlags('sub',S,'(i64.const 0)',rd(insn.dst,S,next),`(local.get ${t})`); break; }
        case 'shl': case 'shr': case 'sar': {
          if (S === 4 && insn.dst.kind === 'reg') {
            const c=`(i32.and ${rd32(insn.src,next)} (i32.const 31))`; const a=rd32(insn.dst,next); let e;
            if (insn.mnem==='shl') e=`(i32.shl ${a} ${c})`; else if (insn.mnem==='shr') e=`(i32.shr_u ${a} ${c})`; else e=`(i32.shr_s ${a} ${c})`;
            L.push(wr32reg(insn.dst.r, e)); break;
          }
          const c=`(i64.and ${rd(insn.src,1,next)} (i64.const ${S===8?63:31}))`; const a=rd(insn.dst,S,next); let e;
          if (insn.mnem==='shl') e=`(i64.shl ${a} ${c})`; else if (insn.mnem==='shr') e=`(i64.shr_u ${a} ${c})`; else e=`(i64.shr_s ${sx(a,S)} ${c})`;
          L.push(wr(insn.dst,S,`(i64.and ${e} (i64.const ${m}))`,next)); break; }
        case 'rol': case 'ror': {
          const c=`(i32.and ${rd32(insn.src,next)} (i32.const ${S===8?63:31}))`;
          if (S===8) { const a=rd(insn.dst,8,next);
            L.push(`(local.set ${reg(insn.dst.r)} (i64.${insn.mnem==='rol'?'rotl':'rotr'} ${a} (i64.extend_i32_u ${c})))`); }
          else if (insn.dst.kind === 'reg') L.push(wr32reg(insn.dst.r, `(i32.${insn.mnem==='rol'?'rotl':'rotr'} ${rd32(insn.dst,next)} ${c})`));
          else L.push(wr(insn.dst,S,`(i64.and (i64.extend_i32_u (i32.${insn.mnem==='rol'?'rotl':'rotr'} ${rd32(insn.dst,next)} ${c})) (i64.const ${m}))`,next));
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
          // one-operand widening multiply: rdx:rax = rax * src. Handle widths <= 4 via i64.
          if (S > 4) throw new Error('AOT: 128-bit '+insn.mnem+' @ '+insn.rip.toString(16));
          const ext = insn.mnem === 'imul1' ? 'i64.extend_i32_s' : 'i64.extend_i32_u';
          const a = `(${ext} ${rd32({kind:'reg',r:0,size:S},next)})`;
          const b = `(${ext} ${rd32(insn.src,next)})`;
          const t = T(); L.push(`(local.set ${t} (i64.mul ${a} ${b}))`);
          L.push(wr32reg(0, `(i32.wrap_i64 ${andmask(`(local.get ${t})`,S)})`));       // rax = low
          L.push(wr32reg(2, `(i32.wrap_i64 (i64.shr_u (local.get ${t}) (i64.const ${S*8})))`)); // rdx = high
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
            // 128-bit dividend: only the compiler's own zero/sign-extended
            // patterns are translatable — rdx zeroed right before (div) or
            // cqo right before (idiv). Anything else deopts the function.
            const prev = ii > 0 ? blk.insns[ii-1] : null;
            const zeroed = prev && prev.mnem === 'xor' && prev.dst?.kind==='reg' && prev.dst.r===2 && prev.src?.kind==='reg' && prev.src.r===2;
            const cqo = prev && prev.mnem === 'cdq' && (prev.size||8) === 8;
            if (!sgn && !zeroed) throw new Error('AOT: unpatterned 64-bit div @ '+insn.rip.toString(16));
            if (sgn && !cqo) throw new Error('AOT: unpatterned 64-bit idiv @ '+insn.rip.toString(16));
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
        case 'leave':    // mov rsp,rbp ; pop rbp
          L.push(`(local.set $r4 ${rd({kind:'reg',r:5,size:8},8,next)})`);
          if (savedI32(5)) L.push(`(i64.store (i32.const 40) (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)}))`);
          else L.push(wr({kind:'reg',r:5,size:8},8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next));
          L.push(`(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          break;
        case 'call': {   // push return address, spill, direct wasm call (or callout), reload
          const target = (next + insn.rel) & MM;
          L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (i64.const ${hexs(next)}))`);
          L.push(...spillAll());
          L.push(canDirect(target.toString()) ? `(drop (call $f_${target.toString(16)}))`
                                              : `(drop (call $x_callout (i64.const ${hexs(target)})))`);
          L.push(...reloadAll());
          break; }
        case 'callind': {   // compute target BEFORE the push moves rsp
          const t = T(); L.push(`(local.set ${t} ${rd(insn.src,8,next)})`);
          L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,
                 `(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} (i64.const ${hexs(next)}))`);
          L.push(...spillAll());
          L.push(`(drop (call $x_callout (local.get ${t})))`);
          L.push(...reloadAll());
          break; }
        case 'syscall':
          L.push(...spillAll(), `(call $x_syscall)`, ...reloadAll());
          break;
        case 'push': {
          // A callee-saved i32-working register keeps only its low 32 bits in its local;
          // its full 64-bit caller value still lives in the register file at prologue time,
          // so read it from there to round-trip the upper 32 bits through the stack.
          const srcExpr = (insn.src.kind === 'reg' && savedI32(insn.src.r))
            ? `(i64.load (i32.const ${insn.src.r*8}))` : rd(insn.src,8,next);
          L.push(`(local.set $r4 (i64.sub (local.get $r4) (i64.const 8)))`,`(i64.store ${wasmAddr({base:4,index:-1,disp:0n},next)} ${srcExpr})`); break; }
        case 'pop': {
          if (insn.dst.kind === 'reg' && savedI32(insn.dst.r))
            L.push(`(i64.store (i32.const ${insn.dst.r*8}) (i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)}))`, `(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          else
            L.push(wr(insn.dst,8,`(i64.load ${wasmAddr({base:4,index:-1,disp:0n},next)})`,next),`(local.set $r4 (i64.add (local.get $r4) (i64.const 8)))`);
          break; }
        case 'jmp': case 'jcc': case 'ret': case 'retn': case 'jmpind': case 'udec': break;  // terminator handled below
        default: throw new Error('AOT: unhandled '+insn.mnem+' @ '+insn.rip.toString(16));
      }
    }
    // terminator as label-based branches (RPO indices)
    const t = term[i];
    const last = blk.insns[blk.insns.length-1], lnext = last.next;
    const labelFor = (j) => j <= i ? '$loop_'+j : '$blk_'+j;
    const brTo = (j) => { if (j < 0) throw new Error('AOT: branch into undecoded code'); return j === i+1 ? '' : `(br ${labelFor(j)})`; };
    if (t.kind === 'jcc') {
      const c = cond(last.cond);
      const lbl = (j) => { if (j < 0) throw new Error('AOT: jcc into undecoded code'); return labelFor(j); };
      const T = t.t, F = t.f;
      if (T === i+1 && F === i+1) { /* both fall through */ }
      else if (T !== i+1 && F === i+1) L.push(`(br_if ${lbl(T)} ${c})`);
      else if (T === i+1 && F !== i+1) L.push(`(br_if ${lbl(F)} (i32.eqz ${c}))`);
      else { L.push(`(br_if ${lbl(T)} ${c})`); L.push(`(br ${lbl(F)})`); }
    } else if (t.kind === 'jmp') {
      const b = brTo(t.t); if (b) L.push(b);
    } else if (t.kind === 'ret') {
      // pop the return address, retire the frame, hand the exit rip back
      L.push(`(local.set $rex (i64.load ${wasmAddr({base:4,index:-1,disp:0n},lnext)}))`);
      L.push(`(local.set $r4 (i64.add (local.get $r4) (i64.const ${8 + t.pad})))`);
      L.push(...spillExit());
      L.push(`(return (local.get $rex))`);
    } else if (t.kind === 'deopt') {
      // indirect jump (jump table / tail call) or undecodable byte:
      // hand the frame to the engine at the computed target / that rip
      L.push(`(local.set $rex ${t.src ? rd(t.src,8,lnext) : `(i64.const ${hexs(t.at)})`})`);
      L.push(...spillAll());
      L.push(`(return (call $x_deopt (local.get $rex) (local.get $rsp0)))`);
    } else { const b = brTo(t.t); if (b) L.push(b); }
    return L.join('\n      ');
  }

  const bodies = []; for (let i=0;i<N;i++) bodies.push(emitBlock(i));

  const name = 'f_' + fnAddr.toString(16);
  let wat = `  (func $${name} (export "${name}") (result i64)\n`;
  for (let r=0;r<16;r++) wat += `    (local $r${r} ${isI32(r)?'i32':'i64'})\n`;
  wat += '    (local $fa i64) (local $fb i64) (local $fr i64) (local $rsp0 i64) (local $rex i64)\n';
  for (const t of tmps) wat += `    (local ${t} i64)\n`;
  for (let r=0;r<16;r++) if (touched(r)) wat += '    ' + reloadR(r) + '\n';
  wat += '    (local.set $rsp0 (local.get $r4))\n';
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
      const an = analyze(mem, a, { maxInsns });
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
  wat += '  (import "env" "syscall" (func $x_syscall))\n';
  wat += '  (import "env" "callout" (func $x_callout (param i64) (result i64)))\n';
  wat += '  (import "env" "deopt" (func $x_deopt (param i64 i64) (result i64)))\n';
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
