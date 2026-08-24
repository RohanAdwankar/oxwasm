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
  // a [addr, addr+len) range as one typed-array view, or null if it spans regions
  view(addr, len) {
    if (len <= 0n) return null;
    const r = this.find(addr);
    const off = Number(addr - r.base);
    if (off + Number(len) > r.bytes.length) return null;
    return r.bytes.subarray(off, off + Number(len));
  }
}

export class CPU {
  constructor(mem) {
    this.mem = mem;
    this.regs = new Array(16).fill(0n);
    this.rip = 0n;
    this.xmm = new Array(16).fill(0n);          // 128-bit values as BigInt
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
    if (op.fs) a += this.fsBase || 0n;
    return a & (op.a32 ? MASK[4] : MASK[8]);
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
      case 'syscall':
        this.regs[1] = next;                      // rcx = return rip (arch behavior)
        this.regs[11] = this.flagsValue();        // r11 = rflags
        if (this.onSyscall) this.onSyscall(this); else throw new Error('syscall with no handler');
        break;
      case 'sse': {
        const M128 = (1n << 128n) - 1n;
        const rdRm = (bytes) => insn.rm.kind === 'xmm' ? this.xmm[insn.rm.r] & ((1n << BigInt(bytes*8)) - 1n)
                     : this.mem.read(this.ea(insn.rm), BigInt(bytes));
        const wrRm = (bytes, v) => { if (insn.rm.kind === 'xmm')
            this.xmm[insn.rm.r] = bytes === 16 ? v & M128 : (this.xmm[insn.rm.r] & ~((1n << BigInt(bytes*8)) - 1n)) | (v & ((1n << BigInt(bytes*8)) - 1n));
          else this.mem.write(this.ea(insn.rm), BigInt(bytes), v); };
        switch (insn.op) {
          case 0x6E:   // movd/movq xmm <- r/m (zero-extend to 128)
            this.xmm[insn.xr] = (insn.rm.kind === 'xmm' ? this.regs[insn.rm.r] :
              (insn.rm.kind === 'mem' ? this.mem.read(this.ea(insn.rm), insn.W ? 8n : 4n) : 0n));
            if (insn.rm.kind === 'reg') this.xmm[insn.xr] = this.regs[insn.rm.r];
            this.xmm[insn.xr] &= insn.W ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn;
            break;
          case 0x7E:
            if (insn.pF3) { this.xmm[insn.xr] = rdRm(8); }                        // movq xmm <- xmm/m64
            else {                                                                 // movd/movq r/m <- xmm
              const v = this.xmm[insn.xr] & (insn.W ? 0xFFFFFFFFFFFFFFFFn : 0xFFFFFFFFn);
              if (insn.rm.kind === 'xmm') this.regs[insn.rm.r] = v;                // mod=3: dest is GPR
              else this.mem.write(this.ea(insn.rm), insn.W ? 8n : 4n, v);
            }
            break;
          case 0xD6: wrRm(8, this.xmm[insn.xr] & 0xFFFFFFFFFFFFFFFFn); break;      // movq m/xmm <- xmm
          case 0x6F: case 0x10: case 0x28:
            if (insn.op === 0x10 && insn.pF3) { this.xmm[insn.xr] = (this.xmm[insn.xr] & ~0xFFFFFFFFn) | rdRm(4); }
            else if (insn.op === 0x10 && insn.pF2) { this.xmm[insn.xr] = (this.xmm[insn.xr] & ~0xFFFFFFFFFFFFFFFFn) | rdRm(8); }
            else this.xmm[insn.xr] = rdRm(16);
            break;
          case 0x7F: case 0x11: case 0x29:
            if (insn.op === 0x11 && insn.pF3) wrRm(4, this.xmm[insn.xr]);
            else if (insn.op === 0x11 && insn.pF2) wrRm(8, this.xmm[insn.xr]);
            else wrRm(16, this.xmm[insn.xr]);
            break;
          case 0x6C: {  // punpcklqdq: dst = [dst.lo64, src.lo64]
            const lo = this.xmm[insn.xr] & 0xFFFFFFFFFFFFFFFFn;
            this.xmm[insn.xr] = lo | ((rdRm(16) & 0xFFFFFFFFFFFFFFFFn) << 64n); break; }
          case 0xEF: this.xmm[insn.xr] = (this.xmm[insn.xr] ^ rdRm(16)) & M128; break;  // pxor
          case 0xDB: this.xmm[insn.xr] = this.xmm[insn.xr] & rdRm(16); break;           // pand
          case 0xEB: this.xmm[insn.xr] = (this.xmm[insn.xr] | rdRm(16)) & M128; break;  // por
          case 0x74: {  // pcmpeqb
            const a = this.xmm[insn.xr], b2 = rdRm(16); let r = 0n;
            for (let k = 0n; k < 16n; k++)
              if (((a >> (8n*k)) & 0xFFn) === ((b2 >> (8n*k)) & 0xFFn)) r |= 0xFFn << (8n*k);
            this.xmm[insn.xr] = r; break; }
          case 0xD7: {  // pmovmskb r32 <- xmm  (rm field is the GPR dest? no: reg=dst GPR, rm=xmm)
            const src = this.xmm[insn.rm.kind === 'xmm' ? insn.rm.r : 0]; let msk = 0n;
            for (let k = 0n; k < 16n; k++) if ((src >> (8n*k + 7n)) & 1n) msk |= 1n << k;
            this.regs[insn.xr] = msk; break; }
          case 0x12: this.xmm[insn.xr] = (this.xmm[insn.xr] & ~0xFFFFFFFFFFFFFFFFn) | rdRm(8); break;   // movlps/movlpd load low
          case 0x13: wrRm(8, this.xmm[insn.xr] & 0xFFFFFFFFFFFFFFFFn); break;                             // movlps store
          case 0x16: this.xmm[insn.xr] = (this.xmm[insn.xr] & 0xFFFFFFFFFFFFFFFFn) | (rdRm(8) << 64n); break; // movhps load high
          case 0x17: wrRm(8, this.xmm[insn.xr] >> 64n); break;                                            // movhps store
          case 0x14: {   // unpcklps/pd
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            if (insn.p66) this.xmm[insn.xr] = (a & 0xFFFFFFFFFFFFFFFFn) | ((b2 & 0xFFFFFFFFFFFFFFFFn) << 64n);
            else this.xmm[insn.xr] = (a & 0xFFFFFFFFn) | ((b2 & 0xFFFFFFFFn) << 32n) |
                 (((a >> 32n) & 0xFFFFFFFFn) << 64n) | (((b2 >> 32n) & 0xFFFFFFFFn) << 96n);
            break; }
          case 0x15: {   // unpckhps/pd
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            if (insn.p66) this.xmm[insn.xr] = ((a >> 64n) & 0xFFFFFFFFFFFFFFFFn) | (((b2 >> 64n) & 0xFFFFFFFFFFFFFFFFn) << 64n);
            else this.xmm[insn.xr] = ((a >> 64n) & 0xFFFFFFFFn) | (((b2 >> 64n) & 0xFFFFFFFFn) << 32n) |
                 (((a >> 96n) & 0xFFFFFFFFn) << 64n) | (((b2 >> 96n) & 0xFFFFFFFFn) << 96n);
            break; }
          case 0x60: case 0x61: case 0x62: case 0x68: case 0x69: case 0x6A: case 0x6D: {
            // punpck l/h bw/wd/dq/qdq via generic interleave
            const EB = { 0x60:1, 0x61:2, 0x62:4, 0x68:1, 0x69:2, 0x6A:4, 0x6D:8 }[insn.op];
            const high = insn.op >= 0x68;
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const n = 8 / EB;                        // elements per half
            const eb = BigInt(EB * 8), off = high ? BigInt(64) : 0n;
            let r = 0n;
            for (let k = 0n; k < BigInt(n); k++) {
              const ea = (a >> (off + k * eb)) & ((1n << eb) - 1n);
              const e2 = (b2 >> (off + k * eb)) & ((1n << eb) - 1n);
              r |= ea << (2n * k * eb);
              r |= e2 << ((2n * k + 1n) * eb);
            }
            this.xmm[insn.xr] = r; break; }
          case 0x70: {                                // pshufd (66) / pshuflw(F2)/hw(F3): implement 66 form
            const src = rdRm(16); let r = 0n;
            for (let k = 0n; k < 4n; k++) {
              const sel = BigInt((insn.imm8 >> Number(k) * 2) & 3);
              r |= ((src >> (sel * 32n)) & 0xFFFFFFFFn) << (k * 32n);
            }
            this.xmm[insn.xr] = r; break; }
          case 0xFB: case 0xFA: case 0xF9: case 0xF8: {   // psubq/d/w/b
            const EB = { 0xFB:8, 0xFA:4, 0xF9:2, 0xF8:1 }[insn.op];
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const eb = BigInt(EB*8), mask = (1n << eb) - 1n; let r = 0n;
            for (let k = 0n; k < BigInt(16/EB); k++)
              r |= ((((a >> (k*eb)) & mask) - ((b2 >> (k*eb)) & mask)) & mask) << (k*eb);
            this.xmm[insn.xr] = r; break; }
          case 0xD4: case 0xFE: case 0xFD: case 0xFC: {   // paddq/d/w/b
            const EB = { 0xD4:8, 0xFE:4, 0xFD:2, 0xFC:1 }[insn.op];
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const eb = BigInt(EB * 8), mask = (1n << eb) - 1n; let r = 0n;
            for (let k = 0n; k < BigInt(16 / EB); k++)
              r |= ((((a >> (k*eb)) & mask) + ((b2 >> (k*eb)) & mask)) & mask) << (k*eb);
            this.xmm[insn.xr] = r; break; }
          case 0x64: case 0x65: case 0x66: {             // pcmpgtb/w/d (signed)
            const EB = { 0x64:1, 0x65:2, 0x66:4 }[insn.op];
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const eb = BigInt(EB*8), mask = (1n << eb) - 1n, sbit = 1n << (eb-1n); let r = 0n;
            for (let k = 0n; k < BigInt(16/EB); k++) {
              const ea = ((a >> (k*eb)) & mask), e2 = ((b2 >> (k*eb)) & mask);
              const sa = (ea ^ sbit) - sbit, s2 = (e2 ^ sbit) - sbit;
              if (sa > s2) r |= mask << (k*eb);
            }
            this.xmm[insn.xr] = r; break; }
          case 0x75: case 0x76: {                      // pcmpeqw/d
            const EB = insn.op === 0x75 ? 2 : 4;
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const eb = BigInt(EB*8), mask = (1n << eb) - 1n; let r = 0n;
            for (let k = 0n; k < BigInt(16/EB); k++)
              if (((a >> (k*eb)) & mask) === ((b2 >> (k*eb)) & mask)) r |= mask << (k*eb);
            this.xmm[insn.xr] = r; break; }
          // ---- element-wise SSE2 integer ops (min/max, saturating, avg, mul, pack) ----
          case 0xDA: case 0xDE: case 0xEA: case 0xEE: case 0xD8: case 0xD9:
          case 0xDC: case 0xDD: case 0xE8: case 0xE9: case 0xEC: case 0xED:
          case 0xE0: case 0xE3: case 0xD5: case 0xE5: case 0xE4: {
            const OPS = {
              0xDA:[1,'minu'], 0xDE:[1,'maxu'], 0xEA:[2,'mins'], 0xEE:[2,'maxs'],
              0xD8:[1,'subus'], 0xD9:[2,'subus'], 0xDC:[1,'addus'], 0xDD:[2,'addus'],
              0xE8:[1,'subss'], 0xE9:[2,'subss'], 0xEC:[1,'addss'], 0xED:[2,'addss'],
              0xE0:[1,'avg'], 0xE3:[2,'avg'], 0xD5:[2,'mullo'], 0xE5:[2,'mulhs'], 0xE4:[2,'mulhu'],
            };
            const [EB, kind] = OPS[insn.op];
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const eb = BigInt(EB*8), mask = (1n << eb) - 1n, sbit = 1n << (eb-1n);
            const smin = -(sbit), smax = sbit - 1n;
            let r = 0n;
            for (let k = 0n; k < BigInt(16/EB); k++) {
              const ea = (a >> (k*eb)) & mask, e2 = (b2 >> (k*eb)) & mask;
              const sa = (ea ^ sbit) - sbit, s2 = (e2 ^ sbit) - sbit;
              let v;
              switch (kind) {
                case 'minu': v = ea < e2 ? ea : e2; break;
                case 'maxu': v = ea > e2 ? ea : e2; break;
                case 'mins': v = (sa < s2 ? sa : s2) & mask; break;
                case 'maxs': v = (sa > s2 ? sa : s2) & mask; break;
                case 'subus': v = ea > e2 ? ea - e2 : 0n; break;
                case 'addus': { const s = ea + e2; v = s > mask ? mask : s; break; }
                case 'subss': { let s = sa - s2; if (s < smin) s = smin; if (s > smax) s = smax; v = s & mask; break; }
                case 'addss': { let s = sa + s2; if (s < smin) s = smin; if (s > smax) s = smax; v = s & mask; break; }
                case 'avg': v = (ea + e2 + 1n) >> 1n; break;
                case 'mullo': v = (sa * s2) & mask; break;
                case 'mulhs': v = ((sa * s2) >> eb) & mask; break;
                case 'mulhu': v = ((ea * e2) >> eb) & mask; break;
              }
              r |= v << (k*eb);
            }
            this.xmm[insn.xr] = r; break; }
          case 0xF4: {                                 // pmuludq: lanes 0,2 u32 -> u64
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const lo = (a & 0xFFFFFFFFn) * (b2 & 0xFFFFFFFFn);
            const hi = ((a >> 64n) & 0xFFFFFFFFn) * ((b2 >> 64n) & 0xFFFFFFFFn);
            this.xmm[insn.xr] = (lo & 0xFFFFFFFFFFFFFFFFn) | ((hi & 0xFFFFFFFFFFFFFFFFn) << 64n); break; }
          case 0xF6: {                                 // psadbw: sum |a-b| per 8-byte half
            const a = this.xmm[insn.xr], b2 = rdRm(16); let r = 0n;
            for (const h of [0n, 1n]) { let s = 0n;
              for (let k = 0n; k < 8n; k++) { const i = h*8n + k;
                const ea = (a >> (8n*i)) & 0xFFn, e2 = (b2 >> (8n*i)) & 0xFFn;
                s += ea > e2 ? ea - e2 : e2 - ea; }
              r |= (s & 0xFFFFn) << (64n*h); }
            this.xmm[insn.xr] = r; break; }
          case 0x63: case 0x67: case 0x6B: {           // packsswb / packuswb / packssdw
            const [EB, uns] = insn.op === 0x6B ? [4, false] : [2, insn.op === 0x67];
            const eb = BigInt(EB*8), ob = eb/2n, mask = (1n << eb) - 1n, omask = (1n << ob) - 1n;
            const sbit = 1n << (eb-1n);
            const lo = uns ? 0n : -(1n << (ob-1n)), hi = uns ? omask : (1n << (ob-1n)) - 1n;
            const sat = (x) => { const s = (x ^ sbit) - sbit; return (s < lo ? lo : s > hi ? hi : s) & omask; };
            const a = this.xmm[insn.xr], b2 = rdRm(16);
            const n = BigInt(16/EB); let r = 0n;
            for (let k = 0n; k < n; k++) r |= sat((a  >> (k*eb)) & mask) << (k*ob);
            for (let k = 0n; k < n; k++) r |= sat((b2 >> (k*eb)) & mask) << ((n+k)*ob);
            this.xmm[insn.xr] = r; break; }
          case 0xC5: {                                 // pextrw r32 <- xmm[imm3]
            const src = this.xmm[insn.rm.kind === 'xmm' ? insn.rm.r : 0];
            this.regs[insn.xr] = (src >> (16n * BigInt(insn.imm8 & 7))) & 0xFFFFn; break; }
          case 0xC4: {                                 // pinsrw xmm[imm3] <- r/m16
            const v = insn.rm.kind === 'xmm' ? (this.regs[insn.rm.r] & 0xFFFFn) : this.mem.read(this.ea(insn.rm), 2n);
            const sh = 16n * BigInt(insn.imm8 & 7);
            this.xmm[insn.xr] = (this.xmm[insn.xr] & ~(0xFFFFn << sh)) | (v << sh); break; }
          default: throw new Error('sse op ' + insn.op.toString(16));
        }
        break; }
      case 'mul1': { const a = this.regs[0] & M, b2 = this.get(insn.src), full = a * b2;
        const hi = (full >> BigInt(S*8)) & M;
        this.setReg({kind:'reg',r:0,size:S}, full & M);
        if (S === 1) this.regs[0] = (this.regs[0] & ~0xFFFFn) | (full & 0xFFFFn);
        else this.setReg({kind:'reg',r:2,size:S}, hi);
        this.f.cf = this.f.of = hi !== 0n ? 1 : 0; break; }
      case 'imul1': { const sx = (v) => (v ^ SIGN[S]) - SIGN[S];
        const full = sx(this.regs[0] & M) * sx(this.get(insn.src));
        const lo = full & M, hi = (full >> BigInt(S*8)) & M;
        this.setReg({kind:'reg',r:0,size:S}, lo);
        if (S === 1) this.regs[0] = (this.regs[0] & ~0xFFFFn) | (full & 0xFFFFn);
        else this.setReg({kind:'reg',r:2,size:S}, hi);
        const sxlo = (lo ^ SIGN[S]) - SIGN[S];
        this.f.cf = this.f.of = sxlo !== full ? 1 : 0; break; }
      case 'div1': { const b2 = this.get(insn.src);
        if (b2 === 0n) throw new Error('divide by zero');
        const num = S === 1 ? this.regs[0] & 0xFFFFn
                  : ((this.regs[2] & M) << BigInt(S*8)) | (this.regs[0] & M);
        const q = num / b2, r = num % b2;
        if (S === 1) this.regs[0] = (this.regs[0] & ~0xFFFFn) | (q & 0xFFn) | ((r & 0xFFn) << 8n);
        else { this.setReg({kind:'reg',r:0,size:S}, q & M); this.setReg({kind:'reg',r:2,size:S}, r & M); }
        break; }
      case 'idiv1': { const sxN = (v, bits) => (v ^ (1n << (bits-1n))) - (1n << (bits-1n));
        const b2 = sxN(this.get(insn.src), BigInt(S*8));
        if (b2 === 0n) throw new Error('divide by zero');
        const num = S === 1 ? sxN(this.regs[0] & 0xFFFFn, 16n)
                  : sxN(((this.regs[2] & M) << BigInt(S*8)) | (this.regs[0] & M), BigInt(S*16));
        let q = num / b2; const r = num - q * b2;
        if (S === 1) this.regs[0] = (this.regs[0] & ~0xFFFFn) | (q & 0xFFn) | ((r & 0xFFn) << 8n);
        else { this.setReg({kind:'reg',r:0,size:S}, q & M); this.setReg({kind:'reg',r:2,size:S}, r & M); }
        break; }
      case 'cwde': {   // sign-extend low half of rax into the full width
        const half = S === 8 ? 4 : S === 4 ? 2 : 1;
        let v = this.regs[0] & MASK[half];
        v = ((v ^ SIGN[half]) - SIGN[half]) & MASK[S];
        this.setReg({ kind: 'reg', r: 0, size: S }, v); break; }
      case 'cdq': {    // sign of rax fills rdx
        const neg = (this.regs[0] & SIGN[S]) !== 0n;
        this.setReg({ kind: 'reg', r: 2, size: S }, neg ? MASK[S] : 0n); break; }
      case 'ssegrpshift': {   // psrlw/d/q, psllw/d/q, psra, pslldq/psrldq by imm
        const M128 = (1n << 128n) - 1n;
        const eb = insn.op === 0x71 ? 16n : insn.op === 0x72 ? 32n : 64n;
        const v = this.xmm[insn.xrm]; const c = BigInt(insn.imm8);
        const apply = (fn) => { const mask = (1n << eb) - 1n; let r = 0n;
          for (let k = 0n; k < 128n / eb; k++) r |= (fn((v >> (k*eb)) & mask) & mask) << (k*eb);
          return r; };
        if (insn.op === 0x73 && insn.sub === 3) this.xmm[insn.xrm] = (v >> (c * 8n)) & M128;       // psrldq
        else if (insn.op === 0x73 && insn.sub === 7) this.xmm[insn.xrm] = (v << (c * 8n)) & M128;  // pslldq
        else if (insn.sub === 2) this.xmm[insn.xrm] = apply(e => c >= eb ? 0n : e >> c);           // psrl
        else if (insn.sub === 6) this.xmm[insn.xrm] = apply(e => c >= eb ? 0n : e << c);           // psll
        else if (insn.sub === 4) this.xmm[insn.xrm] = apply(e => {                                  // psra
          const s = (e ^ (1n << (eb-1n))) - (1n << (eb-1n)); return (s >> (c >= eb ? eb-1n : c)); });
        else throw new Error('sse shift sub ' + insn.sub);
        break; }
      case 'cpuid': this.regs[0] = 0n; this.regs[3] = 0n; this.regs[1] = 0n; this.regs[2] = 0n; break;
      case 'movs': {
        const n = BigInt(S);
        // bulk fast path (DF=0): one typed-array copy unless the ranges
        // overlap with dst above src, where x86's forward element copy differs
        // from memmove — fall back to the exact loop there.
        if (insn.rep && this.regs[1] > 1n) {
          const len = this.regs[1] * n;
          const src = this.mem.view(this.regs[6], len), dst = this.mem.view(this.regs[7], len);
          const overlapUp = this.regs[7] > this.regs[6] && this.regs[7] < this.regs[6] + len;
          if (src && dst && !overlapUp) {
            dst.set(src);
            this.regs[6] = (this.regs[6] + len) & MASK[8];
            this.regs[7] = (this.regs[7] + len) & MASK[8];
            this.regs[1] = 0n;
            break;
          }
        }
        do {
          if (insn.rep && this.regs[1] === 0n) break;
          this.mem.write(this.regs[7], n, this.mem.read(this.regs[6], n));
          this.regs[6] = (this.regs[6] + n) & MASK[8];
          this.regs[7] = (this.regs[7] + n) & MASK[8];
          if (insn.rep) this.regs[1] = (this.regs[1] - 1n) & MASK[8];
        } while (insn.rep && this.regs[1] > 0n);
        break; }
      case 'stos': {
        const n = BigInt(S), v = this.regs[0] & MASK[S];
        if (insn.rep && this.regs[1] > 1n) {
          const len = this.regs[1] * n;
          const dst = this.mem.view(this.regs[7], len);
          if (dst) {
            if (S === 1) dst.fill(Number(v));
            else { const b = []; for (let i = 0n; i < n; i++) b.push(Number((v >> (8n*i)) & 0xFFn));
                   for (let o = 0; o < dst.length; o += S) for (let i = 0; i < S; i++) dst[o+i] = b[i]; }
            this.regs[7] = (this.regs[7] + len) & MASK[8];
            this.regs[1] = 0n;
            break;
          }
        }
        do {
          if (insn.rep && this.regs[1] === 0n) break;
          this.mem.write(this.regs[7], n, v);
          this.regs[7] = (this.regs[7] + n) & MASK[8];
          if (insn.rep) this.regs[1] = (this.regs[1] - 1n) & MASK[8];
        } while (insn.rep && this.regs[1] > 0n);
        break; }
      case 'xchg': { const a = this.get(insn.dst), b2 = this.get(insn.src);
        this.set(insn.dst, b2); this.set(insn.src, a); break; }
      case 'cmpxchg': { const dstv = this.get(insn.dst), acc = this.regs[0] & M;
        const r = (acc - dstv) & M; this.subFlags(acc, dstv, r, S);
        if (acc === dstv) this.set(insn.dst, this.get(insn.src) & M);
        else this.setReg({ kind: 'reg', r: 0, size: S }, dstv);
        break; }
      case 'xadd': { const a = this.get(insn.dst), b2 = this.get(insn.src), r = (a + b2) & M;
        this.addFlags(a, b2, r, S, a + b2 > M ? 1 : 0);
        this.set(insn.src, a); this.set(insn.dst, r); break; }
      case 'bswap': {
        const v = this.get(insn.dst); let r = 0n;
        for (let k = 0; k < S; k++) r |= ((v >> BigInt(8*k)) & 0xFFn) << BigInt(8*(S-1-k));
        this.set(insn.dst, r); break; }
      case 'bt': case 'bts': case 'btr': case 'btc': {
        const width = BigInt(S * 8);
        let bit, addr = null, cur;
        if (insn.dst.kind === 'reg') {
          bit = this.get(insn.src) % width;
          cur = this.get(insn.dst);
          this.f.cf = Number((cur >> bit) & 1n);
          if (insn.mnem !== 'bt') {
            if (insn.mnem === 'bts') cur |= 1n << bit;
            else if (insn.mnem === 'btr') cur &= ~(1n << bit);
            else cur ^= 1n << bit;
            this.set(insn.dst, cur & MASK[S]);
          }
        } else {
          // bit-string form: the bit index (signed for the register form)
          // selects a byte relative to the effective address
          const raw = insn.src.kind === 'imm' ? (insn.src.v % width) : BigInt.asIntN(64, this.get(insn.src));
          addr = this.ea(insn.dst) + (raw >> 3n);
          bit = ((raw % 8n) + 8n) % 8n;
          cur = this.mem.read(addr, 1n);
          this.f.cf = Number((cur >> bit) & 1n);
          if (insn.mnem !== 'bt') {
            if (insn.mnem === 'bts') cur |= 1n << bit;
            else if (insn.mnem === 'btr') cur &= ~(1n << bit);
            else cur ^= 1n << bit;
            this.mem.write(addr, 1n, cur & 0xFFn);
          }
        }
        break; }
      case 'shld': case 'shrd': {
        const width = BigInt(S * 8);
        const c = this.get(insn.src2) % (S === 8 ? 64n : 32n);
        if (c === 0n) break;
        const a = this.get(insn.dst), b2 = this.get(insn.src);
        let r;
        if (insn.mnem === 'shld') r = ((a << c) | (b2 >> (width - c))) & MASK[S];
        else r = ((a >> c) | (b2 << (width - c))) & MASK[S];
        this.f.cf = insn.mnem === 'shld' ? Number((a >> (width - c)) & 1n) : Number((a >> (c - 1n)) & 1n);
        this.szp(r, S);
        this.set(insn.dst, r); break; }
      case 'bsf': { const v = this.get(insn.src); this.f.zf = v === 0n ? 1 : 0;
        if (v !== 0n) { let k = 0n; while (!((v >> k) & 1n)) k++; this.setReg(insn.dst, k); } break; }
      case 'bsr': { const v = this.get(insn.src); this.f.zf = v === 0n ? 1 : 0;
        if (v !== 0n) { let k = BigInt(S*8 - 1); while (!((v >> k) & 1n)) k--; this.setReg(insn.dst, k); } break; }
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
      case 'rol': { const w = BigInt(S*8); const c = this.get(insn.src) % w;
        if (c) { const a = this.get(insn.dst); const r = ((a << c) | (a >> (w - c))) & M;
          this.f.cf = Number(r & 1n); this.set(insn.dst, r); } break; }
      case 'ror': { const w = BigInt(S*8); const c = this.get(insn.src) % w;
        if (c) { const a = this.get(insn.dst); const r = ((a >> c) | (a << (w - c))) & M;
          this.f.cf = Number((r >> (w - 1n)) & 1n); this.set(insn.dst, r); } break; }
      case 'push': this.push(this.get(insn.src)); break;
      case 'pop': this.set(insn.dst, this.pop()); break;
      case 'jmp': this.rip = (next + insn.rel) & MASK[8]; break;
      case 'jmpind': this.rip = this.get(insn.src); break;
      case 'callind': this.push(next); this.rip = this.get(insn.src); if (this.onCall) this.onCall(this.rip); break;
      case 'jcc': if (this.cond(insn.cond)) this.rip = (next + insn.rel) & MASK[8]; break;
      case 'cmov': { const v = this.get(insn.src);
        if (this.cond(insn.cond)) this.setReg(insn.dst, v);
        else if (S === 4) this.setReg(insn.dst, this.getReg(insn.dst));  // 32-bit cmov zeroes upper even when not taken
        break; }
      case 'setcc': this.set(insn.dst, this.cond(insn.cond) ? 1n : 0n); break;
      case 'call': this.push(next); this.rip = (next + insn.rel) & MASK[8]; if (this.onCall) this.onCall(this.rip); break;
      case 'ret': this.rip = this.pop(); break;
      case 'retn': this.rip = this.pop(); this.regs[4] = (this.regs[4] + insn.n) & MASK[8]; break;
      case 'leave': this.regs[4] = this.regs[5]; this.regs[5] = this.pop(); break;
      default: throw new Error('unimplemented ' + insn.mnem);
    }
    return insn;
  }
}
