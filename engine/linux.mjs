// oxwasm M3 — run an UNMODIFIED Linux x86-64 static ELF binary.
//
// ELF64 loader + System V stack + a small Linux syscall layer over the
// tier-0 interpreter, with the tiering JIT compiling hot loops. The binary
// is normal compiler output (musl/glibc static); nothing about it is
// adapted for this engine.
import { CPU, Memory } from './interp.mjs';
import { compileLoop } from './jit2.mjs';
import { compileVectorLoop } from './jitsimd.mjs';
import { compileUnitWat, pltStubWat, FTMAP, FTMAP_MAX, FTDLIMIT, FTFUEL, FTLOOP, FTNEST, LOOPYIELD_N,
         FTHASH, FTHBITS, FTHMASK, FTHBYTES } from './aot_wat.mjs';
import { decode } from './decode.mjs';

const PAGE = 4096n;
const align = (v, a) => (v + a - 1n) & ~(a - 1n);
const EXIT = Symbol('guest-exit');           // unwinds live wasm frames on exit()
const SHADOW_ABORT = { shadowAbort: true };
const BRANCHY = new Set(['jmp','jcc','call','ret','retn','jmpind','callind','syscall','leave','hlt','int3']);
// A deopt DESTROYS the live wasm frames instead of interpreting under them:
// at the escape point every register was spilled to the regfile and all
// return addresses live on the guest stack, so the frames are pure execution
// vehicles — the interpreter can continue from `rip` with zero retained JS
// stack. This is what keeps escape handling O(1) in stack depth (a hot loop
// containing a jump table would otherwise grow the stack on every trip).
const PIPE_CAP = 65536;                       // Linux default pipe capacity
// syscalls that sleep: a timer expiring on their entry interrupts them
const SLEEPY = new Set([34, 35, 230, 130, 128, 7, 271, 23, 270, 232, 281, 61, 202]);
const SYNTH_DIRS = new Set(['/proc', '/proc/self', '/proc/self/fd', '/proc/self/task', '/proc/sys', '/proc/sys/kernel',
                            '/proc/sys/kernel/random', '/proc/sys/vm', '/proc/sys/fs', '/dev', '/dev/pts', '/dev/fd']);
class DeoptUnwind { constructor(rip) { this.rip = rip; } }
// A blocking syscall (poll/select/read with nothing ready, nanosleep) suspends
// the guest the same way a deopt escapes compiled code: every register is
// already in the regfile / cpu and the syscall insn's rip is recorded, so ALL
// wasm frames are destroyed and the engine returns to its caller with
// `engine.blocked` set. Resuming just re-enters run(): the syscall RE-EXECUTES
// (rax still holds the syscall number) and either completes or blocks again.
class BlockUnwind { constructor(rip) { this.rip = rip; } }

const UNPRUNE = new Set(((typeof process !== 'undefined' && process.env?.OXWASM_UNPRUNE) || '').split(',').filter(Boolean).map(h => BigInt('0x' + h).toString()));

export class LinuxEngine {
  // threshold: legacy tier-1.5 loop JIT trigger. Defaults OFF — it miscompiles
  // a vfprintf loop in glibc (wrong digits past the 22nd output byte) and the
  // tier-2 whole-frame AOT subsumes it. Pass a finite value to re-enable for
  // the tier's own test suites.
  constructor(elfBytes, { argv = ['prog'], env = [], memMB = 256, threshold = Infinity, files = {},
                          assembleWat = null, aotCallThreshold = 4, aotLoopThreshold = 12,
                          xserver = null, mtimes = {}, tty = false, ttyRows = 24, ttyCols = 80,
                          stdin = null } = {}) {
    this.files = files;                       // path -> Uint8Array (read-only)
    // kept for fork materialisation: a blocked vfork-window child becomes a
    // real child engine built from the same image and options
    this._ctor = { elfBytes, argv, env, memMB, threshold, assembleWat, aotCallThreshold, aotLoopThreshold,
                   xserver, mtimes, tty, ttyRows, ttyCols, stdin };
    // Terminal mode: with it off, ioctl answers ENOTTY for everything, so
    // isatty() is false, `tty` prints "not a tty", stty fails outright and a
    // shell disables job control. With it on the standard fds and /dev/tty
    // look like a terminal and carry termios state.
    this.tty = tty;
    this.ttyWin = { rows: ttyRows, cols: ttyCols };
    this.termios = tty ? LinuxEngine.defaultTermios() : null;
    this.ptys = new Map();                    // pty number -> {m2s, s2m, termios, win}
    this.env = env;                           // "KEY=VALUE" strings
    // display/input layer: an X11-protocol server object (see xserver.mjs).
    // AF_UNIX connects to /tmp/.X11-unix/X* attach to it; its screen is the
    // engine's framebuffer and its event queue is the engine's input.
    this.xserver = xserver;
    this.mtimes = mtimes;                     // guest path -> mtime seconds (fontconfig cache validation)
    this.blocked = null;                      // {deadline: ms|null} while suspended on a blocking syscall
    this._deadline = null;                    // survives re-execution of the same blocked poll/select/sleep
    // real fd table: 0 empty stdin, 1 stdout, 2 stderr. open() and dup()
    // allocate the LOWEST free fd, like Linux — busybox relies on
    // close(0); open(file) landing the file on fd 0.
    this.fds = new Map();
    this.cloexec = new Set();                 // fd numbers with FD_CLOEXEC (per-descriptor, not per-handle)
    // fd 0 is an ordinary read handle over a byte buffer, so giving the guest
    // real stdin is just filling it in. Without this every filter that reads
    // stdin (tr, bc, and most of a shell pipeline) saw EOF immediately and
    // produced nothing - which reads as a miscompile until you notice the
    // program was handed no input.
    this.fds.set(0, { bytes: stdin ? new Uint8Array(stdin) : new Uint8Array(0), pos: 0 });
    this.fds.set(1, { sink: 'out' });
    this.fds.set(2, { sink: 'err' });

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
    this.brk = align(loadEnd, PAGE); this._brk0 = this.brk;
    const total = BigInt(memMB) << 20n;
    // The anonymous-mmap arena starts a quarter of guest RAM (at least 64MB)
    // above the initial break, and brk may NOT grow into it: past that line
    // it answers with the break unchanged and glibc's malloc falls back to
    // mmap, exactly as on Linux when the heap meets a mapping. vim on a 14MB
    // file grew a 64MB+ heap straight through ld.so's first mmapped pages -
    // the link_map chain - and _dl_fini walked an l_next of 0x31 at exit.
    this.mmapNext = align(this.brk + (total / 4n > (64n << 20n) ? total / 4n : (64n << 20n)), PAGE);
    this._mmapBase = this.mmapNext;
    this.stackTop = lo + total - 4096n;

    // one contiguous guest region backed by wasm memory -> interpreter and
    // JIT share it with zero copying
    this.RAMOFF = 1 << 20;
    const pages = Math.max(256, Math.ceil((this.RAMOFF + Number(total)) / 65536) + 16);
    this.wmem = new WebAssembly.Memory({ initial: pages });
    // global dispatch table: every registered compiled function gets a slot
    // here plus a sorted (addr -> slot) entry in wasm memory at FTMAP, so
    // units chain indirect calls / cross-unit calls wasm-to-wasm (see $ftr)
    // Sized up front rather than grown on demand: every unit imports this
    // table, so a grow has to fix up each importing instance's cached table
    // base — with thousands of units that made growth O(instances), and the
    // handful of grows during a warm GIMP menu cycle cost 12% of it. Sizing
    // it once, before any instance exists, is free.
    this.ftab = new WebAssembly.Table({ element: 'anyfunc', initial: FTMAP_MAX });
    this._ftCount = 0; this._ftSeen = new Set();
    this.regview = new BigInt64Array(this.wmem.buffer, 0, 16);
    this.fsview = new BigInt64Array(this.wmem.buffer, 128, 1);   // fs base for AOT TLS accesses
    this.xmmview = new BigInt64Array(this.wmem.buffer, 256, 32); // 16 xmm regs (2 words each) for AOT SIMD
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
    // loop tiers (superblock/simd) stay on this proven ground; unit tier-up
    // profiling uses the full (mmap-widened) execRanges
    this.execRangesStatic = this.execRanges.slice();
    this.entry = interp ? interp.entry + interpBase : main.entry + mainBias;
    // auxv facts the dynamic linker needs; the usual layout maps file offset 0
    // in the first PT_LOAD, so the phdrs sit at that segment's vaddr + phoff
    this.aux = { phdr: mainBias + (main.loads[0]?.vaddr ?? 0n) + BigInt(main.phoff),
                 phent: main.phentsize, phnum: main.phnum,
                 entry: main.entry + mainBias, base: interpBase };

    // The legacy vsyscall page (0xffffffffff600000): gettimeofday at +0,
    // time at +0x400, getcpu at +0x800, each `mov eax, nr; syscall; ret` as
    // the kernel's emulation executes them. HotSpot probes the page with a
    // data read at startup and the interpreter faulted on it; it lives only
    // in this region list (units cannot address it - a call there misses
    // the dispatch table and the interpreter runs the stub).
    const vsys = new Uint8Array(4096);
    for (const [off, nr] of [[0, 96], [0x400, 201], [0x800, 309]])
      vsys.set([0xb8, nr & 0xff, (nr >> 8) & 0xff, 0, 0, 0x0f, 0x05, 0xc3], off);
    this.mem = new Memory([{ base: lo, bytes: this.ram }, { base: 0xffffffffff600000n, bytes: vsys }]);
    this.cpu = new CPU(this.mem);
    this.cpu.fsBase = 0n;
    this.cpu.onSyscall = (cpu) => this.syscall(cpu);
    // green threads: clone(CLONE_VM) adds a CPU context over the shared
    // memory; the scheduler switches at block points (every blocking syscall
    // already unwinds to run() and re-executes on resume, so a switch is
    // always at a clean instruction boundary) and on a step quantum.
    this.threads = [{ id: 1, cpu: this.cpu, state: 'run', dl: null, futex: null, ctid: 0n, _dl: null }];
    this.ti = 0; this.nextTid = 2; this._futexAddr = null;
    this.argv0 = argv[0]; this.setupStack(argv);
    this.cpu.rip = this.entry;
    this.profile = new Map(); this.compiled = new Map();
    this.threshold = threshold;
    this.stats = { interpreted: 0, compiledRuns: 0, aotRuns: 0, tiers: {}, syscalls: {} };
    this._ftFull = 0;                         // functions refused by the FTMAP_MAX ceiling
    this.exitCode = null;
    this.stdout = [];
    this.stdoutBytes = [];                    // raw chunks — binary-safe (gzip -c etc.)
    // ---- tier-2: runtime whole-function AOT ----
    // assembleWat: (watText) -> Uint8Array of wasm; injected because the text
    // assembler differs by host (wat2wasm CLI under node, wabt.js in a page).
    this.assembleWat = assembleWat;
    this.aotFns = new Map();                  // ripStr -> wasm export
    this.aotFailed = new Set();
    this.tierMs = 0;                          // sync translation time this slice (host zeroes; see tierMsMax)
    this.aotCalls = new Map();                // call-target profile
    this._unprune = UNPRUNE;
    this.aotCallThreshold = aotCallThreshold;
    this.aotLoopThreshold = aotLoopThreshold;
    if (assembleWat) {
      this.cpu.onCall = (t) => this.profileTarget(t);
      // a PLT stub reaches the real function via `jmp *GOT` — profile the
      // indirect-jump landing so tail-called library functions (memcpy,
      // strlen, ...) tier up like directly-called ones.
      this.cpu.onJmp = (t) => { if (this.inExec(t)) this.profileTarget(t); };
    }
  }

  profileTarget(t) {
    const k = t;
    if (this.aotFns.has(k) || this.aotFailed.has(k)) return;
    const n = (this.aotCalls.get(k) || 0) + 1;
    this.aotCalls.set(k, n);
    if (n >= this.aotCallThreshold) this.tierUpAot(t);
  }

  // A PLT/IFUNC stub is `endbr64?; jmp *GOT` — compiling it just deopts back
  // to the real function AND, worse, once compiled its indirect jump runs in
  // wasm so the interpreter never profiles the real target. Refuse it: keep it
  // interpreted (2 instructions, trivial) so onJmp keeps profiling the callee.
  isTrampoline(entry) {
    try {
      let rip = entry, n = 0;
      for (;;) {
        const insn = decode((i) => Number(this.mem.read(rip + BigInt(i), 1n)), rip);
        if (insn.mnem === 'jmpind') return true;
        if (insn.mnem === 'nop') { rip += BigInt(insn.len); if (++n > 3) return false; continue; }
        return false;                                  // any real work -> compile it
      }
    } catch { return false; }
  }

  // For a `jmp *[GOT]` stub with a register-free address, read where it
  // points right now. Post-boot GOT slots are resolved and stable, so the
  // stub can alias its callee's compiled function outright.
  // Decode a PLT/IFUNC stub (`endbr64/nops then jmp *GOT`) down to its GOT
  // SLOT ADDRESS — the slot address is immutable even though the slot's
  // VALUE is rebound (lazy resolution; ld.so re-relocating itself).
  trampolineGotAddr(entry) {
    try {
      let rip = entry;
      for (let n = 0; n <= 4; n++) {
        const insn = decode((i) => Number(this.mem.read(rip + BigInt(i), 1n)), rip);
        if (insn.mnem === 'nop') { rip += BigInt(insn.len); continue; }
        if (insn.mnem !== 'jmpind') return null;
        const op = insn.src;
        if (!op || op.kind === 'reg' || op.base >= 0 || op.index >= 0 || op.fs) return null;
        let a = op.disp;
        if (op.ripRel) a += rip + BigInt(insn.len);
        return BigInt.asUintN(64, a);
      }
      return null;
    } catch { return null; }
  }

  trampolineTarget(entry) {
    const a = this.trampolineGotAddr(entry);
    try { return a !== null ? this.mem.read(a, 8n) : null; } catch { return null; }
  }

  // Compile the call-graph closure rooted at `entry` (a function entry or a
  // loop head — the translator only needs "runs forward to this frame's ret")
  // and register every function the unit produced for dispatch.
  // Register one compiled function for dispatch AND for in-wasm chaining:
  // aotFns serves the engine's JS dispatch; the funcref table + the sorted
  // (addr, slot) map at FTMAP serve every unit's $ftr resolver, which lets
  // compiled code make indirect calls / cross-unit calls / indirect tail
  // jumps without a JS boundary or regfile sync.
  registerAotFn(a, f) {
    this.aotFns.set(a, f);
    // __noFtab bisect lever: an empty map makes every $ftr miss, so all
    // sites take their pre-existing x_callout / x_deopt fallbacks
    // Past FTMAP_MAX the function is never mapped, so every cross-unit call to
    // it takes the x_callout JS round-trip forever. That is a silent cliff, so
    // count it: the shipped GIMP demo has 13,173 distinct AOT functions across
    // 7,653 units, which is 66% of the ceiling - close enough that a larger app
    // could cross it, and there would otherwise be nothing to see.
    //
    // Raising FTMAP_MAX alone is not enough: $ftr probes the FTHASH table
    // linearly and that table has FTSLOTS (32,768) entries, so past roughly
    // 26,000 mapped functions the probe chains degrade and at 32,768 an
    // unmapped lookup would never find an empty slot to stop on. The hash has
    // to grow with the ceiling - it is 40% loaded today.
    if (!f || globalThis.__noFtab || this._ftSeen.has(a)) return;
    if (this._ftCount >= FTMAP_MAX) { this._ftFull = (this._ftFull || 0) + 1; return; }
    this._ftSeen.add(a);
    const idx = this._ftCount++;
    this.ftab.set(idx, f);
    const dv = new DataView(this.wmem.buffer);
    const au = BigInt.asUintN(64, a);
    // open addressing with linear probing, mirroring $ftr's own walk
    let p = FTHASH + (((Math.imul(Number(au & 0xFFFFFFFFn), 0x9E3779B1) >>> (32 - FTHBITS))) << 4);
    for (;;) {
      const k = dv.getBigUint64(p, true);
      if (k === 0n || k === au) break;
      p = FTHASH + (((p - FTHASH) + 16) & FTHMASK);
    }
    dv.setBigUint64(p, au, true);
    dv.setUint32(p + 8, idx, true);
    dv.setUint32(FTMAP, this._ftCount, true);
  }

  // ---- mmap arena: bump pointer plus a sorted list of holes munmap returned
  _mmapTake(len) {
    const holes = (this._mmapHoles ??= []);
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i], sz = h[1] - h[0];
      if (sz < len) continue;
      const at = h[0];
      if (sz === len) holes.splice(i, 1); else h[0] += len;
      return at;
    }
    const at = this.mmapNext; this.mmapNext += len; return at;
  }
  _mmapFree(lo, len) {                              // is [lo, lo+len) unmapped as far as the arena knows?
    if (this._mmapBase === undefined) return false; // no arena knowledge (an engine restored from an old state): never claim free
    const hi = lo + len, base = this._mmapBase;
    if (lo < base) return false;                    // below the arena: ELF, brk - not ours to say
    if (lo >= this.mmapNext) return hi - this.base <= BigInt(this.ram.length);
    for (const h of (this._mmapHoles ??= [])) if (lo >= h[0] && hi <= h[1]) return true;
    return false;
  }
  _mmapCarve(lo, len) {                             // a fixed mapping lands here: remove it from holes, advance the bump past it
    const hi = lo + len, holes = (this._mmapHoles ??= []);
    for (let i = 0; i < holes.length; i++) {
      const h = holes[i];
      if (hi <= h[0] || lo >= h[1]) continue;
      const parts = [];
      if (h[0] < lo) parts.push([h[0], lo]);
      if (hi < h[1]) parts.push([hi, h[1]]);
      holes.splice(i, 1, ...parts); i += parts.length - 1;
    }
    if (lo >= (this._mmapBase ?? 0n) && hi > this.mmapNext && lo <= this.mmapNext) this.mmapNext = hi;
  }
  _mmapGive(lo, len) {
    if (this._mmapBase === undefined) return;       // no arena knowledge: reuse nothing
    const base = this._mmapBase, hi = lo + len;
    if (lo < base || hi > this.mmapNext || len <= 0n) return;   // not the arena's (fixed spans, brk): leave it
    const holes = (this._mmapHoles ??= []);
    let i = 0; while (i < holes.length && holes[i][1] < lo) i++;
    // merge with a hole ending at lo and/or starting at hi
    let nlo = lo, nhi = hi;
    if (i < holes.length && holes[i][1] === lo) { nlo = holes[i][0]; holes.splice(i, 1); }
    if (i < holes.length && holes[i][0] === hi) { nhi = holes[i][1]; holes.splice(i, 1); }
    if (nhi === this.mmapNext) { this.mmapNext = nlo; return; }  // top of the arena: shrink the bump instead
    holes.splice(i, 0, [nlo, nhi]);
  }
  aotImports() { return { js: { mem: this.wmem, ftab: this.ftab }, env: this.aotEnv() }; }

  // Rebuild the in-memory (addr, slot) dispatch map from aotFns. Snapshot
  // restore must invalidate the map baked into the restored image (its slots
  // belong to the CAPTURE engine's table), but zeroing alone was a trap:
  // functions registered before the async tile chain finished stayed in
  // aotFns yet never re-entered the map — every in-wasm resolution missed
  // and each tail jump/call paid a JS hop (measured: ~500k callouts and
  // ~50k deopts per warm GIMP menu cycle, all to compiled-but-unmapped
  // functions).
  rebuildFtmap() {
    new DataView(this.wmem.buffer).setUint32(FTMAP, 0, true);
    // open addressing has no in-place delete: clearing and reinserting is
    // the only way to drop an entry (a blacklisted unit, a restored image)
    new Uint8Array(this.wmem.buffer, FTHASH, FTHBYTES).fill(0);
    this._ftCount = 0; this._ftSeen = new Set();
    for (const [a, f] of this.aotFns)
      if (f && !f.jsStub) this.registerAotFn(a, f);
  }

  // Register a unit's exports once its instance exists. Shared by both
  // off-thread paths (async assemble, async compile): a placeholder null is
  // already in aotFns for the entry, so `get` — not `has` — is what decides
  // whether an address still needs registering.
  finishAotUnit(unit, instance) {
    for (const a of unit.funcs)
      if (!this.aotFns.get(a)) this.registerAotFn(a, instance.exports['f_' + a.toString(16)]);
    if (instance.exports.drive) this.aotDrive = instance.exports.drive;
    this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
  }

  tierUpAot(entry) {
    const k = entry;
    if (this.aotFns.has(k) || this.aotFailed.has(k)) return;
    // Entry-keyed precompiled units (browser manifest): registering one costs
    // no translation at all — the wasm bytes are instantiated off-thread and
    // every exported function registers by its address-bearing export name.
    // Without this, a "cache" keyed by the generated WAT still pays the whole
    // closure translation on the main thread just to compute the lookup key —
    // measured at 30-second pump slices on GIMP's first menu open.
    if (this.unitBytes) {
      const bytes = this.unitBytes(k);
      if (bytes) {
        this.aotFns.set(k, null);              // placeholder: profiling stops re-triggering
        WebAssembly.instantiate(bytes, this.aotImports())
          .then(({ instance }) => {
            for (const name of Object.keys(instance.exports))
              if (name.startsWith('f_')) {
                const a = BigInt('0x' + name.slice(2));
                if (!this.aotFns.get(a)) this.registerAotFn(a, instance.exports[name]);
              }
            if (instance.exports.drive) this.aotDrive = instance.exports.drive;
            this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
          })
          .catch((e) => { this.aotFns.delete(k); this.aotFailed.add(k);
                          if (this.onAotFail) this.onAotFail(entry, e.message); });
        return;
      }
      if (this.cacheOnly) { this.aotFailed.add(k); return; }   // no assembler here: skip translation too
    }
    // Deferral must be CHEAP: once a hot entry crosses the profile threshold,
    // every subsequent call re-enters here until something registers. With the
    // slice budget spent, bail before the trampoline probe — that probe
    // decodes instructions out of guest memory, and paying it a quarter
    // million times during one busy window was itself a main-thread wedge.
    if (this.tierMsMax !== undefined && this.tierMs >= this.tierMsMax) return;
    if (this.isTrampoline(entry)) {
      // PLT stub: dispatch must read the GOT slot on EVERY call, never a
      // cached alias. The old permanent alias assumed the slot stays stable —
      // but ld.so RE-RELOCATES ITSELF after libc loads, rebinding its own
      // malloc/free GOT slots from the minimal rtld allocator to libc's; the
      // stale alias kept dispatching rtld-malloc, and glibc aborts on free()
      // of the resulting mixed-allocator pointers (leafpad, via dlerror's
      // check_free).
      const gotAddr = this.trampolineGotAddr(entry);
      if (gotAddr === null) { this.aotFailed.add(k); return; }
      const tgt0 = this.trampolineTarget(entry);
      if (tgt0 !== null) this.profileTarget(tgt0);   // push the real callee toward tiering
      // Preferred form: a WASM stub (see pltStubWat) that reads the GOT slot
      // live and tail-calls through the shared table — it registers in the
      // funcref table under the stub's address, so translated call sites and
      // the dispatch driver route through PLT indirection with no JS hop
      // (the JS closure below cost a callout round-trip per call: 23M in one
      // CPython run). The closure remains the no-assembler fallback.
      if (this.assembleWat) {
        try {
          const gotOff = Number(BigInt.asUintN(32, gotAddr - this.base + BigInt(this.RAMOFF)));   // unsigned: GOT slots above 2GB must not wrap negative
          const { wat, entryName } = pltStubWat(entry, gotOff);
          const bytes = this.assembleWat(wat);
          if (this.onUnitBytes) this.onUnitBytes(k, bytes);
          if (this.asyncCompile) {
            this.aotFns.set(k, null);
            WebAssembly.instantiate(bytes, this.aotImports())
              .then(({ instance }) => { this.registerAotFn(k, instance.exports[entryName]); })
              .catch(() => { this.aotFns.delete(k); });   // fall back to re-tiering
          } else {
            const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), this.aotImports());
            this.registerAotFn(k, inst.exports[entryName]);
          }
          return;
        } catch (e) { /* fall through to the JS closure */ }
      }
      let cachedVal = null, cachedFn = null;         // re-resolve only when the slot changes
      const stub = () => {
        const v = this.mem.read(gotAddr, 8n);
        // re-lookup when the slot changed OR the target wasn't compiled yet
        // (a cached miss must not stick once the callee's unit registers)
        if (v !== cachedVal || typeof cachedFn !== 'function') { cachedVal = v; cachedFn = this.aotFns.get(v); }
        if (typeof cachedFn === 'function') return cachedFn();
        // Miss: emulate the `jmp *GOT` ourselves — deopt TO THE TARGET, and
        // profile it so it tiers. A jmp changes nothing but rip, so resuming
        // interp at the target is exact. Deopting to `entry` instead was a
        // LIVELOCK: interp resumed at this stub's own address, the run loop
        // saw a registered function there and re-dispatched this closure,
        // which threw again with rip unmoved — the page's whole slice went
        // to throw/catch with zero guest progress (browser wedge regression).
        this.profileTarget(v);
        throw new DeoptUnwind(v);
      };
      stub.jsStub = true;             // not table-eligible: rebuildFtmap skips it
      this.aotFns.set(k, stub);
      return;
    }
    // the slice budget (checked above, before the trampoline probe) bounds the
    // synchronous translation cost per host slice: the host zeroes tierMs each
    // pump and deferred entries re-trigger on their next call
    const t0c = (this.tierMsMax !== undefined) ? performance.now() : 0;
    const un = (this._unitN = (this._unitN || 0) + 1);   // bisect aid: veto unit N -> stays interpreted
    if (this.unitFilter && !this.unitFilter(un, entry)) { this.aotFailed.add(k); return; }
    try {
      const unit = compileUnitWat(this.mem, entry, { guestBase: this.base, ramBase: this.RAMOFF,
        // prune the closure at functions already in the dispatch map: calls
        // reach them via $ftr chaining, so re-including their bodies only
        // duplicates translation work and module bytes
        // OXWASM_UNPRUNE=hex,hex: keep these callees in every closure even
        // when already compiled (diagnosis: the upper bound of a re-tier that
        // un-prunes a hot caller's hot small callees so they can be inlined)
        skip: (c) => this._ftSeen.has(BigInt(c)) && !UNPRUNE.has(c),
        // bisect aids: fnVeto never compiles these; fnAllow compiles only these (roots and closure members)
        veto: (this.fnVeto || this.fnAllow) ? (c) => (this.fnVeto?.has(c) ?? false) || (this.fnAllow ? !this.fnAllow.has(c) : false) : null,
        tinyMemo: (this._tinyMemo ??= new Map()),
        // the tiering call profile, so the inliner can pick targets by how
        // often they are actually called rather than by what fits a budget
        hot: this.aotCalls,
        // every function entry the engine knows of: the analyzer cuts a
        // call's fall-through at one (a noreturn callee's neighbour)
        entries: this._knownEntries(),
        // ... and the addresses actually seen called: what a tail jmp may target
        callTargets: new Set([...this.aotCalls.keys()].map(k => k.toString())),
        // hosts whose assembler is wabt.js (itself wasm) choke on multi-MB
        // closure texts — child engines cap the unit size and chain instead
        ...(this.unitMaxFuncs ? { maxFuncs: this.unitMaxFuncs } : {}),
        ...(this.unitMaxInsns ? { maxInsns: this.unitMaxInsns } : {}) });
      if (this.onUnitWat) this.onUnitWat(un, entry, unit);
      // assembleWatAsync (browser): the assembler is 65% of the on-thread
      // tier-up cost and is a pure text -> bytes transform with no engine
      // state, so it can run in a worker. Hand the text over and finish in
      // the callback; execution stays interpreted until the bytes come back,
      // exactly as it already does for asyncCompile below. The null
      // placeholder goes in BEFORE the handoff or profiling re-triggers this
      // same entry on every call while the worker is busy.
      if (this.assembleWatAsync) {
        this.aotFns.set(k, null);
        this.assembleWatAsync(unit.wat)
          .then((bytes) => {
            if (this.onUnitBytes) this.onUnitBytes(k, bytes);
            return WebAssembly.instantiate(bytes, this.aotImports());
          })
          .then(({ instance }) => this.finishAotUnit(unit, instance))
          .catch((e) => { this.aotFns.delete(k); this.aotFailed.add(k);
                          if (this.onAotFail) this.onAotFail(entry, e.message); });
        return;
      }
      const bytes = this.assembleWat(unit.wat);
      if (this.onUnitBytes) this.onUnitBytes(k, bytes);   // manifest capture: entry -> compiled wasm
      // asyncCompile (browser): hand the bytes to the engine's off-thread
      // compiler instead of blocking this slice — execution stays interpreted
      // until the instantiate resolves, then the unit's functions register.
      // aotFns holds null meanwhile so profiling doesn't re-trigger; every
      // dispatch site treats a null entry as not-compiled.
      if (this.asyncCompile) {
        this.aotFns.set(k, null);
        WebAssembly.instantiate(bytes, this.aotImports())
          .then(({ instance }) => this.finishAotUnit(unit, instance))
          .catch((e) => { this.aotFns.delete(k); this.aotFailed.add(k);
                          if (this.onAotFail) this.onAotFail(entry, e.message); });
        return;
      }
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), this.aotImports());
      for (const a of unit.funcs) {
        const ak = a;
        if (!this.aotFns.has(ak)) this.registerAotFn(ak, inst.exports['f_' + a.toString(16)]);
      }
      if (inst.exports.drive) this.aotDrive = inst.exports.drive;
      if (!this.aotFns.has(k)) throw new Error('entry missing from unit');
      this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
    } catch (e) { this.aotFailed.add(k);
      if (this.onAotFail) this.onAotFail(entry, e.message);
    } finally { if (t0c) this.tierMs += performance.now() - t0c; }
  }

  // GPRs at 0..127, fs base at 128, the 16 xmm registers at 256..511 (16B
  // each, low 64 then high 64) — the AOT reads/writes v128 there directly.
  syncOut() { for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
              this.fsview[0] = BigInt.asIntN(64, this.cpu.fsBase || 0n);
              const x = this.xmmview; const M = (1n << 64n) - 1n;
              for (let r = 0; r < 16; r++) { const v = this.cpu.xmm[r] || 0n;
                x[r*2] = BigInt.asIntN(64, v & M); x[r*2+1] = BigInt.asIntN(64, (v >> 64n) & M); } }
  syncIn()  { this._cleanSync = true;
              for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
              this.cpu.fsBase = BigInt.asUintN(64, this.fsview[0]);
              const x = this.xmmview;
              for (let r = 0; r < 16; r++) this.cpu.xmm[r] = BigInt.asUintN(64, x[r*2]) | (BigInt.asUintN(64, x[r*2+1]) << 64n); }

  // Run one compiled function; a deopt inside it (or its wasm callees)
  // unwinds here and execution state is already in the regfile/guest stack.
  // Returns the rip to continue at.
  dispatchAot(f) {
    this.stats.disp = (this.stats.disp || 0) + 1;
    if (this._cleanSync) this.stats.dispClean = (this.stats.dispClean || 0) + 1;
    // Save/restore the wasm-frame budget word (FTMAP+8) around the dispatch:
    // interpUntil dispatches units NESTED under live wasm frames (a callout's
    // interpreter), so a reset here would wipe the taxes of everything above
    // us and unbound the stack. run() resets the word at true top level.
    const fdv = (this._ftdv ??= new DataView(this.wmem.buffer));
    const fd0 = fdv.getUint32(FTMAP + 8, true);
    // fill the chain-fuel tank for this dispatch (see FTFUEL in aot_wat.mjs);
    // hosts that set no sliceDeadline get an effectively bottomless tank
    fdv.setUint32(FTFUEL, this.chainFuel ?? 0x0FFFFFFF, true);
    fdv.setUint32(FTLOOP, this.loopYield ?? LOOPYIELD_N, true);      // backward edges before a frame yields its loop head (see FTLOOP)
    const fn0 = fdv.getUint32(FTNEST, true); fdv.setUint32(FTNEST, 0, true);   // this dispatch's frame is top-level: its exit rip is honoured
    this.syncOut();
    const entry = this.cpu.rip;
    try { let exit = f();
      if (fdv.getUint32(FTLOOP, true) === 0) this.stats.loopYieldTop = (this.stats.loopYieldTop || 0) + 1;   // the frame returned on a spent loop budget: a top-level yield
      // In-wasm driver: a top frame's guest ret exits its wasm function, but
      // the next rip is usually another compiled function — chain to it in
      // wasm ($drive resolves via the shared map and call_indirects, burning
      // the same fuel/depth budgets) instead of paying a JS round-trip with a
      // full regfile syncOut/syncIn per top-frame ret.
      if (this.aotDrive) exit = this.aotDrive(exit);
      this.syncIn(); this.stats.aotRuns++;
      if (this.onProgress && this.stats.aotRuns % 4e6 === 0) this.onProgress('aot');
      return BigInt.asUintN(64, exit); }
    catch (e) { if (e instanceof DeoptUnwind) { this.syncIn();
        // A deopt back to the exact rip we dispatched made zero progress, and
        // the caller's loop will re-dispatch the same function — with a deopt
        // GUARD at the entry insn (e.g. a 128-bit `div` whose back-edge
        // carries the remainder in rdx) that is an infinite churn: leafpad's
        // boot spun forever inside libc's multiword division. Blacklist the
        // entry after repeated same-rip deopts; the interpreter runs it.
        if (e.rip === entry) {
          const n = ((this._entryDeopts ??= new Map()).get(entry) || 0) + 1;
          this._entryDeopts.set(entry, n);
          if (n >= 32 && this.aotFns.has(entry)) {
            this.aotFns.delete(entry); this.aotFailed.add(entry);
            if (this.onAotFail) this.onAotFail(entry, 'entry-deopt churn (blacklisted)');
          }
        }
        return BigInt.asUintN(64, e.rip); }
      if (e instanceof BlockUnwind) { this.syncIn(); return BigInt.asUintN(64, e.rip); }
      throw e; }
    finally { fdv.setUint32(FTMAP + 8, fd0, true); fdv.setUint32(FTNEST, fn0, true); }
  }

  // Differential shadow: run one compiled-function dispatch BOTH ways — first
  // pure interp with a memory write-journal (side-effect free: any syscall
  // aborts the attempt), undo the journal, then the compiled unit — and
  // compare final registers and every journaled location. First divergence
  // pinpoints the miscompiled frame and its input state.
  shadowDispatch(f) {
    const cpu = this.cpu;
    const entryRip = cpu.rip, rsp0 = cpu.regs[4];
    let retAddr;
    try { retAddr = this.mem.read(rsp0, 8n); } catch { return this.dispatchAot(f); }
    const rspExit = rsp0 + 8n;
    const regs0 = cpu.regs.slice(), xmm0 = cpu.xmm.slice(), fs0 = cpu.fsBase, fl0 = { ...cpu.f };
    // Count what the shadow actually did. Every bail below is silent - a
    // syscall, the step cap, or an exit that is not a clean return - so a run
    // that never compared anything looked exactly like a run that compared
    // everything and found nothing. That is the worst failure mode a
    // differential can have.
    const st = (this._shadowStats ??= { tried: 0, aborted: 0, compared: 0, diverged: 0 });
    st.tried++;
    this._shadowBusy = true; this._shadowInterp = true;
    const savedBudget = this.aotBudget; this.aotBudget = 0;
    this.mem.jrnl = [];
    let ok = true, steps = 0;
    try {
      while (!(cpu.rip === retAddr && cpu.regs[4] === rspExit)) {
        cpu.step();
        if (this.exitCode !== null || this.blocked) { ok = false; break; }
        if (++steps > 5e6) { ok = false; break; }
      }
    } catch (e) { ok = false; if (!(e === SHADOW_ABORT || e instanceof Error)) throw e; }
    this._shadowInterp = false;
    const jr = this.mem.jrnl; this.mem.jrnl = null;
    this.aotBudget = savedBudget;
    // capture interp outcome (before undo)
    const iRegs = cpu.regs.slice(), iXmm = cpu.xmm.slice();
    const iFlags = { ...cpu.f }, iFs = cpu.fsBase;
    const iVals = ok ? jr.map(([a, n, _o, snap]) =>
      snap ? this.mem.view(a, BigInt(snap.length)).slice() : this.mem.read(a, n)) : null;
    // undo the journal in reverse
    for (let i = jr.length - 1; i >= 0; i--) {
      const [a, n, old, snap] = jr[i];
      if (snap) this.mem.view(a, BigInt(snap.length)).set(snap);
      else this.mem.write(a, n, old);
    }
    // restore entry state and run the compiled side for real
    cpu.regs = regs0.slice(); cpu.xmm = xmm0.slice(); cpu.fsBase = fs0; cpu.f = { ...fl0 };
    cpu.rip = entryRip;
    const exitRip = this.dispatchAot(f);
    if (!(ok && exitRip === retAddr && cpu.regs[4] === rspExit)) st.aborted++;
    if (ok && exitRip === retAddr && cpu.regs[4] === rspExit && (this._shadowDiverged ?? 0) < 12) {
      st.compared++;
      const diffs = [];
      for (let r = 0; r < 16; r++) if (cpu.regs[r] !== iRegs[r])
        diffs.push(`r${r} aot=${cpu.regs[r].toString(16)} interp=${iRegs[r].toString(16)}`);
      for (let r = 0; r < 16; r++) if (cpu.xmm[r] !== iXmm[r])
        diffs.push(`xmm${r} aot=${cpu.xmm[r].toString(16)} interp=${iXmm[r].toString(16)}`);
      // Flags and the fs base were saved to RESTORE entry state but never
      // compared, so a compiled unit that returned the right registers and
      // the wrong flags looked clean. Hand-written libc asm is exactly where
      // that matters.
      for (const k of Object.keys(iFlags)) if (cpu.f[k] !== iFlags[k])
        diffs.push(`flag ${k} aot=${cpu.f[k]} interp=${iFlags[k]}`);
      if (cpu.fsBase !== iFs) diffs.push(`fsBase aot=${cpu.fsBase?.toString(16)} interp=${iFs?.toString(16)}`);
      for (let i = 0; i < jr.length; i++) {
        const [a, n, _o, snap] = jr[i];
        if (snap) { const cur = this.mem.view(a, BigInt(snap.length)).slice();
          const iv = iVals[i];
          for (let b = 0; b < cur.length; b++) if (cur[b] !== iv[b]) { diffs.push(`mem 0x${(a + BigInt(b)).toString(16)} aot=${cur[b].toString(16)} interp=${iv[b].toString(16)}`); break; }
        } else { const cur = this.mem.read(a, n);
          if (cur !== iVals[i]) diffs.push(`mem 0x${a.toString(16)}/${n} aot=${cur.toString(16)} interp=${iVals[i].toString(16)}`);
        }
      }
      if (diffs.length) {
        st.diverged++;
        this._shadowDiverged = (this._shadowDiverged ?? 0) + 1;
        console.error(`<SHADOW-DIVERGE fn=0x${entryRip.toString(16)} steps=${steps} entry=[${regs0.map(v=>v.toString(16)).join(',')}]>`);
        for (const d of diffs.slice(0, 20)) console.error('  ' + d);
      }
    }
    this._shadowBusy = false;
    return exitRip;
  }

  dispatchMaybeShadow(f) {
    if (this.shadowLib && !this.shadowRange) {
      for (const m of this.maps ?? []) if (m.path.includes(this.shadowLib)) {
        this.shadowRange = [m.at, m.at + m.len];
        console.error(`<shadow armed ${m.path} 0x${m.at.toString(16)}+0x${m.len.toString(16)}>`);
        break;
      }
    }
    if (!this.shadowRange || this._shadowBusy ||
        this.cpu.rip < this.shadowRange[0] || this.cpu.rip >= this.shadowRange[1])
      return this.dispatchAot(f);
    const k = this.cpu.rip;
    const n = (this._shadowClean ??= new Map()).get(k) ?? 0;
    // Exonerate after this many clean passes, so shadowing a hot function does
    // not cost the whole run. 50 is right for a first sweep and wrong for a
    // bug that needs a rare input: a libc string routine is called thousands
    // of times, and a divergence on call 900 is invisible if shadowing stops
    // at 50. shadowMax lifts the cap when hunting one.
    if (n >= (this.shadowMax ?? 50)) return this.dispatchAot(f);
    this._shadowClean.set(k, n + 1);
    return this.shadowDispatch(f);
  }

  // Interpret (dispatching into compiled functions when rip lands on one)
  // until `done()` — used by the callout escape.
  interpUntil(done) {
    // Depth of nested interpretation under a live wasm callout. fork/vfork
    // must not spawn a child from here: the child would run on the shared
    // stack UNDER the parent's suspended wasm frame, and unwinding that frame
    // on the child's execve leaves the parent resuming into corrupt state
    // (traced: gcc's vfork of cc1, and a minimal vfork+exec repro, both landed
    // the parent in __execve's error tail). The guard in case 56/57/58 deopts
    // to _run1 so the fork re-executes at top level with no frame beneath it.
    this._iuDepth = (this._iuDepth | 0) + 1;
    try {
    let guard = 0;
    let branched = true;      // compiled entries are branch targets: only look up after a branch
    while (!done()) {
      let f = branched ? this.aotFns.get(this.cpu.rip) : undefined;
      if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
      // stack budget: this interpreter can be nested deep under live wasm
      // frames (contained deopt/callout) — don't dispatch further fat wasm
      // frames when the shared budget word says the stack is near its edge
      if (f && (this._ftdv ??= new DataView(this.wmem.buffer)).getUint32(FTMAP + 8, true) >= FTDLIMIT) f = null;
      if (f) { this.cpu.rip = this.dispatchMaybeShadow(f);
               if (this.blocked) throw new BlockUnwind(this.cpu.rip);
               continue; }
      const before = this.cpu.rip;
      this._cleanSync = false;
      const insn = this.cpu.step(); this.stats.interpreted++;
      branched = BRANCHY.has(insn.mnem) || this.cpu.rip !== this.cpu.ripNext && this.cpu.rip !== before + BigInt(insn.len);
      if (this.onProgress && this.stats.interpreted % 2e7 === 0) this.onProgress('callout');
      if (this.exitCode !== null) throw EXIT;
      if (this.blocked) {
        // Publish the interp's CURRENT state to the regfile before unwinding:
        // dispatchAot's BlockUnwind catch does syncIn(), and without this it
        // would resurrect the registers spilled at the callout entry — the
        // thread would resume at the deep syscall rip with call-site rsp/args,
        // and the next ret would pop a local (observed: a timespec's tv_sec)
        // as a return address.
        this.cpu.rip = before;
        this.syncOut();
        throw new BlockUnwind(before);
      }
      // profile back-edges here too: a callout can nest arbitrarily deep and
      // run for millions of steps — without tier-up, everything under it
      // would stay interpreted forever (GIMP's babl LUT init lives here)
      // jmp too: a rotated loop's back-edge is an UNCONDITIONAL jump — the
      // hot string-join loop in CPython interpreted 4M steps here invisibly
      if ((insn.mnem === 'jcc' || insn.mnem === 'jmp') && this.cpu.rip < before && this.inExec(this.cpu.rip)) {
        const hk = this.cpu.rip;
        const n = (this.profile.get(hk) || 0) + 1;
        this.profile.set(hk, n);
        if (this.assembleWat && n >= this.aotLoopThreshold && !this.aotFns.has(hk) && !this.aotFailed.has(hk))
          this.tierUpAot(this.cpu.rip);
      }
      // slice preemption (browser): a callout can interpret for minutes, and
      // async-compiled units only register when the event loop turns — which
      // it can't until we return. Unwind exactly like a blocking syscall
      // (state published, resume re-enters interp at this rip); the host sees
      // an immediately-due blocked deadline and re-pumps on the next task.
      this._itc = (this._itc | 0) + 1;            // persistent across nested interpUntil calls
      if ((this._itc & 0xFFF) === 0 && this.sliceDeadline != null && performance.now() > this.sliceDeadline) {
        this.syncOut();
        this.blocked = { deadline: this.nowMs() };
        throw new BlockUnwind(this.cpu.rip);
      }
      if (++guard > 5e9) throw new Error('escape runaway');
    }
    } finally { this._iuDepth--; }
  }

  // A compiled frame's back edge found its loop head unresolvable after a
  // full yield budget (see FTLOOP): root a unit there, once, so the next
  // expiry's probe hits and the frame hands its loop over in wasm.
  _loopHot(a) {
    if (!this.assembleWat && !this.unitBytes) return;
    (this._loopHotSeen ??= new Set());
    if (this._loopHotSeen.has(a)) return;
    this._loopHotSeen.add(a);
    this.stats.loopHot = (this.stats.loopHot || 0) + 1;
    if (!this.aotFns.has(a) && !this.aotFailed.has(a)) this.tierUpAot(a);
    if (globalThis.__loopTrace) console.error(`<loophot ${a.toString(16)} -> aotFns=${this.aotFns.has(a)} failed=${this.aotFailed.has(a)}>`);
  }
  aotEnv() {
    return {
      loophot: (a) => this._loopHot(BigInt.asUintN(64, a)),
      // rip = guest address of the syscall instruction (an emit-time constant)
      // so a blocking syscall can suspend: state is spilled, frames unwind,
      // and resume re-executes the syscall at exactly this rip.
      syscall: (rip) => {
        this.syncIn();
        // arch behavior of the syscall insn (the interp models it; compiled
        // code must too): rcx = return rip, r11 = rflags
        this.cpu.regs[1] = BigInt.asUintN(64, (rip ?? 0n) + 2n);
        this.cpu.regs[11] = this.cpu.flagsValue ? this.cpu.flagsValue() : 0x246n;
        // rip must be the post-syscall address BEFORE dispatch: clone() seeds
        // the child thread from cpu.rip (a stale value sent a pthread into
        // the weeds); the blocked path below rewinds it for re-execution
        this.cpu.rip = BigInt.asUintN(64, (rip ?? 0n) + 2n);
        this._sigRedirected = false;
        this.syscall(this.cpu);
        if (this.exitCode !== null) throw EXIT;
        if (this.blocked) {
          this.cpu.rip = BigInt.asUintN(64, rip ?? 0n);
          this.syncOut();
          throw new BlockUnwind(this.cpu.rip);
        }
        this.syncOut();
        // A signal handler (or rt_sigreturn) redirected rip: the compiled
        // unit would otherwise carry on at its own next instruction. Unwind
        // to the top loop, which resumes at the new rip with the state just
        // published.
        if (this._sigRedirected) { this._sigRedirected = false; throw new DeoptUnwind(this.cpu.rip); }
      },
      callout: (target) => {
        target = BigInt.asUintN(64, target);
        // Chain preemption: a wasm-to-wasm chain never returns to run(), and
        // each hop's interpUntil restarts its own step counter, so thousands
        // of short hops dodge every other deadline check (measured: 175ms
        // slices). At callout entry the caller has spilled the whole regfile
        // and the return address is on the guest stack — resuming interp AT
        // the target reproduces the call exactly.
        if (this.sliceDeadline != null && performance.now() > this.sliceDeadline) {
          this.blocked = { deadline: this.nowMs() };
          throw new BlockUnwind(target);
        }
        // deadline fine: re-arm the chain fuel so in-wasm chaining resumes at
        // full speed — this hop IS the periodic clock check fuel exists for
        (this._ftdv ??= new DataView(this.wmem.buffer)).setUint32(FTFUEL, this.chainFuel ?? 0x0FFFFFFF, true);
        // The caller (compiled code) already spilled the whole register file to
        // memory before the call, and the guest return address is on the guest
        // stack. rsp lives in the regfile at slot 4.
        const rsp0 = BigInt.asUintN(64, this.regview[4]);
        if (rsp0 < 0x10000n && this.onBadRsp) this.onBadRsp(target, rsp0);
        const retAddr = this.mem.read(rsp0, 8n);
        const rspExit = BigInt.asUintN(64, rsp0 + 8n);
        let f = this.aotFns.get(target);
        if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
        if (this.chainSlow) f = null;                       // diagnostic: disable wasm-to-wasm fastpath
        // Shared wasm-frame budget (FTDEPTH, also bumped by in-wasm
        // call_indirect chains): each f() here nests a REAL wasm frame, and
        // post-jump-table units are big functions with fat frames — deep
        // guest recursion overflowed the host stack. Past the budget the
        // callee interprets: thin JS frames only, any depth.
        const ftdv = (this._ftdv ??= new DataView(this.wmem.buffer));
        const ftd = ftdv.getUint32(FTMAP + 8, true);
        if (f && ftd >= FTDLIMIT) f = null;
        if (f) {
          // Target is compiled: run it wasm-to-wasm over the shared register
          // file — NO BigInt cpu<->memory sync (the expensive part). It reads
          // and writes the same regfile memory the caller will reload from.
          try { this.stats.aotRuns++;
            ftdv.setUint32(FTMAP + 8, ftd + 1, true);
            const exit = BigInt.asUintN(64, f());
            ftdv.setUint32(FTMAP + 8, ftd, true);
            if (this.onCalloutExit) this.onCalloutExit(target, exit, retAddr);
            // The caller DROPS this return and resumes after its call, so we
            // may only come back once the call really returned. A compiled
            // callee that TAIL-JUMPS out of its unit exits at the jump target
            // with the frame still open — finish the chain first.
            if (exit === retAddr && BigInt.asUintN(64, this.regview[4]) === rspExit)
              return BigInt.asIntN(64, exit);
            this.syncIn(); this.cpu.rip = exit;
            this.interpUntil(() => this.cpu.rip === retAddr && this.cpu.regs[4] === rspExit);
            this.syncOut();
            return BigInt.asIntN(64, retAddr);
          }
          catch (e) {
            ftdv.setUint32(FTMAP + 8, ftd, true);
            if (!(e instanceof DeoptUnwind)) throw e;
            // Deopt inside the compiled callee: its state is spilled to the
            // regfile; finish the frame by interpreting, contained here so the
            // caller's wasm frame survives.
            this.syncIn(); this.cpu.rip = e.rip;
            this.interpUntil(() => this.cpu.rip === retAddr && this.cpu.regs[4] === rspExit);
            this.syncOut();
            return BigInt.asIntN(64, retAddr);
          }
        }
        // Not compiled: fall back to interpreting the target to completion.
        // PROFILE it first — a function whose callers are all compiled is
        // only ever reached as a callout target, and without this it could
        // never tier up: cpu.onCall fires only in the interpreter, so the
        // whole warm interactive path (GTK menu open/close) stayed
        // interpreted forever at ~5M steps per cycle.
        if (this.assembleWat) this.profileTarget(target);
        this.syncIn(); this.cpu.rip = target;
        this.interpUntil(() => this.cpu.rip === retAddr && this.cpu.regs[4] === rspExit);
        this.syncOut();
        return BigInt.asIntN(64, retAddr);
      },
      // The unit spilled the whole regfile before `(return (call $x_deopt ...))`
      // and returns our result as its own exit rip — so when the landing is
      // itself compiled, run it wasm-to-wasm over the shared regfile and
      // return ITS exit: no exception, no BigInt sync, no run()-loop lap.
      // (Measured ~69k deopts per warm menu cycle, mostly cross-DSO jumps.)
      // The depth guard stops a computed-goto ping-pong from consuming host
      // stack — tail-jumps spend no guest stack, so only this bounds it.
      // Profile the landing so an indirect jump that only runs inside AOT code
      // (a compiled trampoline, a jump table) still tiers up its target.
      deopt: (rip, _rsp0) => {
        if (this._loopHotSeen?.has(BigInt.asUintN(64, rip))) this.stats.loopYieldNested = (this.stats.loopYieldNested || 0) + 1;   // a nested frame's yield arrives as a deopt to a loop head
        const t = BigInt.asUintN(64, rip);
        this.stats.deopts = (this.stats.deopts || 0) + 1;
        if (this.deoptLog) this.deoptLog.set(t, (this.deoptLog.get(t) || 0) + 1);
        if (this.inExec(t)) this.profileTarget(t);
        const f = this.aotFns.get(t);
        // t !== _deoChainT: an instruction-escape deopt (rdtsc/cpuid/div
        // guard) passes its own rip — a landing-unit rooted exactly there
        // would re-deopt at the same t forever; only the interpreter can
        // execute that instruction.
        const fdv = (this._ftdv ??= new DataView(this.wmem.buffer));
        const fd = fdv.getUint32(FTMAP + 8, true);
        if (f && !this.chainSlow && t !== this._deoChainT && (this._deoD | 0) < 200 &&
            fd < FTDLIMIT &&                                   // shared wasm-frame budget (see callout)
            (this.sliceDeadline == null || performance.now() <= this.sliceDeadline)) {
          const prevT = this._deoChainT;
          this._deoChainT = t; this._deoD = (this._deoD | 0) + 1;
          fdv.setUint32(FTMAP + 8, fd + 1, true);
          try { this.stats.aotRuns++; return BigInt.asIntN(64, BigInt.asUintN(64, f())); }
          finally { this._deoD--; this._deoChainT = prevT;     // restores through unwinds too
                    fdv.setUint32(FTMAP + 8, fd, true); }
        }
        throw new DeoptUnwind(t); },
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

  // The three names that resolve to this session's terminal.  glibc's ttyname()
  // readlinks /proc/self/fd/N and then stats the answer, so every stat flavour
  // has to agree with fstat on the fd or isatty()/ttyname() disagree.
  isTtyPath(p) {
    if (!this.tty) return false;
    const n = this.norm(p);
    return n === '/dev/tty' || n === '/dev/console' || n === '/dev/pts/0';
  }

  static defaultTermios() {
    return {
      iflag: 0x500,          // ICRNL | IXON
      oflag: 0x5,            // OPOST | ONLCR
      cflag: 0xBF,           // B38400 | CS8 | CREAD
      lflag: 0x8A3B,         // ISIG ICANON ECHO ECHOE ECHOK IEXTEN ECHOCTL
      cc: (() => { const c = new Uint8Array(32);
        c[0]=3; c[1]=28; c[2]=127; c[3]=21; c[4]=4; c[5]=0; c[6]=1;
        c[8]=17; c[9]=19; c[10]=26; c[12]=18; c[13]=15; c[14]=23; c[15]=22; return c; })(),
    };
  }

  // A pty is two pipe buffers crossed: what the master writes, the slave
  // reads (the keyboard) and what the slave writes, the master reads (the
  // screen). Both ends share one termios, so a TCSETS through either is
  // visible to the other — which is the whole point of the pair.
  //
  // The handles carry `pipe` for their read side and `wpipe` for their write
  // side, so read(2) and poll(2) treat a pty end exactly like a pipe and only
  // write(2) needs to know the difference.
  newPty() {
    const n = this._ptyN = (this._ptyN ?? -1) + 1;
    const pty = { n, m2s: { chunks: [], off: 0 }, s2m: { chunks: [], off: 0 },
                  termios: LinuxEngine.defaultTermios(),
                  win: { rows: this.ttyWin.rows, cols: this.ttyWin.cols } };
    this.ptys.set(n, pty);
    return pty;
  }
  // The input side of the line discipline: bytes "typed" into the master.
  //
  // In canonical mode (ICANON) a terminal hands the reading program whole
  // LINES, not keystrokes — it buffers until Enter and lets ERASE and KILL
  // edit what is pending. A shell reading its own prompt depends on this;
  // without it every keystroke arrives as a separate read and backspace
  // shows up as a literal 0x7f in the command.
  //
  // ECHO is what makes typing visible, and it echoes the EDITED text: an
  // erase has to un-draw the character (backspace, space, backspace), not
  // echo the erase byte itself.
  ttyInput(pty, bytes) {
    const T = pty.termios;
    const echo = (b) => { if (T.lflag & 8) pty.s2m.chunks.push(b instanceof Uint8Array ? b : new Uint8Array(b)); };
    if (!(T.lflag & 2)) {                                   // raw: straight through
      pty.m2s.chunks.push(bytes);
      echo(bytes.slice());
      return;
    }
    const line = (pty.line ??= []);
    for (let b of bytes) {
      if (b === 13 && (T.iflag & 0x100)) b = 10;            // ICRNL
      else if (b === 10 && (T.iflag & 0x40)) b = 13;        // INLCR
      if (b === T.cc[2]) {                                   // VERASE
        if (line.length) { line.pop(); echo([8, 32, 8]); }
        continue;
      }
      if (b === T.cc[3]) {                                   // VKILL
        while (line.length) { line.pop(); echo([8, 32, 8]); }
        continue;
      }
      if (b === T.cc[4] && !line.length) {                    // VEOF on an empty line
        pty.m2s.weof = true;
        continue;
      }
      line.push(b);
      echo([b]);
      if (b === 10) {                                        // Enter: the line is now readable
        pty.m2s.chunks.push(new Uint8Array(line));
        line.length = 0;
      }
    }
  }

  ptmxHandle(pty) {
    return { ptm: pty, istty: true, pipe: pty.s2m, wpipe: pty.m2s, path: '/dev/ptmx' };
  }
  ptsHandle(pty) {
    return { pts: pty, istty: true, pipe: pty.m2s, wpipe: pty.s2m, path: '/dev/pts/' + pty.n };
  }

  // syscall paths that read guest memory via this.ram bypass Memory's pend
  // guard; the ones that can plausibly source read-only file pages (path
  // strings, write/writev payloads) call this explicitly.
  guardRange(addr, len) { if (this.mem.pend !== null && len > 0) this.mem.pend(addr, BigInt(len)); }
  readCStrMem(addr, len) { this.guardRange(addr, len);
    return new TextDecoder().decode(this.ram.subarray(Number(addr - this.base), Number(addr - this.base) + len)); }
  readPath(addr) { let p = '', a = addr;
    for (;;) { const c = Number(this.mem.read(a, 1n)); if (!c) break; p += String.fromCharCode(c); a++; }
    return p; }
  // trailing slashes are not part of a name: mkdir("/tmp/a/") and
  // stat("/tmp/a") must agree, and a dir recorded WITH one listed itself
  // as an empty-named child (find then walked "/tmp/a/" forever)
  // *at syscalls: a RELATIVE path resolves against the directory fd, not the
  // cwd. gzip (and modern coreutils generally) open the parent directory and
  // then openat the basename, which is race-safe on a real kernel; ignoring
  // dirfd turned that into a lookup of "/basename" and a bogus ENOENT.
  atPath(dirfd, addr) {
    const p = this.readPath(addr);
    if (p.charCodeAt(0) === 47) return p;                 // absolute: dirfd irrelevant
    const fd = Number(BigInt.asIntN(32, dirfd));
    if (fd === -100) return p;                            // AT_FDCWD: norm() applies the cwd
    const h = this.fds.get(fd);
    return (h && h.isdir && h.path) ? h.path + '/' + p : p;
  }
  norm(p) {
    // relative paths resolve against the process cwd (tar -C, configure
    // scripts, anything that chdir()s and then opens a bare name)
    if (p.charCodeAt(0) !== 47 && this.cwd && this.cwd !== '/') p = this.cwd + '/' + p;
    p = p.replace(/\/{2,}/g, '/');
    if (!p.includes('.')) return p.length > 1 ? p.replace(/\/+$/, '') : p;   // fast path
    const abs = p.charCodeAt(0) === 47;
    const out = [];
    for (const seg of p.split('/')) {
      if (seg === '' || seg === '.') continue;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop();
                          else if (!abs) out.push('..'); continue; }
      out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  }
  // Follow symlinks component by component. Costs nothing until the guest
  // actually makes one (packed sysroots are realpath'd at pack time), so the
  // hot library-loading path keeps its plain map lookup.
  resolve(p) {
    const m = this._fsMeta();
    if (!m.links.size) return p;
    for (let hop = 0; hop < 40; hop++) {
      const segs = p.split('/');
      let cur = '', hit = false;
      for (let i = 1; i < segs.length; i++) {
        cur += '/' + segs[i];
        const t = m.links.get(cur);
        if (t === undefined) continue;
        const base = t.charCodeAt(0) === 47 ? t : cur.slice(0, cur.lastIndexOf('/')) + '/' + t;
        const rest = segs.slice(i + 1).join('/');
        p = this.norm(rest ? base + '/' + rest : base);
        hit = true; break;
      }
      if (!hit) return p;
    }
    return p;                                    // link loop: leave it dangling
  }
  lookup(p) { p = this.resolve(this.norm(p)); return this.files[p] ?? this._synth(p); }
  // ---- synthetic /proc and /dev ------------------------------------------------
  // Generated on every lookup (cheap, always current). Only the files real
  // programs read: glibc's pthread_getattr_np walks /proc/self/maps for the
  // [stack] line holding rsp; runtimes read cpuinfo/meminfo/status; shells
  // open /proc/self/fd/N; scripts read cmdline/environ and sys/kernel/*.
  _synth(p) {
    if (!p.startsWith('/proc') && !p.startsWith('/dev')) return undefined;
    {
      const m = /^\/(?:proc\/(?:self|\d+)|dev)\/fd\/(\d+)$/.exec(p)
             ?? (p === '/dev/stdin' ? [0, '0'] : p === '/dev/stdout' ? [0, '1'] : p === '/dev/stderr' ? [0, '2'] : null);
      if (m) { const h = this.fds.get(Number(m[1])); return h ? (h.bytes ?? new Uint8Array(0)) : undefined; }
    }
    const enc = (t) => new TextEncoder().encode(t);
    const argv = this._ctor?.argv ?? [this.argv0 ?? 'prog'];
    const comm = (this.argv0 ?? 'prog').split('/').pop().slice(0, 15);
    const memKB = Number((BigInt(this._ctor?.memMB ?? 256) << 20n) / 1024n);
    const self = p.replace(/^\/proc\/(self|\d+)(\/|$)/, '/proc/self$2');
    switch (self) {
      case '/proc/self/cmdline': return enc(argv.join('\0') + '\0');
      case '/proc/self/environ': return enc((this.env ?? []).join('\0') + '\0');
      case '/proc/self/exe': case '/prog': return this._ctor?.elfBytes;   // '/prog': what readlink answers for a relative argv0
      case '/proc/self/comm': return enc(comm + '\n');
      case '/proc/self/maps': case '/proc/self/smaps': {
        const hx = (v) => BigInt.asUintN(64, v).toString(16).padStart(12, '0');
        const lines = [];
        for (const [a, b] of (this.execRangesStatic ?? this.execRanges ?? []))
          lines.push(`${hx(a)}-${hx(b)} r-xp 00000000 00:00 0                          ${this.argv0 ?? ''}`);
        for (const m of this.maps ?? [])
          lines.push(`${hx(m.at)}-${hx(m.at + m.len)} rw-p ${m.fileOff.toString(16).padStart(8, '0')} 00:00 0                          ${m.path}`);
        const heap0 = this._brk0 ?? this.brk;
        if (this.brk > heap0) lines.push(`${hx(heap0)}-${hx(this.brk)} rw-p 00000000 00:00 0                          [heap]`);
        const top = this.stackTop + 4096n, bot = top - (8n << 20n);
        lines.push(`${hx(bot)}-${hx(top)} rw-p 00000000 00:00 0                          [stack]`);
        return enc(lines.join('\n') + '\n');
      }
      case '/proc/self/status': {
        const threads = this.threads.filter(t => t.state !== 'dead').length;
        const rss = Math.min(memKB, Number(this.brk - this.base) / 1024 | 0);
        return enc(`Name:\t${comm}\nUmask:\t0022\nState:\tR (running)\nTgid:\t${this.pid ?? 1}\nNgid:\t0\nPid:\t${this.pid ?? 1}\nPPid:\t${this.ppid ?? 0}\n` +
          `TracerPid:\t0\nUid:\t0\t0\t0\t0\nGid:\t0\t0\t0\t0\nFDSize:\t64\nGroups:\t0\nNStgid:\t1\nNSpid:\t1\nNSpgid:\t1\nNSsid:\t1\n` +
          `VmPeak:\t${memKB} kB\nVmSize:\t${memKB} kB\nVmLck:\t0 kB\nVmPin:\t0 kB\nVmHWM:\t${rss} kB\nVmRSS:\t${rss} kB\n` +
          `RssAnon:\t${rss} kB\nRssFile:\t0 kB\nRssShmem:\t0 kB\nVmData:\t${rss} kB\nVmStk:\t132 kB\nVmExe:\t4 kB\nVmLib:\t0 kB\nVmPTE:\t4 kB\nVmSwap:\t0 kB\n` +
          `Threads:\t${threads}\nSigQ:\t0/1024\nSigPnd:\t0000000000000000\nShdPnd:\t0000000000000000\nSigBlk:\t0000000000000000\n` +
          `SigIgn:\t0000000000000000\nSigCgt:\t0000000000000000\nCapInh:\t0000000000000000\nCapPrm:\t000001ffffffffff\nCapEff:\t000001ffffffffff\n` +
          `CapBnd:\t000001ffffffffff\nCapAmb:\t0000000000000000\nNoNewPrivs:\t0\nSeccomp:\t0\nSeccomp_filters:\t0\nSpeculation_Store_Bypass:\tvulnerable\n` +
          `Cpus_allowed:\t1\nCpus_allowed_list:\t0\nMems_allowed:\t1\nMems_allowed_list:\t0\nvoluntary_ctxt_switches:\t0\nnonvoluntary_ctxt_switches:\t0\n`);
      }
      case '/proc/self/stat': {
        const rssPages = Math.max(1, Number(this.brk - this.base) / 4096 | 0);
        return enc(`${this.pid ?? 1} (${comm}) R ${this.ppid ?? 0} ${this.pid ?? 1} ${this.pid ?? 1} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 ${this.threads.filter(t => t.state !== 'dead').length} 0 0 ${memKB * 1024} ${rssPages} 18446744073709551615 ` +
          `${this.base} ${this.brk} ${this.stackTop} 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0\n`);
      }
      case '/proc/self/statm': return enc(`${memKB / 4 | 0} ${Number(this.brk - this.base) / 4096 | 0} 0 1 0 ${Number(this.brk - this.base) / 4096 | 0} 0\n`);
      case '/proc/self/mounts': case '/proc/mounts':
        return enc('rootfs / rootfs rw 0 0\nproc /proc proc rw,nosuid,nodev,noexec,relatime 0 0\ndevtmpfs /dev devtmpfs rw 0 0\n');
      case '/proc/self/mountinfo':
        return enc('1 1 0:1 / / rw - rootfs rootfs rw\n2 1 0:2 / /proc rw - proc proc rw\n3 1 0:3 / /dev rw - devtmpfs devtmpfs rw\n');
      case '/proc/self/limits':
        return enc('Limit                     Soft Limit           Hard Limit           Units     \nMax stack size            8388608              unlimited            bytes     \nMax open files            4096                 1048576              files     \n');
      case '/proc/cpuinfo':
        return enc('processor\t: 0\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 85\nmodel name\t: oxwasm x86-64\nstepping\t: 4\n' +
          'microcode\t: 0x1\ncpu MHz\t\t: 2000.000\ncache size\t: 8192 KB\nphysical id\t: 0\nsiblings\t: 1\ncore id\t\t: 0\ncpu cores\t: 1\napicid\t\t: 0\n' +
          'fpu\t\t: yes\nfpu_exception\t: yes\ncpuid level\t: 13\nwp\t\t: yes\n' +
          'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm constant_tsc nopl pni ssse3 cx16 sse4_1 sse4_2 popcnt\n' +
          'bogomips\t: 4000.00\nclflush size\t: 64\ncache_alignment\t: 64\naddress sizes\t: 46 bits physical, 48 bits virtual\n\n');
      case '/proc/meminfo':
        return enc(`MemTotal:       ${memKB} kB\nMemFree:        ${memKB >> 1} kB\nMemAvailable:   ${memKB >> 1} kB\nBuffers:               0 kB\nCached:                0 kB\n` +
          `SwapCached:            0 kB\nActive:                0 kB\nInactive:              0 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\nDirty:                 0 kB\n` +
          `Shmem:                 0 kB\nCommitLimit:    ${memKB} kB\nCommitted_AS:   ${memKB >> 1} kB\nHugepagesize:       2048 kB\n`);
      case '/proc/filesystems': return enc('nodev\tproc\nnodev\tdevtmpfs\nnodev\ttmpfs\n\text4\n');
      case '/proc/version': return enc('Linux version 6.1.0 (oxwasm) (gcc) #1 oxwasm\n');
      case '/proc/uptime': return enc(`${(this.nowMs() / 1000).toFixed(2)} ${(this.nowMs() / 1000).toFixed(2)}\n`);
      case '/proc/loadavg': return enc('0.00 0.00 0.00 1/1 2\n');
      case '/proc/stat': return enc('cpu  0 0 0 0 0 0 0 0 0 0\ncpu0 0 0 0 0 0 0 0 0 0 0\nintr 0\nctxt 0\nbtime 1700000000\nprocesses 1\nprocs_running 1\nprocs_blocked 0\n');
      case '/proc/sys/kernel/osrelease': return enc('6.1.0\n');
      case '/proc/sys/kernel/ostype': return enc('Linux\n');
      case '/proc/sys/kernel/version': return enc('#1 oxwasm\n');
      case '/proc/sys/kernel/hostname': return enc('oxwasm\n');
      case '/proc/sys/kernel/pid_max': return enc('4194304\n');
      case '/proc/sys/kernel/threads-max': return enc('65536\n');
      case '/proc/sys/kernel/ngroups_max': return enc('65536\n');
      case '/proc/sys/kernel/cap_last_cap': return enc('40\n');
      case '/proc/sys/kernel/random/boot_id': return enc('9d5a2e42-0f1c-4a7e-b0f6-6d5c1e0a1b2c\n');
      case '/proc/sys/kernel/random/uuid': { const h = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
        return enc(`${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}\n`); }
      case '/proc/sys/vm/overcommit_memory': return enc('0\n');
      case '/proc/sys/vm/max_map_count': return enc('65530\n');
      case '/proc/sys/fs/file-max': return enc('1048576\n');
      case '/proc/sys/fs/nr_open': return enc('1048576\n');
      case '/proc/sys/fs/pipe-max-size': return enc('1048576\n');
    }
    return undefined;
  }
  // Shared fs metadata rides on the files object itself (non-enumerable, so
  // path listings skip it): child engines share `files` by reference, and a
  // busybox NOEXEC applet runs inside the PARENT engine — a per-engine dir
  // cache with no cross-engine invalidation went stale the moment a shell
  // redirect created a file under a previously-empty directory.
  _fsMeta() {
    let m = this.files._meta;
    if (!m) Object.defineProperty(this.files, '_meta',
      { value: m = { v: 0, dirs: new Set(), links: new Map() }, configurable: true });
    return m;
  }
  fsBump() { this._fsMeta().v++; }
  // a guest path is a directory iff some provided file lives under it,
  // or the guest mkdir'd it
  isDir(p) {
    p = this.resolve(this.norm(p));
    if (p === '/' ) return true;
    if (SYNTH_DIRS.has(p) || /^\/proc\/\d+(\/(fd|task))?$/.test(p)) return true;
    const pre = p.endsWith('/') ? p : p + '/';
    const m = this._fsMeta();
    if (this._dirset === undefined || this._dirsetV !== m.v) {
      this._dirsetV = m.v;
      this._dirset = new Set();
      for (const k of [...Object.keys(this.files), ...m.dirs]) {
        if (m.dirs.has(k)) this._dirset.add(k);
        let i = 0;
        while ((i = k.indexOf('/', i + 1)) > 0) this._dirset.add(k.slice(0, i));
      }
    }
    return this._dirset.has(pre.slice(0, -1));
  }
  mtimeOf(p) { return this.mtimes?.[this.norm(p)] ?? 0; }
  // a directory's link count is 2 + its subdirectories; a hard-linked file's
  // is the size of its alias group
  nlinkOf(p, mode) {
    if ((mode & 0o170000) === 0o040000) { let n = 2; for (const [, d] of this.dirEntries(p).slice(2)) if (d) n++; return n; }
    const g = this._fsMeta().hard?.get(this.norm(p)); return g ? g.size : 1;
  }
  dirEntries(p) {
    p = this.norm(p); const pre = p.endsWith('/') ? p : p + '/';
    const names = new Map();                       // name -> isDir
    for (const k of Object.keys(this.files)) {
      if (!k.startsWith(pre)) continue;
      const rest = k.slice(pre.length), i = rest.indexOf('/');
      if (i < 0) names.set(rest, false); else names.set(rest.slice(0, i), true);
    }
    for (const d of this._fsMeta().dirs) {         // guest-created (possibly empty) dirs
      if (!d.startsWith(pre)) continue;
      const rest = d.slice(pre.length), i = rest.indexOf('/');
      if (rest) names.set(i < 0 ? rest : rest.slice(0, i), true);
    }
    for (const l of this._fsMeta().links.keys()) {
      if (!l.startsWith(pre)) continue;
      const rest = l.slice(pre.length);
      if (rest && rest.indexOf('/') < 0) names.set(rest, false);
    }
    for (const f of this._fsMeta().fifos?.keys() ?? []) {
      if (!f.startsWith(pre)) continue;
      const rest = f.slice(pre.length);
      if (rest && rest.indexOf('/') < 0) names.set(rest, false);
    }
    // the synthetic /proc and /dev trees list what _synth answers
    const synth = {
      '/proc': [['self', true], ['sys', true], ['cpuinfo', false], ['meminfo', false], ['mounts', false], ['filesystems', false],
                ['version', false], ['uptime', false], ['loadavg', false], ['stat', false], [String(this.pid ?? 1), true]],
      '/proc/self': [['cmdline', false], ['environ', false], ['exe', false], ['comm', false], ['maps', false], ['smaps', false],
                     ['status', false], ['stat', false], ['statm', false], ['mounts', false], ['mountinfo', false], ['limits', false],
                     ['fd', true], ['task', true]],
      '/proc/self/fd': [...this.fds.keys()].map(fd => [String(fd), false]),
      '/proc/self/task': [...this.threads.filter(t => t.state !== 'dead').map(t => [String(t.id), true])],
      '/proc/sys': [['kernel', true], ['vm', true], ['fs', true]],
      '/proc/sys/kernel': [['osrelease', false], ['ostype', false], ['version', false], ['hostname', false], ['pid_max', false],
                           ['threads-max', false], ['ngroups_max', false], ['cap_last_cap', false], ['random', true]],
      '/proc/sys/kernel/random': [['boot_id', false], ['uuid', false]],
      '/proc/sys/vm': [['overcommit_memory', false], ['max_map_count', false]],
      '/proc/sys/fs': [['file-max', false], ['nr_open', false], ['pipe-max-size', false]],
      '/dev': [['null', false], ['zero', false], ['urandom', false], ['random', false], ['tty', false], ['ptmx', false], ['pts', true],
               ['fd', true], ['stdin', false], ['stdout', false], ['stderr', false]],
      '/dev/fd': [...this.fds.keys()].map(fd => [String(fd), false]),
    }[p.replace(/^\/proc\/\d+(\/|$)/, '/proc/self$1')];
    if (synth) for (const [n, d] of synth) names.set(n, d);
    // every real directory has these; without them find's recursive walk
    // never terminates (it re-opens the parent forever) and rm -r/du misread
    // the tree
    return [['.', true], ['..', true], ...names.entries()];
  }
  // rmdir/unlinkat(AT_REMOVEDIR): a directory exists either because files
  // live under it or because the guest mkdir'd it, and is removable only when
  // nothing is left inside (rm -r unlinks depth-first, then removes the dirs)
  rmdirPath(p) {
    if (this.files[p] !== undefined) return -20;              // ENOTDIR
    if (!this.isDir(p)) return -2;                            // ENOENT
    const pre = p + '/';
    for (const k of Object.keys(this.files)) if (k.startsWith(pre)) return -39;   // ENOTEMPTY
    const m = this._fsMeta();
    for (const d of m.dirs) if (d.startsWith(pre)) return -39;
    m.dirs.delete(p); this.fsBump(); return 0;
  }
  allocFd() { let fd = 0; while (this.fds.has(fd)) fd++; return fd; }
  nowMs() { return (typeof performance !== 'undefined') ? performance.now() : Date.now(); }
  // stable unique inode per path: ld.so dedups loaded objects by
  // (st_dev, st_ino), so size-derived inodes made same-sized modules alias
  // to one link_map — dlopen returned the WRONG module and dlsym missed
  // (babl extensions, gegl ops). Anonymous fds get their own counter.
  inoOf(p) { p = this.norm(p); this._inos ??= new Map(); let n = this._inos.get(p);
    if (n === undefined) { n = this._inos.size + 1000; this._inos.set(p, n); }
    return BigInt(n); }

  // fill a struct stat (the by-path shape: dev/ino/nlink/mode/size/times)
  // Regular files stat with a mode derived from content: ELF binaries and
  // shebang scripts are 0755, everything else 0644. All-0755 was the old
  // answer and tar archived data files with the execute bit set - native
  // headers say 0644 - while a blanket 0644 would break shells probing
  // PATH entries with access(X_OK).
  fileMode(bytes) {
    return bytes && bytes.length >= 2 &&
      ((bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) ||
       (bytes[0] === 0x23 && bytes[1] === 0x21)) ? 0o100755 : 0o100644;
  }

  writeStat(buf, path, size, mode, rdev = 0n, ino = null) {
    this.jsnap(buf, 144);
    const off = this.RAMOFF + Number(buf - this.base);
    new Uint8Array(this.wmem.buffer, off, 144).fill(0);
    const v = new DataView(this.wmem.buffer);
    v.setBigUint64(off + 0, 8n, true);                        // st_dev
    v.setBigUint64(off + 8, ino ?? this.inoOf(path), true);   // st_ino
    v.setBigUint64(off + 40, rdev, true);                     // st_rdev
    v.setBigUint64(off + 16, BigInt(this.nlinkOf(path, mode)), true);   // st_nlink
    v.setUint32(off + 24, mode, true);                        // st_mode
    v.setBigUint64(off + 48, BigInt(size), true);             // st_size
    v.setBigUint64(off + 56, 4096n, true);                    // st_blksize
    v.setBigUint64(off + 64, BigInt(Math.ceil(size / 4096) * 8), true);   // st_blocks: 4K allocation units
    const mt = BigInt(this.mtimeOf(path));
    v.setBigUint64(off + 72, mt, true);                       // atime
    v.setBigUint64(off + 88, mt, true);                       // mtime
    v.setBigUint64(off + 104, mt, true);                      // ctime
  }

  block(deadline) { this.blocked = { deadline: deadline ?? null }; }
  // host-side wake: mark every parked thread runnable. Safe because every
  // blocking syscall re-executes and re-checks its condition — a spurious
  // wake just re-blocks.
  wake() { this.blocked = null;
    for (const t of this.threads) if (t.state === 'blk') { t.state = 'run'; t.futex = null; }
    if (this.threads[this.ti].state === 'dead') {
      const i = this.threads.findIndex(t => t.state === 'run');
      if (i >= 0) this.switchTo(i);
    } }

  switchTo(i) {
    const c = this.threads[this.ti]; c._dl = this._deadline;
    this.ti = i; const n = this.threads[i];
    this.cpu = n.cpu; this._deadline = n._dl ?? null;
    // A forked (vfork-window) child runs with a COPY of the fd table — its
    // dup2/close before execve must not disturb the parent's descriptors.
    // Its memory writes are journaled (rolled back at exec/exit) and it runs
    // interpreted so every store goes through the journal.
    if (n.proc) { this._mainFds ??= this.fds; this.fds = n.proc.fds;
      this.mem.jrnl = n.proc.jrnl;
      if (this._vforkBudget === undefined) { this._vforkBudget = this.aotBudget; this.aotBudget = 0; } }
    else { if (this._mainFds) { this.fds = this._mainFds; this._mainFds = null; }
      if (this.mem.jrnl && this._vforkBudget !== undefined) { this.mem.jrnl = null;
        this.aotBudget = this._vforkBudget; this._vforkBudget = undefined; } }
  }
  reapTimers() { const now = this.nowMs();
    if (this.itimer?.at != null) this._checkAlarm();
    for (const t of this.threads)
      if (t.state === 'blk' && t.dl != null && now >= t.dl) { t.state = 'run'; t.futex = null; } }
  futexWake(addr, max) { let n = 0;
    for (const t of this.threads)
      if (t.state === 'blk' && t.futex === addr) { t.state = 'run'; t.futex = null; if (++n >= max) break; }
    return n; }
  wakeAllBlk() {   // a guest-side event (pipe/eventfd write, X data) may unblock a sibling
    for (const t of this.threads) if (t.state === 'blk' && t.futex === null) t.state = 'run'; }
  // current thread hit a blocking syscall (this.blocked set): park it and run
  // another. Returns true if a switch happened; false = nobody runnable, so
  // run() should surface this.blocked (earliest deadline) to the host.
  park() {
    const t = this.threads[this.ti];
    // A fork child that BLOCKS inside its vfork window (reads a pipe the
    // parent has yet to write, fills a 64KB pipe the parent has yet to
    // drain, sleeps) would otherwise freeze its parent forever: the window
    // exists so that fork+exec costs no memory copy, and it is only when the
    // child needs the parent to run that the copy is paid.
    if (t.proc && this.blocked && t.state !== 'dead' && t.state !== 'vfork' &&
        !this.threads.some(x => x !== t && x.state !== 'dead' && x.proc?.parent === t))
      return this._materializeFork(t);
    if (t.state !== 'dead' && t.state !== 'vfork') {   // vfork: parent stays
      t.state = 'blk'; t.dl = this.blocked?.deadline ?? null;   // suspended (child
      t.futex = this._futexAddr; t._dl = this._deadline;        // owns the stack)
    }
    this._futexAddr = null;
    this.reapTimers();
    for (let k = 1; k <= this.threads.length; k++) {
      const i = (this.ti + k) % this.threads.length;
      if (this.threads[i].state === 'run') { this.blocked = null; this.switchTo(i); return true; }
    }
    let dl = null;
    for (const x of this.threads) if (x.state === 'blk' && x.dl != null) dl = dl == null ? x.dl : Math.min(dl, x.dl);
    if (this.itimer?.at != null) dl = dl == null ? this.itimer.at : Math.min(dl, this.itimer.at);   // SIGALRM due
    this.blocked = { deadline: dl };
    return false;
  }
  rotate() {   // preemption at the run() quantum: round-robin among runnable threads
    this.reapTimers();
    for (let k = 1; k < this.threads.length; k++) {
      const i = (this.ti + k) % this.threads.length;
      if (this.threads[i].state === 'run') { this.switchTo(i); return; }
    }
  }

  syscall(cpu) {
    if (this._shadowInterp) throw SHADOW_ABORT;   // shadow interp must stay side-effect free
    const nr = Number(cpu.regs[0]);
    const [a1, a2, a3] = [cpu.regs[7], cpu.regs[6], cpu.regs[2]];   // rdi rsi rdx
    this.stats.syscalls[nr] = (this.stats.syscalls[nr] || 0) + 1;
    // strace ring: the last few hundred (nr, args, ret) tuples, kept only when
    // switched on - reading a silent exit 1 out of a guest needs the tail of
    // its syscall history, not a fault address
    const ret = this.strace
      ? (v) => { cpu.regs[0] = BigInt.asUintN(64, v);
                 let ps = '';   // decode the path argument of the fs family
                 try { if (nr === 257 || nr === 262) ps = ' "' + this.readPath(a2) + '"';
                       else if (nr === 2 || nr === 21 || nr === 89 || nr === 4 || nr === 6 || nr === 87 || nr === 82 || nr === 83 || nr === 59) ps = ' "' + this.readPath(a1) + '"';
                       else if (nr === 263 || nr === 264) ps = ' "' + this.readPath(a2) + '"'; } catch {}
                 this.strace.push(`[${this.threads[this.ti]?.id ?? 1}]${nr}(${a1.toString(16)},${a2.toString(16)},${a3.toString(16)})=${BigInt.asIntN(64, v)}${ps}`);
                 if (this.strace.length > 400) this.strace.shift(); }
      : (v) => { cpu.regs[0] = BigInt.asUintN(64, v); };
    // resolve a write target: stdout / stderr sink, or a pipe buffer
    const defSink = (fd) => this.fds.get(fd) ?? (fd === 1 ? { sink: 'out' } : fd === 2 ? { sink: 'err' } : undefined);
    const writeChunk = (fd, addr, len) => {
      if (len <= 0) return;
      this.guardRange(addr, len);                          // payload may be .rodata
      const bytes = this.ram.slice(Number(addr - this.base), Number(addr - this.base) + len);
      const h = defSink(fd);
      if (h?.sock?.conn) { h.sock.conn.write(bytes); this.wakeAllBlk(); return; }
      if (h?.wpipe) {                                        // a pty end
        const T = (h.ptm ?? h.pts).termios;
        if (h.pts) {
          // program output: OPOST|ONLCR turns a bare \n into \r\n, which is
          // what makes a terminal's next line start at column 0
          if ((T.oflag & 1) && (T.oflag & 4) && bytes.includes(10)) {
            const out = [];
            for (const b of bytes) { if (b === 10) out.push(13); out.push(b); }
            h.wpipe.chunks.push(new Uint8Array(out));
          } else h.wpipe.chunks.push(bytes);
        } else {
          // keyboard input, through the line discipline
          this.ttyInput(h.ptm, bytes);
        }
        this.wakeAllBlk(); return;
      }
      if (h?.pipe) {
        const pb = h.peer ?? h.pipe;                         // a socketpair end writes the OTHER end's buffer (wpipe is the pty field)
        // no read end open anywhere in the process tree: SIGPIPE, and EPIPE
        // if the writer survives it (handler installed or SIG_IGN) — this is
        // what ends `yes | head -1` instead of letting yes fill a dead pipe
        if (!this._pipeReaderAlive(pb)) { this.raiseSignal(13, null, { pid: 0, code: 0 }); return -32; }
        // A pipe holds 64KB: a writer that finds it full BLOCKS until a reader
        // drains it (EAGAIN if non-blocking). Without a bound, a compiled
        // `yes` pushed gigabytes of chunks before `head` ever ran.
        if ((pb.size ?? 0) >= PIPE_CAP) {
          if (h.nonblock) return -11;
          this.block(null); return -4096;                    // re-executed once woken
        }
        pb.chunks.push(bytes); pb.size = (pb.size ?? 0) + bytes.length; this.wakeAllBlk(); return;
      }
      if (h?.ev) {                                           // eventfd: add to the counter
        let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] ?? 0);
        h.ev.count += v; this.wakeAllBlk(); return;
      }
      if (h?.devnull || h?.gen) return;                      // /dev/null, /dev/zero, /dev/urandom: discard, count as written
      if (h && h.bytes !== undefined && h.writable) {        // regular file opened for writing
        if (h.path) (this.dirtyFiles ??= new Set()).add(h.path);
        const end = h.pos + bytes.length;
        if (end > h.bytes.length) this._growFile(h, end);
        h.bytes.set(bytes, h.pos);
        this._mapsAbsorb(h.path, h.pos, bytes);              // coherence: mapped pages see the write
        h.pos = end;
        return;
      }
      const str = new TextDecoder().decode(bytes);
      // sink output belongs to the process TREE's observer: an execve'd
      // child's stdout/stderr surface on the root engine, like a terminal
      let root = this; while (root.parentEng) root = root.parentEng;
      if (h?.sink === 'err') { (root.stderr ||= []).push(str); (root.stderrBytes ||= []).push(bytes); }
      else { root.stdout.push(str); root.stdoutBytes.push(bytes); }
    };
    if (this._sigEntry(cpu, nr)) return;                  // signal delivery: interrupted / pending
    switch (nr) {
      case 1: {                                              // write(fd, buf, len)
        const r = writeChunk(Number(a1), a2, Number(a3));
        if (r === -4096) break;                              // pipe full: blocked, re-executes
        ret(r === undefined ? a3 : BigInt(r)); break; }
      case 20: {                                             // writev(fd, iov, cnt)
        const view = new DataView(this.wmem.buffer);
        let total = 0n;
        for (let i = 0; i < Number(a3); i++) {
          const io = this.RAMOFF + Number(a2 - this.base) + i * 16;
          const b = view.getBigUint64(io, true), l = view.getBigUint64(io + 8, true);
          const r = writeChunk(Number(a1), b, Number(l));
          if (r === -4096) {                                 // pipe full mid-vector
            if (total > 0n) this.blocked = null;             // short write: the guest retries the rest
            break;
          }
          if (r !== undefined && r < 0) { if (total === 0n) total = BigInt(r); break; }
          total += l;
        }
        if (this.blocked) break;
        ret(total); break; }
      case 32: case 33: case 292: {                          // dup / dup2 / dup3
        const old = Number(a1), h = defSink(old);
        if (!h && !this.fds.has(old)) { ret(-9n); break; }   // EBADF
        const handle = h ?? this.fds.get(old);
        if (nr === 32) { const fd = this.allocFd(); this.fds.set(fd, handle); this.cloexec.delete(fd); ret(BigInt(fd)); break; }
        const nw = Number(a2); this.fds.set(nw, handle);
        if (nr === 292 && (Number(cpu.regs[2]) & 0x80000)) this.cloexec.add(nw); else this.cloexec.delete(nw);
        ret(BigInt(nw)); break; }
      case 22: case 293: {                                   // pipe / pipe2
        const buf = { chunks: [], pos: 0, off: 0, size: 0 };
        const rfd = this.allocFd(); this.fds.set(rfd, null); const wfd = this.allocFd(); this.fds.delete(rfd);
        this.fds.set(rfd, { pipe: buf, mode: 'r' });
        this.fds.set(wfd, { pipe: buf, mode: 'w' });
        if (nr === 293 && (Number(a2) & 0x80000)) { this.cloexec.add(rfd); this.cloexec.add(wfd); }
        this.jsnap(a1, 8);
        const v = new DataView(this.wmem.buffer), o = this.RAMOFF + Number(a1 - this.base);
        v.setUint32(o, rfd, true); v.setUint32(o + 4, wfd, true);
        ret(0n); break; }
      case 53: {                                             // socketpair(domain, type, protocol, sv)
        // AF_UNIX stream pair as two crossed pipe buffers: each end reads its
        // own buffer and writes the other's. cargo spawns rustc over one
        // (std's spawn error channel) and reported "Function not implemented".
        if (Number(a1) !== 1) { ret(-97n); break; }          // EAFNOSUPPORT
        const b1 = { chunks: [], pos: 0, off: 0, size: 0 }, b2 = { chunks: [], pos: 0, off: 0, size: 0 };
        const nb = !!(Number(a2) & 0x800);
        const f1 = this.allocFd(); this.fds.set(f1, null); const f2 = this.allocFd(); this.fds.delete(f1);
        this.fds.set(f1, { pipe: b1, peer: b2, mode: 'rw', nonblock: nb });
        this.fds.set(f2, { pipe: b2, peer: b1, mode: 'rw', nonblock: nb });
        if (Number(a2) & 0x80000) { this.cloexec.add(f1); this.cloexec.add(f2); }
        const sv = cpu.regs[10];
        this.jsnap(sv, 8); this.mem.write(sv, 4n, BigInt(f1)); this.mem.write(sv + 4n, 4n, BigInt(f2));
        ret(0n); break; }
      case 12: {                                             // brk
        // Linux answers a brk it cannot satisfy by returning the break
        // UNCHANGED; glibc's sbrk compares what came back against what it
        // asked for and reports ENOMEM. Accepting any value and echoing it
        // back told malloc that memory past the end of the guest region was
        // its to use, and it wrote chunk headers there - surfacing as a fault
        // deep inside _int_malloc rather than the program's own allocation
        // failure. xz -9 asking for 512MB+16 on a 512MB guest is how this was
        // found; mmap already bounds-checked and returned -ENOMEM, brk did
        // not.
        //
        // Both ends are enforced: the end of guest RAM and the mmap arena
        // above the heap (glibc's malloc switches to mmap when brk stops).
        const lim = this.base + BigInt(this.ram.length);
        const want = align(a1, PAGE);
        if (a1 > this.brk && want <= lim && want <= this._mmapBase) this.brk = want;
        ret(this.brk); break; }
      case 9: {                                              // mmap(addr,len,prot,flags,fd,off)
        for (const t of this.threads) t.cpu.icache?.clear();  // new code may appear
        const len = align(a2, PAGE);
        const flags = cpu.regs[10], fdArg = Number(BigInt.asIntN(32, cpu.regs[8] & 0xFFFFFFFFn));
        const FIXED = 0x10n, ANON = 0x20n;
        // Un-fixed mappings come first-fit from the holes munmap left, then
        // from the bump pointer. The arena was bump-only and never reused:
        // Go's runtime probes a dozen 64 MB arena hints (each returned
        // elsewhere, unmapped, retried) and then a 512 MB summary, and
        // exhausted a 3 GB slab in reservations it had already released.
        // MAP_FIXED_NOREPLACE (0x100000): the caller's address or EEXIST, never
        // a different one. "Free" here is what the arena knows: inside a hole
        // munmap left, or at/above the bump pointer within RAM. HotSpot
        // reserves its heap and code cache this way (falling back to hints).
        const NOREPLACE = 0x100000n;
        let fixedAt = (flags & FIXED) ? a1 : null;
        if (fixedAt === null && (flags & NOREPLACE)) {
          if (this._mmapFree(a1, len)) fixedAt = a1; else { ret(-17n); break; }
        }
        // a fixed mapping over arena space takes it out of the holes / bump
        if (fixedAt !== null) { this._unmapRange(fixedAt, fixedAt + len); this._mmapCarve(fixedAt, len); }   // replaces whatever was mapped there
        const at = fixedAt !== null ? fixedAt : this._mmapTake(len);
        if (fixedAt !== null) if (a1 < (this._mmapBase ?? 0n) || a1 >= this.mmapNext) {   // outside the arena: remember the span
          this._fixedLo = this._fixedLo === undefined ? a1 : (a1 < this._fixedLo ? a1 : this._fixedLo);
          const hi = a1 + len; this._fixedHi = this._fixedHi === undefined ? hi : (hi > this._fixedHi ? hi : this._fixedHi);
        }
        const off0 = Number(at - this.base);
        if (off0 < 0 || off0 + Number(len) > this.ram.length) { ret(-12n); break; }   // ENOMEM
        this.ram.fill(0, off0, off0 + Number(len));          // fresh mapping is zeroed
        if (!(flags & ANON) && this.fds.get(fdArg)?.gen === 'zero') { ret(at); break; }   // /dev/zero: anonymous
        if (!(flags & ANON)) {
          const h = this.fds.get(fdArg);
          if (!h) { ret(-9n); break; }                       // EBADF
          const fo = Number(cpu.regs[9]);
          const n = Math.min(Number(a2), Math.max(0, h.bytes.length - fo));
          if (n > 0) this.ram.set(h.bytes.subarray(fo, fo + n), off0);
          // MAP_SHARED + PROT_WRITE on a regular file: stores through the
          // mapping must reach the file. The kernel writes dirty pages back
          // lazily; here they are copied out at msync, munmap and exit.
          const shared = !!(flags & 0x1n) && !!(a3 & 0x2n) && h.bytes !== undefined && !!h.writable;
          (this.maps ??= []).push({ at, len, path: h.path ?? '?', fileOff: fo, h, shared });
          this.execRanges.push([at, at + len]);   // library text: profiling must see it (prot untracked)
        }
        ret(at); break; }
      case 11: {                                             // munmap
        // A JIT guest (V8 writes machine code into pages at runtime, then
        // recycles them) invalidates address-keyed translations: a fresh
        // mmap at this address after the munmap would otherwise dispatch
        // into stale units. Drop every compiled artifact whose entry lies
        // in the range and rebuild the dispatch hash without them; skip all
        // of it for the common data-buffer munmap that intersects nothing.
        const lo = a1, hi = a1 + a2;
        const inR = (k) => k >= lo && k < hi;
        this._unmapRange(lo, hi);                            // shared-mapping write-back
        this._mmapGive(lo, align(a2, PAGE));                 // the arena reuses it
        let hit = false;
        for (const k of this.aotFns.keys()) if (inR(k)) { this.aotFns.delete(k); hit = true; }
        for (const k of this.aotFailed) if (inR(k)) this.aotFailed.delete(k);
        if (this.compiled) for (const k of this.compiled.keys()) if (inR(k)) this.compiled.delete(k);
        if (this.profile) for (const k of this.profile.keys()) if (inR(k)) this.profile.delete(k);
        if (hit) this.rebuildFtmap();
        ret(0n); break; }
      case 10: ret(0n); break;                               // mprotect (no page prot here)
      case 273: ret(0n); break;                              // set_robust_list
      case 334: ret(-38n); break;                            // rseq -> ENOSYS (glibc copes)
      case 302: {                                            // prlimit64(pid, res, new, old)
        const oldp = cpu.regs[10];                           // r10 = old_limit (rdx is new_limit!)
        if (oldp) { const v = new DataView(this.wmem.buffer);
          const off = this.RAMOFF + Number(oldp - this.base);
          // RLIMIT_STACK must be finite: glibc sizes every pthread stack from
          // it — garbage/huge values made 516MB stacks and EAGAIN thread spawns.
          // RLIMIT_NOFILE too: infinity sent node's close-on-exec sweep over
          // 16M descriptors of interpreted fcntl before main was reached
          const [cur, max] = this.rlimits(Number(a2));
          v.setBigUint64(off, cur, true);
          v.setBigUint64(off + 8, max, true); }
        ret(0n); break; }
      case 97: {                                             // getrlimit(res, rlim*)
        const v = new DataView(this.wmem.buffer);
        const off = this.RAMOFF + Number(a2 - this.base);
        const [cur, max] = this.rlimits(Number(a1));
        v.setBigUint64(off, cur, true);
        v.setBigUint64(off + 8, max, true);
        ret(0n); break; }
      case 267: {                                            // readlinkat: /proc/self/exe -> argv0
        // the real path, as readlink (89) already answers: Go's os.Executable
        // re-execs the binary by this name for its telemetry child
        // (absolute only: busybox re-execs itself by this name and aborted
        // on a relative argv0; '/prog' resolves to the image in lookup())
        const buf = cpu.regs[2], sz = cpu.regs[10] ?? cpu.regs[8];
        const p = new TextEncoder().encode(this.argv0?.startsWith('/') ? this.argv0 : '/prog');
        this.ram.set(p.subarray(0, Number(sz)), Number(buf - this.base));
        ret(BigInt(Math.min(p.length, Number(sz)))); break; }
      case 318: {                                            // getrandom
        const buf = a1, len = Number(a2);
        const bytes = new Uint8Array(len);
        crypto.getRandomValues(bytes.subarray(0, Math.min(len, 65536)));
        this.ram.set(bytes, Number(buf - this.base));
        ret(BigInt(len)); break; }
      case 16: {                                             // ioctl
        const req = Number(a2 & 0xffffffffn), h = this.fds.get(Number(a1));
        const pty = h?.ptm ?? h?.pts;                        // a pty end, either side
        // a pty pair works whether or not the session has a console tty
        // descriptor-generic requests, valid on any fd kind
        if (req === 0x5451 || req === 0x5450) {              // FIOCLEX / FIONCLEX
          if (!h) { ret(-9n); break; }
          if (req === 0x5451) this.cloexec.add(Number(a1)); else this.cloexec.delete(Number(a1));
          ret(0n); break; }
        if (req === 0x5421) {                                 // FIONBIO: O_NONBLOCK on/off
          if (!h) { ret(-9n); break; }
          h.nonblock = !!Number(this.mem.read(a3, 4n)); if (h.sock) h.sock.nonblock = h.nonblock; if (h.ev) h.ev.nonblock = h.nonblock;
          ret(0n); break; }
        if (req === 0x541B) {                                 // FIONREAD: bytes readable now
          if (!h) { ret(-9n); break; }
          const avail = h.pipe ? (h.pipe.size ?? 0) : h.bytes !== undefined ? Math.max(0, h.bytes.length - h.pos) : 0;
          this.jsnap(a3, 4); this.mem.write(a3, 4n, BigInt(avail)); ret(0n); break; }
        if (!pty && !(this.tty && (Number(a1) <= 2 || h?.istty))) {   // ENOTTY
          this._noteIoctl(req, h); ret(-25n); break; }
        const v = new DataView(this.wmem.buffer);
        const off = a3 ? this.RAMOFF + Number(a3 - this.base) : 0;
        const T = pty ? pty.termios : this.termios;
        switch (req) {
          // TCGETS/TCSETS use the KERNEL struct termios: four u32 flags, a
          // u8 c_line, then c_cc[19] — 36 bytes. glibc's user-facing termios
          // is 60 bytes with c_ispeed/c_ospeed appended, and writing that
          // many bytes overruns the caller's buffer (the guest reported
          // "*** stack smashing detected ***", which is exactly what it is).
          case 0x5401: {                                     // TCGETS
            if (!a3) { ret(-14n); break; }
            this.jsnap(a3, 36);
            v.setUint32(off + 0, T.iflag, true); v.setUint32(off + 4, T.oflag, true);
            v.setUint32(off + 8, T.cflag, true); v.setUint32(off + 12, T.lflag, true);
            v.setUint8(off + 16, 0);
            new Uint8Array(this.wmem.buffer, off + 17, 19).set(T.cc.subarray(0, 19));
            ret(0n); break; }
          case 0x5402: case 0x5403: case 0x5404: {           // TCSETS / SETSW / SETSF
            if (!a3) { ret(-14n); break; }
            T.iflag = v.getUint32(off + 0, true); T.oflag = v.getUint32(off + 4, true);
            T.cflag = v.getUint32(off + 8, true); T.lflag = v.getUint32(off + 12, true);
            T.cc.set(new Uint8Array(this.wmem.buffer, off + 17, 19).slice(0, 19));
            ret(0n); break; }
          case 0x5413: {                                     // TIOCGWINSZ
            if (!a3) { ret(-14n); break; }
            this.jsnap(a3, 8);
            const W = pty ? pty.win : this.ttyWin;
            v.setUint16(off + 0, W.rows, true); v.setUint16(off + 2, W.cols, true);
            v.setUint16(off + 4, W.cols * 8, true); v.setUint16(off + 6, W.rows * 16, true);
            ret(0n); break; }
          case 0x5414: {                                     // TIOCSWINSZ
            const W = pty ? pty.win : this.ttyWin;
            if (a3) { W.rows = v.getUint16(off + 0, true) || 24;
                      W.cols = v.getUint16(off + 2, true) || 80; }
            ret(0n); break; }
          // ptmx-only: the number of the slave, and unlocking it. glibc's
          // grantpt/unlockpt/ptsname sequence is TIOCSPTLCK then TIOCGPTN,
          // and openpty/forkpty go straight to TIOCGPTPEER when it exists.
          case 0x80045430:                                   // TIOCGPTN
            if (!h?.ptm || !a3) { ret(-25n); break; }
            this.jsnap(a3, 4);
            v.setUint32(off, h.ptm.n, true); ret(0n); break;
          case 0x40045431: ret(h?.ptm ? 0n : -25n); break;    // TIOCSPTLCK
          case 0x5441: {                                     // TIOCGPTPEER
            if (!h?.ptm) { ret(-25n); break; }
            const fd = this.allocFd();
            this.fds.set(fd, this.ptsHandle(h.ptm));
            ret(BigInt(fd)); break; }
          case 0x540E: ret(0n); break;                       // TIOCSCTTY
          case 0x540F: if (a3) { this.jsnap(a3, 4); v.setUint32(off, 1, true); } ret(0n); break;   // TIOCGPGRP
          case 0x5410: ret(0n); break;                                      // TIOCSPGRP
          case 0x540B: ret(0n); break;                                      // TCFLSH
          case 0x5409: ret(0n); break;                                      // TCSBRK
          default: this._noteIoctl(req, h); ret(-25n); break;
        }
        break; }
      case 158:                                              // arch_prctl
        if (Number(a1) === 0x1002) { cpu.fsBase = a2; ret(0n); } else ret(-22n);
        break;
      case 218: { const t = this.threads[this.ti]; t.ctid = a1; ret(BigInt(t.id)); break; }  // set_tid_address
      case 56: case 57: case 58: {                           // clone / fork / vfork
        const flags = nr === 56 ? Number(a1 & 0xffffffffn) : 0;
        // posix_spawn is clone(CLONE_VM|CLONE_VFORK|SIGCHLD): a vfork child
        // on its own small stack, not a thread — CLONE_VFORK decides
        if (!(flags & 0x100) || (flags & 0x4000)) {
          // Reached nested under a live wasm callout (a tiered caller reached
          // fork through interpUntil): spawning the child here runs it on the
          // shared stack beneath the parent's suspended wasm frame, and the
          // child's execve-unwind resumes that frame corrupt. Deopt to _run1
          // and re-execute the fork at top level, where no frame is beneath
          // it. cpu.rip is one past the 2-byte syscall; rewind to it.
          if ((this._iuDepth | 0) > 0) {
            this.cpu.rip = BigInt.asUintN(64, this.cpu.rip - 2n);
            this.syncOut();
            throw new DeoptUnwind(this.cpu.rip);
          }
          // fork/vfork: VFORK SEMANTICS — the child shares this memory image
          // and runs with a copy of the fd table; the parent thread is
          // suspended until the child execve()s (which moves it into its own
          // engine) or exits. Exact for the g_spawn / posix_spawn pattern
          // (dup2 + close + execve between fork and exec), which is what
          // GIMP's plug-in launcher does.
          const pid = this._allocPid();
          const c = new CPU(this.mem);
          c.onSyscall = (cc) => this.syscall(cc);
          for (let r = 0; r < 16; r++) c.regs[r] = cpu.regs[r];
          for (let r = 0; r < 16; r++) c.xmm[r] = cpu.xmm[r] ?? 0n;
          c.rip = cpu.rip; c.fsBase = cpu.fsBase;
          c.regs[0] = 0n;                                    // child sees 0
          if (nr === 56 && a2) c.regs[4] = a2;               // posix_spawn's child stack
          const parent = this.threads[this.ti];
          parent.state = 'vfork';                            // scheduler skips until released
          this._vforkFreeze(parent);                         // ... and so do its sibling threads
          // The child shares this memory image, but real fork gives it a
          // COPY: everything it writes before execve — fork()'s return
          // value stored to a stack local, and heap mutation from child-
          // setup callbacks (GIMP's prep_for_exec NULLs and frees the
          // parent's wire channels!) — must vanish when the parent resumes.
          // The child runs INTERPRETED with the write journal armed
          // (switchTo swaps it in only while the child is current, so other
          // threads' writes are untouched); exec/exit rolls it back.
          const t = { id: pid, cpu: c, state: 'run', dl: null, futex: null, ctid: 0n, _dl: null,
                      proc: { pid, fds: new Map(this.fds), parent, jrnl: [], cwd0: this.cwd ?? '/' } };
          this._sigInherit(t, parent, true);
          this.threads.push(t);
          // Complete the parent's syscall (rax = pid, rip already past the
          // insn) and switch STRAIGHT to the child — blocking here would
          // rewind the parent's rip and re-execute the fork on release.
          ret(BigInt(pid));
          this.switchTo(this.threads.length - 1); break;
        }
        const tid = this.nextTid++;
        const c = new CPU(this.mem);
        c.onSyscall = (cc) => this.syscall(cc);
        for (let r = 0; r < 16; r++) c.regs[r] = cpu.regs[r];
        for (let r = 0; r < 16; r++) c.xmm[r] = cpu.xmm[r] ?? 0n;
        c.rip = cpu.rip;                                     // resumes after the syscall insn
        c.regs[0] = 0n;                                      // child sees 0
        c.regs[4] = a2;                                      // child stack
        c.fsBase = (flags & 0x80000) ? cpu.regs[8] : cpu.fsBase;               // CLONE_SETTLS
        const t = { id: tid, cpu: c, state: 'run', dl: null, futex: null,
                    ctid: (flags & 0x200000) ? cpu.regs[10] : 0n, _dl: null,   // CLONE_CHILD_CLEARTID
                    proc: this.threads[this.ti].proc };          // a window child's thread is the CHILD's (Ruby's timer thread after fork)
        this._sigInherit(t, this.threads[this.ti], false);
        this.threads.push(t);
        if (flags & 0x100000) this.mem.write(a3, 4n, BigInt(tid));             // CLONE_PARENT_SETTID
        if (flags & 0x1000000) this.mem.write(cpu.regs[10], 4n, BigInt(tid));  // CLONE_CHILD_SETTID
        ret(BigInt(tid)); break; }
      case 59: {                                             // execve(path, argv, envp)
        const t = this.threads[this.ti];
        // the old image of a tail-exec'd main process re-steps its execve on
        // every blocked-rewind resume: keep it parked, never exec twice
        if (this._execed) { this.block(null); break; }
        const path = this.readPath(a1);
        const readVec = (p) => { const out = [];
          for (let i = 0n; ; i += 8n) { const sp = this.mem.read(p + i, 8n); if (sp === 0n) break;
            out.push(this.readPath(sp)); } return out; };
        const argv = a2 ? readVec(a2) : [path];
        const envp = a3 ? readVec(a3) : [];
        const bytes = this.lookup(path);
        if (!bytes) { ret(-2n); break; }                     // ENOENT
        // The child becomes its own engine: fresh memory image for the new
        // binary, the vfork-window fd table carried over so the wire pipes
        // the parent set up (dup2 before exec) connect the two engines.
        const ceng = new LinuxEngine(bytes, {
          argv, env: envp, files: this.files, mtimes: this.mtimes,
          memMB: this.childMemMB ?? 256, assembleWat: this.assembleWat,   // small: plug-ins are lean, and the tab already holds the parent's image
          aotCallThreshold: this.aotCallThreshold, aotLoopThreshold: this.aotLoopThreshold,
          xserver: this.xserver });
        if (this.strace) ceng.strace = [];                   // a traced parent traces its children
        if (this.childMemMB !== undefined) ceng.childMemMB = this.childMemMB;   // grandchildren too (cargo -> rustc -> cc -> collect2 -> ld)
        if (this.onChildEngine) { ceng.onChildEngine = this.onChildEngine; this.onChildEngine(ceng, argv); }   // tooling: see every execve'd image, grandchildren included, even ones reaped inside one run slice
        const skipped = [];
        const srcFds = t.proc ? t.proc.fds : this.fds;
        for (const [fd, h] of srcFds) {
          // close-on-exec descriptors are NOT inherited; if one was the last
          // write end of a pipe (g_spawn's child-error-report pipe), readers
          // get EOF — the signal g_spawn's parent blocks on to learn the
          // exec succeeded. The sweep below runs after this context is dead.
          if (this.cloexec.has(fd)) { skipped.push(h); continue; }
          ceng.fds.set(fd, h);
        }
        // NOTE: the parent's unit manifest is NOT shared — its keys are
        // parent-address-space entries; the child's library layout differs.
        if (this.asyncCompile) ceng.asyncCompile = this.asyncCompile;
        ceng.unitMaxFuncs = this.childUnitMaxFuncs ?? 24;    // wabt-sized units
        ceng.unitMaxInsns = this.childUnitMaxInsns ?? 4000;
        // Per-binary child unit cache: a plug-in's load layout is
        // deterministic (same binary, same files, same allocator sequence),
        // so its compiled units are keyed by (path, entry) and reused across
        // spawns — the first run of a filter tiers organically, repeats
        // register instantly.
        {
          const cache = (this.childUnits ??= new Map()).get(path) ?? new Map();
          this.childUnits.set(path, cache);
          ceng.unitBytes = (k) => cache.get(k.toString(16));
          ceng.onUnitBytes = (k, bytes) => cache.set(k.toString(16), bytes);
        }
        ceng.cwd = this.cwd;                                 // exec inherits the cwd
        ceng.parentEng = this;
        if (!t.proc) {
          // Tail exec of the MAIN process (busybox sh execs the last command
          // of a script in place): this engine can't replace its own image,
          // so it becomes a pump for the replacement child — run() forwards
          // slices to it and adopts its exit code.
          const pid = this._allocPid();
          const rec = { pid, eng: ceng, exited: null };
          ceng.pid = this.pid ?? 1; ceng.ppid = this.ppid ?? 0;   // a tail-exec IS this process
          (this.children ??= []).push(rec);
          this._execed = rec;
          this._pipeEofSweep(skipped);
          if (this.onSpawn) this.onSpawn(pid, path, argv);
          t.state = 'dead';                                  // this image never resumes
          // no ret(): a blocking syscall re-executes on resume, so rax must
          // still hold the syscall number when the rewound insn re-steps
          this.block(null); break;
        }
        (this.children ??= []).push({ pid: t.proc.pid, eng: ceng, exited: null });
        ceng.pid = t.proc.pid; ceng.ppid = this.pid ?? 1;
        t.state = 'dead'; this._killProcSiblings(t);
        this._pipeEofSweep(skipped);
        this._vforkRollback(t);
        t.proc.parent.state = 'run'; this._vforkThaw(t.proc.parent);   // vfork release
        if (this.onSpawn) this.onSpawn(t.proc.pid, path, argv);
        this.block(null); ret(0n); break; }
      case 61: {                                             // wait4(pid, status*, options, rusage)
        const pid = Number(BigInt.asIntN(32, a1)), opts = Number(a3);
        const kids = this.children ?? [];
        const mine = kids.filter(c => pid <= 0 || c.pid === pid);
        if (!mine.length) { ret(-10n); break; }              // ECHILD
        const done = mine.find(c => c.exited !== null || (c.eng && c.eng.exitCode !== null));
        if (!done) { if (opts & 1) ret(0n); else this.block(null); break; }   // WNOHANG / block
        const code = done.exited ?? done.eng.exitCode;
        const tsig = done.sig ?? done.eng?.termSig;
        if (a2) this.mem.write(a2, 4n, BigInt(tsig ? (tsig & 0x7f) : ((code & 0xff) << 8)));   // WIFSIGNALED / WIFEXITED
        this.children.splice(this.children.indexOf(done), 1);
        ret(BigInt(done.pid)); break; }
      case 98: {                                             // getrusage(who, rusage*): zeros (gdb asks at startup)
        if (a2) { this.jsnap(a2, 144); new Uint8Array(this.wmem.buffer, this.RAMOFF + Number(a2 - this.base), 144).fill(0); }
        ret(0n); break; }
      case 74: case 75: case 162: case 306: case 277:        // fsync / fdatasync / sync / syncfs / sync_file_range
        ret(0n); break;                                      // the FS is in memory: durable already. vim's write path fsyncs and, on ENOSYS, reports the write failed and unlinks it
      case 24: ret(0n); break;                               // sched_yield (quantum rotation covers fairness)
      case 273: ret(0n); break;                              // set_robust_list
      case 157: ret(0n); break;                              // prctl (PR_SET_NAME etc.)
      case 204: {                                            // sched_getaffinity: one CPU
        const n = Math.min(Number(a2), 8);
        const o = this.RAMOFF + Number(a3 - this.base);
        new Uint8Array(this.wmem.buffer, o, n).fill(0);
        new DataView(this.wmem.buffer).setUint8(o, 1);
        ret(8n); break; }
      case 60: case 231: {                                   // exit / exit_group
        const t = this.threads[this.ti];
        if (t.proc && nr === 60 && this.threads.some(x => x !== t && x.state !== 'dead' && x.proc === t.proc)) {
          t.state = 'dead';                                  // one thread of a window child: the process lives on
          if (t.ctid) { this.mem.write(t.ctid, 4n, 0n); this.futexWake(t.ctid, 1 << 30); }
          this.block(null); ret(0n); break;
        }
        if (t.proc) {
          // a vfork-window child died without execve (e.g. g_spawn's _exit
          // after a failed exec): release the parent, record the status for
          // wait4, retire this context
          t.state = 'dead'; this._killProcSiblings(t);
          this._pipeEofSweep([...t.proc.fds.values()]);
          this._rlockExit(t.proc);
          this._vforkRollback(t);
          t.proc.parent.state = 'run'; this._vforkThaw(t.proc.parent);
          (this.children ??= []).push({ pid: t.proc.pid, eng: null, exited: Number(a1 & 0xffn) });
          // SIGCHLD to the PARENT thread (the current thread is the dying child)
          this.raiseSignal(17, t.proc.parent.id, { pid: t.proc.pid, code: 1, status: Number(a1 & 0xffn) });
          this.block(null); ret(0n); break;
        }
        if (nr === 231 || this.threads.filter(x => x.state !== 'dead').length <= 1) {
          this._flushSharedMaps();                            // dirty shared pages reach the file
          this._rlockExit(this);                              // POSIX record locks die with the process
          this.exitCode = Number(a1 & 0xffn); cpu.halted = true; ret(0n); break;
        }
        t.state = 'dead';
        if (t.ctid) { this.mem.write(t.ctid, 4n, 0n); this.futexWake(t.ctid, 1 << 30); }
        this.block(null); ret(0n); break; }                  // park() skips dead threads
      case 228: {                                            // clock_gettime(clk, ts*)
        const clk = Number(a1), o = this.RAMOFF + Number(a2 - this.base);
        const v = new DataView(this.wmem.buffer);
        const ms = (clk === 0 || clk === 5 || clk === 6) ? Date.now() : this.nowMs();
        if (this.dbgClockWatch && a2 >= this.dbgClockWatch[0] && a2 < this.dbgClockWatch[1]) {
          console.error(`<clock_gettime clk=${clk} ts=0x${a2.toString(16)} rsp=0x${cpu.regs[4].toString(16)} thr=${this.threads?.[this.ti]?.id} rip=0x${cpu.rip.toString(16)} interp=${this.stats.interpreted} wall=${(this.nowMs()/1000)|0}s>`);
          const st = [];
          for (let i = -2n; i <= 4n; i++) { try { st.push(`[ts${i >= 0n ? '+' : ''}${i * 8n}]=0x${this.mem.read(a2 + i * 8n, 8n).toString(16)}`); } catch {} }
          console.error('  ' + st.join(' '));
        }
        v.setBigUint64(o, BigInt(Math.floor(ms / 1000)), true);
        v.setBigUint64(o + 8, BigInt(Math.floor((ms % 1000) * 1e6)), true);
        ret(0n); break; }
      case 201: ret(BigInt(Math.floor(Date.now() / 1000))); break;   // time
      case 309: {                                             // getcpu(cpu*, node*, tcache): one CPU, one node
        if (a1) this.mem.write(a1, 4n, 0n); if (a2) this.mem.write(a2, 4n, 0n); ret(0n); break; }
      case 188: case 189: case 190: ret(-95n); break;           // setxattr family: ENOTSUP
      case 191: case 192: case 193: ret(-61n); break;           // getxattr family: ENODATA
      case 194: case 195: case 196: ret(0n); break;             // listxattr family: empty list
      case 197: case 198: case 199: ret(-61n); break;           // removexattr family: ENODATA
      case 229: {                                             // clock_getres(clk, res*): 1ns
        if (a2) { this.jsnap(a2, 16); this.mem.write(a2, 8n, 0n); this.mem.write(a2 + 8n, 8n, 1n); }
        ret(0n); break; }
      case 125: {                                             // capget: no capabilities
        if (a2) { this.jsnap(a2, 24); for (let o = 0n; o < 24n; o += 4n) this.mem.write(a2 + o, 4n, 0n); }
        ret(0n); break; }
      case 27: {                                              // mincore: everything resident
        const n = Math.ceil(Number(a2) / 4096);
        this.jsnap(a3, n); this.ram.fill(1, Number(a3 - this.base), Number(a3 - this.base) + n);
        ret(0n); break; }
      case 35: case 230: {                                   // nanosleep / clock_nanosleep
        const req = nr === 35 ? a1 : cpu.regs[2];            // rdx for clock_nanosleep
        const abs = nr === 230 && (Number(a2) & 1);          // TIMER_ABSTIME
        if (req === 0n) { ret(0n); break; }
        const o = this.RAMOFF + Number(req - this.base);
        const v = new DataView(this.wmem.buffer);
        const tms = Number(v.getBigUint64(o, true)) * 1000 + Number(v.getBigUint64(o + 8, true)) / 1e6;
        const now = this.nowMs();
        const deadline = this._deadline ??
          (abs ? (Number(a1) === 0 ? tms - Date.now() + now : tms) : now + tms);
        if (now >= deadline) { this._deadline = null; ret(0n); break; }
        this._deadline = deadline; this.block(deadline); break; }
      case 39: ret(BigInt(this.threads[this.ti].proc?.pid ?? this.pid ?? 1)); break;   // getpid: a vfork-window child has its own
      case 62: case 200: case 234: {                         // kill / tkill / tgkill
        // signal delivery to SELF with a fatal signal takes the default
        // action: terminate with the shell-convention 128+sig status. No
        // handler machinery exists (rt_sigaction is a stored no-op), so the
        // default is the faithful approximation - php's fortify abort used
        // to reach exit 127 via tgkill=ENOSYS + glibc's fallback exit,
        // where native dies 134. sig 0 stays a liveness probe.
        const sig = Number(nr === 62 ? a2 : a3);
        if (sig === 0) { ret(0n); break; }
        if (sig < 1 || sig > 64) { ret(-22n); break; }
        if (nr === 62) {
          const pid = Number(BigInt.asIntN(32, a1));
          const kid = (this.children ?? []).find(c => c.pid === pid && c.exited === null);
          if (kid) { kid.eng.raiseSignal(sig, null, { pid: 1, code: 0 }); ret(0n); break; }
          const self = this.threads[this.ti].proc?.pid ?? this.pid ?? 1;
          if (pid > 1 && pid !== self) { ret(-3n); break; }         // ESRCH: no such process here
          this.raiseSignal(sig, null, { pid: 1, code: 0 });         // SI_USER, process-directed
        } else {
          const tid = Number(nr === 200 ? a1 : a2);
          if (!this.threads.some(t => t.id === tid) && tid > 1) { ret(-3n); break; }
          this.raiseSignal(sig, tid <= 1 ? this.threads[0].id : tid, { pid: 1, code: -6 });   // SI_TKILL
        }
        ret(0n); break; }
      case 102: case 104: case 107: case 108: ret(0n); break; // getuid/getgid/geteuid/getegid
      // Credentials and ownership are single-user here: everything runs as
      // one uid, so these succeed rather than reporting ENOSYS. xterm calls
      // setegid() (i.e. setresgid) to drop privileges after opening its pty
      // and treats the failure as fatal — "setegid(0): Function not
      // implemented", then "Cannot chown /dev/pts/0".
      case 105: case 106:                                     // setuid / setgid
      case 113: case 114:                                     // setreuid / setregid
      case 117: case 119:                                     // setresuid / setresgid
      case 92: case 93: case 260:                             // chown / fchown / fchownat
      case 90: case 91: case 268: ret(0n); break;             // chmod / fchmod / fchmodat
      case 452: {                                             // fchmodat2(dirfd, path, mode, flags): modes are not modelled
        const p = this.norm(this.atPath(a1, a2));
        const exists = this.files[p] !== undefined || this.isDir(p) || this._fsMeta().links.has(p) || !!this._fifoAt(p);
        ret(exists ? 0n : -2n); break; }
      case 157: ret(0n); break;                               // prctl
      case 96: {                                              // gettimeofday(tv*, tz)
        if (a1 !== 0n) {
          const o = this.RAMOFF + Number(a1 - this.base);
          const v = new DataView(this.wmem.buffer);
          const ms = Date.now();
          v.setBigUint64(o, BigInt(Math.floor(ms / 1000)), true);
          v.setBigUint64(o + 8, BigInt(Math.floor((ms % 1000) * 1000)), true);
        }
        ret(0n); break; }
      case 257: case 2: {                                     // openat(dirfd,path,flags) / open(path,flags)
        const p = nr === 257 ? this.atPath(a1, a2) : this.readPath(a1);
        const flags = Number(nr === 257 ? a3 : a2);
        // the controlling terminal: a shell opens it to test for job control
        // and `tty` reports its name. Only present in terminal mode.
        {
          const np = this.norm(p);
          if (np === '/dev/null') {
            // Empty backing bytes make read (EOF), fstat (size 0) and lseek
            // behave through the ordinary file paths; only write needs its
            // discard case in writeChunk. Found by perl, which opens
            // /dev/null during startup and exits 2 when it cannot.
            const fd = this.allocFd();
            this.fds.set(fd, { bytes: new Uint8Array(0), pos: 0, writable: true, devnull: true });
            ret(BigInt(fd)); break;
          }
          if (np === '/dev/ptmx') {                          // allocate a pty pair
            const fd = this.allocFd();
            this.fds.set(fd, this.ptmxHandle(this.newPty()));
            ret(BigInt(fd)); break;
          }
          const mp = /^\/dev\/pts\/(\d+)$/.exec(np);
          if (mp && this.ptys.has(Number(mp[1]))) {          // the slave side
            const fd = this.allocFd();
            this.fds.set(fd, this.ptsHandle(this.ptys.get(Number(mp[1]))));
            ret(BigInt(fd)); break;
          }
        }
        if (this.isTtyPath(p)) {
          const fd = this.allocFd();
          this.fds.set(fd, { sink: 'out', istty: true, path: '/dev/pts/0' });
          ret(BigInt(fd)); break;
        }
        {
          const np = this.norm(p);
          if (np === '/dev/zero' || np === '/dev/urandom' || np === '/dev/random') {
            const fd = this.allocFd();
            this.fds.set(fd, { gen: np === '/dev/zero' ? 'zero' : 'rand', pos: 0, path: np, writable: true, devnull: np === '/dev/zero' ? false : false });
            ret(BigInt(fd)); break;
          }
          // a FIFO: a pipe buffer with a name. open blocks until the other
          // end is open somewhere in the process tree (O_NONBLOCK: a reader
          // proceeds, a writer gets ENXIO); a writer's open clears EOF.
          const fifo = this._fifoAt(np);
          if (fifo) {
            const wr = (flags & 3) !== 0, nb = !!(flags & 0x800);
            // the rendezvous: an open completes when the other end is open OR
            // is itself waiting to open (both sides would otherwise wait for
            // a handle that only a completed open creates)
            fifo.waiters ??= new Map();
            const key = `${this.pid ?? 1}:${this.threads[this.ti].id}`;
            const otherWaiting = [...fifo.waiters.values()].some(v => v === (wr ? 'r' : 'w'));
            const other = (wr ? this._pipeReaderAlive(fifo) : this._pipeWriterAlive(fifo)) || otherWaiting;
            if (!other && !nb && (flags & 3) !== 2) { fifo.waiters.set(key, wr ? 'w' : 'r'); this.block(null); break; }   // O_RDWR never blocks
            fifo.waiters.delete(key);
            if (!other && nb && wr) { ret(-6n); break; }                          // ENXIO
            const fd = this.allocFd();
            if (wr) fifo.weof = false;
            this.fds.set(fd, { pipe: fifo, mode: wr ? 'w' : 'r', fifo: true, nonblock: nb, path: np });
            this.wakeAllBlk();                                                    // the waiting opener re-checks
            let root = this; while (root.parentEng) root = root.parentEng; if (root !== this) root.wakeAllBlk();
            ret(BigInt(fd)); break;
          }
          // /proc/self/fd/N reopens descriptor N (bash's <(...) and >(...)):
          // a regular file gets its own offset, a pipe end is shared
          const m = /^\/proc\/(?:self|\d+)\/fd\/(\d+)$/.exec(np) ?? /^\/dev\/fd\/(\d+)$/.exec(np)
                 ?? (np === '/dev/stdin' ? [0, '0'] : np === '/dev/stdout' ? [0, '1'] : np === '/dev/stderr' ? [0, '2'] : null);
          if (m) {
            const src = this.fds.get(Number(m[1]));
            if (!src) { ret(-2n); break; }
            const fd = this.allocFd();
            this.fds.set(fd, src.bytes !== undefined ? { bytes: src.bytes, pos: 0, path: src.path, writable: (flags & 3) !== 0 } : src);
            ret(BigInt(fd)); break;
          }
        }
        let f = this.lookup(p);
        if (f === undefined) {
          if (this.isDir(p)) {                                // O_DIRECTORY / readdir scans
            const fd = this.allocFd();
            // the RESOLVED path: listing a symlinked directory must enumerate
            // what the link points at
            this.fds.set(fd, { isdir: true, path: this.resolve(this.norm(p)), pos: 0 });
            ret(BigInt(fd)); break;
          }
          if (flags & 0x40) {                                 // O_CREAT: writable guest files
            f = new Uint8Array(0);
            this.files[this.norm(p)] = f; this.fsBump();
            if (this.mtimes) this.mtimes[this.norm(p)] = Math.floor(this.nowMs() / 1000);
          } else { ret(-2n); break; }                         // ENOENT
        } else if (flags & 0x200) {                           // O_TRUNC
          f = new Uint8Array(0);
          this.files[this.norm(p)] = f;
        }
        const fd = this.allocFd();
        const wr = (flags & 3) !== 0;                         // O_WRONLY / O_RDWR
        this.fds.set(fd, { bytes: f, pos: (flags & 0x400) ? f.length : 0,
                           path: this.resolve(this.norm(p)), writable: wr });
        ret(BigInt(fd)); break; }
      case 0: {                                               // read(fd, buf, len)
        const fd = Number(a1), h = this.fds.get(fd);
        if (!h) { ret(fd === 0 ? 0n : -9n); break; }          // stdin -> EOF
        if (h.sock) {                                         // stream socket (X connection)
          const c = h.sock.conn;
          if (!c) { ret(-107n); break; }                      // ENOTCONN
          const data = c.read(Number(a3));
          if (data === null) { if (h.sock.nonblock) ret(-11n); else this.block(null); break; }
          this.jsnap(a2, data.length); this.ram.set(data, Number(a2 - this.base));
          ret(BigInt(data.length)); break;
        }
        if (h.ev) {                                           // eventfd: 8-byte counter
          if (h.ev.count > 0n) {
            const val = h.ev.sem ? 1n : h.ev.count;
            h.ev.count -= val;
            this.mem.write(a2, 8n, val); ret(8n); break;
          }
          if (h.ev.nonblock) ret(-11n); else this.block(null);
          break;
        }
        if (h.pipe) {                                         // drain the shared pipe buffer
          const want = Number(a3); let dst = Number(a2 - this.base), got = 0;
          while (got < want && h.pipe.chunks.length) {
            const c = h.pipe.chunks[0], avail = c.length - h.pipe.off;
            const take = Math.min(avail, want - got);
            this.jsnap(this.base + BigInt(dst), take);
            this.ram.set(c.subarray(h.pipe.off, h.pipe.off + take), dst);
            dst += take; got += take; h.pipe.off += take;
            if (h.pipe.off >= c.length) { h.pipe.chunks.shift(); h.pipe.off = 0; }
          }
          if (got > 0) { h.pipe.size = Math.max(0, (h.pipe.size ?? 0) - got); this.wakeAllBlk(); }   // a blocked writer may fit now
          // empty: EOF only once the writing side is gone (weof — set when a
          // child process holding the write end exits); otherwise BLOCK like
          // a real pipe — the plug-in wire protocol reads before data arrives
          if (got === 0 && want > 0 && !h.pipe.weof) {
            if (h.nonblock) { ret(-11n); break; }             // EAGAIN
            this.block(null); break;
          }
          ret(BigInt(got)); break;
        }
        if (h.tfd) {                                          // timerfd: 8-byte expiration count
          this._tfdTick(h.tfd);
          if (h.tfd.fired > 0) { this.mem.write(a2, 8n, BigInt(h.tfd.fired)); h.tfd.fired = 0; ret(8n); break; }
          if (h.nonblock) { ret(-11n); break; }
          this.block(h.tfd.at); break;
        }
        if (h.sfd) {                                          // signalfd: signalfd_siginfo records
          const t = this._ts(this.threads[this.ti]);
          let n = 0; const cap = Math.floor(Number(a3) / 128);
          while (n < cap) { const sig = this._sigTake(t, h.sfd.mask); if (!sig) break;
            this._writeSignalfdInfo(a2 + BigInt(n * 128), sig, t.siginfo?.get(sig) ?? {}); n++; }
          if (n > 0) { ret(BigInt(n * 128)); break; }
          if (h.nonblock) { ret(-11n); break; }
          this.block(null); break;
        }
        if (h.gen) {                                          // /dev/zero, /dev/urandom
          const n = Number(a3); this.jsnap(a2, n);
          const dst = this.ram.subarray(Number(a2 - this.base), Number(a2 - this.base) + n);
          if (h.gen === 'zero') dst.fill(0); else for (let i = 0; i < n; i += 65536) crypto.getRandomValues(dst.subarray(i, Math.min(n, i + 65536)));
          h.pos += n; ret(BigInt(n)); break;
        }
        if (h.path && this.maps?.length) this._mapsFlushPath(h.path);   // coherence: mapped stores reach the read
        // A read at or past EOF returns 0 and must NOT move the position.
        // Without the max(0,...), a read whose offset is beyond the current
        // file length (h.pos > h.bytes.length — routine while a linker writes
        // a sparse output and glibc's stdio reads a block ahead) yields a
        // NEGATIVE count and rewinds h.pos, so the next SEEK_CUR lands the
        // following write at the wrong offset (ld left _start zero-filled).
        const n = Math.max(0, Math.min(Number(a3), h.bytes.length - h.pos));
        this.jsnap(a2, n);
        this.ram.set(h.bytes.subarray(h.pos, h.pos + n), Number(a2 - this.base));
        h.pos += n; ret(BigInt(n)); break; }
      case 3: { const cfd = Number(a1), ch = this.fds.get(cfd);
        this.fds.delete(cfd); this.cloexec.delete(cfd);
        if (ch?.pipe && (ch.mode === 'w' || ch.peer)) this._pipeEofSweep([ch]);
        if (ch && this._fsMeta().flocks?.size) this._flockRelease(ch);
        if (ch && this._fsMeta().rlocks?.size) this._rlockClose(ch);
        ret(0n); break; }                                     // close
      case 436: {                                             // close_range(first, last, flags)
        const first = Number(a1), last = Math.min(Number(BigInt.asUintN(32, a2)), 1 << 20), fl = Number(a3);
        for (const fd of [...this.fds.keys()]) if (fd >= first && fd <= last) {
          if (fl & 4) { this.cloexec.add(fd); continue; }     // CLOSE_RANGE_CLOEXEC
          const ch = this.fds.get(fd); this.fds.delete(fd); this.cloexec.delete(fd);
          if (ch?.pipe && (ch.mode === 'w' || ch.peer)) this._pipeEofSweep([ch]);
          if (ch && this._fsMeta().flocks?.size) this._flockRelease(ch);
          if (ch && this._fsMeta().rlocks?.size) this._rlockClose(ch);
        }
        ret(0n); break; }
      case 73: {                                              // flock(fd, op): advisory, per open file description
        const h = this.fds.get(Number(a1)); if (!h) { ret(-9n); break; }
        const op = Number(a2) & ~4, nb = !!(Number(a2) & 4);   // LOCK_NB
        const key = h.path ?? h; const m = this._fsMeta(); m.flocks ??= new Map();
        let L = m.flocks.get(key);
        if (op === 8) { if (L) { L.sh.delete(h); if (L.ex === h) L.ex = null; if (!L.ex && !L.sh.size) m.flocks.delete(key); this.wakeAllBlk(); } ret(0n); break; }   // LOCK_UN
        L ??= { ex: null, sh: new Set() };
        const busy = op === 2 ? (L.ex && L.ex !== h) || [...L.sh].some(x => x !== h)    // LOCK_EX
                   : op === 1 ? (L.ex && L.ex !== h) : true;                             // LOCK_SH
        if (busy) { if (nb) { ret(-11n); break; } this.block(null); break; }             // EWOULDBLOCK / wait
        if (op === 2) { L.sh.delete(h); L.ex = h; } else { if (L.ex === h) L.ex = null; L.sh.add(h); }
        m.flocks.set(key, L); ret(0n); break; }
      case 8: {                                               // lseek
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        if (h.gen) { ret(0n); break; }
        if (!h.bytes) { ret(-29n); break; }                   // pipe/sink/socket: ESPIPE
        const w = Number(a3);                                 // rdx = whence
        const off = BigInt.asIntN(64, a2);
        h.pos = w === 0 ? Number(off) : w === 1 ? h.pos + Number(off) : h.bytes.length + Number(off);
        ret(BigInt(h.pos)); break; }
      case 5: case 262: {                                     // fstat / newfstatat
        const isAt = nr === 262;
        let size = null, mode = 0o020620, statPath = null;    // default: char dev (tty)
        // newfstatat(fd, "", AT_EMPTY_PATH) is fstat(fd): take the fd path
        // below for every handle kind (ripgrep stats its directory fds this
        // way, and the file-only branch that lived here threw on a dir
        // handle's missing bytes)
        // (a NULL path with AT_EMPTY_PATH is fstat too - Linux 6.11 allows it
        // and Rust's std uses it; reading the path first faulted at 0)
        const byFd = !isAt || ((cpu.regs[10] & 0x1000n) && (a2 === 0n || this.atPath(a1, a2) === ''));
        if (!byFd) {
          if (a2 === 0n) { ret(-14n); break; }                // EFAULT: NULL path without AT_EMPTY_PATH (Rust's std probes this)
          const p = this.atPath(a1, a2);
          if ((cpu.regs[10] & 0x100n) && !p.endsWith('/') &&   // AT_SYMLINK_NOFOLLOW
                     this._fsMeta().links.has(this.norm(p))) {
            statPath = this.norm(p);
            size = this._fsMeta().links.get(statPath).length; mode = 0o120777;
          } else if (this.isTtyPath(p)) {
            this.writeStat(cpu.regs[2], '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break;
          } else {
            const f = this.lookup(p);
            if (f !== undefined) { size = f.length; mode = this.fileMode(f); }
            else if (this.isDir(p)) { size = 4096; mode = 0o040755; }
            else if (this._fifoAt(p)) { size = 0; mode = 0o010644; }
            else { ret(-2n); break; }                         // ENOENT
            statPath = p;
          }
        } else {
          const h = this.fds.get(Number(a1));
          if (this.tty && (Number(a1) <= 2 || h?.istty)) {     // terminal: match stat("/dev/pts/0")
            this.writeStat(a2, '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break; }
          if (h?.gen) { size = 0; mode = 0o020666; }                        // /dev/zero, /dev/urandom
          else if (h?.tfd || h?.sfd) { size = 0; mode = 0o0100600; }       // anon inode
          else if (h?.bytes) { size = h.bytes.length; mode = this.fileMode(h.bytes); statPath = h.path ?? null; }  // regular file
          else if (h?.pipe) { size = 0; mode = h.fifo ? 0o010644 : 0o010600; statPath = h.fifo ? h.path : null; }   // FIFO / pipe
          else if (h?.sock) { size = 0; mode = 0o140777; }                 // socket
          else if (h?.isdir) { size = 4096; mode = 0o040755; statPath = h.path; }
          // sink/tty: leave mode as the char-device default
        }
        const buf = isAt ? cpu.regs[2] : a2;
        this.jsnap(buf, 144);
        const off = this.RAMOFF + Number(buf - this.base);
        new Uint8Array(this.wmem.buffer, off, 144).fill(0);
        const v = new DataView(this.wmem.buffer);
        v.setBigUint64(off + 0, 8n, true);                    // st_dev
        {
          let ino;
          if (statPath) ino = this.inoOf(statPath);
          else { const h = this.fds.get(Number(a1));
                 if (h) ino = (h._ino ??= this.inoOf('\0anon:' + (this._anonN = (this._anonN || 0) + 1)));
                 else ino = 7n; }
          v.setBigUint64(off + 8, ino, true);                 // st_ino
        }
        v.setBigUint64(off + 16, BigInt(statPath ? this.nlinkOf(statPath, mode) : 1), true);   // st_nlink
        v.setUint32(off + 24, mode, true);                    // st_mode (u32 at 24)
        v.setBigUint64(off + 48, BigInt(size ?? 0), true);    // st_size
        v.setBigUint64(off + 56, 4096n, true);                // st_blksize
        v.setBigUint64(off + 64, BigInt(Math.ceil((size ?? 0) / 4096) * 8), true);    // st_blocks: 4K units
        if (statPath) { const mt = BigInt(this.mtimeOf(statPath));
          v.setBigUint64(off + 72, mt, true); v.setBigUint64(off + 88, mt, true); v.setBigUint64(off + 104, mt, true); }
        ret(0n); break; }
      case 4: case 6: {                                       // stat / lstat (by path)
        const p = this.readPath(a1);
        // lstat does NOT follow a link — unless the path ends in '/', which
        // POSIX says forces the target (find walks "dir/" that way)
        if (nr === 6 && !p.endsWith('/')) {
          const t = this._fsMeta().links.get(this.norm(p));
          if (t !== undefined) { this.writeStat(a2, this.norm(p), t.length, 0o120777); ret(0n); break; }
        }
        if (this.debugPollAfter != null && this.nowMs() > this.debugPollAfter) {
          if (this.nowMs() - (this._dbgStatLast ?? 0) > 5000) { this._dbgStatLast = this.nowMs();
            console.error(`<statwd thr=${this.threads?.[this.ti]?.id} ${nr===6?'lstat':'stat'} ${p}>`); } }
        if (this.isTtyPath(p)) {
          this.writeStat(a2, '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break; }
        const f = this.lookup(p);
        if (f === undefined && !this.isDir(p)) {
          if (this._fifoAt(p)) { this.writeStat(a2, p, 0, 0o010644); ret(0n); break; }
          ret(-2n); break; }                                  // ENOENT
        this.writeStat(a2, p, f ? f.length : 4096, f ? this.fileMode(f) : 0o040755);
        ret(0n); break; }
      case 17: {                                              // pread64(fd, buf, count, off)
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        const fo = Number(cpu.regs[10]);
        if (h.path && this.maps?.length) this._mapsFlushPath(h.path);
        const n = Math.min(Number(a3), Math.max(0, h.bytes.length - fo));
        if (n > 0) { this.jsnap(a2, n); this.ram.set(h.bytes.subarray(fo, fo + n), Number(a2 - this.base)); }
        ret(BigInt(n)); break; }
      case 18: {                                              // pwrite64(fd, buf, count, off)
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }                          // EBADF
        // Only regular files honour an explicit offset. A pwrite writes at
        // `off` and does NOT move the file position (unlike write). ld uses
        // it to backfill sections (e.g. _start from Scrt1.o) after computing
        // final layout; falling through to ENOSYS zero-fills those bytes.
        if (h.bytes === undefined || !h.writable) {
          const r = writeChunk(Number(a1), a2, Number(a3)); if (r === -4096) break; ret(r === undefined ? a3 : BigInt(r)); break;   // pipe/sink: sequential
        }
        const len = Number(a3);
        if (len <= 0) { ret(0n); break; }
        this.guardRange(a2, len);
        const bytes = this.ram.slice(Number(a2 - this.base), Number(a2 - this.base) + len);
        const off = Number(cpu.regs[10]);
        const end = off + len;
        if (end > h.bytes.length) this._growFile(h, end);

        if (h.path) (this.dirtyFiles ??= new Set()).add(h.path);
        h.bytes.set(bytes, off);                              // position unchanged
        this._mapsAbsorb(h.path, off, bytes);
        ret(a3); break; }
      case 86: case 265: {                                    // link(old, new) / linkat(olddirfd, old, newdirfd, new, flags)
        const oldp = this.resolve(this.norm(nr === 86 ? this.readPath(a1) : this.atPath(a1, a2)));
        const newp = this.norm(nr === 86 ? this.readPath(a2) : this.atPath(a3, cpu.regs[10]));
        const f = this.files[oldp];
        if (f === undefined) { ret(this.isDir(oldp) ? -1n : -2n); break; }    // EPERM on a dir, ENOENT
        if (this.files[newp] !== undefined || this.isDir(newp)) { ret(-17n); break; }   // EEXIST
        this.files[newp] = f;                                   // one inode, two names
        const m = this._fsMeta(); m.hard ??= new Map();
        const g = m.hard.get(oldp) ?? new Set([oldp]);
        g.add(newp); for (const q of g) m.hard.set(q, g);
        if (this.mtimes) this.mtimes[newp] = this.mtimes[oldp] ?? Math.floor(this.nowMs() / 1000);
        this.fsBump(); ret(0n); break; }
      case 21: { const p = this.readPath(a1); ret(this.lookup(p) !== undefined || this.isDir(p) || !!this._fifoAt(p) ? 0n : -2n); break; }   // access
      case 269: case 439: { const p = this.atPath(a1, a2); ret(this.lookup(p) !== undefined || this.isDir(p) || !!this._fifoAt(p) ? 0n : -2n); break; }  // faccessat / faccessat2
      case 63: {                                              // uname
        const put = (o, s) => { const b = new TextEncoder().encode(s + '\0');
          this.ram.set(b, Number(a1 - this.base) + o); };
        this.jsnap(a1, 390);                                  // the zero-fill covers the whole struct
        this.ram.fill(0, Number(a1 - this.base), Number(a1 - this.base) + 390);
        put(0, 'Linux'); put(65, 'oxwasm'); put(130, '6.1.0'); put(195, '#1 oxwasm');
        put(260, 'x86_64'); ret(0n); break; }
      case 89: {                                              // readlink(path, buf, sz)
        const p = this.readPath(a1);
        if (p === '/proc/self/exe') { const b = new TextEncoder().encode(this.argv0?.startsWith('/') ? this.argv0 : '/prog');
          this.jsnap(a2, Math.min(b.length, Number(a3)));
          this.ram.set(b.subarray(0, Number(a3)), Number(a2 - this.base));
          ret(BigInt(Math.min(b.length, Number(a3)))); break; }
        if (this.tty) {                                       // ttyname(): /proc/self/fd/N
          const m = /^\/proc\/(?:self|\d+)\/fd\/(\d+)$/.exec(this.norm(p));
          if (m) { const h2 = this.fds.get(Number(m[1]));
            if (Number(m[1]) <= 2 || h2?.istty) {
              const b2 = new TextEncoder().encode('/dev/pts/0');
              const n2 = Math.min(b2.length, Number(a3));
              this.jsnap(a2, n2);
              this.ram.set(b2.subarray(0, n2), Number(a2 - this.base));
              ret(BigInt(n2)); break; } }
        }
        const t = this._fsMeta().links.get(this.norm(p));
        if (t !== undefined) { const b = new TextEncoder().encode(t);
          const n = Math.min(b.length, Number(a3));
          this.jsnap(a2, n);
          this.ram.set(b.subarray(0, n), Number(a2 - this.base));
          ret(BigInt(n)); break; }
        ret(-22n); break; }                                   // EINVAL: not a symlink
      case 133: case 259: {                                   // mknod(path, mode, dev) / mknodat(dirfd, path, mode, dev)
        const p = this.norm(nr === 133 ? this.readPath(a1) : this.atPath(a1, a2));
        const mode = Number(nr === 133 ? a2 : a3);
        if ((mode & 0o170000) !== 0o010000 && (mode & 0o170000) !== 0) { ret(-1n); break; }   // only FIFOs (and S_IFREG) here: EPERM
        if (this.files[p] !== undefined || this.isDir(p) || this._fifoAt(p)) { ret(-17n); break; }   // EEXIST
        if ((mode & 0o170000) === 0) { this.files[p] = new Uint8Array(0); this.fsBump(); ret(0n); break; }
        const m = this._fsMeta(); (m.fifos ??= new Map()).set(p, { chunks: [], pos: 0, off: 0, size: 0, weof: false });
        if (this.mtimes) this.mtimes[p] = Math.floor(this.nowMs() / 1000);
        this.fsBump(); ret(0n); break; }
      case 79: {                                              // getcwd
        const b = new TextEncoder().encode((this.cwd ?? '/') + '\0');
        if (b.length > Number(a2)) { ret(-34n); break; }       // ERANGE
        this.jsnap(a1, b.length);
        this.ram.set(b, Number(a1 - this.base)); ret(BigInt(b.length)); break; }
      case 80: {                                              // chdir
        const p = this.norm(this.readPath(a1));
        if (this.files[p] !== undefined) { ret(-20n); break; } // ENOTDIR
        if (!this.isDir(p)) { ret(-2n); break; }               // ENOENT
        this.cwd = p; ret(0n); break; }
      case 81: {                                              // fchdir
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        if (!h.isdir) { ret(-20n); break; }
        this.cwd = h.path; ret(0n); break; }
      case 202: {                                             // futex
        const op = Number(a2) & 0x7f;
        if (op === 0 || op === 9) {                           // WAIT / WAIT_BITSET
          const cur = Number(this.mem.read(a1, 4n));
          if (cur !== Number(a3 & 0xFFFFFFFFn)) { this._deadline = null; ret(-11n); break; }   // EAGAIN (a wake changed the word)
          let dl = null;
          const tp = cpu.regs[10];                            // struct timespec*
          if (tp) {
            // A timed wait that nobody wakes must return ETIMEDOUT. This path
            // re-executes on every host wake and used to recompute a RELATIVE
            // deadline each time (so it slid forever) and never compared an
            // absolute one: pthread_cond_timedwait with no signaller hung, and
            // HotSpot's timed parks span between host wakes for ever. The
            // deadline is now fixed on the first execution (this._deadline,
            // per thread, as nanosleep and poll do) and checked on re-entry.
            if (this._deadline == null) {
              const o = this.RAMOFF + Number(tp - this.base);
              const v = new DataView(this.wmem.buffer);
              let ms = Number(v.getBigUint64(o, true)) * 1000 + Number(v.getBigUint64(o + 8, true)) / 1e6;
              if (op === 9) {                                 // WAIT_BITSET: absolute time
                if (ms > 1e11) ms = ms - Date.now() + this.nowMs();   // realtime epoch -> engine clock
              } else ms = this.nowMs() + ms;                  // WAIT: relative
              this._deadline = ms;
            } else if (this.nowMs() >= this._deadline) { this._deadline = null; ret(-110n); break; }   // ETIMEDOUT
            dl = this._deadline;
          }
          this._futexAddr = a1;                               // park() records it on the thread
          this.block(dl); break;                              // re-executes on wake; re-checks *addr
        }
        if (op === 1 || op === 10 || op === 3 || op === 4) {  // WAKE / WAKE_BITSET / REQUEUE / CMP_REQUEUE
          ret(BigInt(this.futexWake(a1, Number(a3 & 0x7fffffffn) || 1))); break;
        }
        ret(0n); break; }
      case 290: {                                             // eventfd2 (glib GWakeup)
        const fd = this.allocFd();
        this.fds.set(fd, { ev: { count: BigInt(Number(a1)), nonblock: !!(Number(a2) & 0x800), sem: !!(Number(a2) & 1) } });
        ret(BigInt(fd)); break; }
      // ---- epoll: level-triggered readiness over the same sources poll sees.
      // EPOLLET/ONESHOT are accepted and ignored - with the whole machine in
      // one thread of JS, a level scan at each wait is observationally close
      // enough. ruby 3.3 aborts at boot ([BUG] epoll_create errno:38) if this
      // family is missing, which is what forced it to exist.
      case 213: case 291: {                                   // epoll_create / epoll_create1
        const fd = this.allocFd();
        this.fds.set(fd, { ep: { interest: new Map() } });
        ret(BigInt(fd)); break; }
      case 233: {                                             // epoll_ctl(epfd, op, fd, event*)
        const h = this.fds.get(Number(a1));
        if (!h?.ep) { ret(-9n); break; }                      // EBADF
        const op = Number(a2), tfd = Number(a3);
        if (op === 2) { h.ep.interest.delete(tfd); ret(0n); break; }   // DEL
        // epoll_event is packed on x86-64: u32 events + u64 data = 12 bytes
        const v = new DataView(this.wmem.buffer), o = this.RAMOFF + Number(cpu.regs[10] - this.base);
        const events = v.getUint32(o, true), data = v.getBigUint64(o + 4, true);
        if (op === 1 && h.ep.interest.has(tfd)) { ret(-17n); break; }  // ADD -> EEXIST
        if (op === 3 && !h.ep.interest.has(tfd)) { ret(-2n); break; }  // MOD -> ENOENT
        h.ep.interest.set(tfd, { events, data }); ret(0n); break; }
      case 232: case 281: {                                   // epoll_wait / epoll_pwait
        const h = this.fds.get(Number(a1));
        if (!h?.ep) { ret(-9n); break; }
        const maxev = Number(a3);
        const timeoutMs = Number(BigInt.asIntN(32, cpu.regs[10] & 0xFFFFFFFFn));
        const readyR = (t) => !t ? false
          : t.sock ? !!(t.sock.conn && t.sock.conn.readable())
          : t.pipe ? (t.pipe.chunks.length > 0 || !!t.pipe.weof)
          : t.ev ? t.ev.count > 0n
          : t.tfd ? this._tfdReady(t.tfd)
          : t.sfd ? this._sfdReady(t.sfd)
          : !!t.bytes;
        this.jsnap(a2, maxev * 12);
        const v = new DataView(this.wmem.buffer), base = this.RAMOFF + Number(a2 - this.base);
        let n = 0;
        for (const [tfd, it] of h.ep.interest) {
          if (n >= maxev) break;
          const t = this.fds.get(tfd);
          if (!t) continue;                                   // closed while registered: dropped, like real epoll
          let re = 0;
          if ((it.events & 1) && readyR(t)) re |= 1;          // EPOLLIN
          if (it.events & 4) re |= 4;                         // EPOLLOUT: always writable
          if (re) { v.setUint32(base + n * 12, re, true); v.setBigUint64(base + n * 12 + 4, it.data, true); n++; }
        }
        const now = this.nowMs();
        if (n > 0 || timeoutMs === 0 || (this._deadline != null && now >= this._deadline)) {
          this._deadline = null; ret(BigInt(n)); break;
        }
        this._deadline ??= (timeoutMs < 0 ? Infinity : now + timeoutMs);
        this.block(this._capByTimerfd(this._deadline)); break; }
      case 13: {                                              // rt_sigaction(sig, act*, oldact*, sz)
        const sig = Number(a1);
        if (sig < 1 || sig > 64 || sig === 9 || sig === 19) { ret(-22n); break; }   // EINVAL
        const acts = (this.sigact ??= new Map());
        if (a3) {                                             // report the old action
          const o = acts.get(sig) ?? { handler: 0n, flags: 0n, restorer: 0n, mask: 0n };
          this.jsnap(a3, 32);
          this.mem.write(a3, 8n, o.handler); this.mem.write(a3 + 8n, 8n, o.flags);
          this.mem.write(a3 + 16n, 8n, o.restorer); this.mem.write(a3 + 24n, 8n, o.mask);
        }
        if (a2) {
          const act = { handler: this.mem.read(a2, 8n), flags: this.mem.read(a2 + 8n, 8n),
                        restorer: this.mem.read(a2 + 16n, 8n), mask: this.mem.read(a2 + 24n, 8n) };
          if (act.handler === 0n || act.handler === 1n) acts.delete(sig); else acts.set(sig, act);
          if (act.handler === 1n) (this.sigign ??= new Set()).add(sig); else this.sigign?.delete(sig);
        }
        ret(0n); break; }
      case 14: {                                              // rt_sigprocmask(how, set*, oldset*, sz)
        const t = this._ts(this.threads[this.ti]);
        if (a3) { this.jsnap(a3, 8); this.mem.write(a3, 8n, t.sigmask); }
        if (a2) {
          const m = this.mem.read(a2, 8n), how = Number(a1);
          const CANT = (1n << 8n) | (1n << 18n);              // SIGKILL / SIGSTOP never block
          if (how === 0) t.sigmask |= (m & ~CANT);            // SIG_BLOCK
          else if (how === 1) t.sigmask &= ~m;                // SIG_UNBLOCK
          else if (how === 2) t.sigmask = m & ~CANT;          // SIG_SETMASK
          else { ret(-22n); break; }
        }
        ret(0n); break; }
      case 15: this._sigreturn(cpu); break;                   // rt_sigreturn
      case 34: {                                              // pause(): until a handler has run
        this.block(null); break; }
      case 36: {                                              // getitimer(which, cur*)
        const it = this._itimer(Number(a1)); if (!it) { ret(-22n); break; }
        const left = it.at == null ? 0 : Math.max(0, it.at - this.nowMs());
        this._writeItimerval(a2, it.interval, left); ret(0n); break; }
      case 37: {                                              // alarm(seconds)
        const it = this._itimer(0);
        const leftMs = it.at == null ? 0 : Math.max(0, it.at - this.nowMs());
        const secs = Number(a1);
        it.interval = 0; it.at = secs === 0 ? null : this.nowMs() + secs * 1000;
        this._timerArmed();
        ret(BigInt(Math.ceil(leftMs / 1000))); break; }
      case 38: {                                              // setitimer(which, new*, old*)
        // ITIMER_VIRTUAL / ITIMER_PROF count CPU time; a guest thread here is
        // always running when it is current, so wall time is the model
        const it = this._itimer(Number(a1)); if (!it) { ret(-22n); break; }
        if (a3) { const left = it.at == null ? 0 : Math.max(0, it.at - this.nowMs());
                  this._writeItimerval(a3, it.interval, left); }
        if (a2) {
          const rd = (o) => Number(this.mem.read(a2 + BigInt(o), 8n)) * 1000 + Number(this.mem.read(a2 + BigInt(o) + 8n, 8n)) / 1000;
          const interval = rd(0), value = rd(16);             // it_interval, it_value (ms)
          it.interval = interval; it.at = value === 0 ? null : this.nowMs() + value;
          this._timerArmed();
        }
        ret(0n); break; }
      // ---- POSIX timers: timer_create / settime / gettime / getoverrun / delete
      case 222: {                                             // timer_create(clockid, sigevent*, timerid*)
        let sig = 14, notify = 0, sival = 0n, tid = null;
        if (a2) { sival = this.mem.read(a2, 8n); sig = Number(this.mem.read(a2 + 8n, 4n)); notify = Number(this.mem.read(a2 + 12n, 4n)); }
        // glibc's SIGEV_THREAD is a helper thread it starts itself, then
        // SIGEV_THREAD_ID (4) to the kernel with that thread's tid and
        // SIGTIMER; the helper sigwaits and runs the callback. So the kernel
        // never sees notify=2 from glibc (and treats it as SIGEV_SIGNAL when
        // it does); what it needs is the thread-directed delivery.
        if (notify === 4) { tid = Number(this.mem.read(a2 + 16n, 4n));
          if (!this.threads.some(x => x.id === tid && x.state !== 'dead')) { ret(-22n); break; } }
        else if (notify !== 0 && notify !== 1 && notify !== 2) { ret(-22n); break; }
        if (notify !== 1 && (sig < 1 || sig > 64)) { ret(-22n); break; }
        const id = (this._ptimerNext = (this._ptimerNext ?? 0) + 1);
        (this.ptimers ??= new Map()).set(id, { at: null, interval: 0, sig, notify, sival, tid, overrun: 0 });
        this.jsnap(a3, 4); this.mem.write(a3, 4n, BigInt(id)); ret(0n); break; }
      case 223: {                                             // timer_settime(id, flags, new*, old*)
        const t = this.ptimers?.get(Number(a1)); if (!t) { ret(-22n); break; }
        const abs = Number(a2) & 1;
        if (cpu.regs[10]) this._writeItimerspec(cpu.regs[10], t.interval, t.at == null ? 0 : Math.max(0, t.at - this.nowMs()));
        const rd = (o) => Number(this.mem.read(a3 + BigInt(o), 8n)) * 1000 + Number(this.mem.read(a3 + BigInt(o) + 8n, 8n)) / 1e6;
        const interval = rd(0), value = rd(16);
        t.interval = interval;
        t.at = value === 0 ? null : abs ? (value - Date.now() + this.nowMs()) : this.nowMs() + value;
        this._timerArmed(); ret(0n); break; }
      case 224: {                                             // timer_gettime(id, cur*)
        const t = this.ptimers?.get(Number(a1)); if (!t) { ret(-22n); break; }
        this._writeItimerspec(a2, t.interval, t.at == null ? 0 : Math.max(0, t.at - this.nowMs())); ret(0n); break; }
      case 225: { const t = this.ptimers?.get(Number(a1)); ret(t ? BigInt(t.overrun) : -22n); break; }   // timer_getoverrun
      case 226: { ret(this.ptimers?.delete(Number(a1)) ? 0n : -22n); break; }                       // timer_delete
      // ---- timerfd -------------------------------------------------------------
      case 283: {                                             // timerfd_create(clockid, flags)
        const fd = this.allocFd();
        this.fds.set(fd, { tfd: { at: null, interval: 0, fired: 0 }, nonblock: !!(Number(a2) & 0x800), path: 'anon_inode:[timerfd]' });
        if (Number(a2) & 0x80000) this.cloexec.add(fd);
        ret(BigInt(fd)); break; }
      case 286: {                                             // timerfd_settime(fd, flags, new*, old*)
        const h = this.fds.get(Number(a1)); if (!h?.tfd) { ret(-22n); break; }
        const t = h.tfd, abs = Number(a2) & 1;
        if (cpu.regs[10]) this._writeItimerspec(cpu.regs[10], t.interval, t.at == null ? 0 : Math.max(0, t.at - this.nowMs()));
        const rd = (o) => Number(this.mem.read(a3 + BigInt(o), 8n)) * 1000 + Number(this.mem.read(a3 + BigInt(o) + 8n, 8n)) / 1e6;
        const interval = rd(0), value = rd(16);
        t.interval = interval; t.fired = 0;
        t.at = value === 0 ? null : abs ? (value - Date.now() + this.nowMs()) : this.nowMs() + value;
        ret(0n); break; }
      case 287: {                                             // timerfd_gettime(fd, cur*)
        const h = this.fds.get(Number(a1)); if (!h?.tfd) { ret(-22n); break; }
        this._writeItimerspec(a2, h.tfd.interval, h.tfd.at == null ? 0 : Math.max(0, h.tfd.at - this.nowMs())); ret(0n); break; }
      // ---- signalfd -------------------------------------------------------------
      case 282: case 289: {                                   // signalfd / signalfd4(fd, mask*, sz, flags)
        const mask = this.mem.read(a2, 8n) & ~((1n << 8n) | (1n << 18n));
        const fdArg = Number(BigInt.asIntN(32, a1 & 0xFFFFFFFFn));
        if (fdArg >= 0) { const h = this.fds.get(fdArg); if (!h?.sfd) { ret(-22n); break; } h.sfd.mask = mask; ret(BigInt(fdArg)); break; }
        const flags = nr === 289 ? Number(cpu.regs[10]) : 0;
        const fd = this.allocFd();
        this.fds.set(fd, { sfd: { mask }, nonblock: !!(flags & 0x800), path: 'anon_inode:[signalfd]' });
        if (flags & 0x80000) this.cloexec.add(fd);
        ret(BigInt(fd)); break; }
      case 128: {                                             // rt_sigtimedwait(set*, info*, timeout*, sz)
        const set = this.mem.read(a1, 8n);
        const t = this._ts(this.threads[this.ti]);
        const sig = this._sigTake(t, set);
        if (sig) { this._deadline = null; if (a2) this._writeSiginfo(a2, sig, t.siginfo?.get(sig) ?? {}); ret(BigInt(sig)); break; }
        const now = this.nowMs();
        if (a3 === 0n) { this._deadline ??= Infinity; }
        else { const ms = Number(this.mem.read(a3, 8n)) * 1000 + Number(this.mem.read(a3 + 8n, 8n)) / 1e6;
               if (ms === 0) { ret(-11n); break; }             // EAGAIN
               this._deadline ??= now + ms; }
        if (this._deadline !== Infinity && now >= this._deadline) { this._deadline = null; ret(-11n); break; }
        this.block(this._deadline === Infinity ? null : this._deadline); break; }
      case 127: {                                             // rt_sigpending(set*, sz)
        const t = this._ts(this.threads[this.ti]);
        this.jsnap(a1, 8); this.mem.write(a1, 8n, t.pending); ret(0n); break; }
      case 130: {                                             // rt_sigsuspend(mask*, sz)
        const t = this._ts(this.threads[this.ti]);
        t.suspendOld = t.sigmask;
        t.sigmask = this.mem.read(a1, 8n) & ~((1n << 8n) | (1n << 18n));
        const sig = this._sigDeliverable(t);
        if (sig) { ret(-4n); this._sigDeliver(cpu, t, sig, cpu.rip); break; }   // EINTR after the handler
        this.block(null); break; }
      case 131: {                                             // sigaltstack(new*, old*)
        const t = this._ts(this.threads[this.ti]);
        if (a2) { this.jsnap(a2, 24);
          const st = t.altstack;
          this.mem.write(a2, 8n, st ? st.sp : 0n); this.mem.write(a2 + 8n, 4n, st ? 0n : 2n);   // SS_DISABLE
          this.mem.write(a2 + 16n, 8n, st ? st.size : 0n); }
        if (a1) { const flags = Number(this.mem.read(a1 + 8n, 4n));
          t.altstack = (flags & 2) ? null : { sp: this.mem.read(a1, 8n), size: this.mem.read(a1 + 16n, 8n) }; }
        ret(0n); break; }
      case 99: {                                              // sysinfo: modest plausible box
        const o = this.RAMOFF + Number(a1 - this.base);
        new Uint8Array(this.wmem.buffer, o, 112).fill(0);
        const dv = new DataView(this.wmem.buffer);
        dv.setBigUint64(o, 1000n, true);                      // uptime
        dv.setBigUint64(o + 32, BigInt(512 << 20), true);     // totalram: 512MB keeps app cache heuristics small
        dv.setBigUint64(o + 40, BigInt(256 << 20), true);     // freeram
        dv.setUint16(o + 72, 8, true);                        // procs
        dv.setUint32(o + 100, 1, true);                       // mem_unit
        ret(0n); break; }
      case 332: ret(-38n); break;                             // statx -> ENOSYS (glibc falls back)
      case 217: {                                             // getdents64(fd, dirp, count)
        const h = this.fds.get(Number(a1));
        if (!h?.isdir) { ret(-20n); break; }                  // ENOTDIR
        const entries = h.entries ??= this.dirEntries(h.path);
        const cap = Number(a3);
        let off = 0;
        const base = this.RAMOFF + Number(a2 - this.base);
        const v = new DataView(this.wmem.buffer);
        while (h.pos < entries.length) {
          const [name, isdir] = entries[h.pos];
          const nb = new TextEncoder().encode(name);
          const reclen = (19 + nb.length + 1 + 7) & ~7;
          if (off + reclen > cap) break;
          v.setBigUint64(base + off, BigInt(h.pos + 100), true);        // d_ino
          v.setBigUint64(base + off + 8, BigInt(h.pos + 1), true);      // d_off
          v.setUint16(base + off + 16, reclen, true);
          v.setUint8(base + off + 18, isdir ? 4 : 8);                   // DT_DIR / DT_REG
          new Uint8Array(this.wmem.buffer, base + off + 19, nb.length + 1).fill(0);
          new Uint8Array(this.wmem.buffer, base + off + 19, nb.length).set(nb);
          off += reclen; h.pos++;
        }
        ret(BigInt(off)); break; }
      case 78: {                                              // getdents (old layout: d_type is the LAST byte)
        const h = this.fds.get(Number(a1));
        if (!h?.isdir) { ret(-20n); break; }
        const entries = h.entries ??= this.dirEntries(h.path);
        const cap = Number(a3);
        let off = 0;
        const base = this.RAMOFF + Number(a2 - this.base);
        const v = new DataView(this.wmem.buffer);
        while (h.pos < entries.length) {
          const [name, isdir] = entries[h.pos];
          const nb = new TextEncoder().encode(name);
          const reclen = (18 + nb.length + 1 + 1 + 7) & ~7;   // header + name + NUL + d_type
          if (off + reclen > cap) break;
          v.setBigUint64(base + off, BigInt(h.pos + 100), true);        // d_ino
          v.setBigUint64(base + off + 8, BigInt(h.pos + 1), true);      // d_off
          v.setUint16(base + off + 16, reclen, true);
          new Uint8Array(this.wmem.buffer, base + off + 18, reclen - 18).fill(0);
          new Uint8Array(this.wmem.buffer, base + off + 18, nb.length).set(nb);
          v.setUint8(base + off + reclen - 1, isdir ? 4 : 8);           // DT_DIR / DT_REG
          off += reclen; h.pos++;
        }
        ret(BigInt(off)); break; }
      case 221: ret(0n); break;                               // fadvise64: hints are free
      case 72: {                                              // fcntl
        const h = this.fds.get(Number(a1)), cmd = Number(a2);
        // a missing fd is EBADF for EVERY cmd: answering 0 let node's
        // close-on-exec sweep push millions of dead fds into the cloexec
        // set (F_SETFD tracked them unconditionally) until the JS Set hit
        // its 2^24 ceiling and took the engine down with it
        if (!h && Number(a1) > 2) { ret(-9n); break; }
        if (cmd === 3) { ret(BigInt(2 | (h?.sock?.nonblock ? 0x800 : 0))); break; }   // F_GETFL: O_RDWR
        if (cmd === 4) { if (h?.sock) h.sock.nonblock = !!(Number(a3) & 0x800); if (h?.pipe) h.nonblock = !!(Number(a3) & 0x800); ret(0n); break; }  // F_SETFL
        if (cmd === 1) { ret(BigInt(this.cloexec.has(Number(a1)) ? 1 : 0)); break; }   // F_GETFD
        if (cmd === 2) { if (Number(a3) & 1) this.cloexec.add(Number(a1)); else this.cloexec.delete(Number(a1)); ret(0n); break; }  // F_SETFD
        if (cmd === 5 || cmd === 6 || cmd === 7 || cmd === 36 || cmd === 37 || cmd === 38) {
          // POSIX record locks (F_GETLK/F_SETLK/F_SETLKW) and the OFD trio.
          // Advisory byte ranges in the shared fs meta, so a fork child (its
          // own engine over the same files) sees the parent's locks. A POSIX
          // lock is owned by the process and dropped when ANY fd on the file
          // closes; an OFD lock by the open file description (the fd handle
          // shared by dup/fork) and dropped with its last fd. Before this,
          // every F_SETLK was granted and F_GETLK always said unlocked:
          // two processes contending for a lock file both won.
          if (!h) { ret(-9n); break; }
          const r = this._rlockRange(h, a3); if (!r) { ret(-22n); break; }
          const ofd = cmd >= 36, tcur = this.threads[this.ti];
          const owner = ofd ? h : (tcur.proc ?? this), pid = tcur.proc?.pid ?? this.pid ?? 1;
          const key = h.path ?? h, m = this._fsMeta(); m.rlocks ??= new Map();
          const L = m.rlocks.get(key) ?? [];
          if (globalThis.__dbg) console.error(`<rlock cmd=${cmd} key=${String(key)} owner=${owner === this ? 'eng' + (this.pid ?? '?') : 'proc'} r=${JSON.stringify(r)} table=${JSON.stringify(L.map(x => ({ o: x.owner === this ? 'me' : 'other', t: x.type, s: x.start, e: x.end })))}>`);
          const conflict = (x) => x.owner !== owner && x.start <= r.end && r.start <= x.end && (x.type === 1 || r.type === 1);
          if (cmd === 5 || cmd === 36) {                      // F_GETLK: describe the first blocker, or F_UNLCK
            const c = r.type === 2 ? null : L.find(conflict);
            this.jsnap(a3, 32);
            if (!c) this.mem.write(a3, 2n, 2n);
            else { this.mem.write(a3, 2n, BigInt(c.type)); this.mem.write(a3 + 2n, 2n, 0n);
                   this.mem.write(a3 + 8n, 8n, BigInt(c.start));
                   this.mem.write(a3 + 16n, 8n, c.end === Infinity ? 0n : BigInt(c.end - c.start + 1));
                   this.mem.write(a3 + 24n, 4n, BigInt.asUintN(32, BigInt(c.ofd ? -1 : c.pid))); }
            ret(0n); break; }
          if (r.type !== 2 && L.some(conflict)) {
            if (cmd === 6 || cmd === 37) { ret(-11n); break; } // F_SETLK: EAGAIN
            this.block(this.nowMs() + 20); break; }           // F_SETLKW: re-checked on every wake
          this._rlockApply(L, owner, r, ofd, pid);
          if (L.length) m.rlocks.set(key, L); else m.rlocks.delete(key);
          this.wakeAllBlk(); ret(0n); break; }
        if (cmd === 0 || cmd === 1030) {                      // F_DUPFD / F_DUPFD_CLOEXEC
          if (!h) { ret(-9n); break; }
          let fd = Number(a3); while (this.fds.has(fd)) fd++;
          this.fds.set(fd, h);
          if (cmd === 1030) this.cloexec.add(fd); else this.cloexec.delete(fd);
          ret(BigInt(fd)); break;
        }
        ret(0n); break; }                                     // F_GETFD/F_SETFD/...
      case 28: {                                             // madvise(addr, len, advice)
        // MADV_DONTNEED drops the pages: anonymous memory reads back as
        // zeros, a private file mapping re-faults the file's bytes. jemalloc
        // probes the first shape at startup (fill a page, DONTNEED it, read
        // it back) and falls back to memset purging with a warning when the
        // bytes survive; rustc carried that warning.
        if (a3 === 4n && a2 > 0n) this._madvDontneed(a1 & ~(PAGE - 1n), align(a1 + a2, PAGE));
        ret(0n); break; }
      case 149: case 150: case 151: case 152: ret(0n); break;   // mlock/munlock/mlockall/munlockall: nothing swaps here (gpg's "insecure memory" warning otherwise)
      case 110: ret(BigInt(this.threads[this.ti].proc ? (this.pid ?? 1) : (this.ppid ?? 0))); break;   // getppid
      // Job control: a shell loops on getpgrp() != tcgetpgrp(fd) until they
      // agree, so these must match what TIOCGPGRP reports. Leaving getpgrp
      // unimplemented made dash spin forever — 1.28M ioctls in one run.
      case 111: ret(1n); break;                               // getpgrp
      case 121: ret(1n); break;                               // getpgid
      case 109: ret(0n); break;                               // setpgid
      case 112: ret(1n); break;                               // setsid
      case 124: ret(1n); break;                               // getsid
      case 186: ret(BigInt(this.threads[this.ti].id)); break;  // gettid
      case 83: case 258: {                                    // mkdir / mkdirat
        const p = this.norm(nr === 83 ? this.readPath(a1) : this.atPath(a1, a2));
        if (this.isDir(p) || this.files[p] !== undefined) { ret(-17n); break; } // EEXIST
        this._fsMeta().dirs.add(p); this.fsBump();
        if (this.mtimes) this.mtimes[p] = Math.floor(Date.now() / 1000);
        ret(0n); break; }
      case 132: case 235: case 280: {                         // utime / utimes / utimensat
        // touch: utimensat must report ENOENT for a missing path (that is the
        // signal to create it with open(O_CREAT)) and succeed otherwise
        const pa = nr === 280 ? a2 : a1;
        if (nr === 280 && pa === 0n) { ret(0n); break; }       // futimens on a fd
        const p = this.norm(nr === 280 ? this.atPath(a1, pa) : this.readPath(pa));
        if (this.files[p] === undefined && !this.isDir(p) && !this._fsMeta().links.has(p) && !this._fifoAt(p)) { ret(-2n); break; }
        if (this.mtimes) {
          let secs = Math.floor(Date.now() / 1000);
          const tp = nr === 280 ? a3 : a2;                     // timespec[2] / timeval[2]
          if (tp) { const v = this.mem.read(tp + 16n, 8n);     // [1] = mtime
                    const ns = this.mem.read(tp + 24n, 8n);
                    if (ns !== 0x3ffffffen) secs = Number(ns === 0x3fffffffn ? BigInt(secs) : v); }
          this.mtimes[p] = secs;
        }
        ret(0n); break; }
      case 88: case 266: {                                    // symlink / symlinkat
        const target = this.readPath(a1);
        const link = this.norm(nr === 88 ? this.readPath(a2) : this.atPath(a2, a3));   // symlinkat: relative to dirfd
        if (this.files[link] !== undefined || this.isDir(link) ||
            this._fsMeta().links.has(link)) { ret(-17n); break; }   // EEXIST
        this._fsMeta().links.set(link, target); this.fsBump();
        if (this.mtimes) this.mtimes[link] = Math.floor(Date.now() / 1000);
        ret(0n); break; }
      case 84: {                                              // rmdir
        ret(BigInt(this.rmdirPath(this.norm(this.readPath(a1))))); break; }
      case 87: case 263: {                                    // unlink / unlinkat (open fds keep their buffer)
        const p = this.norm(nr === 87 ? this.readPath(a1) : this.atPath(a1, a2));
        if (nr === 263 && (Number(a3) & 0x200)) {             // AT_REMOVEDIR (rm -r)
          ret(BigInt(this.rmdirPath(p))); break; }
        const lm = this._fsMeta().links;
        if (lm.has(p)) { lm.delete(p); this.fsBump(); ret(0n); break; }   // the link, not its target
        if (this._fsMeta().fifos?.delete(p)) { this.fsBump(); ret(0n); break; }
        if (this.files[p] === undefined) { ret(this.isDir(p) ? -21n : -2n); break; }  // EISDIR
        const g = this._fsMeta().hard?.get(p); if (g) { g.delete(p); this._fsMeta().hard.delete(p); }
        delete this.files[p]; this.fsBump(); ret(0n); break; }
      case 77: {                                              // ftruncate(fd, len)
        const h = this.fds.get(Number(a1));
        if (!h || h.bytes === undefined) { ret(-9n); break; }
        const len = Number(a2);
        const nb = new Uint8Array(len);
        nb.set(h.bytes.subarray(0, Math.min(len, h.bytes.length)));
        h.bytes = nb; if (h.path && this.files[h.path] !== undefined) this.files[h.path] = nb;
        ret(0n); break; }
      case 82: {                                              // rename(old, new)
        const po = this.norm(this.readPath(a1)), pn = this.norm(this.readPath(a2));
        if (this.files[po] === undefined) { ret(-2n); break; }
        this.files[pn] = this.files[po]; delete this.files[po]; this.fsBump(); ret(0n); break; }
      case 95: ret(0o022n); break;                            // umask
      case 137: case 138: {                                   // statfs / fstatfs: tmpfs-ish dummy
        const buf = a2, o = this.RAMOFF + Number(buf - this.base);
        new Uint8Array(this.wmem.buffer, o, 120).fill(0);
        const v = new DataView(this.wmem.buffer);
        v.setBigUint64(o, 0x01021994n, true);                 // f_type: TMPFS_MAGIC
        v.setBigUint64(o + 8, 4096n, true);                   // f_bsize
        v.setBigUint64(o + 16, 1n << 20n, true);              // f_blocks
        v.setBigUint64(o + 24, 1n << 19n, true);              // f_bfree
        v.setBigUint64(o + 32, 1n << 19n, true);              // f_bavail
        v.setBigUint64(o + 40, 1n << 16n, true);              // f_files
        v.setBigUint64(o + 48, 1n << 15n, true);              // f_ffree
        v.setBigUint64(o + 64, 255n, true);                   // f_namelen
        ret(0n); break; }
      case 25: {                                              // mremap(old, oldsz, newsz, flags, new)
        const flags = Number(cpu.regs[10]);
        const oldLen = align(a2, PAGE), newLen = align(a3, PAGE);
        if (newLen <= oldLen) {                               // shrink (or same) in place
          if (newLen < oldLen) this._unmapRange(a1 + newLen, a1 + oldLen);
          ret(a1); break;
        }
        if (!(flags & 1)) { ret(-12n); break; }                // no MREMAP_MAYMOVE: cannot grow here (ENOMEM)
        const at = this.mmapNext; this.mmapNext += newLen;
        const o0 = Number(at - this.base);
        if (o0 < 0 || o0 + Number(newLen) > this.ram.length) { ret(-12n); break; }
        this.ram.fill(0, o0, o0 + Number(newLen));
        this.ram.copyWithin(o0, Number(a1 - this.base), Number(a1 - this.base) + Number(oldLen));
        for (const m of this.maps ?? []) if (m.at === a1) { m.at = at; m.len = newLen; }   // the record follows the pages
        for (const t of this.threads) t.cpu.icache?.clear();
        let hit = false;
        for (const k of this.aotFns.keys()) if (k >= a1 && k < a1 + oldLen) { this.aotFns.delete(k); hit = true; }
        if (hit) this.rebuildFtmap();
        ret(at); break; }
      case 26: {                                              // msync(addr, len, flags)
        for (const m of this.maps ?? []) if (m.shared && m.at < a1 + a2 && m.at + m.len > a1) this._writeBackMap(m);
        ret(0n); break; }

      // ---- sockets: the display connection (AF_UNIX -> in-process X server) ----
      case 41: {                                              // socket(domain, type, proto)
        if (Number(a1) !== 1) { ret(-97n); break; }           // EAFNOSUPPORT: AF_UNIX only
        const fd = this.allocFd();
        this.fds.set(fd, { sock: { conn: null, nonblock: !!(Number(a2) & 0x800) } });
        ret(BigInt(fd)); break; }
      case 42: {                                              // connect(fd, sockaddr_un*, len)
        const h = this.fds.get(Number(a1));
        if (!h?.sock) { ret(-88n); break; }                   // ENOTSOCK
        const len = Number(a3), b0 = Number(a2 - this.base);
        const raw = this.ram.subarray(b0, b0 + len);
        // filesystem ("/tmp/.X11-unix/X0\0") and abstract ("\0/tmp/...") forms
        let path = '';
        for (let i = 2; i < len; i++) { const c = raw[i]; if (c === 0 && path) break; if (c !== 0) path += String.fromCharCode(c); }
        if (/^\/tmp\/\.X11-unix\/X\d+$/.test(path) && this.xserver) {
          h.sock.conn = this.xserver.connect(); ret(0n); break;
        }
        ret(-111n); break; }                                  // ECONNREFUSED
      case 44: {                                              // sendto (connected stream: == write)
        const h = this.fds.get(Number(a1));
        if (h?.sock?.conn) {
          const b = this.ram.slice(Number(a2 - this.base), Number(a2 - this.base) + Number(a3));
          h.sock.conn.write(b); ret(a3); break;
        }
        const r = writeChunk(Number(a1), a2, Number(a3)); if (r === -4096) break; ret(r === undefined ? a3 : BigInt(r)); break; }
      case 45: {                                              // recvfrom
        const h = this.fds.get(Number(a1));
        if (!h?.sock?.conn) { ret(-88n); break; }
        const data = h.sock.conn.read(Number(a3));
        if (data === null) { if (h.sock.nonblock) ret(-11n); else this.block(null); break; }
        this.jsnap(a2, data.length);
        this.ram.set(data, Number(a2 - this.base)); ret(BigInt(data.length)); break; }
      case 46: {                                              // sendmsg(fd, msghdr*, flags)
        const h = this.fds.get(Number(a1));
        const v = new DataView(this.wmem.buffer);
        const mo = this.RAMOFF + Number(a2 - this.base);
        const iovp = v.getBigUint64(mo + 16, true), iovn = Number(v.getBigUint64(mo + 24, true));
        let total = 0; const parts = [];
        for (let i = 0; i < iovn; i++) {
          const o = this.RAMOFF + Number(iovp - this.base) + i * 16;
          const p = v.getBigUint64(o, true), l = Number(v.getBigUint64(o + 8, true));
          parts.push(this.ram.slice(Number(p - this.base), Number(p - this.base) + l)); total += l;
        }
        if (h?.sock?.conn) { for (const b of parts) h.sock.conn.write(b); }
        else { let off = 0; for (let i = 0; i < iovn; i++) {
                 const o = this.RAMOFF + Number(iovp - this.base) + i * 16;
                 writeChunk(Number(a1), v.getBigUint64(o, true), Number(v.getBigUint64(o + 8, true))); } }
        ret(BigInt(total)); break; }
      case 47: {                                              // recvmsg(fd, msghdr*, flags)
        const h = this.fds.get(Number(a1));
        if (!h?.sock?.conn) { ret(-88n); break; }
        const v = new DataView(this.wmem.buffer);
        const mo = this.RAMOFF + Number(a2 - this.base);
        const iovp = v.getBigUint64(mo + 16, true), iovn = Number(v.getBigUint64(mo + 24, true));
        let want = 0; const list = [];
        for (let i = 0; i < iovn; i++) {
          const o = this.RAMOFF + Number(iovp - this.base) + i * 16;
          const p = v.getBigUint64(o, true), l = Number(v.getBigUint64(o + 8, true));
          list.push([p, l]); want += l;
        }
        const data = h.sock.conn.read(want);
        if (data === null) { if (h.sock.nonblock) ret(-11n); else this.block(null); break; }
        let off = 0;
        for (const [p, l] of list) { if (off >= data.length) break;
          const take = Math.min(l, data.length - off);
          this.jsnap(p, take); this.ram.set(data.subarray(off, off + take), Number(p - this.base)); off += take; }
        v.setBigUint64(mo + 40, 0n, true);                    // msg_controllen: no ancillary data
        v.setUint32(mo + 48, 0, true);                        // msg_flags
        ret(BigInt(data.length)); break; }
      case 19: {                                              // readv(fd, iov, cnt)
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        const v = new DataView(this.wmem.buffer);
        const list = [];
        for (let i = 0; i < Number(a3); i++) {
          const o = this.RAMOFF + Number(a2 - this.base) + i * 16;
          list.push([v.getBigUint64(o, true), Number(v.getBigUint64(o + 8, true))]);
        }
        if (h.sock) {
          const c = h.sock.conn; if (!c) { ret(-107n); break; }
          const want = list.reduce((s, [, l]) => s + l, 0);
          const data = c.read(want);
          if (data === null) { if (h.sock.nonblock) ret(-11n); else this.block(null); break; }
          let off = 0;
          for (const [p, l] of list) { if (off >= data.length) break;
            const take = Math.min(l, data.length - off);
            this.jsnap(p, take); this.ram.set(data.subarray(off, off + take), Number(p - this.base)); off += take; }
          ret(BigInt(data.length)); break;
        }
        if (!h.bytes) { ret(-9n); break; }
        let got = 0;
        for (const [p, l] of list) {
          const n = Math.min(l, h.bytes.length - h.pos); if (n <= 0) break;
          this.jsnap(p, n); this.ram.set(h.bytes.subarray(h.pos, h.pos + n), Number(p - this.base));
          h.pos += n; got += n;
        }
        ret(BigInt(got)); break; }
      case 48: ret(0n); break;                                // shutdown
      case 51: case 52: {                                     // getsockname / getpeername
        const name = '/tmp/.X11-unix/X0';
        const o = Number(a2 - this.base);
        this.ram[o] = 1; this.ram[o + 1] = 0;                 // AF_UNIX
        for (let i = 0; i < name.length; i++) this.ram[o + 2 + i] = name.charCodeAt(i);
        this.ram[o + 2 + name.length] = 0;
        const lo = this.RAMOFF + Number(cpu.regs[2] - this.base);   // rdx = addrlen*
        new DataView(this.wmem.buffer).setUint32(lo, 2 + name.length + 1, true);
        ret(0n); break; }
      case 54: ret(0n); break;                                // setsockopt
      case 55: {                                              // getsockopt: zero int
        const vo = this.RAMOFF + Number(cpu.regs[10] - this.base);
        const lo = this.RAMOFF + Number(cpu.regs[8] - this.base);
        const v = new DataView(this.wmem.buffer);
        v.setUint32(vo, 0, true); v.setUint32(lo, 4, true);
        ret(0n); break; }

      // ---- poll / select: the guest's event wait, mapped onto engine.blocked ----
      case 7: case 271: {                                     // poll / ppoll
        const nfds = Number(a2), v = new DataView(this.wmem.buffer);
        let timeoutMs;
        if (nr === 7) timeoutMs = Number(BigInt.asIntN(32, a3 & 0xFFFFFFFFn));
        else if (a3 === 0n) timeoutMs = -1;
        else { const o = this.RAMOFF + Number(a3 - this.base);
               timeoutMs = Number(v.getBigUint64(o, true)) * 1000 + Number(v.getBigUint64(o + 8, true)) / 1e6; }
        const readyR = (h) => !h ? false
          : h.sock ? !!(h.sock.conn && h.sock.conn.readable())
          : h.pipe ? (h.pipe.chunks.length > 0 || !!h.pipe.weof)
          : h.ev ? h.ev.count > 0n
          : h.tfd ? this._tfdReady(h.tfd)
          : h.sfd ? this._sfdReady(h.sfd)
          : !!h.bytes;                                        // regular file: always ready (EOF too)
        const base = this.RAMOFF + Number(a1 - this.base);
        this.jsnap(a1, nfds * 8);                             // revents go back into the caller's array
        let ready = 0;
        for (let i = 0; i < nfds; i++) {
          const o = base + i * 8;
          const fd = v.getInt32(o, true), ev = v.getUint16(o + 4, true);
          let re = 0;
          if (fd >= 0) {
            const h = this.fds.get(fd);
            if (!h && fd > 2) re = 0x20;                      // POLLNVAL
            else { if ((ev & 1) && readyR(h)) re |= 1;        // POLLIN
                   if (ev & 4) re |= 4; }                     // POLLOUT: always writable
          }
          v.setUint16(o + 6, re, true); if (re) ready++;
        }
        const now = this.nowMs();
        if (this.debugPollAfter != null && now > this.debugPollAfter) {
          if (now - (this._dbgPollLast ?? 0) > 10000) { this._dbgPollLast = now;
            const ds = [];
            for (let i = 0; i < nfds; i++) {
              const fd = v.getInt32(base + i * 8, true), ev = v.getUint16(base + i * 8 + 4, true);
              const h = this.fds.get(fd);
              const kind = !h ? 'nofd' : h.sock ? (h.sock.conn ? 'xsock' : 'sock-unconn')
                : h.pipe ? `pipe(${h.pipe.chunks.length})` : h.ev ? `evfd(${h.ev.count})` : h.path ?? 'file';
              ds.push(`${fd}:${kind}:ev${ev}`);
            }
            console.error(`<pollwd thr=${this.threads?.[this.ti]?.id} t=${(now/1000)|0}s to=${timeoutMs} [${ds.join(' ')}]>`);
          }
        }
        if (ready > 0 || timeoutMs === 0 || (this._deadline != null && now >= this._deadline)) {
          this._deadline = null; ret(BigInt(ready)); break;
        }
        this._deadline ??= (timeoutMs < 0 ? Infinity : now + timeoutMs);
        this.block(this._capByTimerfd(this._deadline)); break; }
      case 23: case 270: {                                    // select / pselect6
        const nfds = Number(a1), v = new DataView(this.wmem.buffer);
        const rp = a2, wp = a3, ep = cpu.regs[10], tp = cpu.regs[8];
        let timeoutMs = -1;
        if (tp !== 0n) {
          const o = this.RAMOFF + Number(tp - this.base);
          const sec = Number(v.getBigUint64(o, true)), sub = Number(v.getBigUint64(o + 8, true));
          timeoutMs = nr === 23 ? sec * 1000 + sub / 1000 : sec * 1000 + sub / 1e6;
        }
        const readyR = (h) => !h ? false
          : h.sock ? !!(h.sock.conn && h.sock.conn.readable())
          : h.pipe ? (h.pipe.chunks.length > 0 || !!h.pipe.weof)
          : h.ev ? h.ev.count > 0n
          : h.tfd ? this._tfdReady(h.tfd)
          : h.sfd ? this._sfdReady(h.sfd)
          : !!h.bytes;
        const scan = (ptr) => { if (ptr === 0n) return [];
          const o = this.RAMOFF + Number(ptr - this.base); const out = [];
          for (let fd = 0; fd < nfds; fd++) if (v.getUint8(o + (fd >> 3)) & (1 << (fd & 7))) out.push(fd);
          return out; };
        const rd = scan(rp).filter(fd => readyR(this.fds.get(fd)));
        const wr = scan(wp);                                  // always writable
        const now = this.nowMs();
        if (rd.length + wr.length > 0 || timeoutMs === 0 || (this._deadline != null && now >= this._deadline)) {
          this._deadline = null;
          const store = (ptr, set) => { if (ptr === 0n) return;
            const o = this.RAMOFF + Number(ptr - this.base);
            new Uint8Array(this.wmem.buffer, o, 128).fill(0);
            for (const fd of set) v.setUint8(o + (fd >> 3), v.getUint8(o + (fd >> 3)) | (1 << (fd & 7))); };
          store(rp, rd); store(wp, wr); store(ep, []);
          ret(BigInt(rd.length + wr.length)); break;
        }
        this._deadline ??= (timeoutMs < 0 ? Infinity : now + timeoutMs);
        this.block(this._capByTimerfd(this._deadline)); break; }
      default:
        ret(-38n);                                           // ENOSYS
        (this.unknown ||= new Set()).add(nr);
    }
    if (this._sigAny) this._sigExit(cpu);                   // signal delivery on return to user
  }

  // survey aid: every ioctl request answered ENOTTY, keyed by request and
  // the kind of descriptor it was aimed at (breadth prints the union)
  _noteIoctl(req, h) {
    const kind = !h ? 'nofd' : h.pipe ? 'pipe' : h.sock ? 'sock' : h.bytes !== undefined ? 'file' : h.isdir ? 'dir' : h.ev ? 'evfd' : h.ptm || h.pts ? 'pty' : h.sink ? 'sink' : 'other';
    const k = req.toString(16) + '@' + kind;
    (this.unknownIoctl ??= new Map()).set(k, (this.unknownIoctl.get(k) || 0) + 1);
  }

  // ---- shared file mappings ---------------------------------------------------
  // Copy a MAP_SHARED|PROT_WRITE mapping's pages back into the file. Only the
  // bytes inside the file's current length are written: a store past EOF in
  // the last page does not grow the file (kernel semantics), and other
  // handles on the same path see the new bytes through this.files.
  _writeBackMap(m) {
    const cur = this.files[m.path] ?? m.h.bytes;
    if (!cur) return;
    const n = Math.min(Number(m.len), Math.max(0, cur.length - m.fileOff));
    if (n <= 0) return;
    const o = Number(m.at - this.base);
    cur.set(this.ram.subarray(o, o + n), m.fileOff);
    if (m.h.bytes !== cur) m.h.bytes = cur;
    (this.dirtyFiles ??= new Set()).add(m.path);
  }
  // a write through a descriptor lands in every live mapping of the path
  _mapsAbsorb(path, fileOff, bytes) {
    if (!path || !this.maps) return;
    for (const m of this.maps) {
      if (m.path !== path) continue;
      const lo = Math.max(fileOff, m.fileOff), hi = Math.min(fileOff + bytes.length, m.fileOff + Number(m.len));
      if (hi <= lo) continue;
      this.ram.set(bytes.subarray(lo - fileOff, hi - fileOff), Number(m.at - this.base) + (lo - m.fileOff));
    }
  }
  // stores through a shared writable mapping reach a descriptor read
  _mapsFlushPath(path) { for (const m of this.maps) if (m.shared && m.path === path) this._writeBackMap(m); }
  // ---- POSIX / OFD record locks (fcntl F_SETLK family) ----
  // struct flock: l_type i16 @0, l_whence i16 @2, l_start i64 @8, l_len i64 @16, l_pid i32 @24
  _rlockRange(h, p) {
    const type = Number(this.mem.read(p, 2n)), whence = Number(this.mem.read(p + 2n, 2n));
    const off = Number(BigInt.asIntN(64, this.mem.read(p + 8n, 8n))), len = Number(BigInt.asIntN(64, this.mem.read(p + 16n, 8n)));
    if (type < 0 || type > 2 || whence > 2) return null;
    const base = whence === 0 ? 0 : whence === 1 ? (h.pos ?? 0) : (h.bytes?.length ?? 0);
    let start = base + off, end;
    if (len === 0) end = Infinity; else if (len > 0) end = start + len - 1; else { end = start - 1; start += len; }
    if (start < 0) return null;
    return { type, start, end };
  }
  _rlockApply(L, owner, r, ofd, pid) {
    // the owner's existing locks over the range are cut out (split at the
    // ends), then the new lock is added - F_UNLCK adds nothing
    for (let i = L.length - 1; i >= 0; i--) {
      const x = L[i]; if (x.owner !== owner || x.start > r.end || r.start > x.end) continue;
      L.splice(i, 1);
      if (x.start < r.start) L.push({ ...x, end: r.start - 1 });
      if (x.end > r.end) L.push({ ...x, start: r.end + 1 });
    }
    if (r.type !== 2) L.push({ owner, ofd, pid, type: r.type, start: r.start, end: r.end });
  }
  _rlockDrop(pred) {
    const m = this._fsMeta(); if (!m.rlocks) return; let any = false;
    for (const [k, L] of m.rlocks) {
      const keep = L.filter(x => !pred(k, x)); if (keep.length === L.length) continue;
      any = true; if (keep.length) m.rlocks.set(k, keep); else m.rlocks.delete(k);
    }
    if (any) this.wakeAllBlk();
  }
  _rlockClose(h) {
    const key = h.path ?? h, owner = this.threads[this.ti]?.proc ?? this;
    if (globalThis.__dbg) console.error(`<rlockClose key=${String(key)} owner=${owner === this ? 'eng' + (this.pid ?? '?') : 'proc'} table=${JSON.stringify([...(this._fsMeta().rlocks ?? [])].map(([k, L]) => [k, L.map(x => x.owner === this ? 'me' : 'other')]))}>`);
    const last = ![...this.fds.values()].includes(h);          // the description's last fd is gone
    this._rlockDrop((k, x) => k === key && (x.ofd ? (last && x.owner === h) : x.owner === owner));
  }
  _rlockExit(owner) { this._rlockDrop((k, x) => x.owner === owner); }
  _flockRelease(h) {
    const m = this._fsMeta(); if (!m.flocks) return;
    for (const [k, L] of m.flocks) { if (L.ex === h) L.ex = null; L.sh.delete(h); if (!L.ex && !L.sh.size) m.flocks.delete(k); }
    this.wakeAllBlk();
  }
  _fifoAt(p) { return this._fsMeta().fifos?.get(this.resolve(this.norm(p))); }
  _hardRefresh(path, nb) {
    const g = this._fsMeta().hard?.get(this.norm(path)); if (!g) return;
    for (const q of g) if (this.files[q] !== undefined) this.files[q] = nb;
  }
  // Take [lo, hi) out of the file-mapping table: shared pages under it are
  // written back first, and a mapping only partly covered is trimmed or
  // split so the table keeps describing what is actually mapped. ld.so
  // reserves a library's whole span, overlays the segments MAP_FIXED and
  // unmaps the gaps: with whole-entry removal only, the reservation stayed
  // on the table and later anonymous pages in the reused holes were taken
  // for file-backed (madvise left jemalloc's probe page unzeroed).
  _unmapRange(lo, hi) {
    if (!this.maps) return;
    const out = [];
    for (const m of this.maps) {
      const mhi = m.at + m.len;
      if (mhi <= lo || m.at >= hi) { out.push(m); continue; }
      if (m.shared) this._writeBackMap(m);
      if (m.at < lo) out.push({ ...m, len: lo - m.at });
      if (mhi > hi) out.push({ ...m, at: hi, len: mhi - hi, fileOff: m.fileOff + Number(hi - m.at) });
    }
    this.maps = out;
  }
  // madvise(MADV_DONTNEED): zero the range, then put a private file
  // mapping's bytes back where the range crosses one (its pages re-fault
  // from the file); shared mappings keep their pages, they hold dirty data
  // this engine writes back lazily.
  _madvDontneed(lo, hi) {
    const off0 = Number(lo - this.base), off1 = Number(hi - this.base);
    if (off0 < 0 || off1 > this.ram.length || off1 <= off0) return;
    const over = (this.maps || []).filter(m => m.at < hi && m.at + m.len > lo);
    if (over.some(m => m.shared)) return;
    this.ram.fill(0, off0, off1);
    for (const m of over) {
      const a = m.at > lo ? m.at : lo, b = m.at + m.len < hi ? m.at + m.len : hi;
      const cur = this.files[m.path] ?? m.h.bytes; if (!cur) continue;
      const fo = m.fileOff + Number(a - m.at), n = Math.min(Number(b - a), Math.max(0, cur.length - fo));
      if (n > 0) this.ram.set(cur.subarray(fo, fo + n), Number(a - this.base));
    }
  }
  _flushSharedMaps() { for (const m of this.maps ?? []) if (m.shared) this._writeBackMap(m); }

  // ---- signals -------------------------------------------------------------
  // Actions are per process (this.sigact: sig -> {handler, flags, restorer,
  // mask}); the blocked mask, pending set and alternate stack are per thread.
  // Delivery happens where the kernel does it — on the way back to user code:
  // at syscall exit (_sigExit), at syscall ENTRY for a thread a signal woke
  // out of a blocking call (_sigEntry: EINTR, or SA_RESTART re-execution),
  // and at the run-loop quantum for a thread that is computing (_sigPoll). A
  // real x86-64 rt_sigframe (ucontext + siginfo at the kernel's offsets) is
  // pushed so SA_SIGINFO handlers read what they expect and rt_sigreturn
  // restores exactly what was saved. From compiled code the redirect unwinds
  // the wasm frame (aotEnv.syscall) so the top loop resumes at the handler.
  // clone: the new thread / window child starts with its creator's signal
  // mask (glibc blocks every signal around pthread_create of its timer
  // helper, which then sigwaits for SIGTIMER - started with an empty mask,
  // the first tick's default action killed the process, exit 160), no
  // pending set, and the alternate stack only across fork, not per thread
  _sigInherit(t, from, isFork) {
    this._ts(from);
    t.sigmask = from.sigmask; t.pending = 0n; t.eintr = false; t.suspendOld = null;
    t.altstack = isFork ? from.altstack : null;
  }
  _ts(t) { if (t.sigmask === undefined) { t.sigmask = 0n; t.pending = 0n; t.eintr = false; t.suspendOld = null; t.altstack = null; } return t; }
  _sigDeliverable(t) {
    const bits = t.pending & ~t.sigmask;
    if (bits === 0n) return 0;
    for (let s = 1; s <= 64; s++) if (bits & (1n << BigInt(s - 1))) return s;
    return 0;
  }
  // raise `sig` on this process (tid null: process-directed) or on thread tid
  raiseSignal(sig, tid = null, info = {}) {
    // A main process that tail-exec'd is gone: its old image is only parked
    // so its re-stepped execve keeps blocking. A signal to it (the child
    // pump raising SIGCHLD when the replacement exits) must vanish — waking
    // that image made the re-stepped execve return EINTR and the dead shell
    // ran on to exit 126.
    if (this._execed) return;
    const bit = 1n << BigInt(sig - 1);
    const act = this.sigact?.get(sig);
    if (!act && this._sigDefaultIgnored(sig)) return;                          // SIG_IGN / default-ignore: discarded
    let t = null;
    const live = (x) => x.state !== 'dead';
    if (tid != null) t = this.threads.find(x => x.id === tid && live(x)) ?? this.threads.find(live);
    else {
      const cur = this.threads[this.ti];
      t = this.threads.find(x => x === cur && live(x) && !((this._ts(x).sigmask) & bit))
       ?? this.threads.find(x => live(x) && !((this._ts(x).sigmask) & bit))
       ?? this.threads.find(live);
    }
    if (!t) return;                                                             // nobody left to signal
    this._ts(t);
    if (globalThis.__sigtrace) console.error(`<raise sig=${sig} -> tid=${t.id} st=${t.state} cur=${this.threads[this.ti].id} mask=${t.sigmask.toString(16)}>`);
    // no handler and deliverable now: the default action (terminate) applies
    // at once. Blocked, it stays pending — for sigprocmask to unblock later,
    // or for sigtimedwait / signalfd to consume.
    if (!act && !(t.sigmask & bit)) { this._terminate(sig); return; }
    t.pending |= bit;
    (t.siginfo ??= new Map()).set(sig, info);
    this._sigAny = true;
    // a thread parked in a blocking syscall is woken: it re-executes the
    // syscall, whose entry checkpoint delivers the signal (EINTR / restart)
    if (t.state === 'blk' && !(t.sigmask & bit)) { t.state = 'run'; t.futex = null; t.dl = null; t.eintr = true; }
    else if (t.sigmask & bit) this.wakeAllBlk();             // sigtimedwait / signalfd / poll on it re-check
    if (t === this.threads[this.ti] && this.blocked) { this.blocked = null; if (!(t.sigmask & bit)) t.eintr = true; }
  }
  // default-action termination by `sig`. A fork child still inside its
  // vfork window is a thread of this engine: only IT dies (journal rolled
  // back, parent released, status recorded for wait4 as WIFSIGNALED);
  // otherwise the whole process ends with the shell-convention 128+sig and
  // remembers the signal so a parent's wait4 can report WTERMSIG.
  _terminate(sig) {
    const t = this.threads[this.ti];
    if (t?.proc) {
      t.state = 'dead'; this._killProcSiblings(t);
      this._pipeEofSweep([...t.proc.fds.values()]);
      this._vforkRollback(t);
      t.proc.parent.state = 'run'; this._vforkThaw(t.proc.parent);
      (this.children ??= []).push({ pid: t.proc.pid, eng: null, exited: 128 + sig, sig });
      this.raiseSignal(17, t.proc.parent.id, { pid: t.proc.pid, code: 2, status: sig });   // CLD_KILLED
      this.cpu.halted = true;                                // this thread's step ends here
      this.block(null);                                      // park: the scheduler moves on
      return;
    }
    this.termSig = sig;
    this.exitCode = 128 + sig; this.cpu.halted = true;
  }
  _itimer(which) {
    if (which < 0 || which > 2) return null;
    const a = (this.itimers ??= [null, null, null]);
    return a[which] ??= { at: null, interval: 0, sig: [14, 26, 27][which] };   // SIGALRM SIGVTALRM SIGPROF
  }
  // any armed timer keeps the cheap per-quantum check alive
  _timerArmed() { this.itimer = { at: this._earliestTimer() }; }
  _earliestTimer() {
    let e = null;
    for (const it of this.itimers ?? []) if (it?.at != null) e = e == null ? it.at : Math.min(e, it.at);
    for (const [, t] of this.ptimers ?? []) if (t.at != null) e = e == null ? t.at : Math.min(e, t.at);
    return e;
  }
  _sigDefaultIgnored(sig) {
    if (this.sigign?.has(sig)) return true;                                     // SIG_IGN
    if (sig === 17 || sig === 18 || sig === 23 || sig === 28) return true;      // CHLD CONT URG WINCH
    if (sig === 19 || sig === 20 || sig === 21 || sig === 22) return true;      // stop signals: not modelled
    return false;
  }
  // a pending signal became deliverable with no handler installed
  _sigDefault(t, sig) {
    t.pending &= ~(1n << BigInt(sig - 1));
    this._sigAny = this.threads.some(x => (x.pending ?? 0n) !== 0n);
    if (!this._sigDefaultIgnored(sig)) this._terminate(sig);
  }
  _checkAlarm() {
    const now = this.nowMs();
    for (const it of this.itimers ?? []) {
      if (!it || it.at == null || now < it.at) continue;
      it.at = it.interval > 0 ? now + it.interval : null;
      this.raiseSignal(it.sig, null, { pid: 0, code: 0x80 });                  // SI_KERNEL
    }
    for (const [id, t] of this.ptimers ?? []) {
      if (t.at == null || now < t.at) continue;
      let over = 0;
      if (t.interval > 0) { over = Math.max(0, Math.floor((now - t.at) / t.interval)); t.at = t.at + (over + 1) * t.interval; }
      else t.at = null;
      t.overrun = over;
      if (t.notify !== 1) this.raiseSignal(t.sig, t.notify === 4 ? t.tid : null, { pid: 0, code: -2, timer: id, overrun: over, sival: t.sival });   // SI_TIMER; SIGEV_THREAD_ID is thread-directed
    }
    this.itimer = { at: this._earliestTimer() };
  }
  _tfdTick(t) {
    if (t.at == null) return;
    const now = this.nowMs(); if (now < t.at) return;
    if (t.interval > 0) { const k = 1 + Math.floor((now - t.at) / t.interval); t.fired += k; t.at += k * t.interval; }
    else { t.fired += 1; t.at = null; }
  }
  _tfdReady(t) { this._tfdTick(t); return t.fired > 0; }
  _sfdReady(sfd) { return this.threads.some(x => x.state !== 'dead' && ((x.pending ?? 0n) & sfd.mask) !== 0n); }
  _capByTimerfd(dl) {
    let e = dl === Infinity ? null : dl;
    for (const [, h] of this.fds) if (h?.tfd?.at != null) e = e == null ? h.tfd.at : Math.min(e, h.tfd.at);
    return e;
  }
  // dequeue the lowest pending signal in `set` from thread t (or any thread
  // for a process-directed one), for sigtimedwait / signalfd
  _sigTake(t, set) {
    for (const x of [t, ...this.threads.filter(y => y !== t && y.state !== 'dead')]) {
      const bits = (x.pending ?? 0n) & set;
      if (bits === 0n) continue;
      for (let s = 1; s <= 64; s++) if (bits & (1n << BigInt(s - 1))) {
        x.pending &= ~(1n << BigInt(s - 1));
        if (x !== t && x.siginfo?.has(s)) (t.siginfo ??= new Map()).set(s, x.siginfo.get(s));
        this._sigAny = this.threads.some(y => (y.pending ?? 0n) !== 0n);
        return s;
      }
    }
    return 0;
  }
  _writeItimerspec(addr, intervalMs, valueMs) {
    this.jsnap(addr, 32);
    const put = (o, ms) => { this.mem.write(addr + BigInt(o), 8n, BigInt(Math.floor(ms / 1000)));
                             this.mem.write(addr + BigInt(o) + 8n, 8n, BigInt(Math.floor((ms % 1000) * 1e6))); };
    put(0, intervalMs); put(16, valueMs);
  }
  _writeSiginfo(addr, sig, info) {                            // 128-byte siginfo_t
    this.jsnap(addr, 128);
    for (let o = 0n; o < 128n; o += 8n) this.mem.write(addr + o, 8n, 0n);
    this.mem.write(addr, 4n, BigInt(sig)); this.mem.write(addr + 8n, 4n, BigInt.asUintN(32, BigInt(info.code ?? 0)));
    if (info.timer !== undefined) { this.mem.write(addr + 16n, 4n, BigInt(info.timer)); this.mem.write(addr + 20n, 4n, BigInt(info.overrun ?? 0));
                                    this.mem.write(addr + 24n, 8n, info.sival ?? 0n); }
    else { this.mem.write(addr + 16n, 4n, BigInt(info.pid ?? 0)); this.mem.write(addr + 20n, 4n, 0n);
           if (sig === 17) this.mem.write(addr + 24n, 4n, BigInt(info.status ?? 0)); }
  }
  _writeSignalfdInfo(addr, sig, info) {                       // 128-byte signalfd_siginfo
    this.jsnap(addr, 128);
    for (let o = 0n; o < 128n; o += 8n) this.mem.write(addr + o, 8n, 0n);
    this.mem.write(addr, 4n, BigInt(sig));                                      // ssi_signo
    this.mem.write(addr + 8n, 4n, BigInt.asUintN(32, BigInt(info.code ?? 0)));  // ssi_code
    this.mem.write(addr + 12n, 4n, BigInt(info.pid ?? 0));                      // ssi_pid
    if (info.timer !== undefined) { this.mem.write(addr + 24n, 4n, BigInt(info.timer)); this.mem.write(addr + 32n, 4n, BigInt(info.overrun ?? 0));
                                    this.mem.write(addr + 44n, 4n, (info.sival ?? 0n) & 0xFFFFFFFFn); this.mem.write(addr + 48n, 8n, info.sival ?? 0n); }
    if (sig === 17) this.mem.write(addr + 40n, 4n, BigInt(info.status ?? 0)); // ssi_status
  }
  _writeItimerval(addr, intervalMs, valueMs) {
    if (!addr) return;
    this.jsnap(addr, 32);
    const put = (o, ms) => { this.mem.write(addr + BigInt(o), 8n, BigInt(Math.floor(ms / 1000)));
                             this.mem.write(addr + BigInt(o) + 8n, 8n, BigInt(Math.floor((ms % 1000) * 1000))); };
    put(0, intervalMs); put(16, valueMs);
  }
  // syscall entry: a signal woke this thread out of a blocking call, or is
  // pending and unblocked. Returns true if the syscall must not run now.
  _sigEntry(cpu, nr) {
    // timers are checked at every syscall entry: a compiled loop that makes
    // syscalls but never returns to the run loop would otherwise never see
    // its ITIMER / POSIX timer expire (the run-loop quantum is the only other
    // place; a pure compute loop that never yields cannot be interrupted)
    const t = this._ts(this.threads[this.ti]);
    if (this.itimer?.at != null) {
      const before = t.pending ?? 0n;
      this._checkAlarm();
      // A timer that expires as a sleep-like syscall is entered counts as
      // interrupting that call (EINTR, or SA_RESTART re-execution): on the
      // wall clock the expiry landed on the call, and running the handler
      // first and then sleeping the full interval is the one order native
      // never shows for a timer armed moments earlier.
      if ((t.pending ?? 0n) !== before && SLEEPY.has(nr)) t.eintr = true;
    }
    if (!this._sigAny || nr === 15) return false;
    if (t.proc || t.state === 'dead') return false;                             // vfork child / retired image
    const sig = this._sigDeliverable(t);
    if (!sig) { t.eintr = false; return false; }
    const act = this.sigact.get(sig);
    if (!act) { t.eintr = false; this._sigDefault(t, sig); return this.exitCode !== null; }
    if (t.eintr) {
      t.eintr = false;
      // pause/sigsuspend always return EINTR; others restart under SA_RESTART
      const restart = (act.flags & 0x10000000n) && nr !== 34 && nr !== 130;
      if (restart) this._sigDeliver(cpu, t, sig, BigInt.asUintN(64, cpu.rip - 2n));
      else { if (nr === 35 || nr === 230) this._deadline = null;
             cpu.regs[0] = BigInt.asUintN(64, -4n); this._sigDeliver(cpu, t, sig, cpu.rip); }
      return true;
    }
    // pending before the call: pause/sigsuspend see it at once and return
    // EINTR; anything else runs the handler first, then the syscall
    if (nr === 34 || nr === 130) { cpu.regs[0] = BigInt.asUintN(64, -4n); this._sigDeliver(cpu, t, sig, cpu.rip); }
    else this._sigDeliver(cpu, t, sig, BigInt.asUintN(64, cpu.rip - 2n));
    return true;
  }
  _sigExit(cpu) {
    if (this.blocked || this.exitCode !== null) return;
    const t = this._ts(this.threads[this.ti]);
    if (t.proc || t.state === 'dead') return;
    const sig = this._sigDeliverable(t);
    if (!sig) return;
    const act = this.sigact.get(sig);
    if (!act) { this._sigDefault(t, sig); return; }
    this._sigDeliver(cpu, t, sig, cpu.rip);
  }
  _sigPoll() {                                                                  // run-loop quantum
    const t = this._ts(this.threads[this.ti]);
    if (t.eintr || t.proc || t.state === 'dead') return false;
    const sig = this._sigDeliverable(t);
    if (!sig) return false;
    const act = this.sigact.get(sig);
    if (!act) { this._sigDefault(t, sig); return false; }
    this._sigDeliver(this.cpu, t, sig, this.cpu.rip);
    return true;
  }
  // push the rt_sigframe and enter the handler
  _sigDeliver(cpu, t, sig, savedRip) {
    const act = this.sigact.get(sig);
    const bit = 1n << BigInt(sig - 1);
    t.pending &= ~bit;
    if (!act.restorer) {                                                        // no SA_RESTORER: cannot return
      this.exitCode = 128 + sig; cpu.halted = true; return;
    }
    const FRAME = 1072n;                                                        // pretcode + ucontext(936) + siginfo(128)
    const onAlt = (act.flags & 0x08000000n) && t.altstack && !(cpu.regs[4] >= t.altstack.sp && cpu.regs[4] < t.altstack.sp + t.altstack.size);
    const base = onAlt ? t.altstack.sp + t.altstack.size : BigInt.asUintN(64, cpu.regs[4] - 128n);   // red zone
    const F = BigInt.asUintN(64, ((base - FRAME) & ~15n) - 8n);
    this.jsnap(F, Number(FRAME));
    const w = (o, n, v) => this.mem.write(F + BigInt(o), BigInt(n), BigInt.asUintN(n * 8, v));
    w(0, 8, act.restorer);                                                      // pretcode
    w(8, 8, 0n); w(16, 8, 0n);                                                  // uc_flags, uc_link
    w(24, 8, t.altstack ? t.altstack.sp : 0n); w(32, 4, t.altstack ? 0n : 2n); w(40, 8, t.altstack ? t.altstack.size : 0n);
    const G = [8, 9, 10, 11, 12, 13, 14, 15, 7, 6, 5, 3, 2, 0, 1, 4];         // r8..r15 rdi rsi rbp rbx rdx rax rcx rsp
    for (let i = 0; i < 16; i++) w(48 + i * 8, 8, cpu.regs[G[i]]);
    w(48 + 16 * 8, 8, savedRip);                                                // rip
    w(48 + 17 * 8, 8, cpu.flagsValue() | (BigInt(cpu.f.df) << 10n));           // eflags
    w(192, 8, 0x33n | (0x2bn << 48n));                                          // cs / gs / fs / ss
    for (let o = 200; o < 304; o += 8) w(o, 8, 0n);                             // err trapno oldmask cr2 fpstate reserved
    const savedMask = t.suspendOld ?? t.sigmask; t.suspendOld = null;
    for (let o = 304; o < 432; o += 8) w(o, 8, o === 304 ? savedMask : 0n);     // uc_sigmask
    const info = t.siginfo?.get(sig) ?? {};
    for (let o = 944; o < 1072; o += 8) w(o, 8, 0n);
    w(944, 4, BigInt(sig)); w(952, 4, BigInt.asUintN(32, BigInt(info.code ?? 0)));   // si_signo, si_code
    if (info.timer !== undefined) { w(960, 4, BigInt(info.timer)); w(964, 4, BigInt(info.overrun ?? 0)); w(968, 8, info.sival ?? 0n); }   // si_tid, si_overrun, si_value
    else { w(960, 4, BigInt(info.pid ?? 0)); w(964, 4, 0n);                     // si_pid, si_uid
           if (sig === 17) w(968, 4, BigInt(info.status ?? 0)); }               // si_status
    if (globalThis.__sigtrace) console.error(`<deliver sig=${sig} tid=${t.id} handler=${act.handler.toString(16)} savedRip=${savedRip.toString(16)} rsp0=${cpu.regs[4].toString(16)} frame=${F.toString(16)} alt=${onAlt} flags=${act.flags.toString(16)}>`);
    cpu.regs[7] = BigInt(sig); cpu.regs[6] = F + 944n; cpu.regs[2] = F + 8n;    // rdi rsi rdx
    cpu.regs[0] = 0n; cpu.regs[4] = F; cpu.rip = act.handler; cpu.f.df = 0;
    t.sigmask |= act.mask | ((act.flags & 0x40000000n) ? 0n : bit);            // SA_NODEFER
    if (act.flags & 0x80000000n) this.sigact.delete(sig);                       // SA_RESETHAND
    this._sigRedirected = true;
    this._sigAny = this.threads.some(x => (x.pending ?? 0n) !== 0n);
  }
  _sigreturn(cpu) {
    const t = this._ts(this.threads[this.ti]);
    const uc = cpu.regs[4];                                                     // handler's ret popped pretcode
    const r = (o) => this.mem.read(uc + BigInt(o), 8n);
    const G = [8, 9, 10, 11, 12, 13, 14, 15, 7, 6, 5, 3, 2, 0, 1, 4];
    for (let i = 0; i < 16; i++) cpu.regs[G[i]] = r(40 + i * 8);
    cpu.rip = r(40 + 16 * 8);
    const fl = r(40 + 17 * 8);
    const f = cpu.f;
    f.cf = Number(fl & 1n); f.pf = Number((fl >> 2n) & 1n); f.af = Number((fl >> 4n) & 1n);
    f.zf = Number((fl >> 6n) & 1n); f.sf = Number((fl >> 7n) & 1n); f.df = Number((fl >> 10n) & 1n); f.of = Number((fl >> 11n) & 1n);
    t.sigmask = r(296) & ~((1n << 8n) | (1n << 18n));
    if (globalThis.__sigtrace) console.error(`<sigreturn tid=${t.id} uc=${uc.toString(16)} rip=${cpu.rip.toString(16)} rsp=${cpu.regs[4].toString(16)}>`);
    this._sigRedirected = true;
  }

  rlimits(res) {                          // [cur, max] per resource
    if (res === 3) return [0x800000n, 0xFFFFFFFFFFFFFFFFn];       // STACK: finite (pthread sizing)
    if (res === 7) return [4096n, 1048576n];                       // NOFILE: a plausible table
    return [0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn];
  }

  inExec(rip) {
    const c = this._ieCache;
    if (c !== undefined && rip >= c[0] && rip < c[1]) return true;
    for (const r of this.execRanges) if (rip >= r[0] && rip < r[1]) { this._ieCache = r; return true; }
    return false;
  }

  // Child processes (execve'd plug-ins etc.) are separate engines pumped
  // from the parent's run(): each gets a small interleaved slice, blocked
  // children are re-woken (their pipes may have data written by us), and a
  // child's exit sets weof on its pipe write-ends so our readers see EOF.
  // Is any live descriptor anywhere in the process tree still a WRITE end of
  // this pipe buffer? Scanned at close/exec/exit so readers see EOF exactly
  // when the last writer disappears — across engines (parent and execve'd
  // children share pipe buffers by reference).
  // Undo everything a vfork-window child wrote to the shared image (reverse
  // order), restoring the parent's memory to its at-fork state.
  // A vfork child runs in the PARENT's address space, so everything it
  // writes has to be undone when it execs. Its own stores go through
  // this.mem and are journaled — but a syscall writes its RESULT straight
  // into guest memory via this.ram/this.wmem, which the journal never saw.
  // The child stat()ing a file therefore left 144 bytes of struct stat
  // permanently on the parent's stack; with enough of them the parent
  // resumed to "*** stack smashing detected ***".
  //
  // Call this with the range a syscall is about to write, before writing it.
  jsnap(addr, len) {
    const jr = this.mem.jrnl;
    if (!jr || len <= 0) return;
    try { jr.push([addr, 0, 0n, this.mem.view(addr, BigInt(len)).slice()]); } catch {}
  }

  // Turn the vfork-window child thread `t` into a real child process: a new
  // engine over a COPY of the memory as the child sees it (its own writes
  // included), its copied fd table, cwd and signal dispositions, resuming at
  // the syscall it blocked in. Then the journal is rolled back so the parent
  // sees memory as it was at the fork, and the parent runs again. The child
  // starts cold in the tiers (compiled units are bound to the parent's
  // memory) and is driven by the child pump like an execve'd child.
  _materializeFork(t) {
    const o = this._ctor;
    const ceng = new LinuxEngine(o.elfBytes, {
      argv: o.argv, env: o.env, memMB: o.memMB, threshold: o.threshold, files: this.files,
      assembleWat: o.assembleWat, aotCallThreshold: o.aotCallThreshold, aotLoopThreshold: o.aotLoopThreshold,
      xserver: o.xserver, mtimes: o.mtimes, tty: o.tty, ttyRows: o.ttyRows, ttyCols: o.ttyCols, stdin: o.stdin });
    if (this.strace) ceng.strace = [];                       // a traced parent traces its children
    if (this.childMemMB !== undefined) ceng.childMemMB = this.childMemMB;
    if (this.onChildEngine) { ceng.onChildEngine = this.onChildEngine; this.onChildEngine(ceng, o.argv); }
    // record locks the child took inside its window are owned by its proc
    // record; from here on its identity is the new engine (it conflicted
    // with its own lock otherwise - F_SETLKW spun forever after the parent
    // unlocked)
    for (const L of this._fsMeta().rlocks?.values() ?? []) for (const x of L) if (x.owner === t.proc) x.owner = ceng;
    this._copyLiveRam(ceng);                                 // the child's view, before rollback (live ranges only)
    ceng.brk = this.brk; ceng.mmapNext = this.mmapNext; ceng._mmapBase = this._mmapBase; ceng._mmapHoles = (this._mmapHoles || []).map(h => [h[0], h[1]]);
    ceng.execRanges = this.execRanges.slice();
    if (this.execRangesStatic) ceng.execRangesStatic = this.execRangesStatic.slice();
    ceng.maps = (this.maps ?? []).map(m => ({ ...m }));
    ceng.cwd = this.cwd;                                     // the child's cwd (its chdir stays with it)
    ceng.fds = t.proc.fds; ceng.cloexec = new Set(this.cloexec);
    ceng.sigact = new Map(this.sigact ?? []); ceng.sigign = new Set(this.sigign ?? []);
    ceng.termios = this.termios; ceng.ptys = this.ptys; ceng.ttyWin = this.ttyWin;
    ceng.env = this.env; ceng.argv0 = this.argv0;
    const c = ceng.cpu;
    for (let r = 0; r < 16; r++) c.regs[r] = t.cpu.regs[r];
    for (let r = 0; r < 16; r++) c.xmm[r] = t.cpu.xmm[r] ?? 0n;
    c.rip = t.cpu.rip; c.fsBase = t.cpu.fsBase; Object.assign(c.f, t.cpu.f);
    ceng._deadline = this._deadline;                         // an interrupted nanosleep keeps its deadline
    // threads[0] IS the blocking thread, whichever of the child's threads
    // that was: Ruby's child restarts its timer thread inside the window and
    // the TIMER thread is the first to block, so it lands here while the
    // main thread migrates below. Its identity must come along whole — the
    // tid glibc cached and the ctid pthread_join waits on. With ctid dropped
    // the timer thread's exit woke nobody and the main thread joined forever.
    const m0 = ceng.threads[0];
    m0.id = t.id; m0.ctid = t.ctid ?? 0n; m0.sigmask = t.sigmask ?? 0n; m0.pending = t.pending ?? 0n;
    m0.altstack = t.altstack ?? null; m0.eintr = false; m0.suspendOld = null;
    ceng.nextTid = Math.max(ceng.nextTid ?? 2, t.id + 1);
    ceng.blocked = null;
    // threads the child created inside the window move with it
    for (const x of this.threads) {
      if (x === t || x.proc !== t.proc || x.state === 'dead') continue;
      const xc = new CPU(ceng.mem); xc.onSyscall = (cc) => ceng.syscall(cc);
      for (let r = 0; r < 16; r++) xc.regs[r] = x.cpu.regs[r];
      for (let r = 0; r < 16; r++) xc.xmm[r] = x.cpu.xmm[r] ?? 0n;
      xc.rip = x.cpu.rip; xc.fsBase = x.cpu.fsBase; Object.assign(xc.f, x.cpu.f);
      ceng.threads.push({ id: x.id, cpu: xc, state: x.state === 'vfork' ? 'run' : x.state, dl: x.dl, futex: x.futex,
                          ctid: x.ctid, _dl: x._dl, sigmask: x.sigmask ?? 0n, pending: x.pending ?? 0n, eintr: false, suspendOld: null, altstack: x.altstack ?? null });
      ceng.nextTid = Math.max(ceng.nextTid ?? 2, x.id + 1);
      x.state = 'dead';
    }
    if (this.asyncCompile) ceng.asyncCompile = this.asyncCompile;
    ceng.unitMaxFuncs = this.childUnitMaxFuncs ?? 24; ceng.unitMaxInsns = this.childUnitMaxInsns ?? 4000;
    ceng.parentEng = this;
    // retire the thread, restore the parent's memory and release it
    t.state = 'dead';
    this._vforkRollback(t);
    const parent = t.proc.parent;
    parent.state = 'run'; this._vforkThaw(parent);
    (this.children ??= []).push({ pid: t.proc.pid, eng: ceng, exited: null });
    ceng.pid = t.proc.pid; ceng.ppid = this.pid ?? 1;
    this.blocked = null;
    this._deadline = null;
    this.switchTo(this.threads.indexOf(parent));
    return true;
  }
  // fork() in a multithreaded parent: while the child runs in the shared
  // image (its writes journaled), the parent's OTHER threads must not run —
  // Ruby's child tears down the parent's thread structures in atfork, and
  // a parent thread that ran on that state jumped to rip 0. Frozen threads
  // keep their real state and resume on release (exec, exit, materialise).
  // pids come from ONE counter at the root of the engine tree: a materialised
  // child that forks must not hand out its own pid (or its sibling's) again
  _allocPid() { let r = this; while (r.parentEng) r = r.parentEng; return (r.nextPid = (r.nextPid ?? 999) + 1); }
  // Grow a written file to `end` bytes. The file array is an exact-length
  // VIEW over a backing buffer with spare capacity, so appending 8KB at a
  // time copies the file once per doubling, not once per write: exact
  // reallocation was O(n^2) - vim writing 14MB in 8KB chunks spent 3.4s of
  // a 6s run copying 12GB. Every consumer takes the view's length and
  // byteOffset (parseElf, DataView, Buffer.from), so the capacity is invisible.
  _growFile(h, end) {
    const old = h.bytes;
    const nb = (old.byteOffset + end <= old.buffer.byteLength)
      ? new Uint8Array(old.buffer, old.byteOffset, end)
      : (() => { const b = new Uint8Array(Math.max(end, old.length * 2, 4096)); b.set(old); return b.subarray(0, end); })();
    h.bytes = nb;
    this.files[h.path] = nb;                                 // growable buffer: refresh the map ref
    this._hardRefresh(h.path, nb);                           // ... and every hard-link alias
  }
  _knownEntries() {
    const e = new Set();
    for (const k of this.aotCalls.keys()) e.add(k.toString());
    for (const k of this.aotFns.keys()) e.add(k.toString());
    for (const k of this._ftSeen) e.add(k.toString());
    return e;
  }
  _killProcSiblings(t) {
    for (const x of this.threads) if (x !== t && x.proc === t.proc && x.state !== 'dead') {
      x.state = 'dead'; if (x.ctid) { try { this.mem.write(x.ctid, 4n, 0n); } catch {} }
    }
  }
  _vforkFreeze(parent) {
    for (const x of this.threads) if (x !== parent && !x.proc && x.state !== 'dead' && x._frz === undefined) { x._frz = x.state; x.state = 'vfork'; }
  }
  _vforkThaw(parent) {
    if (this.threads.some(x => x !== parent && x.proc && x.state !== 'dead' && x.proc.parent === parent)) return;   // another window still open
    for (const x of this.threads) if (x._frz !== undefined) { x.state = x._frz; delete x._frz; }
  }
  // Copy only the ranges a guest can have touched — program+heap up to brk,
  // the mmap arena, MAP_FIXED spans, the top of the stack — so a materialised
  // child commits the pages it needs, not the whole memMB (a Pool of four
  // 1GB workers was OOM-killed copying 4GB of zeros).
  _copyLiveRam(ceng) {
    const B = this.base, L = this.ram.length;
    const cp = (lo, hi) => { lo = Math.max(0, Number(lo - B)); hi = Math.min(L, Number(hi - B)); if (hi > lo) ceng.ram.set(this.ram.subarray(lo, hi), lo); };
    cp(B, this.brk + 65536n);                                              // image + heap
    cp(this._mmapBase ?? this.mmapNext, this.mmapNext + 65536n);           // the arena
    if (this._fixedLo !== undefined) cp(this._fixedLo, this._fixedHi);    // MAP_FIXED spans
    for (const m of this.maps ?? []) cp(m.at, m.at + m.len);
    cp(this.stackTop - (64n << 20n), this.stackTop + 4096n);              // stack (64MB below the top)
  }
  _vforkRollback(t) {
    // the vfork child runs IN this engine, so its chdir (tar -C, cd in a
    // subshell) must not follow the parent out of the window
    if (t.proc.cwd0 !== undefined) { this.cwd = t.proc.cwd0; t.proc.cwd0 = undefined; }
    const jr = t.proc.jrnl; if (!jr) return;
    for (let i = jr.length - 1; i >= 0; i--) {
      const [a, n, old, snap] = jr[i];
      try { if (snap) this.mem.view(a, BigInt(snap.length)).set(snap); else this.mem.write(a, n, old); } catch {}
    }
    t.proc.jrnl = null;
    if (this.mem.jrnl === jr) this.mem.jrnl = null;
    if (this._vforkBudget !== undefined) { this.aotBudget = this._vforkBudget; this._vforkBudget = undefined; }
  }

  _pipeWriterAlive(buf) {
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set();
    const scan = (e) => {
      if (seen.has(e)) return false; seen.add(e);
      const tables = [e.fds];
      if (e._mainFds) tables.push(e._mainFds);
      for (const t of e.threads ?? []) if (t.state !== 'dead' && t.proc?.fds) tables.push(t.proc.fds);
      for (const tb of tables) for (const [, h] of tb) if ((h?.pipe === buf && h.mode === 'w') || h?.peer === buf) return true;
      for (const c of e.children ?? []) if (c.eng && c.exited === null && c.eng.exitCode === null && scan(c.eng)) return true;
      return false;
    };
    return scan(root);
  }
  _pipeReaderAlive(buf) {                     // mirror of _pipeWriterAlive for the read end
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set();
    const scan = (e) => {
      if (seen.has(e)) return false; seen.add(e);
      const tables = [e.fds];
      if (e._mainFds) tables.push(e._mainFds);
      for (const t of e.threads ?? []) if (t.state !== 'dead' && t.proc?.fds) tables.push(t.proc.fds);
      for (const tb of tables) for (const [, h] of tb) if (h?.pipe === buf && h.mode !== 'w') return true;   // 'r', or a socketpair end ('rw')
      for (const c of e.children ?? []) if (c.eng && c.exited === null && c.eng.exitCode === null && scan(c.eng)) return true;
      return false;
    };
    return scan(root);
  }
  _pipeEofSweep(handles) {
    for (const h of handles) { const wb = h?.peer ?? (h?.pipe && h.mode === 'w' ? h.pipe : null); if (wb && !wb.weof && !this._pipeWriterAlive(wb)) wb.weof = true; }
    this.wakeAllBlk();
    let root = this; while (root.parentEng) root = root.parentEng;
    if (root !== this) root.wakeAllBlk();
  }

  pumpChildren() {
    for (const c of this.children) {
      if (c.exited !== null) continue;
      const e = c.eng;
      if (e.exitCode === null) {
        if (e.blocked) e.wake();
        try { e.run(3e5); } catch (err) { c.exited = 127; c.error = err.message; }
      }
      if (c.exited === null && e.exitCode !== null) {
        c.exited = e.exitCode;
        this._pipeEofSweep([...e.fds.values()]);
        this.raiseSignal(17, null, { pid: c.pid, code: 1, status: c.exited });   // SIGCHLD, CLD_EXITED
        if (this.onChildExit) this.onChildExit(c);
      }
    }
    this.wakeAllBlk();   // whatever the children wrote may unblock us
  }

  // Ping-pong the parent and its children within one host slice: a plug-in
  // tile exchange otherwise costs a full host-pump round trip PER MESSAGE
  // (child blocks on the wire, parent answers next slice, ... — 1197 tile
  // messages made a mild blur take minutes). While either side makes
  // progress, keep alternating.
  run(maxSteps = 5e9) {
    if (this._execed) {                // main process tail-exec'd: pump the replacement
      this.pumpChildren();
      const c = this._execed;
      if (c.exited !== null) this.exitCode = c.exited;
      else this.block(this.nowMs() + 2);
      return 0;
    }
    let out = this._run1(maxSteps);
    for (let round = 0; round < 64; round++) {
      if (this.exitCode !== null || !this.blocked) break;
      const live = (this.children ?? []).filter(c => c.exited === null && c.eng.exitCode === null);
      if (!live.length) break;
      const before = live.map(c => c.eng.stats.interpreted + c.eng.stats.aotRuns);
      this.pumpChildren();
      if (!live.some((c, i) => c.eng.stats.interpreted + c.eng.stats.aotRuns !== before[i])) break;
      this.wake();                     // the children may have written what we block on
      out = this._run1(maxSteps);
      if (this.sliceDeadline != null && performance.now() > this.sliceDeadline) break;
    }
    // While children live, the deadline the host sleeps to is the EARLIEST
    // across the tree: a child blocked on a shorter timer than the parent's
    // (Ruby's forked child has its own timer thread), or a runnable child,
    // must not wait out the parent's 100ms tick — that made a fork that
    // finishes in seconds take a quarter of an hour, three quarters of it
    // asleep. Never park indefinitely while a child lives.
    if (this.blocked && this.children?.some(c => c.exited === null)) {
      let dl = this.blocked.deadline;
      for (const c of this.children) if (c.exited === null && c.eng && c.eng.exitCode === null) {
        const cd = c.eng.blocked ? c.eng.blocked.deadline : this.nowMs();
        if (cd != null && (dl == null || cd < dl)) dl = cd;
      }
      this.blocked.deadline = dl == null ? this.nowMs() + 2 : dl;
    }
    return out;
  }

  _run1(maxSteps = 5e9) {
    let steps = 0;
    // true top level (never nested): clear the wasm-frame budget word so
    // taxes leaked by unwound chains can't accumulate across slices
    (this._ftdv ??= new DataView(this.wmem.buffer)).setUint32(FTMAP + 8, 0, true);
    if (this.children?.some(c => c.exited === null)) this.pumpChildren();
    try {
      let branched = true;    // compiled entries are branch targets: only look up after a branch
      while (steps++ < maxSteps && this.exitCode === null) {
        if ((steps & 0x3FFFF) === 0) {
          if (this.threads.length > 1) { this.rotate(); branched = true; }   // preemption quantum
          if (this.itimer?.at != null) this._checkAlarm();
        }
        if (this._sigAny && this._sigPoll()) branched = true;     // asynchronous delivery at an insn boundary
        const key = this.cpu.rip;
        let f = branched ? this.aotFns.get(key) : undefined;
        if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
        if (f) { if (this.ripTrace !== undefined) { this.ripTrace[this.ripTraceI++ & 1023] = -key; }   // negative = AOT entry
                 this.cpu.rip = this.dispatchMaybeShadow(f);
                 if (this.ripTrace !== undefined) { this.ripTrace[this.ripTraceI++ & 1023] = -this.cpu.rip; }  // AOT exit
                 branched = true;
                 if (this.blocked) { if (this.park()) continue; break; }
                 if (this.itimer?.at != null) this._checkAlarm();
                 if (this._sigAny) this._sigPoll();
                 if (this.sliceDeadline != null && performance.now() > this.sliceDeadline) break;
                 continue; }
        const c = branched ? this.compiled.get(key) : undefined;
        if (c) {
          for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
          c.run();
          for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
          this.cpu.rip = c.exit; this.stats.compiledRuns++; branched = true; continue;
        }
        const before = this.cpu.rip;
        if (this.ripTrace !== undefined) this.ripTrace[this.ripTraceI++ & 1023] = before;
        let insn;
        this._cleanSync = false;
        try { insn = this.cpu.step(); }
        catch (e) { if (e === EXIT) break;
          if (e.pending) {                 // streamed page not here yet: rewind
            this.cpu.rip = before;         // and retry the instruction shortly
            this.blocked = { deadline: this.nowMs() + 40 };
            break;
          }
          e.rip = before; throw e; }
        this.stats.interpreted++;
        branched = BRANCHY.has(insn.mnem) || this.cpu.rip !== before + BigInt(insn.len);
        if (this.onProgress && this.stats.interpreted % 2e7 === 0) this.onProgress('run');
        if (this.blocked) { this.cpu.rip = before;            // re-execute the syscall on resume
                            branched = true;
                            if (this.park()) continue; break; }
        if ((steps & 0xFFF) === 0 && this.sliceDeadline != null && performance.now() > this.sliceDeadline) break;
        if ((insn.mnem === 'jcc' || insn.mnem === 'jmp') && this.cpu.rip < before && this.inExec(this.cpu.rip)) {   // jmp: rotated-loop back-edge
          const hk = this.cpu.rip;
          const n = (this.profile.get(hk) || 0) + 1;
          this.profile.set(hk, n);
          // hot loop: first the cheap loop tiers, then whole-frame AOT from
          // the loop head (the unit translator only needs "forward to ret")
          if (n >= this.threshold && !this.compiled.has(hk) &&
              (this.execRangesStatic ?? this.execRanges).some(([a, b]) => hk >= a && hk < b))
            this.tryCompile(hk, this.cpu.rip);
          if (this.assembleWat && n >= this.aotLoopThreshold && !this.aotFns.has(hk) && !this.aotFailed.has(hk))
            this.tierUpAot(this.cpu.rip);
        }
      }
    } catch (e) { if (e !== EXIT) throw e; }
    return { exitCode: this.exitCode, stdout: this.stdout.join(''),
             stderr: (this.stderr || []).join(''), stats: this.stats };
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
