// oxwasm M3 tier-1.5 — the superblock loop JIT (with memory).
//
// Compiles a counted loop into ONE wasm function: live guest registers held
// in wasm i64 LOCALS (loaded once at entry, stored once at exit), the loop
// body and its backward branch emitted inside a wasm `loop`. The JS<->WASM
// boundary is crossed once per loop, and registers never round-trip through
// linear memory inside the loop.
//
// Memory model. The wasm memory holds the 16-entry i64 register file at
// offset 0 (128 bytes), and guest RAM mapped so guest address G lands at
// wasm offset (G - guestBase + ramBase). Pixel loops — GIMP's hot path —
// are exactly load / process / store / bump-pointers / dec-counter / jnz.
//
// Body ops supported: reg/imm ALU (add/sub/and/or/xor), mov reg<->reg/imm,
// inc/dec, movzx, and mov to/from [reg+disp] at sizes 1/4/8. Loop control:
// last op is a backward jcc whose condition comes from the preceding
// flag-setting op's result. Anything else -> null (caller falls back).
import { decode } from './decode.mjs';

const uLEB = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sLEB = (v) => { const o = []; let more = 1; v = BigInt(v);
  while (more) { let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = 0; else b |= 0x80; o.push(b); } return o; };
const str = (s) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const section = (id, body) => [id, ...uLEB(body.length), ...body];
const vec = (items) => [...uLEB(items.length), ...items.flat()];

const I64_CONST=0x42, I32_CONST=0x41, LOCAL_GET=0x20, LOCAL_SET=0x21;
const I64_LOAD=0x29, I64_STORE=0x37, I64_LOAD8U=0x31, I64_LOAD16U=0x33, I64_LOAD32U=0x35;
const I64_STORE8=0x3c, I64_STORE16=0x3d, I64_STORE32=0x3e;
const I64_ADD=0x7c, I64_SUB=0x7d, I64_AND=0x83, I64_OR=0x84, I64_XOR=0x85, I64_MUL=0x7e;
const I32_ADD=0x6a, I32_WRAP=0xa7;
const I64_EQZ=0x50, I64_NE=0x52, I64_LT_S=0x53, I64_GT_S=0x55, I64_LE_S=0x57, I64_GE_S=0x59;
const ALUOP = { add: I64_ADD, sub: I64_SUB, and: I64_AND, or: I64_OR, xor: I64_XOR };
const LOADOP = { 1: I64_LOAD8U, 2: I64_LOAD16U, 4: I64_LOAD32U, 8: I64_LOAD };
const STOREOP = { 1: I64_STORE8, 2: I64_STORE16, 4: I64_STORE32, 8: I64_STORE };
const MASKLO = { 1: 0xFFFFFFFFFFFFFF00n, 2: 0xFFFFFFFFFFFF0000n, 4: 0n /*32-bit zero-extends*/, 8: 0n };
const ALIGN = { 1: 0x00, 2: 0x01, 4: 0x02, 8: 0x03 };

export function compileLoop(mem, ripStart, { guestBase = 0n, ramBase = 0, maxInsns = 512 } = {}) {
  const insns = [];
  let rip = ripStart, branch = null;
  for (let n = 0; n < maxInsns; n++) {
    let insn;
    try { insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip); } catch { return null; }
    insn.rip = rip; insn.next = rip + BigInt(insn.len);
    if (insn.mnem === 'jcc') { branch = insn; rip = insn.next; break; }
    if (!accepts(insn)) return null;
    insns.push(insn); rip = insn.next;
  }
  if (!branch) return null;
  const target = (branch.next + branch.rel) & 0xFFFFFFFFFFFFFFFFn;
  if (target < ripStart || target >= branch.rip) return null;

  // condition from the last flag-setting op (ALU / inc / dec)
  let flagOp = null;
  for (let i = insns.length - 1; i >= 0; i--) {
    const m = insns[i].mnem;
    if (ALUOP[m] || m === 'inc' || m === 'dec') { flagOp = insns[i]; break; }
  }
  if (!flagOp || flagOp.dst.kind !== 'reg') return null;
  const condReg = flagOp.dst.r;
  const CMP = { e: [I64_EQZ], ne: [I64_CONST, 0, I64_NE], l: [I64_CONST, 0, I64_LT_S],
                ge: [I64_CONST, 0, I64_GE_S], g: [I64_CONST, 0, I64_GT_S], le: [I64_CONST, 0, I64_LE_S] };
  if (!(branch.cond in CMP)) return null;

  // live register set (any reg touched as reg operand or mem base)
  const used = new Set();
  const touch = (op) => { if (!op) return; if (op.kind === 'reg') used.add(op.r);
    if (op.kind === 'mem') { if (op.base >= 0) used.add(op.base); if (op.index >= 0) used.add(op.index); } };
  for (const insn of insns) { touch(insn.dst); touch(insn.src); }
  const regs = [...used].sort((a, b) => a - b);
  const L = new Map(regs.map((r, i) => [r, i]));

  const body = [];
  for (const r of regs) body.push(I32_CONST, ...sLEB(r * 8), I64_LOAD, 0x03, 0x00, LOCAL_SET, ...uLEB(L.get(r)));
  body.push(0x03, 0x40);                        // loop void

  const K = (addrDisp) => BigInt.asIntN(32, BigInt(ramBase) - guestBase + addrDisp);
  const emitAddr = (m) => {                       // -> i32 wasm offset of [base(+disp)]
    const out = [LOCAL_GET, ...uLEB(L.get(m.base)), I32_WRAP, I32_CONST, ...sLEB(K(m.disp)), I32_ADD];
    return out;
  };
  const pushRegOrImm = (op) => op.kind === 'imm'
    ? [I64_CONST, ...sLEB(BigInt.asIntN(64, op.v))]
    : [LOCAL_GET, ...uLEB(L.get(op.r))];

  for (const insn of insns) {
    const m = insn.mnem;
    if (ALUOP[m]) {
      const dl = L.get(insn.dst.r);
      body.push(LOCAL_GET, ...uLEB(dl), ...pushRegOrImm(insn.src), ALUOP[m], LOCAL_SET, ...uLEB(dl));
    } else if (m === 'inc' || m === 'dec') {
      const dl = L.get(insn.dst.r);
      body.push(LOCAL_GET, ...uLEB(dl), I64_CONST, 1, m === 'inc' ? I64_ADD : I64_SUB, LOCAL_SET, ...uLEB(dl));
    } else if (m === 'mov') {
      if (insn.dst.kind === 'reg' && insn.src.kind !== 'mem') {          // reg <- reg/imm
        body.push(...pushRegOrImm(insn.src), LOCAL_SET, ...uLEB(L.get(insn.dst.r)));
      } else if (insn.dst.kind === 'reg' && insn.src.kind === 'mem') {   // reg <- [mem]
        const S = insn.src.size, dl = L.get(insn.dst.r);
        if (MASKLO[S] === 0n) { body.push(...emitAddr(insn.src), LOADOP[S], ALIGN[S], 0x00, LOCAL_SET, ...uLEB(dl)); }
        else { body.push(LOCAL_GET, ...uLEB(dl), I64_CONST, ...sLEB(BigInt.asIntN(64, MASKLO[S])), I64_AND,
                         ...emitAddr(insn.src), LOADOP[S], ALIGN[S], 0x00, I64_OR, LOCAL_SET, ...uLEB(dl)); }
      } else if (insn.dst.kind === 'mem') {                             // [mem] <- reg/imm
        const S = insn.dst.size;
        body.push(...emitAddr(insn.dst), ...pushRegOrImm(insn.src), STOREOP[S], ALIGN[S], 0x00);
      } else return null;
    } else if (m === 'movzx') {                                         // reg <- zext [mem]/reg
      const S = insn.src.size, dl = L.get(insn.dst.r);
      if (insn.src.kind === 'mem') body.push(...emitAddr(insn.src), LOADOP[S], ALIGN[S], 0x00, LOCAL_SET, ...uLEB(dl));
      else { const mask = (1n << BigInt(S*8)) - 1n;
             body.push(LOCAL_GET, ...uLEB(L.get(insn.src.r)), I64_CONST, ...sLEB(mask), I64_AND, LOCAL_SET, ...uLEB(dl)); }
    } else return null;
  }

  body.push(LOCAL_GET, ...uLEB(L.get(condReg)), ...CMP[branch.cond], 0x0d, 0x00, 0x0b);  // br_if 0; end loop
  for (const r of regs) body.push(I32_CONST, ...sLEB(r * 8), LOCAL_GET, ...uLEB(L.get(r)), I64_STORE, 0x03, 0x00);
  body.push(0x0b);

  const funcBody = [...vec([[...uLEB(regs.length), 0x7e]]), ...body];
  const wasm = new Uint8Array([
    0x00,0x61,0x73,0x6d, 1,0,0,0,
    ...section(1, vec([[0x60,0,0]])),
    ...section(2, vec([[...str('js'), ...str('mem'), 0x02, 0x00, ...uLEB(256)]])),  // >=16MB memory
    ...section(3, vec([[0]])),
    ...section(7, vec([[...str('run'), 0x00, 0]])),
    ...section(10, vec([[...uLEB(funcBody.length), ...funcBody]])),
  ]);
  return { wasm, endRip: rip, target, bodyInsns: insns.length, live: regs.length };
}

function accepts(insn) {
  const m = insn.mnem;
  if (ALUOP[m]) return insn.size === 8 && insn.dst.kind === 'reg' && (!insn.src || insn.src.kind !== 'mem');
  if (m === 'inc' || m === 'dec') return insn.dst.kind === 'reg';
  if (m === 'movzx') return insn.dst.kind === 'reg' && [1,2,4].includes(insn.src.size);
  if (m === 'mov') {
    if (insn.dst.kind === 'reg' && insn.src.kind === 'mem') return [1,4,8].includes(insn.src.size) && insn.src.base >= 0 && insn.src.index < 0;
    if (insn.dst.kind === 'mem') return [1,4,8].includes(insn.dst.size) && insn.dst.base >= 0 && insn.dst.index < 0 && insn.src.kind !== 'mem';
    if (insn.dst.kind === 'reg') return insn.src.kind !== 'mem';
  }
  return false;
}
