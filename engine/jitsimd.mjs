// oxwasm M3 tier-1.5 — SIMD auto-vectorizer for elementwise pixel loops.
//
// GIMP is image processing, and gcc vectorizes its pixel loops with SIMD —
// which is why native beat the scalar JIT ~2x on the pixel benchmark. This
// recognizer emits wasm v128 for the vectorizable shape and closes that gap.
//
// Recognized loop (the elementwise per-pixel transform):
//   movzx <acc>, byte [<srcPtr>]        ; load one pixel
//   <op> <acc>, imm   (add/sub/and/or/xor, any number)   ; process it
//   [ and <acc>, 0xff ]                 ; optional mask (no-op for byte store)
//   mov  [<dstPtr>], <acc-low-byte>     ; store the pixel
//   inc  <srcPtr> / inc <dstPtr>        ; advance both by 1
//   dec  <cnt> ; jnz top                ; count down
//
// It emits a v128 main loop (16 px/iter: v128.load, i8x16/v128 elementwise
// ops with splatted immediates, v128.store, pointers += 16, cnt -= 16) plus
// a scalar remainder loop for cnt % 16. Anything not matching -> null.
import { decode } from './decode.mjs';

const uLEB = (n) => { const o = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; o.push(b); } while (n); return o; };
const sLEB = (v) => { const o = []; let more = 1; v = BigInt(v);
  while (more) { let b = Number(v & 0x7fn); v >>= 7n;
    if ((v === 0n && !(b & 0x40)) || (v === -1n && (b & 0x40))) more = 0; else b |= 0x80; o.push(b); } return o; };
const str = (s) => [s.length, ...[...s].map(c => c.charCodeAt(0))];
const section = (id, body) => [id, ...uLEB(body.length), ...body];
const vec = (items) => [...uLEB(items.length), ...items.flat()];

const SIMD = 0xFD;
const V128_LOAD = [SIMD, ...uLEB(0)], V128_STORE = [SIMD, ...uLEB(11)];
const I8X16_SPLAT = [SIMD, ...uLEB(15)];
const SIMDOP = { add: [SIMD, ...uLEB(110)], sub: [SIMD, ...uLEB(113)],
                 and: [SIMD, ...uLEB(78)], or: [SIMD, ...uLEB(80)], xor: [SIMD, ...uLEB(81)] };
const I64_LOAD8U = 0x30, I64_STORE8 = 0x3c, I64_LOAD = 0x29, I64_STORE = 0x37;
const I64_CONST = 0x42, I32_CONST = 0x41, LOCAL_GET = 0x20, LOCAL_SET = 0x21, I32_WRAP = 0xa7, I32_ADD = 0x6a;
const I64_ADD = 0x7c, I64_SUB = 0x7d, I64_AND = 0x83, I64_OR = 0x84, I64_XOR = 0x85, I64_EQZ = 0x50, I64_LT_U = 0x54;
const SCALAR = { add: I64_ADD, sub: I64_SUB, and: I64_AND, or: I64_OR, xor: I64_XOR };

export function compileVectorLoop(mem, top, { guestBase = 0n, ramBase = 0 } = {}) {
  // decode the loop body
  const insns = []; let rip = top, branch = null;
  for (let n = 0; n < 64; n++) {
    let insn; try { insn = decode((i) => Number(mem.read(rip + BigInt(i), 1n)), rip); } catch { return null; }
    insn.next = rip + BigInt(insn.len);
    if (insn.mnem === 'jcc') { branch = insn; break; }
    insns.push(insn); rip = insn.next;
  }
  if (!branch || branch.cond !== 'ne') return null;

  // parse the shape
  let srcPtr = -1, dstPtr = -1, cnt = -1, acc = -1;
  const ops = [];          // [{mnem, imm}]
  let load = null, store = null, incs = new Set(), dec = null;
  for (const insn of insns) {
    const m = insn.mnem;
    if ((m === 'movzx' || m === 'mov') && insn.dst.kind === 'reg' && insn.src && insn.src.kind === 'mem'
        && insn.src.size === 1 && insn.src.base >= 0 && insn.src.index < 0 && insn.src.disp === 0n) {
      if (load) return null; load = insn; acc = insn.dst.r; srcPtr = insn.src.base;
    } else if (SCALAR[m] && insn.dst.kind === 'reg' && insn.dst.r === acc && insn.src.kind === 'imm') {
      if (m === 'and' && (insn.src.v & 0xffn) === 0xffn) continue;   // mask before byte store: no-op
      ops.push({ mnem: m, imm: Number(insn.src.v & 0xffn) });
    } else if (m === 'mov' && insn.dst.kind === 'mem' && insn.dst.size === 1 && insn.dst.base >= 0
               && insn.dst.index < 0 && insn.dst.disp === 0n && insn.src.kind === 'reg' && insn.src.r === acc) {
      if (store) return null; store = insn; dstPtr = insn.dst.base;
    } else if ((m === 'inc') && insn.dst.kind === 'reg') { incs.add(insn.dst.r); }
    else if (m === 'dec' && insn.dst.kind === 'reg') { dec = insn; cnt = insn.dst.r; }
    else return null;
  }
  if (!load || !store || dec === null || !incs.has(srcPtr) || !incs.has(dstPtr) || incs.size !== 2) return null;
  if (srcPtr === dstPtr || acc < 0) return null;

  // locals: srcPtr, dstPtr, cnt  -> indices 0,1,2
  const regs = [srcPtr, dstPtr, cnt];
  const Li = new Map(regs.map((r, i) => [r, i]));
  const K = (r) => BigInt.asIntN(32, BigInt(ramBase) - guestBase);   // disp always 0 here
  const addr = (r) => [LOCAL_GET, ...uLEB(Li.get(r)), I32_WRAP, I32_CONST, ...sLEB(K(r)), I32_ADD];

  const body = [];
  for (const r of regs) body.push(I32_CONST, ...sLEB(r * 8), I64_LOAD, 0x03, 0x00, LOCAL_SET, ...uLEB(Li.get(r)));

  // one vector step (16 px) writing at byte-offset `off` from the current
  // srcPtr/dstPtr, WITHOUT advancing the pointers (the caller bumps once).
  const vecStep = (off) => {
    const a = (r) => [LOCAL_GET, ...uLEB(Li.get(r)), I32_WRAP, I32_CONST, ...sLEB(K(r)), I32_ADD,
                      I32_CONST, ...sLEB(off), I32_ADD];
    const out = [...a(dstPtr), ...a(srcPtr), ...V128_LOAD, 0x04, 0x00];
    for (const { mnem, imm } of ops) out.push(I32_CONST, ...sLEB(imm), ...I8X16_SPLAT, ...SIMDOP[mnem]);
    out.push(...V128_STORE, 0x04, 0x00);
    return out;
  };
  const bumpN = (r, n) => [LOCAL_GET, ...uLEB(Li.get(r)), I64_CONST, ...sLEB(n), I64_ADD, LOCAL_SET, ...uLEB(Li.get(r))];
  const subN  = (r, n) => [LOCAL_GET, ...uLEB(Li.get(r)), I64_CONST, ...sLEB(n), I64_SUB, LOCAL_SET, ...uLEB(Li.get(r))];

  // --- 4x-unrolled SIMD loop: while cnt >= 64 (64 px/iter) ---
  const unrolled = [...vecStep(0), ...vecStep(16), ...vecStep(32), ...vecStep(48),
                    ...bumpN(srcPtr, 64), ...bumpN(dstPtr, 64), ...subN(cnt, 64)];
  body.push(0x02, 0x40, 0x03, 0x40,
    LOCAL_GET, ...uLEB(Li.get(cnt)), I64_CONST, 64, I64_LT_U, 0x0d, 0x01,
    ...unrolled, 0x0c, 0x00,
    0x0b, 0x0b);

  // --- SIMD main loop: while cnt >= 16 ---
  const vecBody = [];
  vecBody.push(...addr(dstPtr));                            // store dest addr first
  vecBody.push(...addr(srcPtr), ...V128_LOAD, 0x04, 0x00);  // load 16 px
  for (const { mnem, imm } of ops) vecBody.push(I32_CONST, ...sLEB(imm), ...I8X16_SPLAT, ...SIMDOP[mnem]);
  vecBody.push(...V128_STORE, 0x04, 0x00);
  const bump16 = (r) => [LOCAL_GET, ...uLEB(Li.get(r)), I64_CONST, 16, I64_ADD, LOCAL_SET, ...uLEB(Li.get(r))];
  vecBody.push(...bump16(srcPtr), ...bump16(dstPtr),
               LOCAL_GET, ...uLEB(Li.get(cnt)), I64_CONST, 16, I64_SUB, LOCAL_SET, ...uLEB(Li.get(cnt)));
  body.push(0x02, 0x40, 0x03, 0x40,                        // block { loop {
    LOCAL_GET, ...uLEB(Li.get(cnt)), I64_CONST, 16, I64_LT_U, 0x0d, 0x01,   // if cnt<16 br 1 (exit block)
    ...vecBody, 0x0c, 0x00,                                // br 0 (loop)
    0x0b, 0x0b);                                           // end loop; end block

  // --- scalar remainder: while cnt != 0 ---
  const scalarBody = [];
  scalarBody.push(...addr(dstPtr));
  // acc byte = load8u(src); process
  const accExpr = [...addr(srcPtr), I64_LOAD8U, 0x00, 0x00];
  let expr = accExpr;
  for (const { mnem, imm } of ops) expr = [...expr, I64_CONST, ...sLEB(imm), SCALAR[mnem]];
  scalarBody.push(...expr, I64_STORE8, 0x00, 0x00);
  const inc1 = (r) => [LOCAL_GET, ...uLEB(Li.get(r)), I64_CONST, 1, I64_ADD, LOCAL_SET, ...uLEB(Li.get(r))];
  scalarBody.push(...inc1(srcPtr), ...inc1(dstPtr),
                  LOCAL_GET, ...uLEB(Li.get(cnt)), I64_CONST, 1, I64_SUB, LOCAL_SET, ...uLEB(Li.get(cnt)));
  body.push(0x02, 0x40, 0x03, 0x40,
    LOCAL_GET, ...uLEB(Li.get(cnt)), I64_EQZ, 0x0d, 0x01,
    ...scalarBody, 0x0c, 0x00,
    0x0b, 0x0b);

  for (const r of regs) body.push(I32_CONST, ...sLEB(r * 8), LOCAL_GET, ...uLEB(Li.get(r)), I64_STORE, 0x03, 0x00);
  body.push(0x0b);

  const funcBody = [...vec([[...uLEB(regs.length), 0x7e]]), ...body];
  const wasm = new Uint8Array([
    0x00,0x61,0x73,0x6d, 1,0,0,0,
    ...section(1, vec([[0x60,0,0]])),
    ...section(2, vec([[...str('js'), ...str('mem'), 0x02, 0x00, ...uLEB(256)]])),
    ...section(3, vec([[0]])),
    ...section(7, vec([[...str('run'), 0x00, 0]])),
    ...section(10, vec([[...uLEB(funcBody.length), ...funcBody]])),
  ]);
  return { wasm, vectorOps: ops.length, lanes: 16 };
}
