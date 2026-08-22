// oxwasm M3 tier-0 — x86-64 instruction decoder (core integer subset).
// decode(fetch, rip) -> { mnem, size, dst, src, src2, cond, len, ... }
// fetch(i) returns the byte at rip+i.

const COND = ['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g'];

export function decode(fetch, rip) {
  let i = 0;
  const b = () => fetch(i++);
  let rex = 0, opsize = 4;
  let p;
  for (;;) {                                  // prefixes
    p = b();
    if (p === 0x66) { opsize = 2; continue; }
    if ((p & 0xF0) === 0x40) { rex = p; continue; }
    if (p === 0xF2 || p === 0xF3 || p === 0x2E || p === 0x3E || p === 0x26 ||
        p === 0x36 || p === 0x64 || p === 0x65 || p === 0x67)
      throw new Error(`unsupported prefix ${p.toString(16)}`);
    break;
  }
  const W = rex & 8 ? 1 : 0, R = rex & 4 ? 1 : 0, X = rex & 2 ? 1 : 0, B = rex & 1 ? 1 : 0;
  const osz = W ? 8 : opsize;                 // main operand size
  const reg8 = (r) => ({ kind: 'reg', r: rex ? r : (r & 4 ? r - 4 : r), size: 1, high: !rex && (r & 4) ? 1 : 0 });
  const mkreg = (r, size) => size === 1 ? reg8(r) : { kind: 'reg', r, size };

  function modrm(size) {                      // returns [regOp, rmOp]
    const m = b(), mod = m >> 6, reg = ((m >> 3) & 7) | (R << 3);
    let rm = (m & 7) | (B << 3);
    if (mod === 3) { const out = [mkreg(reg, size), mkreg(rm, size)]; out[2] = reg; return out; }
    let base = rm, index = -1, scale = 1, disp = 0n, ripRel = false;
    if ((m & 7) === 4) {                      // SIB
      const s = b();
      scale = 1 << (s >> 6);
      index = ((s >> 3) & 7) | (X << 3);
      if (index === 4) index = -1;
      base = (s & 7) | (B << 3);
      if ((s & 7) === 5 && mod === 0) { base = -1; disp = imm(4); }
    } else if ((m & 7) === 5 && mod === 0) { base = -1; ripRel = true; disp = imm(4); }
    if (mod === 1) disp = imm(1);
    else if (mod === 2) disp = imm(4);
    const out = [mkreg(reg, size), { kind: 'mem', base, index, scale, disp, ripRel, size }];
    out[2] = reg; return out;
  }
  function imm(n) {                           // sign-extended immediate
    let v = 0n;
    for (let k = 0; k < n; k++) v |= BigInt(b()) << BigInt(8 * k);
    const sign = 1n << BigInt(8 * n - 1);
    return (v ^ sign) - sign;
  }
  function immU(n) {                          // zero-extended
    let v = 0n;
    for (let k = 0; k < n; k++) v |= BigInt(b()) << BigInt(8 * k);
    return v;
  }
  const fin = (o) => (o.len = i, o);
  const ALU = { 0: 'add', 1: 'or', 2: 'adc', 3: 'sbb', 4: 'and', 5: 'sub', 6: 'xor', 7: 'cmp' };
  const SHIFT = { 4: 'shl', 5: 'shr', 7: 'sar' };

  const op = p;
  // ALU r/m,r and r,r/m families: base opcodes 0x00,0x08,0x20,0x28,0x30,0x38
  for (const [base, mnem] of [[0x00,'add'],[0x08,'or'],[0x10,'adc'],[0x18,'sbb'],[0x20,'and'],[0x28,'sub'],[0x30,'xor'],[0x38,'cmp']]) {
    if (op === base + 1) { const [r, rm] = modrm(osz); return fin({ mnem, dst: rm, src: r, size: osz }); }
    if (op === base + 3) { const [r, rm] = modrm(osz); return fin({ mnem, dst: r, src: rm, size: osz }); }
    if (op === base)     { const [r, rm] = modrm(1);  return fin({ mnem, dst: rm, src: r, size: 1 }); }
    if (op === base + 2) { const [r, rm] = modrm(1);  return fin({ mnem, dst: r, src: rm, size: 1 }); }
    if (op === base + 4) return fin({ mnem, dst: reg8(0), src: { kind: 'imm', v: imm(1) }, size: 1 });
    if (op === base + 5) return fin({ mnem, dst: mkreg(0, osz), src: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz });
  }
  if (op === 0xA8) return fin({ mnem: 'test', dst: reg8(0), src: { kind: 'imm', v: imm(1) }, size: 1 });
  if (op === 0xA9) return fin({ mnem: 'test', dst: mkreg(0, osz), src: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz });
  if (op === 0x84) { const [r, rm] = modrm(1);   return fin({ mnem: 'test', dst: rm, src: r, size: 1 }); }
  if (op === 0x85) { const [r, rm] = modrm(osz); return fin({ mnem: 'test', dst: rm, src: r, size: osz }); }
  if (op === 0x88) { const [r, rm] = modrm(1);   return fin({ mnem: 'mov', dst: rm, src: r, size: 1 }); }
  if (op === 0x89) { const [r, rm] = modrm(osz); return fin({ mnem: 'mov', dst: rm, src: r, size: osz }); }
  if (op === 0x8A) { const [r, rm] = modrm(1);   return fin({ mnem: 'mov', dst: r, src: rm, size: 1 }); }
  if (op === 0x8B) { const [r, rm] = modrm(osz); return fin({ mnem: 'mov', dst: r, src: rm, size: osz }); }
  if (op === 0x8D) { const [r, rm] = modrm(osz); return fin({ mnem: 'lea', dst: r, src: rm, size: osz }); }
  if (op === 0x63) { const [r, rm] = modrm(8); rm.size = 4; return fin({ mnem: 'movsx', dst: r, src: rm, size: 8, srcSize: 4 }); }
  if (op >= 0x50 && op <= 0x57) return fin({ mnem: 'push', src: mkreg((op - 0x50) | (B << 3), 8), size: 8 });
  if (op >= 0x58 && op <= 0x5F) return fin({ mnem: 'pop', dst: mkreg((op - 0x58) | (B << 3), 8), size: 8 });
  if (op === 0x68) return fin({ mnem: 'push', src: { kind: 'imm', v: imm(4) }, size: 8 });
  if (op === 0x6A) return fin({ mnem: 'push', src: { kind: 'imm', v: imm(1) }, size: 8 });
  if (op === 0x69) { const [r, rm] = modrm(osz); return fin({ mnem: 'imul3', dst: r, src: rm, src2: { kind: 'imm', v: imm(4) }, size: osz }); }
  if (op === 0x6B) { const [r, rm] = modrm(osz); return fin({ mnem: 'imul3', dst: r, src: rm, src2: { kind: 'imm', v: imm(1) }, size: osz }); }
  if (op >= 0x70 && op <= 0x7F) return fin({ mnem: 'jcc', cond: COND[op - 0x70], rel: imm(1) });
  if (op === 0x80) { const [, rm, g] = modrm(1); const m = ALU[g & 7]; if (!m) throw new Error('grp1/8 ' + (g & 7)); return fin({ mnem: m, dst: rm, src: { kind: 'imm', v: imm(1) }, size: 1 }); }
  if (op === 0x81) { const [, rm, g] = modrm(osz); const m = ALU[g & 7]; if (!m) throw new Error('grp1 ' + (g & 7)); return fin({ mnem: m, dst: rm, src: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz }); }
  if (op === 0x83) { const [, rm, g] = modrm(osz); const m = ALU[g & 7]; if (!m) throw new Error('grp1 ' + (g & 7)); return fin({ mnem: m, dst: rm, src: { kind: 'imm', v: imm(1) }, size: osz }); }
  if (op >= 0xB0 && op <= 0xB7) return fin({ mnem: 'mov', dst: reg8((op - 0xB0) | (B << 3)), src: { kind: 'imm', v: immU(1) }, size: 1 });
  if (op >= 0xB8 && op <= 0xBF) { const r = (op - 0xB8) | (B << 3); return W ? fin({ mnem: 'mov', dst: mkreg(r, 8), src: { kind: 'imm', v: immU(8) }, size: 8 }) : fin({ mnem: 'mov', dst: mkreg(r, osz), src: { kind: 'imm', v: immU(osz) }, size: osz }); }
  if (op === 0xC6) { const [, rm] = modrm(1);   return fin({ mnem: 'mov', dst: rm, src: { kind: 'imm', v: immU(1) }, size: 1 }); }
  if (op === 0xC7) { const [, rm] = modrm(osz); return fin({ mnem: 'mov', dst: rm, src: { kind: 'imm', v: imm(4) }, size: osz }); }
  if (op === 0xC1 || op === 0xD1 || op === 0xD3) {
    const [, rm, g] = modrm(osz); const m = SHIFT[g & 7]; if (!m) throw new Error('grp2 ' + (g & 7));
    const cnt = op === 0xC1 ? { kind: 'imm', v: immU(1) } : op === 0xD1 ? { kind: 'imm', v: 1n } : { kind: 'reg', r: 1, size: 1 };
    return fin({ mnem: m, dst: rm, src: cnt, size: osz });
  }
  if (op === 0xC3) return fin({ mnem: 'ret' });
  if (op === 0xE8) return fin({ mnem: 'call', rel: imm(4) });
  if (op === 0xE9) return fin({ mnem: 'jmp', rel: imm(4) });
  if (op === 0xEB) return fin({ mnem: 'jmp', rel: imm(1) });
  if (op === 0x90 && !rex) return fin({ mnem: 'nop' });
  if (op === 0xF7) {
    const [, rm, g] = modrm(osz); const sub = g & 7;
    if (sub === 0) return fin({ mnem: 'test', dst: rm, src: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz });
    if (sub === 2) return fin({ mnem: 'not', dst: rm, size: osz });
    if (sub === 3) return fin({ mnem: 'neg', dst: rm, size: osz });
    throw new Error('grp3 ' + sub);
  }
  if (op === 0xFF) {
    const [, rm, g] = modrm(osz); const sub = g & 7;
    if (sub === 0) return fin({ mnem: 'inc', dst: rm, size: osz });
    if (sub === 1) return fin({ mnem: 'dec', dst: rm, size: osz });
    if (sub === 6) { rm.size = 8; return fin({ mnem: 'push', src: rm, size: 8 }); }
    throw new Error('grp5 ' + sub);
  }
  if (op === 0x0F) {
    const o2 = b();
    if (o2 >= 0x80 && o2 <= 0x8F) return fin({ mnem: 'jcc', cond: COND[o2 - 0x80], rel: imm(4) });
    if (o2 >= 0x40 && o2 <= 0x4F) { const [r, rm] = modrm(osz); return fin({ mnem: 'cmov', cond: COND[o2 - 0x40], dst: r, src: rm, size: osz }); }
    if (o2 >= 0x90 && o2 <= 0x9F) { const [, rm] = modrm(1); return fin({ mnem: 'setcc', cond: COND[o2 - 0x90], dst: rm, size: 1 }); }
    if (o2 === 0xAF) { const [r, rm] = modrm(osz); return fin({ mnem: 'imul2', dst: r, src: rm, size: osz }); }
    if (o2 === 0xB6) { const [r, rm] = modrm(osz); rm.size = 1; if (rm.kind === 'reg') Object.assign(rm, reg8(rm.r | (rm.high ? 4 : 0))); return fin({ mnem: 'movzx', dst: r, src: rm, size: osz, srcSize: 1 }); }
    if (o2 === 0xB7) { const [r, rm] = modrm(osz); rm.size = 2; return fin({ mnem: 'movzx', dst: r, src: rm, size: osz, srcSize: 2 }); }
    if (o2 === 0xBE) { const [r, rm] = modrm(osz); rm.size = 1; if (rm.kind === 'reg') Object.assign(rm, reg8(rm.r | (rm.high ? 4 : 0))); return fin({ mnem: 'movsx', dst: r, src: rm, size: osz, srcSize: 1 }); }
    if (o2 === 0xBF) { const [r, rm] = modrm(osz); rm.size = 2; return fin({ mnem: 'movsx', dst: r, src: rm, size: osz, srcSize: 2 }); }
    if (o2 === 0x1F) { modrm(osz); return fin({ mnem: 'nop' }); }
    throw new Error(`unsupported 0f ${o2.toString(16)}`);
  }
  throw new Error(`unsupported opcode ${op.toString(16)} at ${rip.toString(16)}`);
}
