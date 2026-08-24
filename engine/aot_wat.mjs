// oxwasm M3 — AOT whole-function translator, x86-64 machine code -> WAT.
// Recovers the function CFG and emits ONE wasm function: all 16 GPRs in
// i64 locals for the function's lifetime, any control flow via the
// universal br_table dispatch loop, lazy flags (a flag op stashes inputs,
// the consuming jcc recomputes just the needed bit). Input is unmodified
// compiled machine code. Text backend, assembled by wat2wasm.
import { decode } from './decode.mjs';

const MASK = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
const SIGN = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };

export function compileFunctionWat(mem, entry, { guestBase, ramBase, maxInsns = 8000 } = {}) {
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
      if (size === 8) return `(local.set ${reg(op.r)} ${expr})`;
      if (size === 4) return `(local.set ${reg(op.r)} (i64.and ${expr} (i64.const 0xFFFFFFFF)))`;
      const m = MASK[size];
      if (op.high) return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~0xFF00n)&MASK[8]})) (i64.shl (i64.and ${expr} (i64.const 0xFF)) (i64.const 8))))`;
      return `(local.set ${reg(op.r)} (i64.or (i64.and (local.get ${reg(op.r)}) (i64.const ${(~m)&MASK[8]})) (i64.and ${expr} (i64.const ${m}))))`;
    }
    return `(${ST[size]} ${wasmAddr(op, next)} ${expr})`;
  };

  const ALU = { add:'i64.add', sub:'i64.sub', and:'i64.and', or:'i64.or', xor:'i64.xor' };
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
        case 'mov': L.push(wr(insn.dst, S, rd(insn.src, S, next), next)); break;
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
