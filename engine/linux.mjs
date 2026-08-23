// oxwasm M3 — run an UNMODIFIED Linux x86-64 static ELF binary.
//
// ELF64 loader + System V stack + a small Linux syscall layer over the
// tier-0 interpreter, with the tiering JIT compiling hot loops. The binary
// is normal compiler output (musl/glibc static); nothing about it is
// adapted for this engine.
import { CPU, Memory } from './interp.mjs';
import { compileLoop } from './jit2.mjs';
import { compileVectorLoop } from './jitsimd.mjs';
import { decode } from './decode.mjs';

const PAGE = 4096n;
const align = (v, a) => (v + a - 1n) & ~(a - 1n);

export class LinuxEngine {
  constructor(elfBytes, { argv = ['prog'], memMB = 256, threshold = 8 } = {}) {
    const dv = new DataView(elfBytes.buffer, elfBytes.byteOffset, elfBytes.length);
    if (dv.getUint32(0, true) !== 0x464c457f || elfBytes[4] !== 2)
      throw new Error('not an ELF64');
    this.entry = dv.getBigUint64(24, true);
    const phoff = Number(dv.getBigUint64(32, true));
    const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
    const loads = [];
    for (let i = 0; i < phnum; i++) {
      const o = phoff + i * phentsize;
      if (dv.getUint32(o, true) !== 1) continue;              // PT_LOAD
      loads.push({ off: Number(dv.getBigUint64(o + 8, true)),
                   vaddr: dv.getBigUint64(o + 16, true),
                   filesz: Number(dv.getBigUint64(o + 32, true)),
                   memsz: Number(dv.getBigUint64(o + 40, true)),
                   flags: dv.getUint32(o + 4, true) });
    }
    const lo = loads.reduce((m, s) => s.vaddr < m ? s.vaddr : m, loads[0].vaddr) & ~(PAGE - 1n);
    const loadEnd = loads.reduce((m, s) => { const e = s.vaddr + BigInt(s.memsz); return e > m ? e : m; }, 0n);
    this.base = lo;
    this.brk = align(loadEnd, PAGE);
    this.mmapNext = align(this.brk + (64n << 20n), PAGE);      // anon mmaps above the heap
    const total = BigInt(memMB) << 20n;
    this.stackTop = lo + total - 4096n;

    // one contiguous guest region backed by wasm memory -> interpreter and
    // JIT share it with zero copying
    this.RAMOFF = 1 << 20;
    const pages = Math.max(256, Math.ceil((this.RAMOFF + Number(total)) / 65536) + 16);
    this.wmem = new WebAssembly.Memory({ initial: pages });
    this.regview = new BigInt64Array(this.wmem.buffer, 0, 16);
    this.ram = new Uint8Array(this.wmem.buffer, this.RAMOFF, Number(total));
    for (const s of loads)
      this.ram.set(elfBytes.subarray(s.off, s.off + s.filesz), Number(s.vaddr - lo));
    this.execRanges = loads.filter(s => s.flags & 1)
      .map(s => [s.vaddr, s.vaddr + BigInt(s.memsz)]);

    this.mem = new Memory([{ base: lo, bytes: this.ram }]);
    this.cpu = new CPU(this.mem);
    this.cpu.fsBase = 0n;
    this.cpu.onSyscall = (cpu) => this.syscall(cpu);
    this.setupStack(argv);
    this.cpu.rip = this.entry;
    this.profile = new Map(); this.compiled = new Map();
    this.threshold = threshold;
    this.stats = { interpreted: 0, compiledRuns: 0, tiers: {}, syscalls: {} };
    this.exitCode = null;
    this.stdout = [];
  }

  setupStack(argv) {
    // strings + AT_RANDOM bytes, then the SysV block: argc argv[] 0 envp0 auxv
    let sp = this.stackTop & ~15n;
    const put = (bytes) => { sp -= BigInt(bytes.length); this.ram.set(bytes, Number(sp - this.base)); return sp; };
    const strPtrs = argv.map(s => put(new TextEncoder().encode(s + '\0')));
    const randPtr = put(crypto.getRandomValues(new Uint8Array(16)));
    sp &= ~15n;
    const auxv = [[25n, randPtr], [6n, 4096n], [0n, 0n]];     // AT_RANDOM, AT_PAGESZ, AT_NULL
    const words = [BigInt(argv.length), ...strPtrs, 0n, 0n,
                   ...auxv.flat()];
    if (words.length % 2 === 1) words.push(0n);               // keep rsp 16-aligned
    sp -= BigInt(words.length * 8);
    sp &= ~15n;
    const view = new DataView(this.wmem.buffer);
    words.forEach((w, i) => view.setBigUint64(this.RAMOFF + Number(sp - this.base) + i * 8, w, true));
    this.cpu.regs[4] = sp;
  }

  readCStrMem(addr, len) { return new TextDecoder().decode(this.ram.subarray(Number(addr - this.base), Number(addr - this.base) + len)); }

  syscall(cpu) {
    const nr = Number(cpu.regs[0]);
    const [a1, a2, a3] = [cpu.regs[7], cpu.regs[6], cpu.regs[2]];   // rdi rsi rdx
    this.stats.syscalls[nr] = (this.stats.syscalls[nr] || 0) + 1;
    const ret = (v) => { cpu.regs[0] = BigInt.asUintN(64, v); };
    switch (nr) {
      case 1: {                                              // write(fd, buf, len)
        this.stdout.push(this.readCStrMem(a2, Number(a3)));
        ret(a3); break; }
      case 20: {                                             // writev(fd, iov, cnt)
        const view = new DataView(this.wmem.buffer);
        let total = 0n;
        for (let i = 0; i < Number(a3); i++) {
          const io = this.RAMOFF + Number(a2 - this.base) + i * 16;
          const b = view.getBigUint64(io, true), l = view.getBigUint64(io + 8, true);
          if (l) this.stdout.push(this.readCStrMem(b, Number(l)));
          total += l;
        }
        ret(total); break; }
      case 12:                                               // brk
        if (a1 > this.brk) this.brk = align(a1, PAGE);
        ret(this.brk); break;
      case 9: {                                              // mmap (anon only)
        const len = align(a2, PAGE);
        const addr = this.mmapNext; this.mmapNext += len;
        ret(addr); break; }
      case 11: ret(0n); break;                               // munmap
      case 16: ret(-25n); break;                             // ioctl -> ENOTTY
      case 158:                                              // arch_prctl
        if (Number(a1) === 0x1002) { cpu.fsBase = a2; ret(0n); } else ret(-22n);
        break;
      case 218: ret(1n); break;                              // set_tid_address
      case 60: case 231:                                     // exit, exit_group
        this.exitCode = Number(a1 & 0xffn); cpu.halted = true; ret(0n); break;
      case 228: ret(0n); break;                              // clock_gettime (zeros)
      case 35: ret(0n); break;                               // nanosleep
      case 39: ret(1n); break;                               // getpid
      default:
        ret(-38n);                                           // ENOSYS
        (this.unknown ||= new Set()).add(nr);
    }
  }

  inExec(rip) { return this.execRanges.some(([a, b]) => rip >= a && rip < b); }

  run(maxSteps = 5e9) {
    let steps = 0;
    while (steps++ < maxSteps && this.exitCode === null) {
      const key = this.cpu.rip.toString();
      const c = this.compiled.get(key);
      if (c) {
        for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
        c.run();
        for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
        this.cpu.rip = c.exit; this.stats.compiledRuns++; continue;
      }
      const before = this.cpu.rip;
      let insn;
      try { insn = this.cpu.step(); }
      catch (e) { e.rip = before; throw e; }
      this.stats.interpreted++;
      if (insn.mnem === 'jcc' && this.cpu.rip < before && this.inExec(this.cpu.rip)) {
        const hk = this.cpu.rip.toString();
        if (!this.compiled.has(hk)) {
          const n = (this.profile.get(hk) || 0) + 1;
          this.profile.set(hk, n);
          if (n >= this.threshold) this.tryCompile(hk, this.cpu.rip);
        }
      }
    }
    return { exitCode: this.exitCode, stdout: this.stdout.join(''), stats: this.stats };
  }

  tryCompile(hk, head) {
    const opts = { guestBase: this.base, ramBase: this.RAMOFF };
    let blk = compileVectorLoop(this.mem, head, opts), kind = 'simd';
    if (!blk) { blk = compileLoop(this.mem, head, opts); kind = 'superblock'; }
    if (!blk) { this.compiled.set(hk, null); return; }
    let rip = head, exit = null;
    for (let i = 0; i < 600; i++) {
      const insn = decode((j) => Number(this.mem.read(rip + BigInt(j), 1n)), rip);
      rip += BigInt(insn.len);
      if (insn.mnem === 'jcc') { exit = rip; break; }
    }
    const inst = new WebAssembly.Instance(new WebAssembly.Module(blk.wasm), { js: { mem: this.wmem } });
    this.compiled.set(hk, { run: inst.exports.run, exit, kind });
    this.stats.tiers[kind] = (this.stats.tiers[kind] || 0) + 1;
  }
}
