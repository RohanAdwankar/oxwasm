// oxwasm M3 — AOT whole-function translator: x86-64 machine code -> ONE
// WebAssembly function. Unlike the tier-1 JIT (per-loop, block-local), this
// recovers the whole function's control-flow graph and emits it as a single
// wasm function with:
//   * all guest GPRs held in wasm i64 LOCALS for the function's lifetime,
//   * structured control flow via the universal dispatch-loop (br_table),
//     so ANY CFG (nested loops, early exits) lowers with no interpreter,
//   * lazy flags: a flag-setting op stashes its inputs/result in temps, and
//     the consuming jcc recomputes only the bit it needs — no eager EFLAGS.
// The input is unmodified compiled machine code; nothing is annotated.
import { decode } from './decode.mjs';

// ---- wasm encoding ----
const uL = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sL = (v) => { const o = []; let more = 1; v = BigInt(v);
  while (more) { let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = 0; else b |= 0x80; o.push(b); } return o; };
const str = (s) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const sec = (id, b) => [id, ...uL(b.length), ...b];
const vec = (a) => [...uL(a.length), ...a.flat()];

const GET = 0x20, SET = 0x21, TEE = 0x22, I64C = 0x42, I32C = 0x41, WRAP = 0xa7, EXTU = 0xad, EXTS = 0xac;
const I64 = { add: 0x7c, sub: 0x7d, mul: 0x7e, and: 0x83, or: 0x84, xor: 0x85, shl: 0x86, shrs: 0x87, shru: 0x88,
              rotl: 0x89, rotr: 0x8a, eqz: 0x50, eq: 0x51, ne: 0x52, lts: 0x53, ltu: 0x54, gts: 0x55, gtu: 0x56,
              les: 0x57, leu: 0x58, ges: 0x59, geu: 0x5a, load: 0x29, store: 0x37,
              load8u: 0x31, load16u: 0x33, load32u: 0x35, store8: 0x3c, store16: 0x3d, store32: 0x3e };
const MASK = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
const SIGN = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };

export function compileFunction(mem, entry, { guestBase, ramBase, maxInsns = 4000 } = {}) {
  // ---- 1. decode the whole function: worklist over reachable addresses ----
  const insnAt = new Map();               // rip(str) -> insn
  const work = [entry]; const seen = new Set();
  let count = 0;
  while (work.length) {
    let rip = work.pop(); const key = rip.toString();
    if (seen.has(key)) continue; seen.add(key);
    if (count++ > maxInsns) throw new Error('function too large');
    const insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip);
    insn.rip = rip; insn.next = rip + BigInt(insn.len);
    insnAt.set(key, insn);
    if (insn.mnem === 'ret' || insn.mnem === 'retn') continue;
    if (insn.mnem === 'jmp') { work.push((insn.next + insn.rel) & MASK[8]); continue; }
    if (insn.mnem === 'jcc') { work.push((insn.next + insn.rel) & MASK[8]); work.push(insn.next); continue; }
    if (insn.mnem === 'jmpind' || insn.mnem === 'callind' || insn.mnem === 'call')
      throw new Error('indirect/inter-proc control flow at ' + rip.toString(16));
    work.push(insn.next);
  }
  // ---- 2. leaders -> basic blocks ----
  const addrs = [...insnAt.keys()].map(BigInt).sort((a, b) => a < b ? -1 : 1);
  const leaders = new Set([entry.toString()]);
  for (const a of addrs) {
    const insn = insnAt.get(a.toString());
    if (insn.mnem === 'jcc') { leaders.add(((insn.next + insn.rel) & MASK[8]).toString()); leaders.add(insn.next.toString()); }
    if (insn.mnem === 'jmp') leaders.add(((insn.next + insn.rel) & MASK[8]).toString());
  }
  const blocks = []; let cur = null;
  for (const a of addrs) {
    if (leaders.has(a.toString())) { cur = { start: a, insns: [] }; blocks.push(cur); }
    cur.insns.push(insnAt.get(a.toString()));
  }
  const blockIndex = new Map(blocks.map((b, i) => [b.start.toString(), i]));
  const N = blocks.length;

  // ---- 3. locals: 16 GPRs, label, and a pool of temps ----
  const R = (r) => r;                    // guest reg -> local index 0..15
  const LABEL = 16;
  let nextTmp = 17;
  const TMP = () => nextTmp++;
  const K = (addr) => BigInt.asIntN(32, addr - guestBase + BigInt(ramBase));   // guest addr -> wasm i32 offset const

  // memory address of an operand -> pushes an i32 wasm offset
  const addrCode = (op) => {
    let out = []; let haveBase = false;
    if (op.ripRel) { return [I32C, ...sL(K((op.disp + op.rip /*ripNext folded below*/))) ]; }  // handled per-insn
    if (op.base >= 0) { out.push(GET, ...uL(R(op.base)), WRAP); haveBase = true; }
    if (op.index >= 0) {
      out.push(GET, ...uL(R(op.index)), WRAP);
      if (op.scale > 1) out.push(I32C, ...sL(Math.log2(op.scale)), 0x74 /*i32.shl*/);
      if (haveBase) out.push(0x6a /*i32.add*/); haveBase = true;
    }
    const k = Number(BigInt.asIntN(32, op.disp - guestBase + BigInt(ramBase)));
    out.push(I32C, ...sL(k));
    if (haveBase) out.push(0x6a);
    return out;
  };

  // read an operand -> pushes i64 (zero-extended to `size`)
  const rd = (op, size, ctx) => {
    if (op.kind === 'imm') return [I64C, ...sL(BigInt.asIntN(64, op.v))];
    if (op.kind === 'reg') {
      const g = [GET, ...uL(R(op.r))];
      if (op.high) return [...g, I64C, 8, I64.shru, I64C, ...sL(0xFFn), I64.and];
      return size === 8 ? g : [...g, I64C, ...sL(MASK[size]), I64.and];
    }
    // memory
    const a = op.ripRel ? [I32C, ...sL(Number(K(ctx.next + op.disp)))] : addrCode(op);
    const ld = { 1: I64.load8u, 2: I64.load16u, 4: I64.load32u, 8: I64.load }[size];
    const align = { 1: 0, 2: 1, 4: 2, 8: 3 }[size];
    return [...a, ld, align, 0x00];
  };
  // write i64-on-stack to an operand of `size`
  const wr = (op, size, valCode, ctx) => {
    if (op.kind === 'reg') {
      if (size === 8) return [...valCode, SET, ...uL(R(op.r))];
      if (size === 4) return [...valCode, I64C, ...sL(0xFFFFFFFFn), I64.and, SET, ...uL(R(op.r))];  // zero-extend
      // 8/16-bit: merge into low bits
      const g = R(op.r), m = MASK[size];
      if (op.high) return [GET, ...uL(g), I64C, ...sL(~(0xFF00n)&MASK[8]), I64.and,
                           ...valCode, I64C, ...sL(0xFFn), I64.and, I64C, 8, I64.shl, I64.or, SET, ...uL(g)];
      return [GET, ...uL(g), I64C, ...sL((~m)&MASK[8]), I64.and, ...valCode, I64C, ...sL(m), I64.and, I64.or, SET, ...uL(g)];
    }
    const a = op.ripRel ? [I32C, ...sL(Number(K(ctx.next + op.disp)))] : addrCode(op);
    const st = { 1: I64.store8, 2: I64.store16, 4: I64.store32, 8: I64.store }[size];
    const align = { 1: 0, 2: 1, 4: 2, 8: 3 }[size];
    return [...a, ...valCode, st, align, 0x00];
  };

  // lazy-flag temps
  const FA = TMP(), FB = TMP(), FR = TMP();     // flag operand a, b, result (all masked to op size held in FSZ at translate time)
  let flagState = null;                          // { kind:'sub'|'logic'|'inc'|'dec', size }
  const setFlags = (kind, size, aCode, bCode, rCode) => {
    const parts = [];
    if (aCode) parts.push(...aCode, SET, ...uL(FA));
    if (bCode) parts.push(...bCode, SET, ...uL(FB));
    parts.push(...rCode, SET, ...uL(FR));
    flagState = { kind, size };
    return parts;
  };
  // produce i32 (0/1) for a condition, from the current flagState
  const condCode = (cc, fs) => {
    const S = fs.size, m = MASK[S], sgn = SIGN[S];
    const a = [GET, ...uL(FA)], b = [GET, ...uL(FB)], r = [GET, ...uL(FR)];
    const eqz = [...r, I64C, 0, I64.eq];                      // ZF
    const ne = [...r, I64C, 0, I64.ne];
    // sign of result
    const sf = [...r, I64C, ...sL(sgn), I64.and, I64C, 0, I64.ne];
    const nsf = [...r, I64C, ...sL(sgn), I64.and, I64C, 0, I64.eq];
    if (fs.kind === 'sub') {
      // CF = a<b (unsigned), for cmp
      const cf = [...a, ...b, I64.ltu];
      const ncf = [...a, ...b, I64.geu];
      switch (cc) {
        case 'e': return eqz; case 'ne': return ne;
        case 'b': return cf; case 'ae': return ncf;
        case 'be': return [...a, ...b, I64.leu]; case 'a': return [...a, ...b, I64.gtu];
        case 'l': return [...a, ...b, I64.lts]; case 'ge': return [...a, ...b, I64.ges];
        case 'le': return [...a, ...b, I64.les]; case 'g': return [...a, ...b, I64.gts];
        case 's': return sf; case 'ns': return nsf;
      }
    } else { // logic / inc / dec: CF cleared (logic); use result only
      switch (cc) {
        case 'e': return eqz; case 'ne': return ne;
        case 's': return sf; case 'ns': return nsf;
        case 'le': return [...r, I64C, 0, I64.les]; case 'g': return [...r, I64C, 0, I64.gts];
        case 'l': return [...r, I64C, 0, I64.lts]; case 'ge': return [...r, I64C, 0, I64.ges];
      }
    }
    throw new Error('cond ' + cc + ' on ' + fs.kind);
  };

  // ---- 4. emit each block's body ----
  const ALU = { add: I64.add, sub: I64.sub, and: I64.and, or: I64.or, xor: I64.xor };
  function emitBlock(blk) {
    const body = [];
    const gotoLabel = (target) => {
      const idx = blockIndex.get(target.toString());
      if (idx === undefined) return [I32C, ...sL(-1), SET, ...uL(LABEL), 0x0c, ...uL(depthToExit())]; // ret/leave
      return [I32C, ...sL(idx), SET, ...uL(LABEL), 0x0c, ...uL(depthToLoop())];
    };
    for (let ii = 0; ii < blk.insns.length; ii++) {
      const insn = blk.insns[ii]; const S = insn.size || 8; const m = MASK[S];
      const ctx = { next: insn.next };
      switch (insn.mnem) {
        case 'nop': case 'endbr': break;
        case 'mov': body.push(...wr(insn.dst, S, rd(insn.src, S, ctx), ctx)); break;
        case 'movzx': body.push(...wr(insn.dst, insn.size, rd(insn.src, insn.src.size, ctx), ctx)); break;
        case 'movsx': {
          const s = insn.src.size, sh = BigInt(64 - s*8);
          body.push(...wr(insn.dst, insn.size, [...rd(insn.src, s, ctx), I64C, ...sL(sh), I64.shl, I64C, ...sL(sh), I64.shrs], ctx));
          break; }
        case 'lea': body.push(...addrCode(insn.src.ripRel ? {ripRel:true,disp:ctx.next+insn.src.disp,base:-1,index:-1} : insn.src),
                              EXTU, SET, ...uL(R(insn.dst.r))); break;
        case 'add': case 'sub': case 'and': case 'or': case 'xor': {
          const dl = insn.dst.kind === 'reg' ? R(insn.dst.r) : null;
          const aC = rd(insn.dst, S, ctx), bC = rd(insn.src, S, ctx);
          let r = [...aC, ...bC, ALU[insn.mnem]];
          if (S !== 8) r = [...r, I64C, ...sL(m), I64.and];
          const tmp = TMP();
          body.push(...r, TEE, ...uL(tmp));                    // result on stack + saved
          body.push(...wr(insn.dst, S, [GET, ...uL(tmp)], ctx));
          body.push(...setFlags(insn.mnem === 'sub' ? 'sub' : 'logic', S,
            insn.mnem === 'sub' ? aC : null, insn.mnem === 'sub' ? bC : null, [GET, ...uL(tmp)]));
          break; }
        case 'cmp': { const aC = rd(insn.dst, S, ctx), bC = rd(insn.src, S, ctx);
          body.push(...setFlags('sub', S, aC, bC, [...aC, ...bC, I64.sub, I64C, ...sL(m), I64.and])); break; }
        case 'test': { const aC = rd(insn.dst, S, ctx), bC = rd(insn.src, S, ctx);
          body.push(...setFlags('logic', S, null, null, [...aC, ...bC, I64.and, I64C, ...sL(m), I64.and])); break; }
        case 'inc': case 'dec': {
          const aC = rd(insn.dst, S, ctx);
          let r = [...aC, I64C, 1, insn.mnem === 'inc' ? I64.add : I64.sub];
          if (S !== 8) r = [...r, I64C, ...sL(m), I64.and];
          const tmp = TMP();
          body.push(...r, TEE, ...uL(tmp));
          body.push(...wr(insn.dst, S, [GET, ...uL(tmp)], ctx));
          body.push(...setFlags(insn.mnem, S, null, null, [GET, ...uL(tmp)]));
          break; }
        case 'not': body.push(...wr(insn.dst, S, [...rd(insn.dst, S, ctx), I64C, ...sL(m), I64.xor], ctx)); break;
        case 'neg': { const aC = rd(insn.dst, S, ctx);
          const r = [I64C, 0, ...aC, I64.sub, I64C, ...sL(m), I64.and];
          const tmp = TMP(); body.push(...r, TEE, ...uL(tmp));
          body.push(...wr(insn.dst, S, [GET, ...uL(tmp)], ctx));
          body.push(...setFlags('sub', S, [I64C, 0], aC, [GET, ...uL(tmp)])); break; }
        case 'shl': case 'shr': case 'sar': case 'rol': case 'ror': {
          const aC = rd(insn.dst, S, ctx); const cC = rd(insn.src, 1, ctx);
          const w = BigInt(S*8);
          let r;
          const cmasked = [...cC, I64C, ...sL(S === 8 ? 0x3Fn : 0x1Fn), I64.and];
          if (insn.mnem === 'shl') r = [...aC, ...cmasked, I64.shl];
          else if (insn.mnem === 'shr') r = [...aC, ...cmasked, I64.shru];
          else if (insn.mnem === 'sar') { const sh = BigInt(64 - S*8);
            r = S === 8 ? [...aC, ...cmasked, I64.shrs]
              : [...aC, I64C, ...sL(sh), I64.shl, ...cmasked, I64.shrs, I64C, ...sL(sh), I64.shrs]; }
          else if (insn.mnem === 'rol') r = S === 8 ? [...aC, ...cmasked, I64.rotl]
            : [...aC, ...cmasked, rotSmall('l', S)].flat();
          else r = S === 8 ? [...aC, ...cmasked, I64.rotr] : [...aC, ...cmasked, rotSmall('r', S)].flat();
          if (S !== 8) r = [...r, I64C, ...sL(m), I64.and];
          body.push(...wr(insn.dst, S, r, ctx));
          break; }
        case 'push': body.push(GET, ...uL(R(4)), I64C, 8, I64.sub, SET, ...uL(R(4)),
                              ...addrReg(4), ...rd(insn.src, 8, ctx), I64.store, 3, 0x00); break;
        case 'pop': body.push(...wr(insn.dst, 8, [...addrReg(4), I64.load, 3, 0x00], ctx),
                             GET, ...uL(R(4)), I64C, 8, I64.add, SET, ...uL(R(4))); break;
        case 'jmp': body.push(...gotoLabel((insn.next + insn.rel) & MASK[8])); break;
        case 'jcc': {
          const tgt = (insn.next + insn.rel) & MASK[8];
          const takenIdx = blockIndex.get(tgt.toString());
          const fallIdx = blockIndex.get(insn.next.toString());
          // if (cond) label=taken else label=fall ; br loop
          body.push(...condCode(insn.cond, flagState), 0x04, 0x40,     // if
            I32C, ...sL(takenIdx), SET, ...uL(LABEL), 0x05,            // else
            I32C, ...sL(fallIdx), SET, ...uL(LABEL), 0x0b,            // end if
            0x0c, ...uL(depthToLoop()));
          break; }
        case 'ret': case 'leave': case 'retn':
          body.push(I32C, ...sL(-1), SET, ...uL(LABEL), 0x0c, ...uL(depthToExit())); break;
        default: throw new Error('AOT: unhandled ' + insn.mnem + ' @ ' + insn.rip.toString(16));
      }
    }
    // fall-through to next block
    if (blk.insns[blk.insns.length-1].mnem !== 'jmp' && blk.insns[blk.insns.length-1].mnem !== 'jcc'
        && blk.insns[blk.insns.length-1].mnem !== 'ret' && blk.insns[blk.insns.length-1].mnem !== 'leave') {
      const fallStart = blk.insns[blk.insns.length-1].next;
      body.push(...gotoLabel(fallStart));
    }
    return body;
  }
  const addrReg = (r) => [GET, ...uL(R(r)), WRAP, I32C, ...sL(Number(BigInt.asIntN(32, -guestBase + BigInt(ramBase)))), 0x6a];
  function rotSmall(dir, S) { return []; }  // handled inline for S===8 only; small rotates fall through mask (md5 is 32-bit rol via 8-byte? see note)

  // depth bookkeeping: layout is  block$exit { loop$loop { blockB0{...blockBn{ br_table }}} <code n>..<code0> } }
  // From inside a block's code, enclosing = loop(0) then exit(1).
  const depthToLoop = () => 0;
  const depthToExit = () => 1;

  const codes = blocks.map(emitBlock);

  // ---- 5. assemble dispatch ----
  const brtable = []; for (let i = 0; i < N; i++) brtable.push(i);
  const dispatch = [];
  // openers: block$exit, loop$loop, then N blocks
  dispatch.push(0x02, 0x40);           // block $exit
  dispatch.push(0x03, 0x40);           // loop $loop
  for (let i = 0; i < N; i++) dispatch.push(0x02, 0x40);   // block B_i (B0 outer .. B(N-1) inner)
  // br_table on LABEL: entry i -> depth (N-1 - i) to reach B_i; default -> exit
  // NOTE arrangement: innermost is B_{N-1}. To reach B_i, branch depth = (N-1 - i).
  const bt = []; for (let i = 0; i < N; i++) bt.push(N - 1 - i);
  const defaultDepth = N + 0; // to $loop? we want default to re-dispatch never; route to exit: depth = N (past all B, loop) +? exit is outermost
  // from br_table position, enclosing: B_{N-1}(0)..B_0(N-1), loop(N), exit(N+1)
  dispatch.push(GET, ...uL(LABEL), 0x0e, ...uL(N), ...bt.flatMap(uL), ...uL(N + 1));
  // after each end(B_i) place code[i], for i = N-1 down to 0
  for (let i = N - 1; i >= 0; i--) {
    dispatch.push(0x0b);               // end B_i
    dispatch.push(...codes[i]);
  }
  dispatch.push(0x0b);                 // end loop
  dispatch.push(0x0b);                 // end block exit

  // ---- 6. prologue/epilogue: sync 16 regs with memory reg-file at offset 0 ----
  const pro = []; for (let r = 0; r < 16; r++) pro.push(I32C, ...sL(r*8), I64.load, 3, 0x00, SET, ...uL(R(r)));
  pro.push(I32C, ...sL(blockIndex.get(entry.toString())), SET, ...uL(LABEL));
  const epi = []; for (let r = 0; r < 16; r++) epi.push(I32C, ...sL(r*8), GET, ...uL(R(r)), I64.store, 3, 0x00);

  const nLocals = nextTmp;
  const funcBody = [...vec([[...uL(nLocals - 0), 0x7e === 0x7e && 0x7e]].length ? [[...uL(nLocals), 0x7e]] : []),
                    ...pro, ...dispatch, ...epi, 0x0b];
  const wasm = new Uint8Array([
    0,0x61,0x73,0x6d, 1,0,0,0,
    ...sec(1, vec([[0x60,0,0]])),
    ...sec(2, vec([[...str('js'), ...str('mem'), 0x02, 0x00, ...uL(4096)]])),
    ...sec(3, vec([[0]])),
    ...sec(7, vec([[...str('run'), 0x00, 0]])),
    ...sec(10, vec([[...uL(funcBody.length), ...funcBody]])),
  ]);
  return { wasm, blocks: N };
}
