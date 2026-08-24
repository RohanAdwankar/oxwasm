// oxwasm M3 — run an UNMODIFIED Linux x86-64 static ELF binary.
//
// ELF64 loader + System V stack + a small Linux syscall layer over the
// tier-0 interpreter, with the tiering JIT compiling hot loops. The binary
// is normal compiler output (musl/glibc static); nothing about it is
// adapted for this engine.
import { CPU, Memory } from './interp.mjs';
import { compileLoop } from './jit2.mjs';
import { compileVectorLoop } from './jitsimd.mjs';
import { compileUnitWat } from './aot_wat.mjs';
import { decode } from './decode.mjs';

const PAGE = 4096n;
const align = (v, a) => (v + a - 1n) & ~(a - 1n);
const EXIT = Symbol('guest-exit');           // unwinds live wasm frames on exit()
// A deopt DESTROYS the live wasm frames instead of interpreting under them:
// at the escape point every register was spilled to the regfile and all
// return addresses live on the guest stack, so the frames are pure execution
// vehicles — the interpreter can continue from `rip` with zero retained JS
// stack. This is what keeps escape handling O(1) in stack depth (a hot loop
// containing a jump table would otherwise grow the stack on every trip).
class DeoptUnwind { constructor(rip) { this.rip = rip; } }

export class LinuxEngine {
  // threshold: legacy tier-1.5 loop JIT trigger. Defaults OFF — it miscompiles
  // a vfprintf loop in glibc (wrong digits past the 22nd output byte) and the
  // tier-2 whole-frame AOT subsumes it. Pass a finite value to re-enable for
  // the tier's own test suites.
  constructor(elfBytes, { argv = ['prog'], env = [], memMB = 256, threshold = Infinity, files = {},
                          assembleWat = null, aotCallThreshold = 12, aotLoopThreshold = 40 } = {}) {
    this.files = files;                       // path -> Uint8Array (read-only)
    this.env = env;                           // "KEY=VALUE" strings
    this.fds = new Map();                     // fd -> { bytes, pos } ; 0/1/2 reserved
    this.nextFd = 3;

    const parseElf = (bytes) => {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
      if (dv.getUint32(0, true) !== 0x464c457f || bytes[4] !== 2) throw new Error('not an ELF64');
      const out = { etype: dv.getUint16(16, true), entry: dv.getBigUint64(24, true),
                    phoff: Number(dv.getBigUint64(32, true)),
                    phentsize: dv.getUint16(54, true), phnum: dv.getUint16(56, true),
                    loads: [], interp: null };
      for (let i = 0; i < out.phnum; i++) {
        const o = out.phoff + i * out.phentsize;
        const type = dv.getUint32(o, true);
        const seg = { off: Number(dv.getBigUint64(o + 8, true)),
                      vaddr: dv.getBigUint64(o + 16, true),
                      filesz: Number(dv.getBigUint64(o + 32, true)),
                      memsz: Number(dv.getBigUint64(o + 40, true)),
                      flags: dv.getUint32(o + 4, true) };
        if (type === 1) out.loads.push(seg);                 // PT_LOAD
        if (type === 3)                                       // PT_INTERP
          out.interp = new TextDecoder().decode(bytes.subarray(seg.off, seg.off + seg.filesz - 1));
      }
      return out;
    };

    const main = parseElf(elfBytes);
    // a PIE main has 0-based vaddrs: give it a conventional base
    const mainBias = main.etype === 3 ? 0x400000n : 0n;
    const lo = (main.loads.reduce((m, s) => s.vaddr < m ? s.vaddr : m, main.loads[0].vaddr) + mainBias) & ~(PAGE - 1n);
    let loadEnd = main.loads.reduce((m, s) => { const e = s.vaddr + mainBias + BigInt(s.memsz); return e > m ? e : m; }, 0n);

    // PT_INTERP: also map the dynamic linker and start there — it maps the
    // rest of the program itself through plain syscalls
    let interp = null, interpBase = 0n;
    if (main.interp) {
      const ib = files[main.interp];
      if (!ib) throw new Error('dynamic executable: interpreter not provided in files: ' + main.interp);
      interp = parseElf(ib); interp.bytes = ib;
      interpBase = align(loadEnd + (16n << 20n), PAGE);
      loadEnd = interp.loads.reduce((m, s) => { const e = s.vaddr + interpBase + BigInt(s.memsz); return e > m ? e : m; }, loadEnd);
    }
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
    this.fsview = new BigInt64Array(this.wmem.buffer, 128, 1);   // fs base for AOT TLS accesses
    this.ram = new Uint8Array(this.wmem.buffer, this.RAMOFF, Number(total));
    for (const s of main.loads)
      this.ram.set(elfBytes.subarray(s.off, s.off + s.filesz), Number(s.vaddr + mainBias - lo));
    this.execRanges = main.loads.filter(s => s.flags & 1)
      .map(s => [s.vaddr + mainBias, s.vaddr + mainBias + BigInt(s.memsz)]);
    if (interp) {
      for (const s of interp.loads)
        this.ram.set(interp.bytes.subarray(s.off, s.off + s.filesz), Number(s.vaddr + interpBase - lo));
      this.execRanges.push(...interp.loads.filter(s => s.flags & 1)
        .map(s => [s.vaddr + interpBase, s.vaddr + interpBase + BigInt(s.memsz)]));
    }
    this.entry = interp ? interp.entry + interpBase : main.entry + mainBias;
    // auxv facts the dynamic linker needs; the usual layout maps file offset 0
    // in the first PT_LOAD, so the phdrs sit at that segment's vaddr + phoff
    this.aux = { phdr: mainBias + (main.loads[0]?.vaddr ?? 0n) + BigInt(main.phoff),
                 phent: main.phentsize, phnum: main.phnum,
                 entry: main.entry + mainBias, base: interpBase };

    this.mem = new Memory([{ base: lo, bytes: this.ram }]);
    this.cpu = new CPU(this.mem);
    this.cpu.fsBase = 0n;
    this.cpu.onSyscall = (cpu) => this.syscall(cpu);
    this.argv0 = argv[0]; this.setupStack(argv);
    this.cpu.rip = this.entry;
    this.profile = new Map(); this.compiled = new Map();
    this.threshold = threshold;
    this.stats = { interpreted: 0, compiledRuns: 0, aotRuns: 0, tiers: {}, syscalls: {} };
    this.exitCode = null;
    this.stdout = [];
    // ---- tier-2: runtime whole-function AOT ----
    // assembleWat: (watText) -> Uint8Array of wasm; injected because the text
    // assembler differs by host (wat2wasm CLI under node, wabt.js in a page).
    this.assembleWat = assembleWat;
    this.aotFns = new Map();                  // ripStr -> wasm export
    this.aotFailed = new Set();
    this.aotCalls = new Map();                // call-target profile
    this.aotCallThreshold = aotCallThreshold;
    this.aotLoopThreshold = aotLoopThreshold;
    if (assembleWat) this.cpu.onCall = (t) => {
      const k = t.toString();
      if (this.aotFns.has(k) || this.aotFailed.has(k)) return;
      const n = (this.aotCalls.get(k) || 0) + 1;
      this.aotCalls.set(k, n);
      if (n >= this.aotCallThreshold) this.tierUpAot(t);
    };
  }

  // Compile the call-graph closure rooted at `entry` (a function entry or a
  // loop head — the translator only needs "runs forward to this frame's ret")
  // and register every function the unit produced for dispatch.
  tierUpAot(entry) {
    const k = entry.toString();
    if (this.aotFns.has(k) || this.aotFailed.has(k)) return;
    try {
      const unit = compileUnitWat(this.mem, entry, { guestBase: this.base, ramBase: this.RAMOFF });
      const bytes = this.assembleWat(unit.wat);
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { js: { mem: this.wmem }, env: this.aotEnv() });
      for (const a of unit.funcs) {
        const ak = a.toString();
        if (!this.aotFns.has(ak)) this.aotFns.set(ak, inst.exports['f_' + a.toString(16)]);
      }
      if (!this.aotFns.has(k)) throw new Error('entry missing from unit');
      this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
    } catch (e) { this.aotFailed.add(k); }
  }

  syncOut() { for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
              this.fsview[0] = BigInt.asIntN(64, this.cpu.fsBase || 0n); }
  syncIn()  { for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
              this.cpu.fsBase = BigInt.asUintN(64, this.fsview[0]); }

  // Run one compiled function; a deopt inside it (or its wasm callees)
  // unwinds here and execution state is already in the regfile/guest stack.
  // Returns the rip to continue at.
  dispatchAot(f) {
    this.syncOut();
    try { const exit = f(); this.syncIn(); this.stats.aotRuns++; return BigInt.asUintN(64, exit); }
    catch (e) { if (e instanceof DeoptUnwind) { this.syncIn(); return BigInt.asUintN(64, e.rip); } throw e; }
  }

  // Interpret (dispatching into compiled functions when rip lands on one)
  // until `done()` — used by the callout escape.
  interpUntil(done) {
    let guard = 0;
    while (!done()) {
      const f = this.aotFns.get(this.cpu.rip.toString());
      if (f) { this.cpu.rip = this.dispatchAot(f); continue; }
      this.cpu.step(); this.stats.interpreted++;
      if (this.exitCode !== null) throw EXIT;
      if (++guard > 5e9) throw new Error('escape runaway');
    }
  }

  aotEnv() {
    return {
      syscall: () => {
        this.syncIn();
        this.syscall(this.cpu);
        if (this.exitCode !== null) throw EXIT;
        this.syncOut();
      },
      callout: (target) => {
        target = BigInt.asUintN(64, target);
        this.syncIn();
        const retAddr = this.mem.read(this.cpu.regs[4], 8n);
        const rspExit = BigInt.asUintN(64, this.cpu.regs[4] + 8n);
        this.cpu.rip = target;
        this.interpUntil(() => this.cpu.rip === retAddr && this.cpu.regs[4] === rspExit);
        this.syncOut();
        return BigInt.asIntN(64, retAddr);
      },
      // rsp0 is unused: the frames unwind, they are not interpreted under.
      deopt: (rip, _rsp0) => { throw new DeoptUnwind(rip); },
    };
  }

  setupStack(argv) {
    // strings + AT_RANDOM bytes, then the SysV block:
    //   argc argv[]... 0 envp[]... 0 auxv...
    let sp = this.stackTop & ~15n;
    const put = (bytes) => { sp -= BigInt(bytes.length); this.ram.set(bytes, Number(sp - this.base)); return sp; };
    const strPtrs = argv.map(s => put(new TextEncoder().encode(s + '\0')));
    const envPtrs = this.env.map(s => put(new TextEncoder().encode(s + '\0')));
    const platPtr = put(new TextEncoder().encode('x86_64\0'));
    const randPtr = put(crypto.getRandomValues(new Uint8Array(16)));
    sp &= ~15n;
    const auxv = [
      [3n, this.aux.phdr], [4n, BigInt(this.aux.phent)], [5n, BigInt(this.aux.phnum)],  // AT_PHDR/PHENT/PHNUM
      [6n, 4096n], [7n, this.aux.base], [8n, 0n], [9n, this.aux.entry],                 // AT_PAGESZ/BASE/FLAGS/ENTRY
      [11n, 0n], [12n, 0n], [13n, 0n], [14n, 0n],                                       // uid/euid/gid/egid
      [15n, platPtr], [16n, 0n], [17n, 100n],                                           // AT_PLATFORM/HWCAP(0: baseline SSE2 only)/CLKTCK
      [23n, 0n], [25n, randPtr], [26n, 0n],                                             // AT_SECURE/RANDOM/HWCAP2
      [31n, strPtrs[0] ?? 0n],                                                          // AT_EXECFN
      [0n, 0n],
    ];
    const words = [BigInt(argv.length), ...strPtrs, 0n, ...envPtrs, 0n,
                   ...auxv.flat()];
    if (words.length % 2 === 1) words.push(0n);               // keep rsp 16-aligned
    sp -= BigInt(words.length * 8);
    sp &= ~15n;
    const view = new DataView(this.wmem.buffer);
    words.forEach((w, i) => view.setBigUint64(this.RAMOFF + Number(sp - this.base) + i * 8, w, true));
    this.cpu.regs[4] = sp;
  }

  readCStrMem(addr, len) { return new TextDecoder().decode(this.ram.subarray(Number(addr - this.base), Number(addr - this.base) + len)); }
  readPath(addr) { let p = '', a = addr;
    for (;;) { const c = Number(this.mem.read(a, 1n)); if (!c) break; p += String.fromCharCode(c); a++; }
    return p; }
  lookup(p) { return this.files[p] ?? this.files[p.replace(/^\.\//, '')]; }

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
      case 9: {                                              // mmap(addr,len,prot,flags,fd,off)
        const len = align(a2, PAGE);
        const flags = cpu.regs[10], fdArg = Number(BigInt.asIntN(32, cpu.regs[8] & 0xFFFFFFFFn));
        const FIXED = 0x10n, ANON = 0x20n;
        const at = (flags & FIXED) ? a1 : this.mmapNext;
        if (!(flags & FIXED)) this.mmapNext += len;
        const off0 = Number(at - this.base);
        if (off0 < 0 || off0 + Number(len) > this.ram.length) { ret(-12n); break; }   // ENOMEM
        this.ram.fill(0, off0, off0 + Number(len));          // fresh mapping is zeroed
        if (!(flags & ANON)) {
          const h = this.fds.get(fdArg);
          if (!h) { ret(-9n); break; }                       // EBADF
          const fo = Number(cpu.regs[9]);
          const n = Math.min(Number(a2), Math.max(0, h.bytes.length - fo));
          if (n > 0) this.ram.set(h.bytes.subarray(fo, fo + n), off0);
        }
        ret(at); break; }
      case 11: ret(0n); break;                               // munmap
      case 10: ret(0n); break;                               // mprotect (no page prot here)
      case 273: ret(0n); break;                              // set_robust_list
      case 334: ret(-38n); break;                            // rseq -> ENOSYS (glibc copes)
      case 302: {                                            // prlimit64: report infinity
        const oldp = cpu.regs[2];                            // rdx = old_limit
        if (oldp) { const v = new DataView(this.wmem.buffer);
          const off = this.RAMOFF + Number(oldp - this.base);
          v.setBigUint64(off, 0xFFFFFFFFFFFFFFFFn, true);
          v.setBigUint64(off + 8, 0xFFFFFFFFFFFFFFFFn, true); }
        ret(0n); break; }
      case 267: {                                            // readlinkat: /proc/self/exe -> argv0
        const buf = cpu.regs[2], sz = cpu.regs[10] ?? cpu.regs[8];
        const p = new TextEncoder().encode('/prog');
        this.ram.set(p.subarray(0, Number(sz)), Number(buf - this.base));
        ret(BigInt(Math.min(p.length, Number(sz)))); break; }
      case 318: {                                            // getrandom
        const buf = a1, len = Number(a2);
        const bytes = new Uint8Array(len);
        crypto.getRandomValues(bytes.subarray(0, Math.min(len, 65536)));
        this.ram.set(bytes, Number(buf - this.base));
        ret(BigInt(len)); break; }
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
      case 102: case 104: case 107: case 108: ret(0n); break; // getuid/getgid/geteuid/getegid
      case 105: case 106: ret(0n); break;                     // setuid/setgid
      case 157: ret(0n); break;                               // prctl
      case 96: ret(0n); break;                                // gettimeofday
      case 257: case 2: {                                     // openat(dirfd,path,flags) / open(path,flags)
        const p = this.readPath(nr === 257 ? a2 : a1);
        const f = this.lookup(p);
        if (f === undefined) { ret(-2n); break; }             // ENOENT
        const fd = this.nextFd++;
        this.fds.set(fd, { bytes: f, pos: 0 });
        ret(BigInt(fd)); break; }
      case 0: {                                               // read(fd, buf, len)
        const fd = Number(a1), h = this.fds.get(fd);
        if (!h) { ret(fd === 0 ? 0n : -9n); break; }          // stdin -> EOF
        const n = Math.min(Number(a3), h.bytes.length - h.pos);
        this.ram.set(h.bytes.subarray(h.pos, h.pos + n), Number(a2 - this.base));
        h.pos += n; ret(BigInt(n)); break; }
      case 3: this.fds.delete(Number(a1)); ret(0n); break;    // close
      case 8: {                                               // lseek
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        const w = Number(a3);                                 // rdx = whence
        const off = BigInt.asIntN(64, a2);
        h.pos = w === 0 ? Number(off) : w === 1 ? h.pos + Number(off) : h.bytes.length + Number(off);
        ret(BigInt(h.pos)); break; }
      case 5: case 262: {                                     // fstat / newfstatat
        const isAt = nr === 262;
        let size = null, mode = 0o020620;                     // default: char dev (tty)
        if (isAt) {
          const p = this.readPath(a2);
          if (p === '' && (cpu.regs[10] & 0x1000n)) {         // AT_EMPTY_PATH: stat the fd
            const h = this.fds.get(Number(a1));
            if (h) { size = h.bytes.length; mode = 0o100755; }
          } else {
            const f = this.lookup(p);
            if (f === undefined) { ret(-2n); break; }         // ENOENT
            size = f.length; mode = 0o100755;
          }
        } else {
          const h = this.fds.get(Number(a1));
          if (h) { size = h.bytes.length; mode = 0o100755; }
        }
        const buf = isAt ? cpu.regs[2] : a2;
        const off = this.RAMOFF + Number(buf - this.base);
        new Uint8Array(this.wmem.buffer, off, 144).fill(0);
        const v = new DataView(this.wmem.buffer);
        v.setBigUint64(off + 0, 8n, true);                    // st_dev
        v.setBigUint64(off + 8, BigInt((Math.abs(size ?? 7) % 1e6) + 2), true);  // st_ino (distinct-ish)
        v.setBigUint64(off + 16, 1n, true);                   // st_nlink
        v.setUint32(off + 24, mode, true);                    // st_mode (u32 at 24)
        v.setBigUint64(off + 48, BigInt(size ?? 0), true);    // st_size
        v.setBigUint64(off + 56, 4096n, true);                // st_blksize
        v.setBigUint64(off + 64, BigInt(Math.ceil((size ?? 0) / 512)), true);    // st_blocks
        ret(0n); break; }
      case 17: {                                              // pread64(fd, buf, count, off)
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        const fo = Number(cpu.regs[10]);
        const n = Math.min(Number(a3), Math.max(0, h.bytes.length - fo));
        if (n > 0) this.ram.set(h.bytes.subarray(fo, fo + n), Number(a2 - this.base));
        ret(BigInt(n)); break; }
      case 21: ret(this.lookup(this.readPath(a1)) !== undefined ? 0n : -2n); break;     // access
      case 269: ret(this.lookup(this.readPath(a2)) !== undefined ? 0n : -2n); break;    // faccessat
      case 63: {                                              // uname
        const put = (o, s) => { const b = new TextEncoder().encode(s + '\0');
          this.ram.set(b, Number(a1 - this.base) + o); };
        this.ram.fill(0, Number(a1 - this.base), Number(a1 - this.base) + 390);
        put(0, 'Linux'); put(65, 'oxwasm'); put(130, '6.1.0'); put(195, '#1 oxwasm');
        put(260, 'x86_64'); ret(0n); break; }
      case 89: {                                              // readlink(path, buf, sz)
        const p = this.readPath(a1);
        if (p === '/proc/self/exe') { const b = new TextEncoder().encode(this.argv0 || '/prog');
          this.ram.set(b.subarray(0, Number(a3)), Number(a2 - this.base));
          ret(BigInt(Math.min(b.length, Number(a3)))); break; }
        ret(-22n); break; }                                   // EINVAL: not a symlink
      case 79: {                                              // getcwd
        const b = new TextEncoder().encode('/\0');
        this.ram.set(b, Number(a1 - this.base)); ret(2n); break; }
      case 202: {                                             // futex (single-threaded)
        const op = Number(a2) & 0x7f;
        if (op === 0) {                                       // WAIT: value check only
          const cur = Number(this.mem.read(a1, 4n));
          ret(cur !== Number(a3 & 0xFFFFFFFFn) ? -11n : 0n);  // EAGAIN or "woken"
        } else ret(0n);                                       // WAKE etc: nobody to wake
        break; }
      case 13: case 14: ret(0n); break;                       // rt_sigaction / rt_sigprocmask
      case 131: ret(0n); break;                               // sigaltstack
      case 99: {                                              // sysinfo: zeros
        this.ram.fill(0, Number(a1 - this.base), Number(a1 - this.base) + 112); ret(0n); break; }
      case 332: ret(-38n); break;                             // statx -> ENOSYS (glibc falls back)
      case 217: ret(-2n); break;                              // getdents64
      case 72: ret(0n); break;                                // fcntl
      case 28: ret(0n); break;                                // madvise
      case 110: ret(0n); break;                               // getppid
      case 186: ret(1n); break;                               // gettid
      case 25: ret(-38n); break;                              // mremap -> ENOSYS
      default:
        ret(-38n);                                           // ENOSYS
        (this.unknown ||= new Set()).add(nr);
    }
  }

  inExec(rip) { return this.execRanges.some(([a, b]) => rip >= a && rip < b); }

  run(maxSteps = 5e9) {
    let steps = 0;
    try {
      while (steps++ < maxSteps && this.exitCode === null) {
        const key = this.cpu.rip.toString();
        const f = this.aotFns.get(key);
        if (f) { this.cpu.rip = this.dispatchAot(f); continue; }
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
        catch (e) { if (e === EXIT) break; e.rip = before; throw e; }
        this.stats.interpreted++;
        if (insn.mnem === 'jcc' && this.cpu.rip < before && this.inExec(this.cpu.rip)) {
          const hk = this.cpu.rip.toString();
          const n = (this.profile.get(hk) || 0) + 1;
          this.profile.set(hk, n);
          // hot loop: first the cheap loop tiers, then whole-frame AOT from
          // the loop head (the unit translator only needs "forward to ret")
          if (n >= this.threshold && !this.compiled.has(hk)) this.tryCompile(hk, this.cpu.rip);
          if (this.assembleWat && n >= this.aotLoopThreshold && !this.aotFns.has(hk) && !this.aotFailed.has(hk))
            this.tierUpAot(this.cpu.rip);
        }
      }
    } catch (e) { if (e !== EXIT) throw e; }
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
