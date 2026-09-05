// oxwasm M3 tier-1 — the JIT seed. Translates a straight-line basic block
// of core integer ops into a REAL WebAssembly function that mutates the
// guest register file in place. This is the smallest honest proof that
// x86 -> wasm code generation works; it shares the decoder with tier-0
// and is verified against the tier-0 interpreter.
//
// Guest state ABI: a WebAssembly.Memory whose first 16 i64 slots are the
// GPRs (index = x86 reg number). The emitted function takes no args and
// reads/writes those slots. Supported: mov/add/sub/and/or/xor between
// 64-bit regs and immediates. Anything else -> block ends (bailout to
// interpreter), exactly how a real tiering JIT hands back control.
import { decode } from './decode.mjs';

// --- minimal wasm module encoder ---
const u = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sLEB = (v) => { const o = []; let more = 1; v = BigInt(v);
  while (more) { let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = 0; else b |= 0x80; o.push(b); } return o; };
const str = (s) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const section = (id, body) => [id, ...u(body.length), ...body];
const vec = (items) => [...u(items.length), ...items.flat()];

const REG = { get: 0x29, set: 0x37 };  // i64.load / i64.store
const OP = { add: 0x7c, sub: 0x7d, and: 0x83, or: 0x84, xor: 0x85 };

export function compileBlock(mem, ripStart) {
  const code = [];              // wasm instructions for the function body
  let rip = ripStart, count = 0;
  const loadReg = (r) => [0x41, ...sLEB(r * 8), REG.get, 0x03, 0x00];   // i32.const off; i64.load align=3
  // i64.const 0xffffffff ; i64.and  -> zero-extend a 32-bit result to 64
  const MASK32 = [0x42, ...sLEB(0xffffffffn), 0x83];
  const storeExpr = (r, emitVal) => [0x41, ...sLEB(r * 8), ...emitVal, REG.set, 0x03, 0x00];

  for (;;) {
    let insn;
    try { insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip); }
    catch { break; }
    if ((insn.size !== 8 && insn.size !== 4) || (insn.dst && insn.dst.kind !== 'reg') ||
        (insn.src && insn.src.kind === 'mem')) break;
    const w32 = insn.size === 4;
    const val = (op) => op.kind === 'imm' ? [0x42, ...sLEB(BigInt.asIntN(64, op.v))] : loadReg(op.r);
    let expr;
    if (insn.mnem === 'mov') expr = val(insn.src);
    else if (OP[insn.mnem]) expr = [...loadReg(insn.dst.r), ...val(insn.src), OP[insn.mnem]];
    else break;
    if (w32) expr = [...expr, ...MASK32];   // 32-bit dst zero-extends upper half
    code.push(...storeExpr(insn.dst.r, expr));
    rip += BigInt(insn.len); count++;
  }
  if (!count) return null;

  const body = [...vec([]), ...code, 0x0b];   // no locals, body, end
  const wasm = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...section(1, vec([[0x60, 0, 0]])),                                  // type: () -> ()
    ...section(2, vec([[...str('js'), ...str('mem'), 0x02, 0x00, 1]])),  // import mem
    ...section(3, vec([[0]])),                                           // func 0: type 0
    ...section(7, vec([[...str('run'), 0x00, 0]])),                      // export run
    ...section(10, vec([[...u(body.length), ...body]])),                 // code
  ]);
  return { wasm, endRip: rip, count };
}
