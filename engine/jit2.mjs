// oxwasm M3 tier-1.5 — the superblock loop JIT.
//
// The per-block JIT (jit.mjs) pays two costs the benchmark exposed: a
// JS<->WASM boundary crossing per block, and reloading all 16 guest
// registers from linear memory on every entry. For a hot loop that is
// almost all the cost.
//
// This compiler removes both. It recognizes a counted loop — a run of
// supported ops ending in a backward conditional branch — and emits ONE
// wasm function that:
//   * loads the live guest registers into wasm i64 LOCALS once at entry,
//   * runs the whole loop, branch and all, inside a wasm `loop`,
//   * stores the registers back to memory once at exit.
// The boundary is crossed once per loop, not once per iteration, and the
// registers never touch linear memory inside the loop.
//
// Supported body ops: reg/imm add/sub/and/or/xor/mov (64-bit), on the 16
// GPRs. Loop control: the block's last instruction is jnz/jz/jl/jge/jg/jle
// with a negative displacement, and its condition is taken from the result
// of the immediately preceding ALU op (the standard `dec rcx; jnz` shape).
// Anything outside this recognized form -> returns null (caller falls back
// to the interpreter or per-block JIT), exactly the tiering contract.
import { decode } from './decode.mjs';

// --- wasm encoder (shared shape with jit.mjs) ---
const uLEB = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sLEB = (v) => { const o = []; let more = 1; v = BigInt(v);
  while (more) { let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = 0; else b |= 0x80; o.push(b); } return o; };
const str = (s) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const section = (id, body) => [id, ...uLEB(body.length), ...body];
const vec = (items) => [...uLEB(items.length), ...items.flat()];

const I64_LOAD = 0x29, I64_STORE = 0x37, LOCAL_GET = 0x20, LOCAL_SET = 0x21, LOCAL_TEE = 0x22;
const I64_CONST = 0x42, I64_ADD = 0x7c, I64_SUB = 0x7d, I64_AND = 0x83, I64_OR = 0x84, I64_XOR = 0x85;
const I64_EQZ = 0x50, I64_NE = 0x52, I64_EQ = 0x51, I64_LT_S = 0x53, I64_GT_S = 0x55, I64_LE_S = 0x57, I64_GE_S = 0x59;
const ALUOP = { add: I64_ADD, sub: I64_SUB, and: I64_AND, or: I64_OR, xor: I64_XOR };

export function compileLoop(mem, ripStart, maxInsns = 256) {
  // 1. linear-scan decode the block until a control-flow instruction
  const insns = [];
  let rip = ripStart;
  let branch = null;
  for (let n = 0; n < maxInsns; n++) {
    let insn;
    try { insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip); }
    catch { return null; }
    insn.rip = rip; insn.next = rip + BigInt(insn.len);
    if (insn.mnem === 'jcc') { branch = insn; rip = insn.next; break; }
    // body op must be a supported 64-bit reg/imm ALU or mov reg,*
    if (insn.size !== 8 || !insn.dst || insn.dst.kind !== 'reg') return null;
    if (insn.src && insn.src.kind === 'mem') return null;
    if (insn.mnem !== 'mov' && !ALUOP[insn.mnem]) return null;
    insns.push(insn); rip = insn.next;
  }
  if (!branch) return null;
  // must be a BACKWARD branch into this block (a loop)
  const target = (branch.next + branch.rel) & 0xFFFFFFFFFFFFFFFFn;
  if (target < ripStart || target >= branch.rip) return null;
  // condition source: the last ALU op before the branch (sets the flags)
  const flagOp = insns[insns.length - 1];
  if (!flagOp || !ALUOP[flagOp.mnem]) return null;
  const condReg = flagOp.dst.r;                 // result lives in this reg's local
  // we support conditions decidable from a single result value vs zero
  const CMP = { e: I64_EQZ, ne: [I64_CONST, ...sLEB(0), I64_NE],
                l: [I64_CONST, ...sLEB(0), I64_LT_S], ge: [I64_CONST, ...sLEB(0), I64_GE_S],
                g: [I64_CONST, ...sLEB(0), I64_GT_S], le: [I64_CONST, ...sLEB(0), I64_LE_S] };
  if (!(branch.cond in CMP)) return null;

  // 2. which regs are read/written -> the live set to shuttle through locals
  const used = new Set();
  for (const insn of insns) {
    if (insn.dst && insn.dst.kind === 'reg') used.add(insn.dst.r);
    if (insn.src && insn.src.kind === 'reg') used.add(insn.src.r);
  }
  const regs = [...used].sort((a, b) => a - b);
  const localOf = new Map(regs.map((r, i) => [r, i]));   // reg -> local index

  // 3. emit the body
  const body = [];
  // prologue: load each live reg from mem[r*8] into its local
  for (const r of regs) body.push(0x41, ...sLEB(r * 8), I64_LOAD, 0x03, 0x00, LOCAL_SET, ...uLEB(localOf.get(r)));
  // loop { body ; br_if 0 (cond) }
  body.push(0x03, 0x40);                          // loop, void
  for (const insn of insns) {
    const dl = localOf.get(insn.dst.r);
    const pushSrc = () => insn.src.kind === 'imm'
      ? [I64_CONST, ...sLEB(BigInt.asIntN(64, insn.src.v))]
      : [LOCAL_GET, ...uLEB(localOf.get(insn.src.r))];
    if (insn.mnem === 'mov') body.push(...pushSrc(), LOCAL_SET, ...uLEB(dl));
    else body.push(LOCAL_GET, ...uLEB(dl), ...pushSrc(), ALUOP[insn.mnem], LOCAL_SET, ...uLEB(dl));
  }
  // branch condition from condReg's local
  body.push(LOCAL_GET, ...uLEB(localOf.get(condReg)));
  const c = CMP[branch.cond];
  if (Array.isArray(c)) body.push(...c); else body.push(c);
  body.push(0x0d, 0x00);                          // br_if 0  (loop back while cond true)
  body.push(0x0b);                                // end loop
  // epilogue: store live regs back to mem
  for (const r of regs) body.push(0x41, ...sLEB(r * 8), LOCAL_GET, ...uLEB(localOf.get(r)), I64_STORE, 0x03, 0x00);
  body.push(0x0b);                                // end function

  const localDecl = vec([[...uLEB(regs.length), 0x7e]]);   // N i64 locals
  const funcBody = [...localDecl, ...body];
  const wasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec([[0x60, 0, 0]])),
    ...section(2, vec([[...str('js'), ...str('mem'), 0x02, 0x00, 1]])),
    ...section(3, vec([[0]])),
    ...section(7, vec([[...str('run'), 0x00, 0]])),
    ...section(10, vec([[...uLEB(funcBody.length), ...funcBody]])),
  ]);
  return { wasm, endRip: rip, target, bodyInsns: insns.length, live: regs.length };
}
