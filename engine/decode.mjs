// oxwasm M3 tier-0 — x86-64 instruction decoder (core integer subset).
// decode(fetch, rip) -> { mnem, size, dst, src, src2, cond, len, ... }
// fetch(i) returns the byte at rip+i.

const COND = ['o','no','b','ae','e','ne','be','a','s','ns','p','np','l','ge','le','g'];

export function decode(fetch, rip) {
  let i = 0;
  const b = () => fetch(i++);
  let rex = 0, opsize = 4, fsSeg = 0, rep = 0, rep2 = 0, lock = 0, addr32 = 0;
  let p;
  for (;;) {                                  // prefixes
    p = b();
    if (p === 0x66) { opsize = 2; continue; }
    if (p === 0x64) { fsSeg = 1; continue; }   // fs segment override (TLS)
    if (p === 0x67) { addr32 = 1; continue; }  // address-size override
    if (p === 0xF3) { rep = 1; continue; }     // rep / repe
    if (p === 0xF2) { rep2 = 1; continue; }    // repne / scalar-double
    if (p === 0xF0) { lock = 1; continue; }    // lock: single-hart, plain semantics
    if ((p & 0xF0) === 0x40) { rex = p; continue; }
    if (p === 0x2E || p === 0x3E) { continue; } // cs/ds overrides: meaningless in 64-bit (padding/notrack)
    if (p === 0x26 ||
        p === 0x36 || p === 0x65)
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
    const out = [mkreg(reg, size), { kind: 'mem', base, index, scale, disp, ripRel, size, fs: fsSeg, a32: addr32 }];
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
  const SHIFT = { 0: 'rol', 1: 'ror', 4: 'shl', 5: 'shr', 7: 'sar' };

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
  if (op === 0x69) { const [r, rm] = modrm(osz); return fin({ mnem: 'imul3', dst: r, src: rm, src2: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz }); }
  if (op === 0x6B) { const [r, rm] = modrm(osz); return fin({ mnem: 'imul3', dst: r, src: rm, src2: { kind: 'imm', v: imm(1) }, size: osz }); }
  if (op >= 0x70 && op <= 0x7F) return fin({ mnem: 'jcc', cond: COND[op - 0x70], rel: imm(1) });
  if (op === 0x80) { const [, rm, g] = modrm(1); const m = ALU[g & 7]; if (!m) throw new Error('grp1/8 ' + (g & 7)); return fin({ mnem: m, dst: rm, src: { kind: 'imm', v: imm(1) }, size: 1 }); }
  if (op === 0x81) { const [, rm, g] = modrm(osz); const m = ALU[g & 7]; if (!m) throw new Error('grp1 ' + (g & 7)); return fin({ mnem: m, dst: rm, src: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz }); }
  if (op === 0x83) { const [, rm, g] = modrm(osz); const m = ALU[g & 7]; if (!m) throw new Error('grp1 ' + (g & 7)); return fin({ mnem: m, dst: rm, src: { kind: 'imm', v: imm(1) }, size: osz }); }
  if (op >= 0xB0 && op <= 0xB7) return fin({ mnem: 'mov', dst: reg8((op - 0xB0) | (B << 3)), src: { kind: 'imm', v: immU(1) }, size: 1 });
  if (op >= 0xB8 && op <= 0xBF) { const r = (op - 0xB8) | (B << 3); return W ? fin({ mnem: 'mov', dst: mkreg(r, 8), src: { kind: 'imm', v: immU(8) }, size: 8 }) : fin({ mnem: 'mov', dst: mkreg(r, osz), src: { kind: 'imm', v: immU(osz) }, size: osz }); }
  if (op === 0xC6) { const [, rm] = modrm(1);   return fin({ mnem: 'mov', dst: rm, src: { kind: 'imm', v: immU(1) }, size: 1 }); }
  if (op === 0xC7) { const [, rm] = modrm(osz); return fin({ mnem: 'mov', dst: rm, src: { kind: 'imm', v: imm(osz === 2 ? 2 : 4) }, size: osz }); }
  if (op === 0xC0 || op === 0xC1 || op === 0xD0 || op === 0xD1 || op === 0xD2 || op === 0xD3) {
    const sz = (op === 0xC0 || op === 0xD0 || op === 0xD2) ? 1 : osz;
    const [, rm, g] = modrm(sz); const m = SHIFT[g & 7]; if (!m) throw new Error('grp2 ' + (g & 7));
    const cnt = (op === 0xC0 || op === 0xC1) ? { kind: 'imm', v: immU(1) }
              : (op === 0xD0 || op === 0xD1) ? { kind: 'imm', v: 1n }
              : { kind: 'reg', r: 1, size: 1 };
    return fin({ mnem: m, dst: rm, src: cnt, size: sz });
  }
  if (op >= 0xD8 && op <= 0xDF) {              // x87: dispatch on (op, reg field, mod)
    const m = b(), mod = m >> 6, sub = (m >> 3) & 7;
    if (mod === 3) return fin({ mnem: 'x87', op, sub, sti: m & 7, modbyte: m, rm: null });
    i--;                                        // re-read modrm for the memory form
    const [, mem] = modrm(8);
    return fin({ mnem: 'x87', op, sub, sti: -1, rm: mem });
  }
  if (op === 0xC3) return fin({ mnem: 'ret' });
  if (op === 0xC2) return fin({ mnem: 'retn', n: immU(2) });
  if (op === 0xC9) return fin({ mnem: 'leave' });
  if (op === 0xE8) return fin({ mnem: 'call', rel: imm(4) });
  if (op === 0xE9) return fin({ mnem: 'jmp', rel: imm(4) });
  if (op === 0xEB) return fin({ mnem: 'jmp', rel: imm(1) });
  if (op === 0x90 && !rex) return fin({ mnem: 'nop' });
  if (op >= 0x91 && op <= 0x97 || (op === 0x90 && rex))   // xchg rax, r
    return fin({ mnem: 'xchg', dst: mkreg(0, osz), src: mkreg((op - 0x90) | (B << 3), osz), size: osz });
  if (op === 0x98) return fin({ mnem: 'cwde', size: osz });   // cbw/cwde/cdqe
  if (op === 0x99) return fin({ mnem: 'cdq', size: osz });    // cwd/cdq/cqo
  if (op === 0xF4) return fin({ mnem: 'hlt' });
  if (op === 0xFC) return fin({ mnem: 'cld' });
  if (op === 0xFD) return fin({ mnem: 'std' });
  if (op === 0xF8) return fin({ mnem: 'clc' });
  if (op === 0xF9) return fin({ mnem: 'stc' });
  if (op === 0xA4) return fin({ mnem: 'movs', size: 1, rep });
  if (op === 0xA5) return fin({ mnem: 'movs', size: osz, rep });
  if (op === 0xAA) return fin({ mnem: 'stos', size: 1, rep });
  if (op === 0xAB) return fin({ mnem: 'stos', size: osz, rep });
  if (op === 0xA6) return fin({ mnem: 'cmps', size: 1, rep, rep2 });
  if (op === 0xA7) return fin({ mnem: 'cmps', size: osz, rep, rep2 });
  if (op === 0xAE) return fin({ mnem: 'scas', size: 1, rep, rep2 });
  if (op === 0xAF) return fin({ mnem: 'scas', size: osz, rep, rep2 });
  if (op === 0xAC) return fin({ mnem: 'lods', size: 1, rep });
  if (op === 0xAD) return fin({ mnem: 'lods', size: osz, rep });
  if (op === 0x86) { const [r, rm] = modrm(1);   return fin({ mnem: 'xchg', dst: rm, src: r, size: 1 }); }
  if (op === 0x87) { const [r, rm] = modrm(osz); return fin({ mnem: 'xchg', dst: rm, src: r, size: osz }); }
  if (op === 0xF6 || op === 0xF7) {
    const sz = op === 0xF6 ? 1 : osz;
    const [, rm, g] = modrm(sz); const sub = g & 7;
    if (sub === 0) return fin({ mnem: 'test', dst: rm, src: { kind: 'imm', v: op === 0xF6 ? imm(1) : imm(sz === 2 ? 2 : 4) }, size: sz });
    if (sub === 2) return fin({ mnem: 'not', dst: rm, size: sz });
    if (sub === 3) return fin({ mnem: 'neg', dst: rm, size: sz });
    if (sub === 4) return fin({ mnem: 'mul1', src: rm, size: sz });
    if (sub === 5) return fin({ mnem: 'imul1', src: rm, size: sz });
    if (sub === 6) return fin({ mnem: 'div1', src: rm, size: sz });
    if (sub === 7) return fin({ mnem: 'idiv1', src: rm, size: sz });
    throw new Error('grp3 ' + sub);
  }
  if (op === 0xFF) {
    const [, rm, g] = modrm(osz); const sub = g & 7;
    if (sub === 0) return fin({ mnem: 'inc', dst: rm, size: osz });
    if (sub === 1) return fin({ mnem: 'dec', dst: rm, size: osz });
    if (sub === 2) { rm.size = 8; return fin({ mnem: 'callind', src: rm }); }
    if (sub === 4) { rm.size = 8; return fin({ mnem: 'jmpind', src: rm }); }
    if (sub === 6) { rm.size = 8; return fin({ mnem: 'push', src: rm, size: 8 }); }
    throw new Error('grp5 ' + sub);
  }
  if (op === 0x0F) {
    const o2 = b();
    if (o2 >= 0x80 && o2 <= 0x8F) return fin({ mnem: 'jcc', cond: COND[o2 - 0x80], rel: imm(4) });
    if (o2 === 0x05) return fin({ mnem: 'syscall' });
    const SSE_OPS = { 0x6E:1, 0x7E:1, 0xD6:1, 0x6F:1, 0x7F:1, 0x10:1, 0x11:1,
                      0x28:1, 0x29:1, 0x6C:1, 0xEF:1, 0x74:1, 0xD7:1, 0xDB:1, 0xEB:1,
                      0x60:1, 0x61:1, 0x62:1, 0x68:1, 0x69:1, 0x6A:1, 0x6D:1,
                      0x70:1, 0xC2:1, 0xD4:1, 0xFE:1, 0xFD:1, 0xFC:1, 0x75:1, 0x76:1, 0x12:1, 0x13:1, 0x16:1, 0x17:1, 0x14:1, 0x15:1, 0x66:1, 0x65:1, 0x64:1, 0xFB:1, 0xFA:1, 0xF9:1, 0xF8:1,
                      0xDA:1, 0xDE:1, 0xEA:1, 0xEE:1, 0xD8:1, 0xD9:1, 0xDC:1, 0xDD:1,
                      0xE8:1, 0xE9:1, 0xEC:1, 0xED:1, 0xE0:1, 0xE3:1, 0xD5:1, 0xE5:1, 0xE4:1,
                      0xF4:1, 0xF6:1, 0x63:1, 0x67:1, 0x6B:1, 0xC5:1, 0xC4:1,
                      0xDF:1, 0xF5:1, 0xE7:1,                                  // pandn, pmaddwd, movntdq
                      0xD1:1, 0xD2:1, 0xD3:1, 0xE1:1, 0xE2:1, 0xF1:1, 0xF2:1, 0xF3:1,  // p{sll,srl,sra}{w,d,q} by-reg
                      0x54:1, 0x55:1, 0x56:1, 0x57:1, 0x2A:1, 0x2C:1, 0x2D:1, 0x2E:1, 0x2F:1,
                      0x50:1, 0x51:1, 0x58:1, 0x59:1, 0x5A:1, 0x5B:1, 0x5C:1, 0x5D:1, 0x5E:1, 0x5F:1, 0x2B:1, 0xC6:1 };
    const SSE_IMM8 = { 0x70:1, 0xC5:1, 0xC4:1, 0xC6:1, 0xC2:1 };
    const SSE_GRP_SHIFT = { 0x71:1, 0x72:1, 0x73:1 };
    if (SSE_GRP_SHIFT[o2]) {
      const m = b(), sub = (m >> 3) & 7, xrm = (m & 7) | (B << 3);
      return fin({ mnem: 'ssegrpshift', op: o2, sub, xrm, imm8: Number(immU(1)), p66: opsize === 2 });
    }
    if (SSE_OPS[o2]) {
      const m = b(), mod = m >> 6, xr = ((m >> 3) & 7) | (R << 3);
      let rm;
      if (mod === 3) rm = { kind: 'xmm', r: (m & 7) | (B << 3) };
      else {
        i--;                                   // re-read modrm via the standard path
        const [, mem] = modrm(16);
        rm = mem;
      }
      const extra = SSE_IMM8[o2] ? Number(immU(1)) : undefined;
      return fin({ mnem: 'sse', op: o2, p66: opsize === 2, pF3: !!rep, pF2: !!rep2, W, xr, rm, imm8: extra });
    }
    if (o2 === 0x1E) { b(); return fin({ mnem: 'nop' }); }   // endbr64 / nop variants
    if (o2 === 0xB0) { const [r, rm] = modrm(1);   return fin({ mnem: 'cmpxchg', dst: rm, src: r, size: 1 }); }
    if (o2 === 0xB1) { const [r, rm] = modrm(osz); return fin({ mnem: 'cmpxchg', dst: rm, src: r, size: osz }); }
    if (o2 === 0xC0) { const [r, rm] = modrm(1);   return fin({ mnem: 'xadd', dst: rm, src: r, size: 1 }); }
    if (o2 === 0xC1) { const [r, rm] = modrm(osz); return fin({ mnem: 'xadd', dst: rm, src: r, size: osz }); }
    if (o2 === 0xBC) { const [r, rm] = modrm(osz); return fin({ mnem: 'bsf', dst: r, src: rm, size: osz }); }
    if (o2 === 0xBD) { const [r, rm] = modrm(osz); return fin({ mnem: 'bsr', dst: r, src: rm, size: osz }); }
    if (o2 === 0xA3) { const [r, rm] = modrm(osz); return fin({ mnem: 'bt',  dst: rm, src: r, size: osz }); }
    if (o2 === 0xAB) { const [r, rm] = modrm(osz); return fin({ mnem: 'bts', dst: rm, src: r, size: osz }); }
    if (o2 === 0xB3) { const [r, rm] = modrm(osz); return fin({ mnem: 'btr', dst: rm, src: r, size: osz }); }
    if (o2 === 0xBB) { const [r, rm] = modrm(osz); return fin({ mnem: 'btc', dst: rm, src: r, size: osz }); }
    if (o2 === 0xBA) { const [, rm, g] = modrm(osz); const M2 = { 4:'bt', 5:'bts', 6:'btr', 7:'btc' }[g & 7];
      if (!M2) throw new Error('grp8 ' + (g & 7));
      return fin({ mnem: M2, dst: rm, src: { kind: 'imm', v: immU(1) }, size: osz }); }
    if (o2 === 0xA4) { const [r, rm] = modrm(osz); return fin({ mnem: 'shld', dst: rm, src: r, src2: { kind: 'imm', v: immU(1) }, size: osz }); }
    if (o2 === 0xA5) { const [r, rm] = modrm(osz); return fin({ mnem: 'shld', dst: rm, src: r, src2: { kind: 'reg', r: 1, size: 1 }, size: osz }); }
    if (o2 === 0xAC) { const [r, rm] = modrm(osz); return fin({ mnem: 'shrd', dst: rm, src: r, src2: { kind: 'imm', v: immU(1) }, size: osz }); }
    if (o2 === 0xAD) { const [r, rm] = modrm(osz); return fin({ mnem: 'shrd', dst: rm, src: r, src2: { kind: 'reg', r: 1, size: 1 }, size: osz }); }
    if (o2 === 0xA2) return fin({ mnem: 'cpuid' });
    if (o2 === 0x31) return fin({ mnem: 'rdtsc' });
    if (o2 === 0x01) { const m = b();
      if (m === 0xF9) return fin({ mnem: 'rdtscp' });
      throw new Error('0f 01 /' + m.toString(16)); }
    if (o2 >= 0xC8 && o2 <= 0xCF) return fin({ mnem: 'bswap', dst: mkreg((o2 - 0xC8) | (B << 3), osz === 2 ? 4 : osz), size: osz === 2 ? 4 : osz });
    if (o2 >= 0x40 && o2 <= 0x4F) { const [r, rm] = modrm(osz); return fin({ mnem: 'cmov', cond: COND[o2 - 0x40], dst: r, src: rm, size: osz }); }
    if (o2 >= 0x90 && o2 <= 0x9F) { const [, rm] = modrm(1); return fin({ mnem: 'setcc', cond: COND[o2 - 0x90], dst: rm, size: 1 }); }
    if (o2 === 0xAF) { const [r, rm] = modrm(osz); return fin({ mnem: 'imul2', dst: r, src: rm, size: osz }); }
    if (o2 === 0xB6) { const [r, rm] = modrm(osz); rm.size = 1; if (rm.kind === 'reg') Object.assign(rm, reg8(rm.r | (rm.high ? 4 : 0))); return fin({ mnem: 'movzx', dst: r, src: rm, size: osz, srcSize: 1 }); }
    if (o2 === 0xB7) { const [r, rm] = modrm(osz); rm.size = 2; return fin({ mnem: 'movzx', dst: r, src: rm, size: osz, srcSize: 2 }); }
    if (o2 === 0xBE) { const [r, rm] = modrm(osz); rm.size = 1; if (rm.kind === 'reg') Object.assign(rm, reg8(rm.r | (rm.high ? 4 : 0))); return fin({ mnem: 'movsx', dst: r, src: rm, size: osz, srcSize: 1 }); }
    if (o2 === 0xBF) { const [r, rm] = modrm(osz); rm.size = 2; return fin({ mnem: 'movsx', dst: r, src: rm, size: osz, srcSize: 2 }); }
    // 0F 18-1F: hint-nop family (prefetcht0/1/2/nta, reserved hints, long
    // nop) — architectural no-ops with a full modrm. 0F 0D is prefetchw.
    if ((o2 >= 0x18 && o2 <= 0x1F) || o2 === 0x0D) { modrm(osz); return fin({ mnem: 'nop' }); }
    if (o2 === 0xAE) {                                    // fence / fxsave group
      const peek = fetch(i);                              // peek modrm without consuming
      if ((peek & 0xC0) === 0xC0) {                       // mod=3: lfence/mfence/sfence
        i++;
        const g = (peek >> 3) & 7;
        if (g === 5 || g === 6 || g === 7) return fin({ mnem: 'nop' });
        throw new Error('0f ae reg /' + g);
      }
      const [, rm, g] = modrm(osz);
      const M2 = { 0: 'fxsave', 1: 'fxrstor', 2: 'ldmxcsr', 3: 'stmxcsr', 7: 'nop' }[g & 7];  // 7=clflush
      if (!M2) throw new Error('0f ae /' + (g & 7));
      return fin({ mnem: M2, dst: rm, src: rm, size: osz });
    }
    throw new Error(`unsupported 0f ${o2.toString(16)}`);
  }
  throw new Error(`unsupported opcode ${op.toString(16)} at ${rip.toString(16)}`);
}
