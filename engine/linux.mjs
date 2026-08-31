// oxwasm M3 — run an UNMODIFIED Linux x86-64 static ELF binary.
//
// ELF64 loader + System V stack + a small Linux syscall layer over the
// tier-0 interpreter, with the tiering JIT compiling hot loops. The binary
// is normal compiler output (musl/glibc static); nothing about it is
// adapted for this engine.
import { CPU, Memory } from './interp.mjs';
import { compileLoop } from './jit2.mjs';
import { compileVectorLoop } from './jitsimd.mjs';
import { compileUnitWat, pltStubWat, FTMAP, FTMAP_MAX, FTDLIMIT, FTFUEL,
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
class DeoptUnwind { constructor(rip) { this.rip = rip; } }
// A blocking syscall (poll/select/read with nothing ready, nanosleep) suspends
// the guest the same way a deopt escapes compiled code: every register is
// already in the regfile / cpu and the syscall insn's rip is recorded, so ALL
// wasm frames are destroyed and the engine returns to its caller with
// `engine.blocked` set. Resuming just re-enters run(): the syscall RE-EXECUTES
// (rax still holds the syscall number) and either completes or blocks again.
class BlockUnwind { constructor(rip) { this.rip = rip; } }

export class LinuxEngine {
  // threshold: legacy tier-1.5 loop JIT trigger. Defaults OFF — it miscompiles
  // a vfprintf loop in glibc (wrong digits past the 22nd output byte) and the
  // tier-2 whole-frame AOT subsumes it. Pass a finite value to re-enable for
  // the tier's own test suites.
  constructor(elfBytes, { argv = ['prog'], env = [], memMB = 256, threshold = Infinity, files = {},
                          assembleWat = null, aotCallThreshold = 4, aotLoopThreshold = 12,
                          xserver = null, mtimes = {}, tty = false, ttyRows = 24, ttyCols = 80 } = {}) {
    this.files = files;                       // path -> Uint8Array (read-only)
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
    this.fds.set(0, { bytes: new Uint8Array(0), pos: 0 });
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
    this.brk = align(loadEnd, PAGE);
    this.mmapNext = align(this.brk + (64n << 20n), PAGE);      // anon mmaps above the heap
    const total = BigInt(memMB) << 20n;
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

    this.mem = new Memory([{ base: lo, bytes: this.ram }]);
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
        skip: (c) => this._ftSeen.has(BigInt(c)),
        // the tiering call profile, so the inliner can pick targets by how
        // often they are actually called rather than by what fits a budget
        hot: this.aotCalls,
        // hosts whose assembler is wabt.js (itself wasm) choke on multi-MB
        // closure texts — child engines cap the unit size and chain instead
        ...(this.unitMaxFuncs ? { maxFuncs: this.unitMaxFuncs } : {}),
        ...(this.unitMaxInsns ? { maxInsns: this.unitMaxInsns } : {}) });
      if (this.onUnitWat) this.onUnitWat(un, entry, unit);
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
          .then(({ instance }) => {
            for (const a of unit.funcs)
              if (!this.aotFns.get(a)) this.registerAotFn(a, instance.exports['f_' + a.toString(16)]);
            if (instance.exports.drive) this.aotDrive = instance.exports.drive;
            this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
          })
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
    this.syncOut();
    const entry = this.cpu.rip;
    try { let exit = f();
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
    finally { fdv.setUint32(FTMAP + 8, fd0, true); }
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
    if (ok && exitRip === retAddr && cpu.regs[4] === rspExit && (this._shadowDiverged ?? 0) < 12) {
      const diffs = [];
      for (let r = 0; r < 16; r++) if (cpu.regs[r] !== iRegs[r])
        diffs.push(`r${r} aot=${cpu.regs[r].toString(16)} interp=${iRegs[r].toString(16)}`);
      for (let r = 0; r < 16; r++) if (cpu.xmm[r] !== iXmm[r])
        diffs.push(`xmm${r} aot=${cpu.xmm[r].toString(16)} interp=${iXmm[r].toString(16)}`);
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
    if (n >= 50) return this.dispatchAot(f);            // exonerated after 50 clean passes
    this._shadowClean.set(k, n + 1);
    return this.shadowDispatch(f);
  }

  // Interpret (dispatching into compiled functions when rip lands on one)
  // until `done()` — used by the callout escape.
  interpUntil(done) {
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
  }

  aotEnv() {
    return {
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
        this.syscall(this.cpu);
        if (this.exitCode !== null) throw EXIT;
        if (this.blocked) {
          this.cpu.rip = BigInt.asUintN(64, rip ?? 0n);
          this.syncOut();
          throw new BlockUnwind(this.cpu.rip);
        }
        this.syncOut();
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
      deopt: (rip, _rsp0) => { const t = BigInt.asUintN(64, rip);
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
  lookup(p) { p = this.resolve(this.norm(p)); return this.files[p]; }
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
  writeStat(buf, path, size, mode, rdev = 0n, ino = null) {
    this.jsnap(buf, 144);
    const off = this.RAMOFF + Number(buf - this.base);
    new Uint8Array(this.wmem.buffer, off, 144).fill(0);
    const v = new DataView(this.wmem.buffer);
    v.setBigUint64(off + 0, 8n, true);                        // st_dev
    v.setBigUint64(off + 8, ino ?? this.inoOf(path), true);   // st_ino
    v.setBigUint64(off + 40, rdev, true);                     // st_rdev
    v.setBigUint64(off + 16, 1n, true);                       // st_nlink
    v.setUint32(off + 24, mode, true);                        // st_mode
    v.setBigUint64(off + 48, BigInt(size), true);             // st_size
    v.setBigUint64(off + 56, 4096n, true);                    // st_blksize
    v.setBigUint64(off + 64, BigInt(Math.ceil(size / 512)), true);
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
    const ret = (v) => { cpu.regs[0] = BigInt.asUintN(64, v); };
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
      if (h?.pipe) { h.pipe.chunks.push(bytes); this.wakeAllBlk(); return; }
      if (h?.ev) {                                           // eventfd: add to the counter
        let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] ?? 0);
        h.ev.count += v; this.wakeAllBlk(); return;
      }
      if (h && h.bytes !== undefined && h.writable) {        // regular file opened for writing
        if (h.path) (this.dirtyFiles ??= new Set()).add(h.path);
        const end = h.pos + bytes.length;
        if (end > h.bytes.length) {
          const nb = new Uint8Array(end);
          nb.set(h.bytes); h.bytes = nb;
          this.files[h.path] = nb;                           // growable buffer: refresh the map ref
        }
        h.bytes.set(bytes, h.pos); h.pos = end;
        return;
      }
      const str = new TextDecoder().decode(bytes);
      // sink output belongs to the process TREE's observer: an execve'd
      // child's stdout/stderr surface on the root engine, like a terminal
      let root = this; while (root.parentEng) root = root.parentEng;
      if (h?.sink === 'err') { (root.stderr ||= []).push(str); (root.stderrBytes ||= []).push(bytes); }
      else { root.stdout.push(str); root.stdoutBytes.push(bytes); }
    };
    switch (nr) {
      case 1:                                                // write(fd, buf, len)
        writeChunk(Number(a1), a2, Number(a3)); ret(a3); break;
      case 20: {                                             // writev(fd, iov, cnt)
        const view = new DataView(this.wmem.buffer);
        let total = 0n;
        for (let i = 0; i < Number(a3); i++) {
          const io = this.RAMOFF + Number(a2 - this.base) + i * 16;
          const b = view.getBigUint64(io, true), l = view.getBigUint64(io + 8, true);
          writeChunk(Number(a1), b, Number(l)); total += l;
        }
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
        const buf = { chunks: [], pos: 0, off: 0 };
        const rfd = this.allocFd(); this.fds.set(rfd, null); const wfd = this.allocFd(); this.fds.delete(rfd);
        this.fds.set(rfd, { pipe: buf, mode: 'r' });
        this.fds.set(wfd, { pipe: buf, mode: 'w' });
        if (nr === 293 && (Number(a2) & 0x80000)) { this.cloexec.add(rfd); this.cloexec.add(wfd); }
        this.jsnap(a1, 8);
        const v = new DataView(this.wmem.buffer), o = this.RAMOFF + Number(a1 - this.base);
        v.setUint32(o, rfd, true); v.setUint32(o + 4, wfd, true);
        ret(0n); break; }
      case 12:                                               // brk
        if (a1 > this.brk) this.brk = align(a1, PAGE);
        ret(this.brk); break;
      case 9: {                                              // mmap(addr,len,prot,flags,fd,off)
        for (const t of this.threads) t.cpu.icache?.clear();  // new code may appear
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
          (this.maps ??= []).push({ at, len, path: h.path ?? '?', fileOff: fo });
          this.execRanges.push([at, at + len]);   // library text: profiling must see it (prot untracked)
        }
        ret(at); break; }
      case 11: ret(0n); break;                               // munmap
      case 10: ret(0n); break;                               // mprotect (no page prot here)
      case 273: ret(0n); break;                              // set_robust_list
      case 334: ret(-38n); break;                            // rseq -> ENOSYS (glibc copes)
      case 302: {                                            // prlimit64(pid, res, new, old)
        const oldp = cpu.regs[10];                           // r10 = old_limit (rdx is new_limit!)
        if (oldp) { const v = new DataView(this.wmem.buffer);
          const off = this.RAMOFF + Number(oldp - this.base);
          // RLIMIT_STACK must be finite: glibc sizes every pthread stack from
          // it — garbage/huge values made 516MB stacks and EAGAIN thread spawns
          const cur = Number(a2) === 3 ? 0x800000n : 0xFFFFFFFFFFFFFFFFn;
          v.setBigUint64(off, cur, true);
          v.setBigUint64(off + 8, 0xFFFFFFFFFFFFFFFFn, true); }
        ret(0n); break; }
      case 97: {                                             // getrlimit(res, rlim*)
        const v = new DataView(this.wmem.buffer);
        const off = this.RAMOFF + Number(a2 - this.base);
        const cur = Number(a1) === 3 ? 0x800000n : 0xFFFFFFFFFFFFFFFFn;
        v.setBigUint64(off, cur, true);
        v.setBigUint64(off + 8, 0xFFFFFFFFFFFFFFFFn, true);
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
      case 16: {                                             // ioctl
        const req = Number(a2 & 0xffffffffn), h = this.fds.get(Number(a1));
        const pty = h?.ptm ?? h?.pts;                        // a pty end, either side
        // a pty pair works whether or not the session has a console tty
        if (!pty && !(this.tty && (Number(a1) <= 2 || h?.istty))) { ret(-25n); break; }   // ENOTTY
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
          default: ret(-25n); break;
        }
        break; }
      case 158:                                              // arch_prctl
        if (Number(a1) === 0x1002) { cpu.fsBase = a2; ret(0n); } else ret(-22n);
        break;
      case 218: { const t = this.threads[this.ti]; t.ctid = a1; ret(BigInt(t.id)); break; }  // set_tid_address
      case 56: case 57: case 58: {                           // clone / fork / vfork
        const flags = nr === 56 ? Number(a1 & 0xffffffffn) : 0;
        if (!(flags & 0x100)) {
          // fork/vfork: VFORK SEMANTICS — the child shares this memory image
          // and runs with a copy of the fd table; the parent thread is
          // suspended until the child execve()s (which moves it into its own
          // engine) or exits. Exact for the g_spawn / posix_spawn pattern
          // (dup2 + close + execve between fork and exec), which is what
          // GIMP's plug-in launcher does.
          const pid = (this.nextPid = (this.nextPid ?? 999) + 1);
          const c = new CPU(this.mem);
          c.onSyscall = (cc) => this.syscall(cc);
          for (let r = 0; r < 16; r++) c.regs[r] = cpu.regs[r];
          for (let r = 0; r < 16; r++) c.xmm[r] = cpu.xmm[r] ?? 0n;
          c.rip = cpu.rip; c.fsBase = cpu.fsBase;
          c.regs[0] = 0n;                                    // child sees 0
          const parent = this.threads[this.ti];
          parent.state = 'vfork';                            // scheduler skips until released
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
                    ctid: (flags & 0x200000) ? cpu.regs[10] : 0n, _dl: null }; // CLONE_CHILD_CLEARTID
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
          const pid = (this.nextPid = (this.nextPid ?? 999) + 1);
          const rec = { pid, eng: ceng, exited: null };
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
        t.state = 'dead';
        this._pipeEofSweep(skipped);
        this._vforkRollback(t);
        t.proc.parent.state = 'run';                         // vfork release
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
        if (a2) this.mem.write(a2, 4n, BigInt((code & 0xff) << 8));           // WIFEXITED status
        this.children.splice(this.children.indexOf(done), 1);
        ret(BigInt(done.pid)); break; }
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
        if (t.proc) {
          // a vfork-window child died without execve (e.g. g_spawn's _exit
          // after a failed exec): release the parent, record the status for
          // wait4, retire this context
          t.state = 'dead';
          this._pipeEofSweep([...t.proc.fds.values()]);
          this._vforkRollback(t);
          t.proc.parent.state = 'run';
          (this.children ??= []).push({ pid: t.proc.pid, eng: null, exited: Number(a1 & 0xffn) });
          this.block(null); ret(0n); break;
        }
        if (nr === 231 || this.threads.filter(x => x.state !== 'dead').length <= 1) {
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
      case 39: ret(1n); break;                               // getpid
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
          // empty: EOF only once the writing side is gone (weof — set when a
          // child process holding the write end exits); otherwise BLOCK like
          // a real pipe — the plug-in wire protocol reads before data arrives
          if (got === 0 && want > 0 && !h.pipe.weof) {
            if (h.nonblock) { ret(-11n); break; }             // EAGAIN
            this.block(null); break;
          }
          ret(BigInt(got)); break;
        }
        const n = Math.min(Number(a3), h.bytes.length - h.pos);
        this.jsnap(a2, n);
        this.ram.set(h.bytes.subarray(h.pos, h.pos + n), Number(a2 - this.base));
        h.pos += n; ret(BigInt(n)); break; }
      case 3: { const cfd = Number(a1), ch = this.fds.get(cfd);
        this.fds.delete(cfd); this.cloexec.delete(cfd);
        if (ch?.pipe && ch.mode === 'w') this._pipeEofSweep([ch]);
        ret(0n); break; }                                     // close
      case 8: {                                               // lseek
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        if (!h.bytes) { ret(-29n); break; }                   // pipe/sink/socket: ESPIPE
        const w = Number(a3);                                 // rdx = whence
        const off = BigInt.asIntN(64, a2);
        h.pos = w === 0 ? Number(off) : w === 1 ? h.pos + Number(off) : h.bytes.length + Number(off);
        ret(BigInt(h.pos)); break; }
      case 5: case 262: {                                     // fstat / newfstatat
        const isAt = nr === 262;
        let size = null, mode = 0o020620, statPath = null;    // default: char dev (tty)
        if (isAt) {
          const p = this.atPath(a1, a2);
          if (p === '' && (cpu.regs[10] & 0x1000n)) {         // AT_EMPTY_PATH: stat the fd
            const h = this.fds.get(Number(a1));
            if (h) { size = h.bytes.length; mode = 0o100755; statPath = h.path ?? null; }
          } else if ((cpu.regs[10] & 0x100n) && !p.endsWith('/') &&   // AT_SYMLINK_NOFOLLOW
                     this._fsMeta().links.has(this.norm(p))) {
            statPath = this.norm(p);
            size = this._fsMeta().links.get(statPath).length; mode = 0o120777;
          } else if (this.isTtyPath(p)) {
            this.writeStat(cpu.regs[2], '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break;
          } else {
            const f = this.lookup(p);
            if (f !== undefined) { size = f.length; mode = 0o100755; }
            else if (this.isDir(p)) { size = 4096; mode = 0o040755; }
            else { ret(-2n); break; }                         // ENOENT
            statPath = p;
          }
        } else {
          const h = this.fds.get(Number(a1));
          if (this.tty && (Number(a1) <= 2 || h?.istty)) {     // terminal: match stat("/dev/pts/0")
            this.writeStat(a2, '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break; }
          if (h?.bytes) { size = h.bytes.length; mode = 0o100755; statPath = h.path ?? null; }  // regular file
          else if (h?.pipe) { size = 0; mode = 0o010600; }                 // FIFO
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
        v.setBigUint64(off + 16, 1n, true);                   // st_nlink
        v.setUint32(off + 24, mode, true);                    // st_mode (u32 at 24)
        v.setBigUint64(off + 48, BigInt(size ?? 0), true);    // st_size
        v.setBigUint64(off + 56, 4096n, true);                // st_blksize
        v.setBigUint64(off + 64, BigInt(Math.ceil((size ?? 0) / 512)), true);    // st_blocks
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
        if (f === undefined && !this.isDir(p)) { ret(-2n); break; }   // ENOENT
        this.writeStat(a2, p, f ? f.length : 4096, f ? 0o100755 : 0o040755);
        ret(0n); break; }
      case 17: {                                              // pread64(fd, buf, count, off)
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        const fo = Number(cpu.regs[10]);
        const n = Math.min(Number(a3), Math.max(0, h.bytes.length - fo));
        if (n > 0) { this.jsnap(a2, n); this.ram.set(h.bytes.subarray(fo, fo + n), Number(a2 - this.base)); }
        ret(BigInt(n)); break; }
      case 21: { const p = this.readPath(a1); ret(this.lookup(p) !== undefined || this.isDir(p) ? 0n : -2n); break; }   // access
      case 269: { const p = this.atPath(a1, a2); ret(this.lookup(p) !== undefined || this.isDir(p) ? 0n : -2n); break; }  // faccessat
      case 63: {                                              // uname
        const put = (o, s) => { const b = new TextEncoder().encode(s + '\0');
          this.ram.set(b, Number(a1 - this.base) + o); };
        this.jsnap(a1, 390);                                  // the zero-fill covers the whole struct
        this.ram.fill(0, Number(a1 - this.base), Number(a1 - this.base) + 390);
        put(0, 'Linux'); put(65, 'oxwasm'); put(130, '6.1.0'); put(195, '#1 oxwasm');
        put(260, 'x86_64'); ret(0n); break; }
      case 89: {                                              // readlink(path, buf, sz)
        const p = this.readPath(a1);
        if (p === '/proc/self/exe') { const b = new TextEncoder().encode(this.argv0 || '/prog');
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
          if (cur !== Number(a3 & 0xFFFFFFFFn)) { ret(-11n); break; }   // EAGAIN
          let dl = null;
          const tp = cpu.regs[10];                            // struct timespec*
          if (tp) {
            const o = this.RAMOFF + Number(tp - this.base);
            const v = new DataView(this.wmem.buffer);
            let ms = Number(v.getBigUint64(o, true)) * 1000 + Number(v.getBigUint64(o + 8, true)) / 1e6;
            if (op === 9) {                                   // WAIT_BITSET: absolute time
              if (ms > 1e11) ms = ms - Date.now() + this.nowMs();   // realtime epoch -> engine clock
              dl = ms;
            } else dl = this.nowMs() + ms;                    // WAIT: relative
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
      case 13: case 14: ret(0n); break;                       // rt_sigaction / rt_sigprocmask
      case 131: ret(0n); break;                               // sigaltstack
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
        if (cmd === 3) { ret(BigInt(2 | (h?.sock?.nonblock ? 0x800 : 0))); break; }   // F_GETFL: O_RDWR
        if (cmd === 4) { if (h?.sock) h.sock.nonblock = !!(Number(a3) & 0x800); if (h?.pipe) h.nonblock = !!(Number(a3) & 0x800); ret(0n); break; }  // F_SETFL
        if (cmd === 1) { ret(BigInt(this.cloexec.has(Number(a1)) ? 1 : 0)); break; }   // F_GETFD
        if (cmd === 2) { if (Number(a3) & 1) this.cloexec.add(Number(a1)); else this.cloexec.delete(Number(a1)); ret(0n); break; }  // F_SETFD
        if (cmd === 0 || cmd === 1030) {                      // F_DUPFD / F_DUPFD_CLOEXEC
          if (!h) { ret(-9n); break; }
          let fd = Number(a3); while (this.fds.has(fd)) fd++;
          this.fds.set(fd, h);
          if (cmd === 1030) this.cloexec.add(fd); else this.cloexec.delete(fd);
          ret(BigInt(fd)); break;
        }
        ret(0n); break; }                                     // F_GETFD/F_SETFD/...
      case 28: ret(0n); break;                                // madvise
      case 110: ret(0n); break;                               // getppid
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
        if (this.files[p] === undefined && !this.isDir(p)) { ret(-2n); break; }
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
        const link = this.norm(this.readPath(nr === 88 ? a2 : a3));
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
        if (this.files[p] === undefined) { ret(this.isDir(p) ? -21n : -2n); break; }  // EISDIR
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
      case 25: ret(-38n); break;                              // mremap -> ENOSYS

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
        writeChunk(Number(a1), a2, Number(a3)); ret(a3); break; }
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
        this.block(this._deadline === Infinity ? null : this._deadline); break; }
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
        this.block(this._deadline === Infinity ? null : this._deadline); break; }
      default:
        ret(-38n);                                           // ENOSYS
        (this.unknown ||= new Set()).add(nr);
    }
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
      for (const tb of tables) for (const [, h] of tb) if (h?.pipe === buf && h.mode === 'w') return true;
      for (const c of e.children ?? []) if (c.eng && c.exited === null && c.eng.exitCode === null && scan(c.eng)) return true;
      return false;
    };
    return scan(root);
  }
  _pipeEofSweep(handles) {
    for (const h of handles) if (h?.pipe && h.mode === 'w' && !h.pipe.weof && !this._pipeWriterAlive(h.pipe)) h.pipe.weof = true;
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
    // while children live, never park indefinitely: the host must keep
    // pumping so the children run (their progress is what unblocks us)
    if (this.blocked && this.blocked.deadline == null && this.children?.some(c => c.exited === null))
      this.blocked.deadline = this.nowMs() + 2;
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
        if ((steps & 0x3FFFF) === 0 && this.threads.length > 1) { this.rotate(); branched = true; }   // preemption quantum
        const key = this.cpu.rip;
        let f = branched ? this.aotFns.get(key) : undefined;
        if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
        if (f) { if (this.ripTrace !== undefined) { this.ripTrace[this.ripTraceI++ & 1023] = -key; }   // negative = AOT entry
                 this.cpu.rip = this.dispatchMaybeShadow(f);
                 if (this.ripTrace !== undefined) { this.ripTrace[this.ripTraceI++ & 1023] = -this.cpu.rip; }  // AOT exit
                 branched = true;
                 if (this.blocked) { if (this.park()) continue; break; }
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
