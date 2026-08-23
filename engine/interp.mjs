// oxwasm M3 tier-0 — x86-64 interpreter over the decoder.
// BigInt everywhere: slow and exact. This is the correctness oracle the
// tier-1 JIT will be measured against; it is itself measured against the
// real CPU by diff/run.mjs.
import { decode } from './decode.mjs';

const MASK = { 1: 0xFFn, 2: 0xFFFFn, 4: 0xFFFFFFFFn, 8: 0xFFFFFFFFFFFFFFFFn };
const SIGN = { 1: 0x80n, 2: 0x8000n, 4: 0x80000000n, 8: 0x8000000000000000n };

export class Memory {
  constructor(regions) { this.regions = regions; }   // [{base, bytes}]
  find(addr) {
    for (const r of this.regions)
      if (addr >= r.base && addr < r.base + BigInt(r.bytes.length)) return r;
    throw new Error(`fault: ${addr.toString(16)}`);
  }
  read(addr, n) {
    let v = 0n;
    for (let i = 0n; i < n; i++) {
      const r = this.find(addr + i);
      v |= BigInt(r.bytes[Number(addr + i - r.base)]) << (8n * i);
    }
    return v;
  }
  write(addr, n, v) {
    for (let i = 0n; i < n; i++) {
      const r = this.find(addr + i);
      r.bytes[Number(addr + i - r.base)] = Number((v >> (8n * i)) & 0xFFn);
    }
  }
}

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.regs = new Array(16).fill(0n);
    this.rip = 0n;
    this.f = { cf: 0, pf: 0, zf: 0, sf: 0, of: 0, af: 0 };
  }
  flagsValue() {
    const f = this.f;
    return 0x202n | BigInt(f.cf) | BigInt(f.pf) << 2n | BigInt(f.af) << 4n |
           BigInt(f.zf) << 6n | BigInt(f.sf) << 7n | BigInt(f.of) << 11n;
  }
  getReg(op) {
    let v = this.regs[op.r];
    if (op.size === 1 && op.high) v >>= 8n;
    return v & MASK[op.size];
  }
  setReg(op, v) {
    v &= MASK[op.size];
    if (op.size === 8) this.regs[op.r] = v;
    else if (op.size === 4) this.regs[op.r] = v;                    // 32-bit zeroes upper
    else if (op.size === 2) this.regs[op.r] = (this.regs[op.r] & ~0xFFFFn) | v;
    else if (op.high) this.regs[op.r] = (this.regs[op.r] & ~0xFF00n) | (v << 8n);
    else this.regs[op.r] = (this.regs[op.r] & ~0xFFn) | v;
  }
  ea(op) {
    let a = op.disp;
    if (op.base >= 0) a += this.regs[op.base];
    if (op.index >= 0) a += this.regs[op.index] * BigInt(op.scale);
    if (op.ripRel) a += this.ripNext;
    return a & MASK[8];
  }
  get(op) {
    if (op.kind === 'imm') return op.v & MASK[op.size || 8];
    if (op.kind === 'reg') return this.getReg(op);
    return this.mem.read(this.ea(op), BigInt(op.size));
  }
  set(op, v) {
    if (op.kind === 'reg') this.setReg(op, v);
    else this.mem.write(this.ea(op), BigInt(op.size), v & MASK[op.size]);
  }
  parity(v) { let n = Number(v & 0xFFn), c = 0; while (n) { c ^= 1; n &= n - 1; } return c ^ 1; }
  szp(r, size) {
    this.f.zf = r === 0n ? 1 : 0;
    this.f.sf = r & SIGN[size] ? 1 : 0;
    this.f.pf = this.parity(r);
  }
  addFlags(a, b, r, size, carryOut) {
    this.f.cf = carryOut;
    this.f.of = ((a ^ r) & (b ^ r) & SIGN[size]) ? 1 : 0;
    this.f.af = ((a ^ b ^ r) & 0x10n) ? 1 : 0;
    this.szp(r, size);
  }
  subFlags(a, b, r, size) {
    this.f.cf = b > a ? 1 : 0;
    this.f.of = ((a ^ b) & (a ^ r) & SIGN[size]) ? 1 : 0;
    this.f.af = ((a ^ b ^ r) & 0x10n) ? 1 : 0;
    this.szp(r, size);
  }
  logicFlags(r, size) { this.f.cf = 0; this.f.of = 0; this.f.af = 0; this.szp(r, size); }
  cond(c) {
    const f = this.f;
    switch (c) {
      case 'o': return f.of; case 'no': return !f.of;
      case 'b': return f.cf; case 'ae': return !f.cf;
      case 'e': return f.zf; case 'ne': return !f.zf;
      case 'be': return f.cf || f.zf; case 'a': return !f.cf && !f.zf;
      case 's': return f.sf; case 'ns': return !f.sf;
      case 'p': return f.pf; case 'np': return !f.pf;
      case 'l': return f.sf !== f.of; case 'ge': return f.sf === f.of;
      case 'le': return f.zf || f.sf !== f.of; case 'g': return !f.zf && f.sf === f.of;
    }
  }
  push(v) { this.regs[4] = (this.regs[4] - 8n) & MASK[8]; this.mem.write(this.regs[4], 8n, v); }
  pop() { const v = this.mem.read(this.regs[4], 8n); this.regs[4] = (this.regs[4] + 8n) & MASK[8]; return v; }

  step() {
    const rip = this.rip;
    const insn = decode((i) => Number(this.mem.read(rip + BigInt(i), 1n)), rip);
    const next = rip + BigInt(insn.len);
    this.ripNext = next;
    this.rip = next;
    const S = insn.size, M = MASK[S];
    switch (insn.mnem) {
      case 'nop': break;
      case 'hlt': this.halted = true; break;
      case 'mov': this.set(insn.dst, this.get(insn.src)); break;
      case 'lea': this.setReg(insn.dst, this.ea(insn.src)); break;
      case 'movzx': this.setReg(insn.dst, this.get(insn.src)); break;
      case 'movsx': {
        const s = insn.src.size;
        let v = this.get(insn.src);
        v = ((v ^ SIGN[s]) - SIGN[s]) & M;
        this.setReg(insn.dst, v); break;
      }
      case 'add': { const a = this.get(insn.dst), b = this.get(insn.src) & M, r = (a + b) & M;
        this.addFlags(a, b, r, S, a + b > M ? 1 : 0); this.set(insn.dst, r); break; }
      case 'sub': { const a = this.get(insn.dst), b = this.get(insn.src) & M, r = (a - b) & M;
        this.subFlags(a, b, r, S); this.set(insn.dst, r); break; }
      case 'adc': { const a = this.get(insn.dst), b = this.get(insn.src) & M, c = BigInt(this.f.cf), r = (a + b + c) & M;
        this.addFlags(a, b, r, S, a + b + c > M ? 1 : 0); this.set(insn.dst, r); break; }
      case 'sbb': { const a = this.get(insn.dst), b = this.get(insn.src) & M, c = BigInt(this.f.cf), r = (a - b - c) & M;
        const cf = b + c > a ? 1 : 0;
        this.subFlags(a, b, r, S); this.f.cf = cf; this.set(insn.dst, r); break; }
      case 'cmp': { const a = this.get(insn.dst), b = this.get(insn.src) & M, r = (a - b) & M;
        this.subFlags(a, b, r, S); break; }
      case 'and': { const r = this.get(insn.dst) & this.get(insn.src) & M;
        this.logicFlags(r, S); this.set(insn.dst, r); break; }
      case 'or': { const r = (this.get(insn.dst) | this.get(insn.src)) & M;
        this.logicFlags(r, S); this.set(insn.dst, r); break; }
      case 'xor': { const r = (this.get(insn.dst) ^ this.get(insn.src)) & M;
        this.logicFlags(r, S); this.set(insn.dst, r); break; }
      case 'test': { const r = this.get(insn.dst) & this.get(insn.src) & M;
        this.logicFlags(r, S); break; }
      case 'not': this.set(insn.dst, ~this.get(insn.dst) & M); break;
      case 'neg': { const b = this.get(insn.dst), r = (0n - b) & M;
        this.subFlags(0n, b, r, S); this.set(insn.dst, r); break; }
      case 'inc': { const a = this.get(insn.dst), r = (a + 1n) & M; const cf = this.f.cf;
        this.addFlags(a, 1n, r, S, 0); this.f.cf = cf; this.set(insn.dst, r); break; }
      case 'dec': { const a = this.get(insn.dst), r = (a - 1n) & M; const cf = this.f.cf;
        this.subFlags(a, 1n, r, S); this.f.cf = cf; this.set(insn.dst, r); break; }
      case 'imul2': case 'imul3': {
        const sx = (v) => ((v ^ SIGN[S]) - SIGN[S]);
        const a = sx(this.get(insn.mnem === 'imul3' ? insn.src : insn.dst));
        const b = insn.mnem === 'imul3' ? (insn.src2.v) : sx(this.get(insn.src));
        const full = a * b, r = full & M;
        const trunc = ((r ^ SIGN[S]) - SIGN[S]);
        this.f.cf = this.f.of = trunc !== full ? 1 : 0;
        this.f.af = 0; this.szp(r, S);      // SF/ZF/PF undefined on HW; masked in diff
        this.setReg(insn.dst, r); break;
      }
      case 'shl': { const c = Number(this.get(insn.src) & (S === 8 ? 0x3Fn : 0x1Fn));
        if (c) { const a = this.get(insn.dst), r = (a << BigInt(c)) & M;
          this.f.cf = (a >> BigInt((S * 8) - c)) & 1n ? 1 : 0;
          if (c === 1) this.f.of = ((r & SIGN[S] ? 1 : 0) ^ this.f.cf) ? 1 : 0;
          this.szp(r, S); this.set(insn.dst, r); } break; }
      case 'shr': { const c = Number(this.get(insn.src) & (S === 8 ? 0x3Fn : 0x1Fn));
        if (c) { const a = this.get(insn.dst), r = a >> BigInt(c);
          this.f.cf = (a >> BigInt(c - 1)) & 1n ? 1 : 0;
          if (c === 1) this.f.of = a & SIGN[S] ? 1 : 0;
          this.szp(r, S); this.set(insn.dst, r); } break; }
      case 'sar': { const c = Number(this.get(insn.src) & (S === 8 ? 0x3Fn : 0x1Fn));
        if (c) { const a = (this.get(insn.dst) ^ SIGN[S]) - SIGN[S], r = (a >> BigInt(c)) & M;
          this.f.cf = (a >> BigInt(c - 1)) & 1n ? 1 : 0;
          if (c === 1) this.f.of = 0;
          this.szp(r, S); this.set(insn.dst, r); } break; }
      case 'push': this.push(this.get(insn.src)); break;
      case 'pop': this.set(insn.dst, this.pop()); break;
      case 'jmp': this.rip = (next + insn.rel) & MASK[8]; break;
      case 'jcc': if (this.cond(insn.cond)) this.rip = (next + insn.rel) & MASK[8]; break;
      case 'cmov': { const v = this.get(insn.src);
        if (this.cond(insn.cond)) this.setReg(insn.dst, v);
        else if (S === 4) this.setReg(insn.dst, this.getReg(insn.dst));  // 32-bit cmov zeroes upper even when not taken
        break; }
      case 'setcc': this.set(insn.dst, this.cond(insn.cond) ? 1n : 0n); break;
      case 'call': this.push(next); this.rip = (next + insn.rel) & MASK[8]; break;
      case 'ret': this.rip = this.pop(); break;
      default: throw new Error('unimplemented ' + insn.mnem);
    }
    return insn;
  }
}
