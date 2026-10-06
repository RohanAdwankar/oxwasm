// oxwasm M3 — run an UNMODIFIED Linux x86-64 static ELF binary.
//
// ELF64 loader + System V stack + a small Linux syscall layer over the
// tier-0 interpreter, with the tiering JIT compiling hot loops. The binary
// is normal compiler output (musl/glibc static); nothing about it is
// adapted for this engine.
import { CPU, Memory } from './interp.mjs';
import { compileLoop } from './jit2.mjs';
import { compileVectorLoop } from './jitsimd.mjs';
import { compileUnitWat, pltStubWat, FTMAP, FTMAP_MAX, FTENTRY, FTDLIMIT, FTFUEL, FTLOOP, FTNEST, LOOPYIELD_N,
         FTHASH, FTHBITS, FTHMASK, FTHBYTES, CWLO_SLOT, CWLEN_SLOT, CWMAP, CWMAP_PAGES } from './aot_wat.mjs';
// OXWASM_DISPSTAT=1: count the rips that HAD a compiled unit and were not
// dispatched anyway. Off by default - it costs a map lookup per instruction.
// the environment, where there is one: the engine also runs in a browser tab, which has no `process`
const ENV = typeof process !== 'undefined' && process.env ? process.env : {};
if (ENV.OXWASM_IHIST) globalThis.__ihist = new Map();   // sampled histogram of interpreted rips (every 64th step), dumped at exit
const DISPSTAT = typeof process !== 'undefined' && ENV.OXWASM_DISPSTAT === '1';
// OXWASM_STOREGUARD=1 (measurement): compiled code checks every store against
// a window of translated generated code and calls back on a hit. The engine
// half only arms when the emitter half is on - a watch on the interpreter's
// writes is not free, and neither is the window bookkeeping.
const STOREGUARD = typeof process !== 'undefined' && ENV.OXWASM_STOREGUARD === '1';
// Rewrites of one page before it is declared volatile and left interpreted.
const CW_VOLATILE = Number(ENV.OXWASM_CW_VOLATILE || 8);
const BREAKS = typeof process !== 'undefined' && ENV.OXWASM_BREAK ? new Set(ENV.OXWASM_BREAK.split(',').map((h) => BigInt('0x' + h))) : null;   // interpreter breakpoints: print the thread, registers and [rdi+0x340..] (diagnosis)
const ROTATE_MS = Number(ENV.OXWASM_ROTATE_MS || 10);   // wall-clock quantum: a thread that has run this long yields to a runnable sibling (see _rotateDue)
// OXWASM_ANON_HEAT: calls required before GENERATED code is translated, as
// against a program's own text. A JIT's output has a different life
// expectancy from a binary's .text - it may be replaced before it is worth
// translating - and the engine has always tiered both on the same heat.
// 0 (the default) means "same as everything else", so this changes nothing
// unless it is asked for.
const ANON_HEAT = Number(ENV.OXWASM_ANON_HEAT || 0);
import { decode } from './decode.mjs';

const PAGE = 4096n;
const align = (v, a) => (v + a - 1n) & ~(a - 1n);
const EXIT = Symbol('guest-exit');           // unwinds live wasm frames on exit()
const SHADOW_ABORT = { shadowAbort: true };
const SHADOW_DISP = ENV.OXWASM_SHADOW_DISP ? ENV.OXWASM_SHADOW_DISP.split('-').map(Number) : null;
const AOTSKIP = ENV.OXWASM_AOTSKIP ? ENV.OXWASM_AOTSKIP.split('-').map(Number) : null;
const DISPRING = !!ENV.OXWASM_DISPRING;
const AT_SHADOW = !!ENV.OXWASM_AT_SHADOW;
// OXWASM_DETRANDOM=<seed>: every byte of randomness the guest sees (AT_RANDOM, getrandom, /dev/urandom)
// comes from a seeded generator, so a run can be replayed exactly (diagnosis; never for real use).
let _detRnd = ENV.OXWASM_DETRANDOM ? (BigInt(ENV.OXWASM_DETRANDOM) | 0x9E3779B97F4A7C15n) & 0xFFFFFFFFFFFFFFFFn : null;
function fillRandom(u8) {
  if (_detRnd === null) return crypto.getRandomValues(u8);
  let x = _detRnd;
  for (let i = 0; i < u8.length; i++) { x ^= (x << 13n) & 0xFFFFFFFFFFFFFFFFn; x ^= x >> 7n; x ^= (x << 17n) & 0xFFFFFFFFFFFFFFFFn; u8[i] = Number(x & 0xFFn); }
  _detRnd = x; return u8;
}
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
const NORESTART = new Set([23, 270, 7, 271, 232, 281, 35, 230, 34, 130]);   // EINTR after a handler even under SA_RESTART (signal(7))
const SYNTH_DIRS = new Set(['/proc', '/proc/self', '/proc/self/fd', '/proc/self/task', '/proc/sys', '/proc/sys/kernel',
                            '/proc/sys/kernel/random', '/proc/sys/vm', '/proc/sys/fs', '/dev', '/dev/pts', '/dev/fd',
                            // the FHS baseline every Linux has: O_CREAT needs its parent to exist, and a guest
                            // whose provisioning put nothing under /tmp or /dev/shm still has them
                            '/tmp', '/var', '/var/tmp', '/dev/shm', '/run', '/root', '/home', '/etc', '/usr', '/usr/lib',
                            '/usr/bin', '/usr/share', '/bin', '/lib', '/opt', '/mnt', '/srv']);
class DeoptUnwind { constructor(rip) { this.rip = rip; } }
class PathErr { constructor(errno) { this.errno = errno; } }   // ENAMETOOLONG / ELOOP from readPath / resolve, answered by the syscall dispatcher
// A blocking syscall (poll/select/read with nothing ready, nanosleep) suspends
// the guest the same way a deopt escapes compiled code: every register is
// already in the regfile / cpu and the syscall insn's rip is recorded, so ALL
// wasm frames are destroyed and the engine returns to its caller with
// `engine.blocked` set. Resuming just re-enters run(): the syscall RE-EXECUTES
// (rax still holds the syscall number) and either completes or blocks again.
class BlockUnwind { constructor(rip) { this.rip = rip; } }

const CLOSURE_ALL = typeof process !== 'undefined' && ENV.OXWASM_CLOSURE_ALL === '1';
const CLOSURE_MIN = Number((typeof process !== 'undefined' && ENV.OXWASM_CLOSURE_MIN) || 3);   // observed calls a callee needs to join a closure; 3 priced against m4 steady state (not worse) and clang -S (50 s -> 45 s)
// Size gate for tier-up by call count: a function of n instructions needs
// max(threshold, n >> SIZEGATE_SHIFT) observed calls, capped at 256, before it
// is emitted (2,000 insns -> 31 calls, 13,000 -> 203). OXWASM_SIZEGATE=0 off.
const SIZEGATE = !(typeof process !== 'undefined' && ENV.OXWASM_SIZEGATE === '0');
const SIZEGATE_SHIFT = Number((typeof process !== 'undefined' && ENV.OXWASM_SIZEGATE_SHIFT) || 6);
const EXEC_ANON = typeof process !== 'undefined' && ENV.OXWASM_EXEC_ANON === '1';   // anonymous PROT_EXEC mmaps count as code for profiling/translation (JIT code caches)
const UNPRUNE = new Set(((typeof process !== 'undefined' && ENV.OXWASM_UNPRUNE) || '').split(',').filter(Boolean).map(h => BigInt('0x' + h).toString()));
// Starting size of the shared funcref table, doubled up to FTMAP_MAX on
// demand. Every instance pays V8 a dispatch table the size of the imported
// one, so this is memory per unit, not a one-off. OXWASM_FTAB_INIT=20000
// restores creating it at the ceiling.
const FTAB_INIT = Number((typeof process !== 'undefined' && ENV.OXWASM_FTAB_INIT) || 1024);

export class LinuxEngine {
  // threshold: legacy tier-1.5 loop JIT trigger. Defaults OFF — it miscompiles
  // a vfprintf loop in glibc (wrong digits past the 22nd output byte) and the
  // tier-2 whole-frame AOT subsumes it. Pass a finite value to re-enable for
  // the tier's own test suites.
  constructor(elfBytes, { argv = ['prog'], env = [], memMB = 256, threshold = Infinity, files = {},
                          assembleWat = null, aotCallThreshold = 4, aotLoopThreshold = 12,
                          xserver = null, mtimes = {}, tty = false, ttyRows = 24, ttyCols = 80,
                          stdin = null, net = null, diskMB = 0, maxProcs = 64 } = {}) {
    this._diskQuota = diskMB * 1048576;       // 0 = unlimited
    if (ENV.OXWASM_RIPLOG) { this._ripLog = new Set(ENV.OXWASM_RIPLOG.split(',').map((h) => BigInt('0x' + h))); this._ripLogRing = []; if (ENV.OXWASM_AOTSKIP_AT) { const [a, b] = ENV.OXWASM_AOTSKIP_AT.split(':'); this._skipAt = [BigInt('0x' + a), b]; } }   // regs at these rips (interpreted), last 48, dumped by _onBreak
    if (ENV.OXWASM_RIPTRACE) { this.ripTrace = new Array(65536).fill(0n); this.ripTraceI = 0; const [lo, hi] = (ENV.OXWASM_RIPTRACE_RANGE || '0-ffffffffffff').split('-'); this._rtLo = BigInt('0x' + lo); this._rtHi = BigInt('0x' + hi); }   // recent rips: AOT entry/exit (negative) and interpreted steps; dumped by _onBreak
    this.maxProcs = maxProcs;                 // live processes per sandbox (root engine's value counts; see _liveProcs)
    this._netProvider = net;                  // host-side network bridge (see sdk/net.mjs); null = no network
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
    this._zeroAbove = this.mmapNext;
    this.stackTop = lo + total - 4096n;

    // one contiguous guest region backed by wasm memory -> interpreter and
    // JIT share it with zero copying
    this.RAMOFF = 1 << 20;
    const pages = Math.max(256, Math.ceil((this.RAMOFF + Number(total)) / 65536) + 16);
    this.wmem = new WebAssembly.Memory({ initial: pages });
    // global dispatch table: every registered compiled function gets a slot
    // here plus a sorted (addr -> slot) entry in wasm memory at FTMAP, so
    // units chain indirect calls / cross-unit calls wasm-to-wasm (see $ftr)
    // Grown geometrically, not per registration: every unit imports this
    // table, so a grow has to fix up each importing instance's cached table
    // base — one grow per doubling keeps that O(instances) cost logarithmic
    // while a per-registration grow made it linear (12% of a warm GIMP menu
    // cycle). Creating it at the ceiling instead is worse in the other
    // direction: V8 gives every instance its own dispatch table sized to the
    // imported one, so 20,000 entries is 492 kB per unit whether the run maps
    // 200 functions or 19,000 (see diff/instbench.mjs).
    this.ftab = new WebAssembly.Table({ element: 'anyfunc',
                                        initial: Math.min(FTAB_INIT, FTMAP_MAX), maximum: FTMAP_MAX });
    this._ftCount = 0; this._ftSeen = new Set(); this._entries = null;
    this.regview = new BigInt64Array(this.wmem.buffer, 0, 16);
    this.fsview = new BigInt64Array(this.wmem.buffer, 128, 1);   // fs base for AOT TLS accesses
    this.mxview = new Uint32Array(this.wmem.buffer, 144, 1);     // MXCSR, so units can run stmxcsr/ldmxcsr instead of escaping
    this.dfview = new Uint32Array(this.wmem.buffer, 152, 1);     // direction flag, so std/cld in a unit reach the interpreter
    this.stickyview = new Uint32Array(this.wmem.buffer, 160, 1); // the AC/ID bits popf stored, so a unit can build a full RFLAGS for pushf
    this.fcwview = new Uint32Array(this.wmem.buffer, 164, 1);    // x87 control word, so fnstcw/fldcw in a unit need not escape
    this.flagview = new BigInt64Array(this.wmem.buffer, 136, 1);  // EFLAGS a unit hands over at an escape (bit 63 = valid)
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
    if (ENV.OXWASM_DEOPTLOG) this.deoptLog = new Map();   // rip -> count of deopts from compiled code, printed with the exit stats
    if (ENV.OXWASM_STATS) {            // per-syscall wall time, printed with the exit stats
      const orig = this.syscall.bind(this);
      this.syscall = (cpu) => { const nr = Number(cpu.regs[0]), t0 = performance.now(); try { return orig(cpu); } finally { const m = (this.stats.sysMs ??= {}); m[nr] = (m[nr] || 0) + performance.now() - t0; } };
    }
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
      this.cpu.onCall = (t) => {
        const ce = (this._callEntries ??= new Set());
        if (!ce.has(t)) { ce.add(t); const ix = this._ftIdxOf?.get(t); if (ix !== undefined) new DataView(this.wmem.buffer).setUint8(FTENTRY + ix, 1); }   // called after it was mapped: flag it now
        this.profileTarget(t);
      };   // _callEntries: real function entries (a longjmp landing is never called)
      // a PLT stub reaches the real function via `jmp *GOT` — profile the
      // indirect-jump landing so tail-called library functions (memcpy,
      // strlen, ...) tier up like directly-called ones.
      this.cpu.onJmp = (t) => { if (this.inExec(t)) this.profileTarget(t); };
    }
  }

  profileTarget(t) {
    const k = t;
    if (this.aotFns.has(k)) return;
    const n = (this.aotCalls.get(k) || 0) + 1;
    this.aotCalls.set(k, n);
    // Keep counting a function whose translation was REFUSED. It is never
    // retried, so this costs one map write per call and buys the only signal
    // there is for a failure mode that is otherwise invisible: the answer
    // stays correct and only the speed collapses, so no output comparison can
    // see it. grep's matcher refused to translate after five calls and then
    // ran 47,875 times interpreted, at 741x native, while the sweep called
    // the case exact.
    if (this.aotFailed.has(k)) return;
    this._entryAdd(k);
    if (n === 1) (this._callTargets ??= new Set()).add(k.toString());   // the string view compileUnitWat takes; rebuilt per tier-up it was 5 s of clang -S
    if (n >= (ANON_HEAT ? this._heatFor(t) : this.aotCallThreshold) && n >= (this._sizeDefer?.get(k) ?? 0)) { this._gateCalls = true; try { this.tierUpAot(t); } finally { this._gateCalls = false; } }
  }

  // Calls needed before this address is translated. Generated code can be
  // asked for more (see ANON_HEAT); everything else uses the one threshold.
  // Cached per page - this runs on every profiled call.
  _heatFor(t) {
    if (!ANON_HEAT || !(this.execAnon ?? EXEC_ANON)) return this.aotCallThreshold;
    const page = t & ~4095n;
    let g = (this._genCache ??= new Map()).get(page);
    if (g === undefined) {
      const stat = this.execRangesStatic ?? [];
      g = this.execRanges.some(([x, y]) => t >= x && t < y && !stat.some(([p, q]) => p === x && q === y));
      this._genCache.set(page, g);
    }
    return g ? ANON_HEAT : this.aotCallThreshold;
  }

  // Why a translation was refused, kept so the diagnostic is self-sufficient:
  // grep's `unmodeled flag producer imul3` only existed because I attached a
  // hook by hand, and the reason is what turns "some function is slow" into a
  // one-instruction fix.
  noteAotFail(entry, why) {
    (this._aotWhy ??= new Map()).set(entry, why);
    if (this.onAotFail) this.onAotFail(entry, why);
  }

  // Functions whose translation was refused and which then ran anyway, worst
  // first. `min` filters the ones nobody would notice: a stub called twice is
  // not a performance defect, a matcher called 47,875 times is.
  hotFailures(min = 1000) {
    const out = [];
    for (const a of this.aotFailed) { const n = this.aotCalls.get(a) || 0; if (n >= min) out.push({ addr: a, calls: n, why: this._aotWhy?.get(a) || 'no reason recorded' }); }
    return out.sort((x, y) => y.calls - x.calls);
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

  // A unit from the disk store, under the key of the mappings as they are NOW (the same key a later run computes at
  // the same point, which is also the key put() uses for a unit requested here).
  _diskUnit(kk) {
    if (!this.unitStore) return undefined;
    const ex = this._unitExeId();
    return ex ? this.unitStore.get(ex, kk.toString(16)) : undefined;
  }
  // A finished unit: hand it to the manifest hook and, when a disk store is attached, persist it - but only
  // if every function in it lies in code the store key covers: the program's static image (executable and
  // dynamic linker) or a file mapping that was loaded when the key was computed and is still mapped.
  // Anonymous and JIT code can differ next run, so a unit that touches it is never stored.
  _unitBytesDone(k, bytes, unit) {
    if (this.onUnitBytes) this.onUnitBytes(k, bytes);
    if (!this.unitStore) return;
    try {
      const ex = unit._ex; if (!ex) return;
      const rs = unit._rs;
      const covered = (a) => rs.some((r) => a >= r.lo && a < r.hi && (r.map === null || (this.maps ?? []).includes(r.map)));
      if (!unit.funcs.every(covered)) return;
      this.unitStore.put(ex, k.toString(16), bytes);
    } catch {}
  }
  // The store key: the static executable ranges as loaded, every file mapping's pristine bytes (what the
  // file says, not what the process has since written to it) with where it sits, and the guest base the
  // units were translated against (their address arithmetic is baked into the wasm). It is recomputed
  // when the set of mappings changes - the first hot code is the dynamic linker, before any library is
  // mapped - and the per-file and static digests are memoised so that is cheap.
  _unitExeId() {
    const nm = (this.maps ?? []).length;
    if (this._exeIdV !== undefined && this._exeMapsN === nm) return this._exeIdV;
    let id = null;
    try {
      const st = this.unitStore, ranges = [], parts = [];
      this._staticDigest ??= st.digest((this.execRangesStatic ?? []).map(([lo, hi]) => this.ram.subarray(Number(lo - this.base), Number(hi - this.base))));
      parts.push('static:' + this._staticDigest);
      for (const [lo, hi] of (this.execRangesStatic ?? [])) ranges.push({ lo, hi, map: null });
      const fileDigest = (this._fileDigests ??= new WeakMap());
      for (const m of (this.maps ?? []).slice().sort((x, y) => (x.at < y.at ? -1 : 1))) {
        if (!m.h?.bytes) continue;
        let dg = fileDigest.get(m.h.bytes); if (dg === undefined) { dg = st.digest([m.h.bytes]); fileDigest.set(m.h.bytes, dg); }
        const fo = Number(m.fileOff ?? 0);
        parts.push(`${m.at}:${m.len}:${m.path}:${fo}:${dg};`);
        ranges.push({ lo: m.at, hi: m.at + BigInt(m.len), map: m });
      }
      if (ranges.length) { id = st.exeId(parts, this.base.toString(16) + ':' + this.RAMOFF); this._exeRanges = ranges; }
    } catch { id = null; }
    this._exeMapsN = nm;
    return (this._exeIdV = id);
  }

  // Does the code at `a` begin like a function: [endbr64] push %rbp; mov %rsp,%rbp. A function reached
  // only by jmp (a sibling call) is never `call`ed, but a longjmp landing - the case that must not chain -
  // sits mid-function and never starts with a frame-setup prologue.
  _looksLikeFnEntry(a) {
    try {
      let at = a;
      if (this.mem.read(at, 4n) === 0xfa1e0ff3n) at += 4n;   // endbr64
      return (this.mem.read(at, 4n) === 0xe5894855n);        // 55 48 89 e5
    } catch { return false; }
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
    if (ENV.OXWASM_DISPLOG && this._ctor?.argv?.[0]?.includes('opencode')) { const [lo, hi] = ENV.OXWASM_DISPLOG.split('-').map(Number); if ((this.stats.disp || 0) >= lo && (this.stats.disp || 0) <= hi) console.error(`[reg disp=${this.stats.disp}] ${a.toString(16)}`); }
    this.aotFns.set(a, f); this._entryAdd(a);
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
    if (!f || globalThis.__noFtab || this._aotOff || this._ftSeen.has(a)) return;
    if (this._ftCount >= FTMAP_MAX) { this._ftFull = (this._ftFull || 0) + 1; return; }
    this._ftSeen.add(a); this._entryAdd(a);
    const idx = this._ftCount++;
    if (idx >= this.ftab.length) this.ftab.grow(Math.min(this.ftab.length, FTMAP_MAX - this.ftab.length));
    this.ftab.set(idx, f);
    const dv = new DataView(this.wmem.buffer);
    dv.setUint8(FTENTRY + idx, (ENV.OXWASM_FTENTRY && (this._callEntries?.has(a) || this._looksLikeFnEntry(a))) ? 1 : 0);   // a real function entry: tail jumps may chain to it from a nested unit
    (this._ftIdxOf ??= new Map()).set(a, idx);
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
    this._ftCount = 0; this._ftSeen = new Set(); this._entries = null;
    for (const [a, f] of this.aotFns)
      if (f && !f.jsStub) this.registerAotFn(a, f);
  }

  // Register a unit's exports once its instance exists. Shared by both
  // off-thread paths (async assemble, async compile): a placeholder null is
  // already in aotFns for the entry, so `get` — not `has` — is what decides
  // whether an address still needs registering.
  // Finish a callout's guest frame by interpreting until the guest returns to
  // retAddr with rsp back at rspExit. If the guest stack rises ABOVE rspExit
  // first, the guest has left this frame without returning - a longjmp past
  // it (ld.so signals a failed symbol lookup that way, on every dlsym miss;
  // the nested interpreter used to keep going inside the frame, one level
  // deeper per miss, until the JS stack overflowed or a stale frame faulted).
  // Unwind the wasm frames to the top loop, which resumes at the landing.
  _finishFrame(retAddr, rspExit) {
    this.interpUntil(() => (this.cpu.rip === retAddr && this.cpu.regs[4] === rspExit) || this.cpu.regs[4] > rspExit);
    if (DISPRING) this._dr('finished', retAddr, this.cpu.rip, this.cpu.regs[4]);
    this.syncOut();
    if (globalThis.__frameTrace && this.cpu.regs[4] <= rspExit) console.error(`<finish retAddr=${retAddr.toString(16)} rsp=${this.cpu.regs[4].toString(16)} rspExit=${rspExit.toString(16)}>`);
    if (this.cpu.regs[4] > rspExit) { this.stats.frameGone = (this.stats.frameGone || 0) + 1; if (globalThis.__frameTrace) console.error(`<framegone callout rip=${this.cpu.rip.toString(16)} rsp=${this.cpu.regs[4].toString(16)} rspExit=${rspExit.toString(16)}>`); throw new DeoptUnwind(this.cpu.rip); }
  }
  // Code in [lo, hi) is gone (munmap, mremap away): drop every artifact keyed
  // in the range - compiled units, failures, the loop tier, both profiles, the
  // closure-pruning and known-entry sets (a fresh mapping here must be able
  // to join closures again) - cancel in-flight units that hold any of it, and
  // rebuild the dispatch hash if anything compiled was dropped.
  // Pages the guest made executable at runtime (see Memory.jitPage).
  _jitMark(lo, hi, on) {
    const m = this.mem.jit ??= (this.mem.jitBase = this.base, new Uint8Array(Math.ceil(this.ram.length / 4096)));
    let a = Number((lo - this.base) >> 12n); const b = Number((hi - this.base + 4095n) >> 12n);
    for (a = Math.max(a, 0); a < b && a < m.length; a++) m[a] = on;
  }
  _invalidateCode(lo, hi) {
    const inR = (k) => k >= lo && k < hi;
    let hit = false;
    for (const k of this.aotFns.keys()) if (inR(k)) { this.aotFns.delete(k); hit = true; }
    for (const k of this.aotFailed) if (inR(k)) this.aotFailed.delete(k);
    if (this.compiled) for (const k of this.compiled.keys()) if (inR(k)) this.compiled.delete(k);
    if (this.profile) for (const k of this.profile.keys()) if (inR(k)) this.profile.delete(k);
    for (const k of this.aotCalls.keys()) if (inR(k)) { this.aotCalls.delete(k); this._callTargets?.delete(k.toString()); }
    for (const k of this._ftSeen) if (inR(k)) { this._ftSeen.delete(k); this._entries?.delete(k.toString()); }
    if (this._failMemo) for (const k of this._failMemo.keys()) if (inR(BigInt(k))) this._failMemo.delete(k);
    if (this._sizeDefer) for (const k of this._sizeDefer.keys()) if (inR(k)) this._sizeDefer.delete(k);
    if (this._sizeMemo) for (const k of this._sizeMemo.keys()) if (inR(BigInt(k))) this._sizeMemo.delete(k);
    if (this.execAnon ?? EXEC_ANON) { const n = this.execRanges.length; this.execRanges = this.execRanges.filter(([a, b]) => !(a >= lo && b <= hi)); if (this.execRanges.length !== n) { this._ieCache = undefined; this._genCache = undefined; this._updateCodeWindow(); } }
    if (this._tinyMemo) for (const k of this._tinyMemo.keys()) if (inR(BigInt(k))) this._tinyMemo.delete(k);
    if (this._inflight) for (const u of this._inflight) if (u.funcs.some(inR)) {
      u.cancelled = true;
      if (this._pendingFns) for (const a of u.funcs) this._pendingFns.delete(a.toString());
    }
    if (hit) this.rebuildFtmap();
  }
  finishAotUnit(unit, instance) {
    this._inflight?.delete(unit);
    // An in-flight unit (deferred assembly, or the browser's off-thread
    // compile) whose code was munmapped meanwhile: registering it would put
    // the OLD code's translation at the address the guest has since reused.
    // The recycle fixture caught this once in an 182-case sweep under
    // deferred assembly: A's answer from a page that now held B.
    if (unit.cancelled) return;
    for (const a of unit.funcs)
      if (!this.aotFns.get(a)) this.registerAotFn(a, instance.exports['f_' + a.toString(16)]);
    if (instance.exports.drive) this.aotDrive = instance.exports.drive;
    this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
  }

  /** True if the code at `a` is a vfork stub: `mov eax, 58; syscall` within its first bytes (glibc's vfork). */
  _isVforkStub(a) {
    const memo = (this._vforkMemo ??= new Map());
    let r = memo.get(a);
    if (r !== undefined) return r;
    r = false;
    try {
      const b = [];
      for (let i = 0n; i < 96n; i++) b.push(Number(this.mem.read(a + i, 1n)));
      // `mov eax, N ; ... ; syscall` with N = clone (56), fork (57) or vfork (58), near the
      // start of the function: libc's vfork stub, and fork() (its _Fork/arch_fork inlines
      // clone(SIGCHLD|CLONE_CHILD_SETTID|CLONE_CHILD_CLEARTID) a few instructions in).
      for (let i = 0; i + 5 <= b.length; i++) {
        if (b[i] !== 0xb8 || b[i + 1] < 0x38 || b[i + 1] > 0x3a || b[i + 2] || b[i + 3] || b[i + 4]) continue;
        for (let j = i + 5; j + 2 <= Math.min(b.length, i + 45); j++) if (b[j] === 0x0f && b[j + 1] === 0x05) { r = true; break; }
        if (r) break;
      }
    } catch { /* unmapped: not a stub */ }
    memo.set(a, r);
    return r;
  }

  tierUpAot(entry) {
    const k = entry;
    if (this.pumpAsm) this.pumpAsm();                       // deferred units whose bytes are back register first
    if (this.aotFns.has(k) || this.aotFailed.has(k)) return;
    // Entry-keyed precompiled units (browser manifest): registering one costs
    // no translation at all — the wasm bytes are instantiated off-thread and
    // every exported function registers by its address-bearing export name.
    // Without this, a "cache" keyed by the generated WAT still pays the whole
    // closure translation on the main thread just to compute the lookup key —
    // measured at 30-second pump slices on GIMP's first menu open.
    if (this.unitStore && !this.unitBytes) this.unitBytes = (kk) => this._diskUnit(kk);
    if (this.unitBytes) {
      const bytes = this.unitBytes(k);
      if (bytes) {
        this.stats.unitHits = (this.stats.unitHits || 0) + 1;
        // A synchronous host (node: breadth, runbin, the benches) never
        // returns to the event loop while the guest runs, so an async
        // instantiate's promise stays pending for the whole job: the child
        // never received its cached units (interpreted instead), and the
        // reaction closure pinned the engine - a cargo build that spawns
        // rustc three times kept every engine and its 2 GB memory alive until
        // exit (sweep chunks were OOM-killed at 13.7 GB). Instantiate in
        // line unless the host wants compilation off the main thread.
        const registerAll = (instance) => {
          for (const name of Object.keys(instance.exports))
            if (name.startsWith('f_')) {
              const a = BigInt('0x' + name.slice(2));
              if (!this.aotFns.get(a)) this.registerAotFn(a, instance.exports[name]);
            }
          if (instance.exports.drive) this.aotDrive = instance.exports.drive;
          this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
        };
        if (!this.asyncCompile && typeof process !== 'undefined') {
          try { registerAll(new WebAssembly.Instance(new WebAssembly.Module(bytes), this.aotImports())); }
          catch (e) { this.aotFailed.add(k); this.noteAotFail(entry, e.message); }
          return;
        }
        this.aotFns.set(k, null); this._entryAdd(k);   // placeholder: profiling stops re-triggering
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
                          this.noteAotFail(entry, e.message); });
        return;
      }
      if (this.cacheOnly) { this.aotFailed.add(k); this.noteAotFail(entry, 'cacheOnly: no assembler in this host'); return; }
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
      if (gotAddr === null) { this.aotFailed.add(k); this.noteAotFail(entry, 'trampoline with no static GOT address'); return; }
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
      this.aotFns.set(k, stub); this._entryAdd(k);
      return;
    }
    // the slice budget (checked above, before the trampoline probe) bounds the
    // synchronous translation cost per host slice: the host zeroes tierMs each
    // pump and deferred entries re-trigger on their next call
    const t0c = (this.tierMsMax !== undefined) ? performance.now() : 0;
    const un = (this._unitN = (this._unitN || 0) + 1);   // bisect aid: veto unit N -> stays interpreted
    if (typeof process !== 'undefined' && (ENV.OXWASM_FNVETO_FILE || ENV.OXWASM_FNALLOW_FILE || ENV.OXWASM_FNDUMP) && this._envVeto(entry)) { this.aotFailed.add(k); this.noteAotFail(entry, 'vetoed by env (bisect)'); return; }
    if (this.unitFilter && !this.unitFilter(un, entry)) { this.aotFailed.add(k); this.noteAotFail(entry, 'vetoed by unitFilter (bisect)'); return; }
    // vfork stays interpreted. Its child runs on the parent's stack and returns
    // through the parent's frame, which only works when the interpreter owns
    // both. Compiled, glibc's vfork left the parent corrupt: it worked for the
    // first seven or eight calls, then the function got hot, was translated, and
    // the next spawn faulted in the child right after execve. Found with a
    // long-lived CPython spawning shells; bisected to this one unit.
    if (this._isVforkStub(entry)) { this.aotFailed.add(k); this.noteAotFail(entry, 'vfork stays interpreted'); return; }
    // Generated code the guest keeps rewriting is left to the interpreter (see
    // _codeWrite). This also marks the region's pages as watched, so a write
    // to one is seen before the translation it invalidates is ever used.
    if (this._cwCover(entry)) { this.aotFailed.add(k); this.noteAotFail(entry, 'volatile code page'); return; }
    const _tc0 = performance.now();
    const _unitEx = this.unitStore ? this._unitExeId() : null, _unitRs = this._exeRanges;   // the key at REQUEST time: the lookup used it, so the store must
    try {
      const unit = compileUnitWat(this.mem, entry, { guestBase: this.base, ramBase: this.RAMOFF,
        // prune the closure at functions already in the dispatch map: calls
        // reach them via $ftr chaining, so re-including their bodies only
        // duplicates translation work and module bytes
        // OXWASM_UNPRUNE=hex,hex: keep these callees in every closure even
        // when already compiled (diagnosis: the upper bound of a re-tier that
        // un-prunes a hot caller's hot small callees so they can be inlined)
        // Profile gate: a callee the profile has never seen called stays out of
        // the closure too (tiny ones excepted, below). On rustc --version 733 of
        // 1259 translated functions were never entered after translation and
        // 250 more fewer than four times: the closure walk was translating the
        // cold branches of hot functions. A gated callee that turns out hot is
        // profiled at its callouts and tiers up as its own root; its call sites
        // then hit through $ftr. OXWASM_CLOSURE_ALL=1 restores the ungated walk.
        skip: (c) => ((this._ftSeen.has(BigInt(c)) || (this._pendingFns !== undefined && this._pendingFns.has(c))) && !UNPRUNE.has(c))
                  || (!CLOSURE_ALL && (this.aotCalls.get(BigInt(c)) || 0) < CLOSURE_MIN),
        // bisect aids: fnVeto never compiles these; fnAllow compiles only these (roots and closure members)
        veto: (c) => this._isVforkStub(BigInt(c)) || (this.fnVeto?.has(c) ?? false) || (this.fnAllow ? !this.fnAllow.has(c) : false) || this._envVeto(c),   // a vfork stub is never compiled, as a root or inside a closure
        tinyMemo: (this._tinyMemo ??= new Map()),
        failMemo: (this._failMemo ??= new Map()),
        sizeMemo: (this._sizeMemo ??= new Map()),          // sizes of callees the size gate refused (cleared per range by _invalidateCode)
        // size gate (see SIZEGATE): giant callees need the calls whatever rooted
        // the unit; a giant ROOT is gated only when the call profile asked for it
        sizeGate: SIZEGATE ? (c, n, isRoot) => {
          if (isRoot && !this._gateCalls) return 0;                   // a loop-head root has proven its heat on back edges
          const need = Math.min(256, Math.max(this.aotCallThreshold, n >> SIZEGATE_SHIFT));
          if (need <= this.aotCallThreshold) return 0;
          const have = this.aotCalls.get(BigInt(c)) || 0;
          if (have >= need) return 0;
          if (isRoot) (this._sizeDefer ??= new Map()).set(BigInt(c), need);
          return need;
        } : null,          // callees whose analysis failed once: poisoned without re-analysis (cleared per range by _invalidateCode)
        // the tiering call profile, so the inliner can pick targets by how
        // often they are actually called rather than by what fits a budget
        hot: this.aotCalls,
        // every function entry the engine knows of: the analyzer cuts a
        // call's fall-through at one (a noreturn callee's neighbour)
        entries: this._knownEntries(),
        // ... and the addresses actually seen called: what a tail jmp may target
        callTargets: (this._callTargets ??= new Set()),
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
        (this._inflight ??= new Set()).add(unit);
        this.assembleWatAsync(unit.wat)
          .then((bytes) => {
            this._unitBytesDone(k, bytes, unit);
            return WebAssembly.instantiate(bytes, this.aotImports());
          })
          .then(({ instance }) => this.finishAotUnit(unit, instance))
          .catch((e) => { this.aotFns.delete(k); this.aotFailed.add(k);
                          this.noteAotFail(entry, e.message); });
        return;
      }
      unit._ex = _unitEx; unit._rs = _unitRs;
      this.stats.compiles = (this.stats.compiles || 0) + 1; this.stats.compileMs = (this.stats.compileMs || 0) + (performance.now() - _tc0);
      // Deferred assembly (node): hand the text to the broker and keep
      // running; the unit registers from a later pumpAsm() when the bytes
      // are back. A clang profile had the host blocked a quarter of its run
      // in readSync on the broker's fifo, i.e. wat2wasm's own time serialised
      // with everything else. Same placeholder protocol as asyncCompile, and
      // the unit's functions count as seen for closure pruning meanwhile.
      if (this.assembleWatDeferred) {
        this.aotFns.set(k, null);
        for (const a of unit.funcs) (this._pendingFns ??= new Set()).add(a.toString());
        (this._inflight ??= new Set()).add(unit);
        if (globalThis.__asmTrace) console.error(`<asm submit ${k.toString(16)} funcs=${unit.funcs.length} t=${Math.round(performance.now())}>`);
        this.assembleWatDeferred(unit.wat, (bytes, err) => {
          if (globalThis.__asmTrace) console.error(`<asm back ${k.toString(16)} err=${!!err} cancelled=${!!unit.cancelled} t=${Math.round(performance.now())}>`);
          for (const a of unit.funcs) this._pendingFns.delete(a.toString());
          this._inflight.delete(unit);
          if (unit.cancelled) return;                    // its code was recycled while it assembled
          if (err) { this.aotFns.delete(k); this.aotFailed.add(k); this.noteAotFail(entry, err.message); return; }
          try {
            this._unitBytesDone(k, bytes, unit);
            const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), this.aotImports());
            this.aotFns.delete(k);                       // the placeholder; finishAotUnit registers the real export
            this.finishAotUnit(unit, inst);
            if (!this.aotFns.has(k)) throw new Error('entry missing from unit');
          } catch (e) { if (globalThis.__asmTrace) console.error(e.stack); this.aotFns.delete(k); this.aotFailed.add(k); this.noteAotFail(entry, e.message); }
        });
        return;
      }
      const bytes = this.assembleWat(unit.wat);
      this._unitBytesDone(k, bytes, unit);   // manifest capture: entry -> compiled wasm
      // asyncCompile (browser): hand the bytes to the engine's off-thread
      // compiler instead of blocking this slice — execution stays interpreted
      // until the instantiate resolves, then the unit's functions register.
      // aotFns holds null meanwhile so profiling doesn't re-trigger; every
      // dispatch site treats a null entry as not-compiled.
      if (this.asyncCompile) {
        this.aotFns.set(k, null);
        (this._inflight ??= new Set()).add(unit);
        WebAssembly.instantiate(bytes, this.aotImports())
          .then(({ instance }) => this.finishAotUnit(unit, instance))
          .catch((e) => { this.aotFns.delete(k); this.aotFailed.add(k);
                          this.noteAotFail(entry, e.message); });
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
    } catch (e) { if (e.deferred) { this.stats.sizeDeferred = (this.stats.sizeDeferred || 0) + 1; return; }   // size gate: not a failure, re-tiers at the count it named
      if (globalThis.__asmTrace) console.error(e.stack);
      this.aotFailed.add(k);
      this.noteAotFail(entry, e.message);
    } finally { if (t0c) this.tierMs += performance.now() - t0c; }
  }

  // GPRs at 0..127, fs base at 128, the 16 xmm registers at 256..511 (16B
  // each, low 64 then high 64) — the AOT reads/writes v128 there directly.
  syncOut() { this.syncOutGpr(); this.syncOutXmm(); }
  syncOutGpr() { for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
              this.fsview[0] = BigInt.asIntN(64, this.cpu.fsBase || 0n);
              this.mxview[0] = this.cpu.mxcsr ?? 0x1f80;
              this.dfview[0] = this.cpu.f.df ? 1 : 0;
              this.stickyview[0] = this.cpu.eflagsSticky || 0;
              this.fcwview[0] = this.cpu.fcw ?? 0x037F; }
  syncOutXmm() { const x = this.xmmview; const M = (1n << 64n) - 1n;
              for (let r = 0; r < 16; r++) { const v = this.cpu.xmm[r] || 0n;
                x[r*2] = BigInt.asIntN(64, v & M); x[r*2+1] = BigInt.asIntN(64, (v >> 64n) & M); } }
  syncIn()  { this._cleanSync = true;
              for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
              this.cpu.fsBase = BigInt.asUintN(64, this.fsview[0]);
              this.cpu.mxcsr = this.mxview[0];
              this.cpu.f.df = this.dfview[0] ? 1 : 0;
              this.cpu.fcw = this.fcwview[0];
              // flags a unit materialized at its escape (pushf, x87, cpuid, a
              // zero-count rep scan ...): without this the interpreter carried
              // on with whatever flags it last computed itself
              const fl = this.flagview[0];
              if (fl < 0n) { const f = this.cpu.f; f.cf = Number(fl & 1n); f.pf = Number((fl >> 2n) & 1n); f.af = Number((fl >> 4n) & 1n);
                f.zf = Number((fl >> 6n) & 1n); f.sf = Number((fl >> 7n) & 1n); f.of = Number((fl >> 11n) & 1n); this.flagview[0] = 0n; }
              this.syncInXmm(); }
  // The 16 xmm as two i64 each: 48 BigInt allocations per direction, the bulk of a sync. The syscall hop
  // from compiled code skips them (syncInGpr) and marks them stale; anything that reads or writes cpu.xmm
  // before the frame resumes (signal delivery, clone, sigreturn, a thread switch) syncs on demand.
  syncInXmm() { const x = this.xmmview; this._xmmStale = false;
              for (let r = 0; r < 16; r++) this.cpu.xmm[r] = BigInt.asUintN(64, x[r*2]) | (BigInt.asUintN(64, x[r*2+1]) << 64n); }
  syncInGpr() { this._cleanSync = true;
              for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
              this.cpu.fsBase = BigInt.asUintN(64, this.fsview[0]);
              this.cpu.mxcsr = this.mxview[0];
              this.cpu.f.df = this.dfview[0] ? 1 : 0;
              this.cpu.fcw = this.fcwview[0];
              const fl = this.flagview[0];
              if (fl < 0n) { const f = this.cpu.f; f.cf = Number(fl & 1n); f.pf = Number((fl >> 2n) & 1n); f.af = Number((fl >> 4n) & 1n);
                f.zf = Number((fl >> 6n) & 1n); f.sf = Number((fl >> 7n) & 1n); f.of = Number((fl >> 11n) & 1n); this.flagview[0] = 0n; }
              this._xmmStale = true; }
  xmmFresh() { if (this._xmmStale) this.syncInXmm(); }

  // Run one compiled function; a deopt inside it (or its wasm callees)
  // unwinds here and execution state is already in the regfile/guest stack.
  // Returns the rip to continue at.
  dispatchAot(f) {
    this.stats.disp = (this.stats.disp || 0) + 1;
    if (ENV.OXWASM_DISPLOG && this._ctor?.argv?.[0]?.includes('opencode')) { const [lo, hi] = ENV.OXWASM_DISPLOG.split('-').map(Number); if (this.stats.disp >= lo && this.stats.disp <= hi) console.error(`[disp ${this.stats.disp}] rip=${this.cpu.rip.toString(16)} rsp=${this.cpu.regs[4].toString(16)}`); }
    if (ENV.OXWASM_AOTSTOP && this.stats.disp === +ENV.OXWASM_AOTSTOP && this._ctor?.argv?.[0]?.includes('opencode')) { this._aotOff = true; if (ENV.OXWASM_AOTSTOP_HARD) { new DataView(this.wmem.buffer).setUint32(FTMAP, 0, true); new Uint8Array(this.wmem.buffer, FTHASH, FTHBYTES).fill(0); this._ftCount = 0; this._ftSeen = new Set(); this._entries = null; } console.error('[aotstop] at disp', this.stats.disp); }
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
    const entry = this.cpu.rip; this._lastEntry = entry;
    if (DISPRING) this._dr('disp', entry, this.cpu.regs[4]);
    try { let exit = f();
      if (DISPRING) this._dr('exit', entry, BigInt.asUintN(64, exit), this.aotDrive ? 1 : 0);
      if (fdv.getUint32(FTLOOP, true) === 0) this.stats.loopYieldTop = (this.stats.loopYieldTop || 0) + 1;   // the frame returned on a spent loop budget: a top-level yield
      // In-wasm driver: a top frame's guest ret exits its wasm function, but
      // the next rip is usually another compiled function — chain to it in
      // wasm ($drive resolves via the shared map and call_indirects, burning
      // the same fuel/depth budgets) instead of paying a JS round-trip with a
      // full regfile syncOut/syncIn per top-frame ret.
      if (this.aotDrive) exit = this.aotDrive(exit);
      if (DISPRING) this._dr('driven', entry, BigInt.asUintN(64, exit));
      this.syncIn(); this.stats.aotRuns++;
      if (this.onProgress && this.stats.aotRuns % 4e6 === 0) this.onProgress('aot');
      return BigInt.asUintN(64, exit); }
    catch (e) { if (DISPRING) this._dr(e instanceof DeoptUnwind ? 'unwind' : e instanceof BlockUnwind ? 'block' : 'throw', entry, e.rip ?? 0n); if (e instanceof DeoptUnwind) { this.syncIn(); if (globalThis.__frameTrace) console.error(`<dispatch-catch entry=${entry.toString(16)} erip=${e.rip.toString(16)} rsp=${this.cpu.regs[4].toString(16)} iu=${this._iuDepth | 0}>`);
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
            this.noteAotFail(entry, 'entry-deopt churn (blacklisted)');
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
    // OXWASM_SHADOW_EXIT: a unit need not come back to its return address - a
    // tail jump out (LLInt's native-call trampoline jumps into the throw path
    // when the native set an exception) exits it elsewhere, and the plain
    // shadow could only bail there, silently. Exit-matched mode records the
    // interpreter's state before every step (registers, flags, and the values
    // its writes stored), runs the compiled side, and compares at the first
    // recorded state whose rip and rsp are where the compiled frame actually
    // left. Costly (a snapshot per step); for hunting, not for sweeps.
    const exitMatch = !!ENV.OXWASM_SHADOW_EXIT, trace = exitMatch ? [] : null, CAP = exitMatch ? 200000 : 5e6;
    // Registers and xmm per step go into one preallocated buffer (48 words a step): the
    // per-step slices were most of the cost of a shadowed dispatch.
    const TB = exitMatch ? (this._shadowTB ??= new BigInt64Array((CAP + 2) * 48)) : null;
    const rec = () => {
      const jr = this.mem.jrnl, from = trace.length ? trace[trace.length - 1].jn : 0, wr = [];
      for (let i = from; i < jr.length; i++) { const [a, n, _o, snap] = jr[i]; wr.push(snap ? [a, BigInt(snap.length), this.mem.view(a, BigInt(snap.length)).slice()] : [a, n, this.mem.read(a, n)]); }
      const o = trace.length * 48;
      for (let r = 0; r < 16; r++) TB[o + r] = BigInt.asIntN(64, cpu.regs[r]);
      for (let r = 0; r < 16; r++) { const x = cpu.xmm[r] ?? 0n; TB[o + 16 + 2 * r] = BigInt.asIntN(64, x & 0xFFFFFFFFFFFFFFFFn); TB[o + 17 + 2 * r] = BigInt.asIntN(64, x >> 64n); }
      trace.push({ rip: cpu.rip, rsp: cpu.regs[4], f: { ...cpu.f }, jn: jr.length, wr });
    };
    try {
      while (!(cpu.rip === retAddr && cpu.regs[4] === rspExit)) {
        if (trace) rec();
        cpu.step();
        if (this.exitCode !== null || this.blocked) { ok = false; break; }
        if (++steps > CAP) { ok = exitMatch; break; }   // exit-matched: the trace so far may still hold the exit
      }
      if (trace && ok) rec();
    } catch (e) { ok = false; if (!(e === SHADOW_ABORT || e instanceof Error)) throw e; if (trace) (st.abortedAt ??= new Map()).set(`${entryRip.toString(16)}@${cpu.rip.toString(16)}${e === SHADOW_ABORT ? 'sys' : 'err'}`, (st.abortedAt?.get(`${entryRip.toString(16)}@${cpu.rip.toString(16)}${e === SHADOW_ABORT ? 'sys' : 'err'}`) ?? 0) + 1); }
    if (trace && !ok && !this.blocked && this.exitCode === null && steps <= CAP) { /* recorded above */ } else if (trace && !ok) (st.abortedAt ??= new Map()).set(`${entryRip.toString(16)}@${cpu.rip.toString(16)}${this.blocked ? 'blk' : 'cap'}`, (st.abortedAt?.get(`${entryRip.toString(16)}@${cpu.rip.toString(16)}${this.blocked ? 'blk' : 'cap'}`) ?? 0) + 1);
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
    // Exit-matched mode also watches for STRAY stores: bytes near the stack the compiled side
    // changed that the interpreter never wrote by the matched step. The journal only knows the
    // interpreter's stores, so a unit writing where it should not was invisible to the comparison.
    let snapLo = 0n, snap = null;
    if (trace !== null && ok) { try { snapLo = rsp0 - 16384n; snap = this.mem.view(snapLo, 16384n + 131072n).slice(); } catch { snap = null; } }
    const exitRip = this.dispatchAot(f);
    if (trace !== null) {
      if (!ok || (this._shadowDiverged ?? 0) >= 100) { st.aborted++; this._shadowBusy = false; return exitRip; }
      const ks = []; for (let i = 0; i < trace.length; i++) if (trace[i].rip === exitRip && trace[i].rsp === cpu.regs[4]) ks.push(i);
      if (!ks.length) { st.aborted++; (st.noexit ??= new Map()).set(entryRip, (st.noexit.get(entryRip) ?? 0) + 1); this._shadowBusy = false; return exitRip; }
      st.compared++;
      let best = null;
      for (const k of ks) {                                 // a loop revisits (rip, rsp): report only if no visit matches
        const T = trace[k], diffs = [], o = k * 48;
        for (let r = 0; r < 16; r++) { const v = BigInt.asUintN(64, TB[o + r]); if (cpu.regs[r] !== v) diffs.push(`r${r} aot=${cpu.regs[r].toString(16)} interp=${v.toString(16)}`); }
        for (let r = 0; r < 16; r++) { const v = BigInt.asUintN(64, TB[o + 16 + 2 * r]) | (BigInt.asUintN(64, TB[o + 17 + 2 * r]) << 64n); const a = cpu.xmm[r] ?? 0n; if (a !== v) diffs.push(`xmm${r} aot=${a.toString(16)} interp=${v.toString(16)}`); }
        // Flags are usually dead where a unit leaves (a call, a return, a jump the condition of
        // which was consumed): exit-matched mode ignores them unless OXWASM_SHADOW_FLAGS=1, so a
        // dozen dead-flag reports do not use up the divergence cap before a real one.
        if (ENV.OXWASM_SHADOW_FLAGS) for (const key of Object.keys(T.f)) if (cpu.f[key] !== T.f[key]) diffs.push(`flag ${key} aot=${cpu.f[key]} interp=${T.f[key]}`);
        else for (const key of Object.keys(T.f)) if (cpu.f[key] !== T.f[key]) (st.flagOnly ??= new Map()).set(`${entryRip.toString(16)}>${exitRip.toString(16)}`, (st.flagOnly?.get(`${entryRip.toString(16)}>${exitRip.toString(16)}`) ?? 0) + 1);
        // The interpreter's memory at step k, byte by byte: its writes replayed in order (a wide
        // store followed by narrower ones to the same bytes must compare as the narrower ones left it)
        const img = new Map();
        for (let i = 0; i <= k; i++) for (const [a, n, v] of trace[i].wr) {
          if (typeof v === 'bigint') { for (let b = 0n; b < n; b++) img.set(a + b, Number((v >> (8n * b)) & 0xFFn)); }
          else for (let b = 0; b < v.length; b++) img.set(a + BigInt(b), v[b]);
        }
        let shown = 0;
        for (const [a, v] of img) { const cur = Number(this.mem.read(a, 1n)); if (cur !== v) { if (shown++ < 12) diffs.push(`mem 0x${a.toString(16)} aot=${cur.toString(16)} interp=${v.toString(16)}`); } }
        if (shown > 12) diffs.push(`... ${shown} bytes differ`);
        if (snap !== null) {
          const cur = this.mem.view(snapLo, BigInt(snap.length)); let stray = 0;
          for (let i = 0; i < snap.length; i++) if (cur[i] !== snap[i] && !img.has(snapLo + BigInt(i))) { if (stray++ < 12) diffs.push(`stray 0x${(snapLo + BigInt(i)).toString(16)} was=${snap[i].toString(16)} aot=${cur[i].toString(16)} (rsp0-${(rsp0 - snapLo - BigInt(i)).toString(16)})`); }
          if (stray > 12) diffs.push(`... ${stray} stray bytes`);
        }
        if (best === null || diffs.length < best.diffs.length) best = { k, diffs };
        if (!diffs.length) break;
      }
      if (best.diffs.length) {
        st.diverged++; this._shadowDiverged = (this._shadowDiverged ?? 0) + 1;
        console.error(`<SHADOW-DIVERGE fn=0x${entryRip.toString(16)} exit=0x${exitRip.toString(16)} step=${best.k}/${trace.length} entry=[${regs0.map(v=>v.toString(16)).join(',')}]>`);
        for (const d of best.diffs.slice(0, 20)) console.error('  ' + d);
      }
      this._shadowBusy = false;
      return exitRip;
    }
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

  // OXWASM_AOTSKIP=lo-hi: the dispatches numbered lo..hi-1 run INTERPRETED to the function's
  // exit instead of entering the unit (the compiled code stays registered for every other
  // dispatch). Bisecting the range that makes a failing run pass costs only the interpretation
  // of that range, where OXWASM_AOTSTOP paid for the whole interpreted tail of the run.
  // OXWASM_DISPRING=1: a ring of the last 512 unit dispatches / callouts / deopts / frame finishes
  // (kind, addresses, rsp, dispatch number), dumped by _onBreak: the compiled-code history the
  // interpreted rip trace cannot see.
  _dr(kind, a, b, c) { const r = (this._dring ??= new Array(512)); r[this._dringI = ((this._dringI | 0) + 1) % 512] = `${kind} ${a.toString(16)} ${b === undefined ? '' : b.toString(16)} ${c === undefined ? '' : c.toString(16)} d=${this.stats.disp} rsp=${BigInt.asUintN(64, this.regview[4]).toString(16)}`; }
  _ripHit(before) {
    const r = this.cpu.regs, rd = (a, n) => { try { return this.mem.read(a, n).toString(16); } catch { return '?'; } };
    // OXWASM_AOTSKIP_AT=rip:site  the first interpreted hit of rip with [rbp+0x24]==site arms an
    // interpreted window of OXWASM_AOTSKIP_N dispatches (dispatch numbers drift between runs)
    // OXWASM_AOTSKIP_REL=lo-hi narrows the window to dispatches lo..hi-1 counted from the arming point.
    // OXWASM_AOTSKIP_AT_N=n arms at the n-th matching hit; OXWASM_AT_BREAK=1 also runs _onBreak there.
    // OXWASM_AOTSKIP_AT_TIGHT=k: only when the last 2000 hits spanned fewer than 2000*k dispatches (a spin, not a loop doing work)
    if (this._skipAt !== undefined && this._skipUntil === undefined && before === this._skipAt[0] && rd(r[5] + 0x24n, 4n) === this._skipAt[1] && ((this._skipAtN = (this._skipAtN | 0) + 1) >= +(ENV.OXWASM_AOTSKIP_AT_N || 1)) &&
        (!ENV.OXWASM_AOTSKIP_AT_TIGHT || (() => { const h = (this._atHist ??= new Int32Array(2000)), n = this._skipAtN, d = this.stats.disp | 0; const old = h[n % 2000]; h[n % 2000] = d; return n > 2000 && d - old < 2000 * +ENV.OXWASM_AOTSKIP_AT_TIGHT; })())) {
      if (ENV.OXWASM_AT_BREAK) { console.error(`[at-break] hit ${this._skipAtN} of ${before.toString(16)} disp=${this.stats.disp}`); this._onBreak(); }
      if (ENV.OXWASM_AT_AOTOFF) { this._aotOff = true; console.error(`[at-aotoff] compiled code off from disp ${this.stats.disp}`); } const rel = (ENV.OXWASM_AOTSKIP_REL || ('0-' + (ENV.OXWASM_AOTSKIP_N || 400))).split('-').map(Number); this._skipFrom = (this.stats.disp | 0) + rel[0]; this._skipUntil = (this.stats.disp | 0) + rel[1]; if (ENV.OXWASM_AOTSKIP_STEPS) this._skipSteps = +ENV.OXWASM_AOTSKIP_STEPS; console.error(`[aotskip] armed at disp ${this.stats.disp}: skipping ${this._skipFrom}..${this._skipUntil}`); }
    this._ripLogRing.push(`${before.toString(16)} disp=${this.stats.disp} r13=${r[13].toString(16)} r8=${r[8].toString(16)} r12=${r[12].toString(16)} rbp=${r[5].toString(16)} rsp=${r[4].toString(16)} rax=${r[0].toString(16)} r10=${r[10].toString(16)} site=${rd(r[5] + 0x24n, 4n)} cb=${rd(r[5] + 0x10n, 8n)} [rsp]=${rd(r[4], 8n)}`);
    if (this._ripLogRing.length > +(ENV.OXWASM_RIPLOG_N || 48)) this._ripLogRing.shift();
    // file log once the window is armed; before that one hit in 1024, to see where a run that never arms is
    if (ENV.OXWASM_RIPLOG_FILE && (this._skipAt === undefined || this._skipUntil !== undefined || ((this._ripN = (this._ripN | 0) + 1) & 1023) === 0)) { (this._ripLogBuf ??= []).push(this._ripLogRing[this._ripLogRing.length - 1]); if (this._ripLogBuf.length >= 64) this._ripLogFlush(); }
  }
  _ripLogFlush() { if (this._ripLogBuf?.length) { process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_RIPLOG_FILE, this._ripLogBuf.join('\n') + '\n'); this._ripLogBuf.length = 0; } }
  _interpOne() {
    const cpu = this.cpu, rsp0 = cpu.regs[4];
    let retAddr = null; try { retAddr = this.mem.read(rsp0, 8n); } catch {}
    const rspExit = rsp0 + 8n;
    let steps = 0;
    while (!(cpu.rip === retAddr && cpu.regs[4] === rspExit) && !(cpu.regs[4] > rspExit)) {
      const before = cpu.rip;
      if (this._ripLog !== undefined && this._ripLog.has(before)) this._ripHit(before);
      const insn = cpu.step(); this.stats.interpreted++;
      if (this.exitCode !== null) throw EXIT;
      if (this.blocked) { cpu.rip = before; break; }           // the run loop parks; the syscall re-executes
      if (++steps > 2e6) break;
      if (this._skipSteps !== undefined && --this._skipSteps <= 0) { console.error(`[aotskip] step budget spent at disp ${this.stats.disp} rip=${cpu.rip.toString(16)}`); break; }
    }
    return cpu.rip;
  }
  dispatchMaybeShadow(f) {
    if (AOTSKIP !== null && this._ctor?.argv?.[0]?.includes('opencode')) {
      const d = this.stats.disp | 0;
      if (d >= AOTSKIP[0] && d < AOTSKIP[1]) { this.stats.disp = d + 1; this.stats.skipped = (this.stats.skipped || 0) + 1; return this._interpOne(); }
    }
    // OXWASM_AOTSKIP_STEPS=k: the window is also bounded to k interpreted steps in total (a dispatch of a
    // long-running frame otherwise interprets it to its exit, which for a module's top-level frame is the
    // rest of the program)
    // OXWASM_AT_SHADOW=1: the armed window is SHADOWED (compiled vs interpreted, see shadowDispatch)
    // instead of interpreted; dispatches outside it run compiled as usual
    if (AT_SHADOW) { if (this._skipUntil !== undefined && (this.stats.disp | 0) < this._skipUntil && (this.stats.disp | 0) >= this._skipFrom) { this.shadowRange ??= [0n, 1n << 63n]; return this.shadowDispatch(f); } return this.dispatchAot(f); }
    if (this._skipUntil !== undefined && (this.stats.disp | 0) < this._skipUntil && (this.stats.disp | 0) >= this._skipFrom && (this._skipSteps === undefined || this._skipSteps > 0)) {
      if (ENV.OXWASM_AOTSKIP_LOG) console.error(`[aotskip] disp ${this.stats.disp} rip=${this.cpu.rip.toString(16)} rsp=${this.cpu.regs[4].toString(16)} rbp=${this.cpu.regs[5].toString(16)} r8=${this.cpu.regs[8].toString(16)}`);
      this.stats.disp = (this.stats.disp | 0) + 1; this.stats.skipped = (this.stats.skipped || 0) + 1; return this._interpOne(); }
    if (this.shadowLib && !this.shadowRange) {
      if (this.shadowLib === 'all') { this.shadowRange = [0n, 1n << 63n]; console.error('<shadow armed: every mapping>'); }
      for (const m of this.maps ?? []) if (m.path.includes(this.shadowLib)) {
        this.shadowRange = [m.at, m.at + m.len];
        console.error(`<shadow armed ${m.path} 0x${m.at.toString(16)}+0x${m.len.toString(16)}>`);
        break;
      }
    }
    if (!this.shadowRange || this._shadowBusy ||
        this.cpu.rip < this.shadowRange[0] || this.cpu.rip >= this.shadowRange[1])
      return this.dispatchAot(f);
    // OXWASM_SHADOW_DISP=lo-hi: shadow only the dispatches numbered lo..hi (stats.disp), so a
    // failure the AOTSTOP bisect placed at dispatch N can be examined without shadowing the
    // hundreds of thousands before it (a full shadow of opencode never reaches N in time).
    if (SHADOW_DISP !== null && ((this.stats.disp | 0) < SHADOW_DISP[0] || (this.stats.disp | 0) > SHADOW_DISP[1])) return this.dispatchAot(f);
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
      let f = branched && !this._aotOff ? this.aotFns.get(this.cpu.rip) : undefined;
      if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
      // stack budget: this interpreter can be nested deep under live wasm
      // frames (contained deopt/callout) — don't dispatch further fat wasm
      // frames when the shared budget word says the stack is near its edge
      if (f && (this._ftdv ??= new DataView(this.wmem.buffer)).getUint32(FTMAP + 8, true) >= FTDLIMIT) { f = null; this.stats.dispDeep = (this.stats.dispDeep || 0) + 1; }
      if (f) { if (this.ripTrace !== undefined) this.ripTrace[this.ripTraceI++ & 65535] = -this.cpu.rip;
               this.cpu.rip = this.dispatchMaybeShadow(f);
               if (this.ripTrace !== undefined) this.ripTrace[this.ripTraceI++ & 65535] = -this.cpu.rip;
               if (this.blocked) throw new BlockUnwind(this.cpu.rip);
               continue; }
      const before = this.cpu.rip;
      if (this.ripTrace !== undefined && before >= this._rtLo && before < this._rtHi) this.ripTrace[this.ripTraceI++ & 65535] = before;
            if (this._ripLog !== undefined && this._ripLog.has(before)) this._ripHit(before);
      this._cleanSync = false;
      if (BREAKS !== null && BREAKS.has(this.cpu.rip)) this._onBreak();
      const insn = this.cpu.step(); this.stats.interpreted++;
      if (globalThis.__ihist !== undefined && (this.stats.interpreted & 63) === 0) { const h = globalThis.__ihist, k = this.cpu.rip; h.set(k, (h.get(k) || 0) + 1); }   // IHIST: every 64th interpreted step, by rip
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
      if ((this._itc & 0x3FFFF) === 0 && this.pumpAsm && this._inflight && this._inflight.size) this.pumpAsm();   // see run(): deferred units register here too
      if ((this._itc & 0xFFF) === 0 && ((this.sliceDeadline != null && performance.now() > this.sliceDeadline) || this._kidsDue() || this._rotateDue())) {
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
  // MEASUREMENT (OXWASM_STOREGUARD=1): a store from compiled code landed in
  // the window that holds translated GENERATED code. Drop the translations
  // covering that page - the guest is patching its own code, which is the
  // thing the engine could not see and the reason anonymous executable memory
  // is not translatable by default.
  _codeWrite(waddr, next) {
    const g = this.base + BigInt((waddr >>> 0) - this.RAMOFF);
    if (this._watchArmed) { this._watchLog(g, 0, 0n, 'compiled next=' + (next === undefined ? '?' : BigInt.asUintN(64, next).toString(16))); return; }
    const lo = g & ~4095n;
    this.stats.codeWrites = (this.stats.codeWrites || 0) + 1;
    this._invalidateCode(lo, lo + 4096n);
    // A page that keeps being rewritten is VOLATILE: the guest is using it as
    // a scratchpad for code, and re-translating it on every patch costs more
    // than interpreting it ever will. HotSpot with C1/C2 on does exactly this,
    // and invalidate-on-every-write alone did not finish a case that takes 110
    // seconds interpreted. Past the limit the page stops being watched and
    // stops being translated, and the rest of the region carries on.
    const n = (this._cwCount ??= new Map()).get(lo) ?? 0;
    this._cwCount.set(lo, n + 1);
    if (n + 1 >= CW_VOLATILE) {
      (this._volatilePages ??= new Set()).add(lo);
      this._cwMark(lo, 0);
      this.stats.volatilePages = this._volatilePages.size;
    }
  }
  // The per-page byte the guard reads. Out-of-window pages are simply not
  // representable, which is the same as not watched.
  _cwMark(page, on) {
    if (!STOREGUARD || !this.wmem) return;
    const dv = new DataView(this.wmem.buffer);
    const lo = dv.getUint32(CWLO_SLOT, true), len = dv.getUint32(CWLEN_SLOT, true);
    const off = this.RAMOFF + Number(page - this.base) - lo;
    if (off < 0 || off >= len) return;
    const idx = off >>> 12;
    if (idx >= CWMAP_PAGES) return;
    new Uint8Array(this.wmem.buffer)[CWMAP + idx] = on;
  }
  // Mark every page of the anonymous executable region holding `a`, because a
  // translated function's extent is not recorded anywhere and a patch lands in
  // the middle of one as readily as at its entry. Volatile pages stay clear.
  _cwCover(a) {
    if (!STOREGUARD) return false;
    const stat = this.execRangesStatic ?? [];
    for (const [x, y] of this.execRanges) {
      if (!(a >= x && a < y)) continue;
      if (stat.some(([p, q]) => p === x && q === y)) return false;      // a file image, not generated code
      if (this._volatilePages?.has(a & ~4095n)) return true;            // caller must not translate it
      for (let p = x & ~4095n; p < y; p += 4096n)
        if (!this._volatilePages?.has(p)) this._cwMark(p, 1);
      return false;
    }
    return false;
  }
  // The window the guard compares against: the anonymous executable ranges,
  // as one interval in WASM offsets. The interpreter watches the same span,
  // because its own stores are just as capable of patching code and it is
  // only compiled code that was ever the blind spot.
  _updateCodeWindow() {
    if (!STOREGUARD || !this.wmem || this._watchArmed) return;
    const stat = this.execRangesStatic ?? [];
    const isStatic = (a, b) => stat.some(([x, y]) => x === a && y === b);
    let lo = null, hi = null;
    for (const [a, b] of this.execRanges) if (!isStatic(a, b)) {
      if (lo === null || a < lo) lo = a;
      if (hi === null || b > hi) hi = b; }
    const dv = new DataView(this.wmem.buffer);
    if (lo === null) { dv.setUint32(CWLO_SLOT, 0, true); dv.setUint32(CWLEN_SLOT, 0, true); this.mem.watch = null; return; }
    dv.setUint32(CWLO_SLOT, this.RAMOFF + Number(lo - this.base), true);
    dv.setUint32(CWLEN_SLOT, Number(hi - lo), true);
    // The window moved, so every page index in the map moved with it. Clear
    // and re-mark from what is actually translated rather than trying to shift
    // the bytes: a stale map watches the wrong pages, which is worse than
    // watching none.
    new Uint8Array(this.wmem.buffer).fill(0, CWMAP, CWMAP + CWMAP_PAGES);
    for (const a of this.aotFns.keys()) this._cwCover(a);
    this.mem.watchLo = lo; this.mem.watchHi = hi;
    this.mem.watch = (addr) => { const p = addr & ~4095n; this._invalidateCode(p, p + 4096n); };
  }

  aotEnv() {
    return {
      codewrite: (a, next) => this._codeWrite(a, next),
      loophot: (a) => this._loopHot(BigInt.asUintN(64, a)),
      // rip = guest address of the syscall instruction (an emit-time constant)
      // so a blocking syscall can suspend: state is spilled, frames unwind,
      // and resume re-executes the syscall at exactly this rip.
      syscall: (rip) => {
        // Fast path for the syscalls a JS runtime spins on (clock_gettime, getpid, gettid, sched_yield):
        // served straight from the register file with no cpu sync at all, when nothing asynchronous is
        // pending. Measured (sig/sysbench): clock_gettime 6.1 -> 1.2 us, getpid 3.5 -> 0.9 us, sched_yield 3.4 -> 0.9 us per call; the full hop was 32 GPR and
        // 96 xmm BigInt conversions plus the dispatcher.
        {
          const nr = Number(this.regview[0]);
          if ((nr === 228 || nr === 39 || nr === 186 || nr === 24) && !this._sigAny && !this.strace && !this.dbgClockWatch && !(this.children !== undefined && this.children.length !== 0) && !ENV.OXWASM_SCTRACE && !ENV.OXWASM_MMAPSTAT && !ENV.OXWASM_WATCHPAGE && !ENV.OXWASM_CLOCKCHAIN) {
            this.stats.syscalls[nr] = (this.stats.syscalls[nr] || 0) + 1;
            let r = 0n;
            if (nr === 228) {
              const clk = Number(this.regview[7]), ts = BigInt.asUintN(64, this.regview[6]);
              const ms = (clk === 0 || clk === 5 || clk === 6) ? Date.now() : this.nowMs();
              const o = this.RAMOFF + Number(ts - this.base);
              const buf = this.wmem.buffer;   // not this.ram: that view is detached once the memory has grown
              if (o < 0 || o + 16 > buf.byteLength) { r = -14n; this.stats.fastSysEfault = (this.stats.fastSysEfault || 0) + 1; }   // EFAULT: let the slow path report it
              else { const v = new DataView(buf); v.setBigUint64(o, BigInt(Math.floor(ms / 1000)), true); v.setBigUint64(o + 8, BigInt(Math.floor((ms % 1000) * 1e6)), true); }
            } else if (nr === 39) r = BigInt(this.threads[this.ti].proc?.pid ?? this.pid ?? 1);
            else if (nr === 186) r = BigInt(this.threads[this.ti].id);
            if (r !== -14n) {
              this.stats.fastSys = (this.stats.fastSys || 0) + 1;
              this.regview[0] = r; this.regview[1] = BigInt.asIntN(64, (rip ?? 0n) + 2n); this.regview[11] = 0x246n;
              // The slow path's yields to the host (slice deadline, children due) and to siblings (quantum):
              // a guest spinning on clock_gettime in compiled code otherwise never returns to the host loop,
              // so a kill request is never seen (sandboxtest's kill check) and the host side piles up.
              if ((this.sliceDeadline != null && performance.now() > this.sliceDeadline) || this._kidsDue() || this._rotateDue()) {
                this.syncIn(); this.cpu.rip = BigInt.asUintN(64, (rip ?? 0n) + 2n);
                this.stats.syscallPreempt = (this.stats.syscallPreempt || 0) + 1;
                this.blocked = { deadline: this.nowMs() }; throw new BlockUnwind(this.cpu.rip);
              }
              return;
            }
          }
        }
        // GPRs only: the xmm half costs 96 BigInt allocations per hop and no syscall reads it. Handlers
        // that need the whole register file (clone's child seed, sigreturn's restore, a signal frame) call
        // xmmFresh(); every unwind below passes through dispatchAot's full syncIn before a thread switch.
        const nrFast = Number(this.regview[0]);
        if (nrFast === 56 || nrFast === 57 || nrFast === 58 || nrFast === 15 || nrFast === 130 || nrFast === 34) this.syncIn(); else this.syncInGpr();
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
          if (this._xmmStale) this.syncOutGpr(); else this.syncOut();
          throw new BlockUnwind(this.cpu.rip);
        }
        if (this._xmmStale) this.syncOutGpr(); else this.syncOut();
        // A signal handler (or rt_sigreturn) redirected rip: the compiled
        // unit would otherwise carry on at its own next instruction. Unwind
        // to the top loop, which resumes at the new rip with the state just
        // published.
        if (this._sigRedirected) { this._sigRedirected = false; throw new DeoptUnwind(this.cpu.rip); }
        // rip is already the post-syscall address: the unwind resumes there
        if (this._kidsDue()) { this.blocked = { deadline: this.nowMs() }; throw new BlockUnwind(this.cpu.rip); }
        // Preemption at a syscall boundary. The run loop rotates threads every
        // 0x3FFFF interpreter steps, but a thread spinning in COMPILED code
        // (clock_gettime in a deadline loop: WTF's ParkingLot, JSC's mutator
        // waiting for its collector) never returns to the run loop, so a
        // sibling it is waiting on starves until its own timed wait expires
        // and asserts (Bun with the JIT on: SIGABRT from the GC thread). The
        // syscall has completed and rip is past it, so the unwind resumes
        // after it; the thread is parked with an immediate deadline and runs
        // again after the siblings' quanta.
        if (this._rotateDue()) {
          this.stats.syscallPreempt = (this.stats.syscallPreempt || 0) + 1;
          this.blocked = { deadline: this.nowMs() }; throw new BlockUnwind(this.cpu.rip);
        }
      },
      callout: (target) => {
        target = BigInt.asUintN(64, target);
        // Chain preemption: a wasm-to-wasm chain never returns to run(), and
        // each hop's interpUntil restarts its own step counter, so thousands
        // of short hops dodge every other deadline check (measured: 175ms
        // slices). At callout entry the caller has spilled the whole regfile
        // and the return address is on the guest stack — resuming interp AT
        // the target reproduces the call exactly.
        if ((this.sliceDeadline != null && performance.now() > this.sliceDeadline) || this._kidsDue()) {
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
        if (globalThis.__frameTrace) console.error(`<callout target=${target.toString(16)} rsp=${rsp0.toString(16)} compiled=${this.aotFns.has(target)} iu=${this._iuDepth | 0}>`);
        if (rsp0 < 0x10000n && this.onBadRsp) this.onBadRsp(target, rsp0);
        const retAddr = this.mem.read(rsp0, 8n);
        const rspExit = BigInt.asUintN(64, rsp0 + 8n);
        if (DISPRING) this._dr('callout', target, retAddr, rspExit);
        let f = this._aotOff ? undefined : this.aotFns.get(target);
        if (this.deoptLog) { const m = (this.calloutLog ??= new Map()); const kk = target.toString(16) + (f ? '' : ' (no unit)'); m.set(kk, (m.get(kk) || 0) + 1); }
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
            if (DISPRING) this._dr('callout-exit', target, exit, retAddr);
            if (this.onCalloutExit) this.onCalloutExit(target, exit, retAddr);
            // The caller DROPS this return and resumes after its call, so we
            // may only come back once the call really returned. A compiled
            // callee that TAIL-JUMPS out of its unit exits at the jump target
            // with the frame still open — finish the chain first.
            if (exit === retAddr && BigInt.asUintN(64, this.regview[4]) === rspExit)
              return BigInt.asIntN(64, exit);
            this.syncIn(); this.cpu.rip = exit;
            this._finishFrame(retAddr, rspExit);
            return BigInt.asIntN(64, retAddr);
          }
          catch (e) {
            ftdv.setUint32(FTMAP + 8, ftd, true);
            if (!(e instanceof DeoptUnwind)) throw e;
            // Deopt inside the compiled callee: its state is spilled to the
            // regfile; finish the frame by interpreting, contained here so the
            // caller's wasm frame survives.
            this.syncIn(); this.cpu.rip = e.rip;
            if (DISPRING) this._dr('callout-catch', target, e.rip, retAddr);
            if (globalThis.__frameTrace) console.error(`<callout-catch target=${target.toString(16)} erip=${e.rip.toString(16)} retAddr=${retAddr.toString(16)} rspExit=${rspExit.toString(16)} rsp=${this.cpu.regs[4].toString(16)}>`);
            this._finishFrame(retAddr, rspExit);
            if (globalThis.__frameTrace) console.error(`<callout-ret(catch) target=${target.toString(16)} retAddr=${retAddr.toString(16)}>`);
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
        if (DISPRING) this._dr('callout-interp', target, retAddr, rspExit);
        this._finishFrame(retAddr, rspExit);
        if (globalThis.__frameTrace) console.error(`<callout-ret(interp) target=${target.toString(16)} retAddr=${retAddr.toString(16)} rsp=${this.cpu.regs[4].toString(16)}>`);
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
        if (DISPRING) this._dr('deopt', BigInt.asUintN(64, rip), _rsp0 === undefined ? 0n : BigInt.asUintN(64, _rsp0));
        if (this._loopHotSeen?.has(BigInt.asUintN(64, rip))) this.stats.loopYieldNested = (this.stats.loopYieldNested || 0) + 1;   // a nested frame's yield arrives as a deopt to a loop head
        const t = BigInt.asUintN(64, rip);
        this.stats.deopts = (this.stats.deopts || 0) + 1;
        if (this.deoptLog) this.deoptLog.set(t, (this.deoptLog.get(t) || 0) + 1);
        if (this.inExec(t)) this.profileTarget(t);
        const f = this._aotOff ? undefined : this.aotFns.get(t);
        // t !== _deoChainT: an instruction-escape deopt (rdtsc/cpuid/div
        // guard) passes its own rip — a landing-unit rooted exactly there
        // would re-deopt at the same t forever; only the interpreter can
        // execute that instruction.
        // The guest stack above this frame's entry rsp means the guest has
        // abandoned the frame: a longjmp (ld.so's _dl_signal_exception out
        // of _dl_catch_exception, on every failed dlsym) landed in a caller
        // whose wasm frame is below us. Running the landing nested here
        // would keep a stale frame chain alive; unwind to the top loop
        // instead, which resumes at t from the published state.
        // A jump to a REAL FUNCTION ENTRY (a target the guest has called) that already has a
        // compiled unit is a tail call, even when the stack sits above this unit's entry rsp:
        // a landing unit entered mid-function has its whole frame above rsp0, so every
        // epilogue-and-jump looks like an abandoned frame. Running it nested costs nothing;
        // unwinding by exception cost ~100 us each (JavaScriptCore: 200k per 20k allocations).
        // A longjmp lands inside a function and is never a call target, so it still unwinds.
        const tailToFn = ENV.OXWASM_FTENTRY && f && this._callEntries?.has(t);
        if (tailToFn && globalThis.__frameTrace && _rsp0 !== undefined && BigInt.asUintN(64, this.regview[4]) > BigInt.asUintN(64, _rsp0)) console.error(`<tailfn t=${t.toString(16)} rsp=${BigInt.asUintN(64, this.regview[4]).toString(16)} rsp0=${BigInt.asUintN(64, _rsp0).toString(16)}>`);
        if (!tailToFn && _rsp0 !== undefined && BigInt.asUintN(64, this.regview[4]) > BigInt.asUintN(64, _rsp0)) {
          this.stats.frameGone = (this.stats.frameGone || 0) + 1;
          if (ENV.OXWASM_FGTRACE && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_FGTRACE) && ((this._fgN = (this._fgN | 0) + 1) <= 30)) console.error(`[fg] rip=${t.toString(16)} rsp=${BigInt.asUintN(64, this.regview[4]).toString(16)} rsp0=${BigInt.asUintN(64, _rsp0).toString(16)} diff=${BigInt.asUintN(64, this.regview[4]) - BigInt.asUintN(64, _rsp0)}`);
          if (globalThis.__frameTrace) console.error(`<framegone deopt rip=${t.toString(16)} rsp=${BigInt.asUintN(64, this.regview[4]).toString(16)} rsp0=${BigInt.asUintN(64, _rsp0).toString(16)} depth=${this._deoD | 0}>`);
          throw new DeoptUnwind(t);
        }
        const fdv = (this._ftdv ??= new DataView(this.wmem.buffer));
        const fd = fdv.getUint32(FTMAP + 8, true);
        if (ENV.OXWASM_FDTRACE && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_FDTRACE) && ((this._fdN = (this._fdN | 0) + 1) % 7919 === 0 || this._fdN < 12)) console.error(`[fd] t=${t.toString(16)} depth=${fd} limit=${FTDLIMIT} fuel=${fdv.getUint32(FTFUEL, true)} nest=${fdv.getUint32(FTNEST, true)} f=${!!f} chainSlow=${!!this.chainSlow} deoD=${this._deoD | 0} chainT=${this._deoChainT?.toString(16)} sliceDl=${this.sliceDeadline != null}`);
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
    const randPtr = put(fillRandom(new Uint8Array(16)));
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
    const push = (buf, b) => { const u = b instanceof Uint8Array ? b : new Uint8Array(b); buf.chunks.push(u); buf.size = (buf.size ?? 0) + u.length; };
    // echo goes through output processing like any write to the slave: an
    // echoed newline is "\r\n" under OPOST|ONLCR, a control character is ^X
    const echo = (b) => { if (!(T.lflag & 8)) return; const out = [];
      for (const x of b) { if (x === 10 && (T.oflag & 1) && (T.oflag & 4)) out.push(13, 10); else out.push(x); } push(pty.s2m, out); };
    const ctl = (x) => { if (T.lflag & 8) push(pty.s2m, [94, x === 127 ? 63 : x + 64]); };   // ECHOCTL: ^C, ^\, ^Z
    const sigc = (sig) => { if (!(T.lflag & 1)) return false; if (!(T.lflag & 0x80)) pty.m2s.chunks.length = 0, pty.m2s.size = 0, (pty.line ??= []).length = 0;   // ISIG: the queue is flushed unless NOFLSH
      if (pty.pgrp !== undefined) this._signalPgrp(pty.pgrp, sig); return true; };
    if (!(T.lflag & 2)) {                                   // raw: straight through (ISIG may still be on)
      const keep = [];
      for (const b of bytes) { if (b === T.cc[0] && sigc(2)) { ctl(b); continue; } if (b === T.cc[1] && sigc(3)) { ctl(b); continue; } if (b === T.cc[10] && sigc(20)) { ctl(b); continue; } keep.push(b); }
      if (keep.length) { push(pty.m2s, keep); echo(keep); }
      this.wakeAllBlk(); return;
    }
    const line = (pty.line ??= []);
    for (let b of bytes) {
      if (b === 13 && (T.iflag & 0x100)) b = 10;            // ICRNL
      else if (b === 10 && (T.iflag & 0x40)) b = 13;        // INLCR
      if (b === T.cc[0] && sigc(2)) { ctl(b); continue; }    // VINTR -> SIGINT to the foreground group
      if (b === T.cc[1] && sigc(3)) { ctl(b); continue; }    // VQUIT -> SIGQUIT
      if (b === T.cc[10] && sigc(20)) { ctl(b); continue; }  // VSUSP -> SIGTSTP
      if (b === T.cc[2]) {                                   // VERASE
        if (line.length) { line.pop(); echo([8, 32, 8]); }
        continue;
      }
      if (b === T.cc[3]) {                                   // VKILL
        while (line.length) { line.pop(); echo([8, 32, 8]); }
        continue;
      }
      if (b === T.cc[4]) {                                   // VEOF: a partial line becomes readable as it is; an empty one is one EOF
        if (line.length) { push(pty.m2s, new Uint8Array(line)); line.length = 0; }
        else pty.m2s.chunks.push(new Uint8Array(0));         // the marker read() answers with 0, once
        continue;
      }
      line.push(b);
      echo([b]);
      if (b === 10) {                                        // Enter: the line is now readable
        push(pty.m2s, new Uint8Array(line));
        line.length = 0;
      }
    }
    this.wakeAllBlk();
  }
  // a signal to every process of a group in the tree (^C on a terminal)
  _isReplacement(e) { return !!(e.parentEng?._execed && e.parentEng._execed.eng === e); }   // a tail-exec'd image's replacement: signalled through the image
  _signalPgrp(pgid, sig, info = { pid: 0, code: 0x80 }) {   // returns how many processes it reached
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set(); let n = 0;
    const scan = (e) => { if (seen.has(e)) return; seen.add(e);
      const main = e.threads[0]; if (main && e.exitCode === null && !this._isReplacement(e) && e._pgrec(main).pgid === pgid) { e.raiseSignal(sig, null, info); n++; }
      for (const x of e.threads) if (x.proc && x.state !== 'dead' && x.state !== 'vfork' && e._pgrec(x).pgid === pgid) { e.raiseSignal(sig, x.id, info); n++; }
      for (const c of e.children ?? []) if (c.eng && c.exited === null) scan(c.eng); };
    scan(root); return n;
  }
  _signalAll(sig, info) {                       // kill(-1): every process in the tree but the caller
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set(), me = this.threads[this.ti];
    const scan = (e) => { if (seen.has(e)) return; seen.add(e);
      if (e !== this && e.exitCode === null && !this._isReplacement(e)) e.raiseSignal(sig, null, info);
      for (const x of e.threads) if (x.proc && x !== me && x.state !== 'dead' && x.state !== 'vfork') e.raiseSignal(sig, x.id, info);
      for (const c of e.children ?? []) if (c.eng && c.exited === null) scan(c.eng); };
    scan(root);
  }
  _findProc(pid) {                              // a live process anywhere in the tree: {eng} or {eng, thread} for a window child
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set();
    const scan = (e) => { if (seen.has(e)) return null; seen.add(e);
      if ((e.pid ?? 1) === pid && e.exitCode === null && !this._isReplacement(e)) return { eng: e };
      for (const x of e.threads) if (x.proc?.pid === pid && x.state !== 'dead') return { eng: e, thread: x };
      for (const c of e.children ?? []) if (c.eng && c.exited === null) { const r = scan(c.eng); if (r) return r; }
      return null; };
    return scan(root);
  }
  _allPtys() { let root = this; while (root.parentEng) root = root.parentEng; const out = new Set(), seen = new Set();
    const scan = (e) => { if (seen.has(e)) return; seen.add(e); for (const p of e.ptys?.values() ?? []) out.add(p); for (const c of e.children ?? []) if (c.eng) scan(c.eng); }; scan(root); return out; }
  _ptyHangup(e) {                                            // a session leader exited: its terminal has no session or foreground group any more
    if (e.pid === undefined || e.sid !== e.pid) return;
    for (const p of this._allPtys()) if (p.sid === e.pid) { p.sid = undefined; p.pgrp = undefined; }
  }
  _ptsReady(h) {                                             // a slave in raw mode is readable only with VMIN bytes queued
    const p = h.pts, T = p.termios;
    if (p.m2s.weof || p.m2s.chunks.some(c => c.length === 0)) return true;
    const avail = p.m2s.size ?? 0;
    return (T.lflag & 2) ? avail > 0 : avail >= Math.max(1, T.cc[6]);
  }

  _ptyStat(p) {                                            // /dev/pts/N of a live pty, or /dev/ptmx: {mode, rdev, ino} for stat
    const m = /^\/dev\/pts\/(\d+)$/.exec(p);
    if (m && this._allPtys().size && [...this._allPtys()].some(x => x.n === Number(m[1]))) return { mode: 0o020620, rdev: 0x8800n + BigInt(m[1]), ino: 2000n + BigInt(m[1]) };
    if (p === '/dev/ptmx') return { mode: 0o020666, rdev: 0x502n, ino: 1999n };
    return null;
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
    for (;;) { const c = Number(this.mem.read(a, 1n)); if (!c) break; p += String.fromCharCode(c); a++; if (p.length > 4096) throw new PathErr(36); }   // ENAMETOOLONG
    if (p.length > 4095) throw new PathErr(36);
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
    if (p.charCodeAt(0) !== 47) p = (this.cwd && this.cwd !== '/' ? this.cwd : '') + '/' + p;   // a relative name at the root is "/name", and "." and ".." there are "/" (the JVM opens ".." while locating itself)
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
    throw new PathErr(40);                       // ELOOP: forty hops and still a link
  }
  // The arena bump pointer. _zeroAbove is the highest it has ever been: the
  // memory above is untouched wasm zero pages, so a new mapping there needs no
  // zeroing. Undefined (a restored engine, whose RAM above may hold stale
  // bytes) means always zero.
  get mmapNext() { return this._mn; }
  set mmapNext(v) { this._mn = v; if (this._zeroAbove !== undefined && v > this._zeroAbove) this._zeroAbove = v; }
  // CPUs the guest sees (sched_getaffinity, /proc/cpuinfo, /proc/stat, /sys/devices/system/cpu/online).
  // Runtimes size their thread pools from it. Execution is still one host thread.
  get ncpu() { return this._ncpu ?? 1; }
  set ncpu(n) { this._ncpu = n; }
  // d_type for a directory entry: a symlink says so, which is how ldconfig
  // (and find, ls, rsync) decide whether to stat or lstat it
  _dtype(dir, name, isdir) {
    const links = this._fsMeta().links;
    if (links.size) { const d = this.resolve(this.norm(dir)); if (links.has((d === '/' ? '' : d) + '/' + name)) return 10; }
    return isdir ? 4 : 8;
  }
  // The path with every symlink resolved except a final one: what lstat and
  // readlink name when a directory above the file is itself a link (/lib ->
  // usr/lib), so the link table, keyed by the real directory, finds the file.
  resolveParent(p) {
    p = this.norm(p);
    const i = p.lastIndexOf('/');
    if (i <= 0 || !this._fsMeta().links.size) return p;
    const dir = this.resolve(p.slice(0, i));
    return (dir === '/' ? '' : dir) + p.slice(i);
  }
  lookup(p) { p = this.resolve(this.norm(p)); return this.files[p] ?? this._synth(p); }
  // readlink's answer for a normalised path: the link's target, a /proc/self
  // form (exe, cwd, root, fd/N naming the descriptor's file or its anonymous
  // kind), or the errno: -22 for something that is not a link, -2 for nothing
  _readlinkTarget(lp) {
    const lm = this._fsMeta().links; if (lm.has(lp)) return lm.get(lp);
    const m = /^\/proc\/(?:self|\d+)\/(.*)$/.exec(lp);
    if (m) {
      if (m[1] === 'exe') return this.argv0?.startsWith('/') ? this.argv0 : '/prog';
      if (m[1] === 'cwd') return this.norm('.');
      if (m[1] === 'root') return '/';
      const fm = /^fd\/(\d+)$/.exec(m[1]);
      if (fm) { const fd = Number(fm[1]), h = this.fds.get(fd);
        if (!h) return fd <= 2 ? (this.tty ? '/dev/pts/0' : fd === 0 ? '/dev/null' : `pipe:[${100 + fd}]`) : -2;
        if (h.istty || (this.tty && fd <= 2)) return '/dev/pts/0';
        const ino = () => (h._ino ??= (this._anonIno = (this._anonIno ?? 5000) + 1));
        if (h.pipe && !h.fifo) return `pipe:[${ino()}]`;
        if (h.sk || h.sock || h.lsock || h.dsock) return `socket:[${ino()}]`;
        if (h.ev) return 'anon_inode:[eventfd]'; if (h.tfd) return 'anon_inode:[timerfd]'; if (h.sfd) return 'anon_inode:[signalfd]';
        if (h.ep) return 'anon_inode:[eventpoll]'; if (h.ino) return 'anon_inode:inotify'; if (h.pidfd) return 'anon_inode:[pidfd]';
        if (h.devnull) return '/dev/null'; if (h.sink) return this.tty ? '/dev/pts/0' : `pipe:[${100 + fd}]`;
        return h.path ?? `anon_inode:[${ino()}]`; }
      return this.lookup(lp) !== undefined || this.isDir(lp) ? -22 : -2;
    }
    if (this.files[lp] !== undefined || this.isDir(lp) || this._fifoAt(lp) || this._sockAt(lp) || this._synth(lp) !== undefined) return -22;
    return -2;
  }
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
      case '/proc/cpuinfo': {
        let out = '';
        for (let c = 0; c < this.ncpu; c++)
          out += `processor\t: ${c}\nvendor_id\t: GenuineIntel\ncpu family\t: 6\nmodel\t\t: 85\nmodel name\t: oxwasm x86-64\nstepping\t: 4\n` +
            `microcode\t: 0x1\ncpu MHz\t\t: 2000.000\ncache size\t: 8192 KB\nphysical id\t: 0\nsiblings\t: ${this.ncpu}\ncore id\t\t: ${c}\ncpu cores\t: ${this.ncpu}\napicid\t\t: ${c}\n` +
            'fpu\t\t: yes\nfpu_exception\t: yes\ncpuid level\t: 13\nwp\t\t: yes\n' +
            'flags\t\t: fpu vme de pse tsc msr pae mce cx8 apic sep mtrr pge mca cmov pat pse36 clflush mmx fxsr sse sse2 ht syscall nx lm constant_tsc nopl pni ssse3 cx16 sse4_1 sse4_2 popcnt\n' +
            'bogomips\t: 4000.00\nclflush size\t: 64\ncache_alignment\t: 64\naddress sizes\t: 46 bits physical, 48 bits virtual\n\n';
        return enc(out); }
      case '/proc/meminfo':
        return enc(`MemTotal:       ${memKB} kB\nMemFree:        ${memKB >> 1} kB\nMemAvailable:   ${memKB >> 1} kB\nBuffers:               0 kB\nCached:                0 kB\n` +
          `SwapCached:            0 kB\nActive:                0 kB\nInactive:              0 kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\nDirty:                 0 kB\n` +
          `Shmem:                 0 kB\nCommitLimit:    ${memKB} kB\nCommitted_AS:   ${memKB >> 1} kB\nHugepagesize:       2048 kB\n`);
      case '/proc/filesystems': return enc('nodev\tproc\nnodev\tdevtmpfs\nnodev\ttmpfs\n\text4\n');
      case '/proc/version': return enc('Linux version 6.1.0 (oxwasm) (gcc) #1 oxwasm\n');
      case '/proc/uptime': return enc(`${(this.nowMs() / 1000).toFixed(2)} ${(this.nowMs() / 1000).toFixed(2)}\n`);
      case '/proc/loadavg': return enc('0.00 0.00 0.00 1/1 2\n');
      case '/proc/stat': return enc('cpu  0 0 0 0 0 0 0 0 0 0\n' + Array.from({ length: this.ncpu }, (_, c) => `cpu${c} 0 0 0 0 0 0 0 0 0 0\n`).join('') + 'intr 0\nctxt 0\nbtime 1700000000\nprocesses 1\nprocs_running 1\nprocs_blocked 0\n');
      case '/sys/devices/system/cpu/online': case '/sys/devices/system/cpu/possible': case '/sys/devices/system/cpu/present': return enc(this.ncpu > 1 ? `0-${this.ncpu - 1}\n` : '0\n');
      case '/proc/sys/kernel/osrelease': return enc('6.1.0\n');
      case '/proc/sys/kernel/ostype': return enc('Linux\n');
      case '/proc/sys/kernel/version': return enc('#1 oxwasm\n');
      case '/proc/sys/kernel/hostname': return enc('oxwasm\n');
      case '/proc/sys/kernel/pid_max': return enc('4194304\n');
      case '/proc/sys/kernel/threads-max': return enc('65536\n');
      case '/proc/sys/kernel/ngroups_max': return enc('65536\n');
      case '/proc/sys/kernel/cap_last_cap': return enc('40\n');
      case '/proc/sys/kernel/random/boot_id': return enc('9d5a2e42-0f1c-4a7e-b0f6-6d5c1e0a1b2c\n');
      case '/proc/sys/kernel/random/uuid': { const h = [...fillRandom(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
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
  // Paths a guest has written, shared by every process in the tree: a write by a spawned
  // child must count for the disk quota and reach a snapshot, not vanish with the child.
  get dirtyFiles() { return (this._fsMeta().dirty ??= new Set()); }
  set dirtyFiles(v) { this._fsMeta().dirty = v; }
  // rename(2) for a file, a symlink or a DIRECTORY. Directories exist here
  // only as prefixes of file paths plus the mkdir set, so a directory rename
  // moves every entry under the old prefix. rustc finalises an incremental
  // session by renaming its `-working` directory and warned on every build
  // when only files could move. flags: RENAME_NOREPLACE (1) -> EEXIST when
  // the target exists; RENAME_EXCHANGE (2) is not modelled (EINVAL).
  _rename(po, pn, flags) {
    if (po === pn) return 0n;
    const m = this._fsMeta();
    const exists = (q) => this.files[q] !== undefined || m.links.has(q) || this.isDir(q);
    if (flags & 2) {                                          // RENAME_EXCHANGE: both must exist; swap files or links (directories: EINVAL)
      if (!exists(po) || !exists(pn)) return -2n;
      if (this.isDir(po) || this.isDir(pn)) return -22n;
      const fo = this.files[po], fn = this.files[pn], lo = m.links.get(po), ln = m.links.get(pn);
      delete this.files[po]; delete this.files[pn]; m.links.delete(po); m.links.delete(pn);
      if (fo !== undefined) this.files[pn] = fo; if (fn !== undefined) this.files[po] = fn;
      if (lo !== undefined) m.links.set(pn, lo); if (ln !== undefined) m.links.set(po, ln);
      this.fsBump(); return 0n;
    }
    if ((flags & 1) && exists(pn)) return -17n;
    const mv = (a, b) => { if (this.mtimes && this.mtimes[a] !== undefined) { this.mtimes[b] = this.mtimes[a]; delete this.mtimes[a]; } };
    if (this.files[po] !== undefined) {
      if (this.isDir(pn) && this.files[pn] === undefined) return -21n;   // EISDIR: a file over a directory
      this.files[pn] = this.files[po]; delete this.files[po]; m.links.delete(pn); mv(po, pn); this.fsBump(); return 0n;
    }
    if (m.links.has(po)) { m.links.set(pn, m.links.get(po)); m.links.delete(po); delete this.files[pn]; mv(po, pn); this.fsBump(); return 0n; }
    if (this.isDir(po)) {
      if (this.files[pn] !== undefined || m.links.has(pn)) return -20n;   // ENOTDIR: a directory over a file
      if (pn.startsWith(po + '/')) return -22n;                          // into itself
      const pre = po + '/', npre = pn + '/';
      for (const k of Object.keys(this.files)) if (k.startsWith(pre)) { const nk = npre + k.slice(pre.length); this.files[nk] = this.files[k]; delete this.files[k]; mv(k, nk); }
      for (const [k, t] of [...m.links]) if (k.startsWith(pre)) { m.links.set(npre + k.slice(pre.length), t); m.links.delete(k); }
      for (const d of [...m.dirs]) if (d === po || d.startsWith(pre)) { m.dirs.delete(d); m.dirs.add(pn + d.slice(po.length)); }
      if (!m.dirs.has(pn)) m.dirs.add(pn);                               // an empty directory survives the move
      mv(po, pn); this.fsBump(); return 0n;
    }
    return -2n;
  }
  // a guest path is a directory iff some provided file lives under it,
  // or the guest mkdir'd it
  isDir(p) {
    p = this.resolve(this.norm(p));
    if (p === '/' ) return true;
    if (SYNTH_DIRS.has(p) || /^\/proc\/\d+(\/(fd|task))?$/.test(p)) return true;
    { const cwd = this.norm('.'); if (p === cwd || (cwd + '/').startsWith(p + '/')) return true; }   // the cwd and its ancestors exist (patch makes its temp file in ./)
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
  inoOf(p) { p = this.resolveParent(p); this._inos ??= new Map(); let n = this._inos.get(p);
    if (n === undefined) { n = this._inos.size + 1000; this._inos.set(p, n); }
    return BigInt(n); }

  // fill a struct stat (the by-path shape: dev/ino/nlink/mode/size/times)
  // Regular files stat with a mode derived from content: ELF binaries and
  // shebang scripts are 0755, everything else 0644. All-0755 was the old
  // answer and tar archived data files with the execute bit set - native
  // headers say 0644 - while a blanket 0644 would break shells probing
  // PATH entries with access(X_OK).
  fileMode(bytes, path) {
    const m = path !== undefined && path !== null ? this._fsMeta().modes?.get(path) : undefined;
    if (m !== undefined) return 0o100000 | m;
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
    this._rotT0 = performance.now();
    const c = this.threads[this.ti]; c._dl = this._deadline;
    this.ti = i; const n = this.threads[i];
    this.cpu = n.cpu; this._deadline = n._dl ?? null;
    // A forked (vfork-window) child runs with a COPY of the fd table — its
    // dup2/close before execve must not disturb the parent's descriptors.
    // Its memory writes are journaled (rolled back at exec/exit) and it runs
    // interpreted so every store goes through the journal.
    if (n.proc) { this._mainFds ??= this.fds; this.fds = n.proc.fds;
      this.mem.jrnl = n.proc.jrnl;
      // The saved budget is normally UNDEFINED (no budget: dispatch freely),
      // so "saved !== undefined" was never true and the parent came back
      // from every vfork window with aotBudget still 0 - vetoing every
      // top-level AOT dispatch for the rest of its life. The vforkexec
      // fixture ran its second hot loop interpreted (30 s for a 2 s case),
      // and every parent of a vfork (gcc's driver, shells, make) paid the
      // same. A separate flag says whether a save happened.
      if (!this._vforkSaved) { this._vforkSaved = true; this._vforkBudget = this.aotBudget; this.aotBudget = 0; } }
    else { if (this._mainFds) { this.fds = this._mainFds; this._mainFds = null; }
      if (this.mem.jrnl && this._vforkSaved) { this.mem.jrnl = null;
        this.aotBudget = this._vforkBudget; this._vforkBudget = undefined; this._vforkSaved = false; } }
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
  // Has the current thread used its wall-clock quantum while a sibling is
  // runnable? The run loop rotated only every 0x3FFFF steps, and a compiled
  // loop is one step however long it runs: a mutator spinning in JIT'd code
  // starved JSC's collector thread, whose Thread::suspend signal was never
  // delivered (the replica in engine/diff/sigsuspendtest.mjs hung). Natively
  // the kernel preempts; here the quantum is checked on cheap paths and the
  // thread yields at the next safe point (the run loop, or an unwind to it).
  _rotateDue() {
    if (this.threads.length < 2) return false;
    const now = performance.now();
    if (now - (this._rotT0 ?? 0) < ROTATE_MS) return false;
    this.reapTimers();
    for (let i = 0; i < this.threads.length; i++) if (i !== this.ti && this.threads[i].state === 'run') return true;
    this._rotT0 = now;                                   // nobody to yield to: start a fresh quantum
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
    if (ENV.OXWASM_WATCHPAGE && !this._watchArmed && this._ctor?.argv?.[0]?.includes('opencode')) this._armWatchPage(BigInt('0x' + ENV.OXWASM_WATCHPAGE));
    if (ENV.OXWASM_MMAPSTAT && (nr === 9 || nr === 11 || nr === 25) && this._ctor?.argv?.[0]?.includes('opencode')) {
      const ms = (this._mmapStat ??= { mmapN: 0, mmapB: 0n, munmapN: 0, munmapB: 0n, mremapN: 0, bySize: new Map() });
      if (nr === 9) { ms.mmapN++; ms.mmapB += a2; const k = (a2 >> 20n).toString() + 'MB/' + cpu.regs[10].toString(16); ms.bySize.set(k, (ms.bySize.get(k) || 0) + 1); }
      else if (nr === 11) { ms.munmapN++; ms.munmapB += a2; } else ms.mremapN++;
    }
    if (ENV.OXWASM_CLOCKCHAIN && nr === 228 && this._ctor?.argv?.[0]?.includes('opencode') && ((this._ccN = (this._ccN | 0) + 1) % (+ENV.OXWASM_CLOCKCHAIN) === 0)) { const out = []; try { let bp = cpu.regs[5]; for (let i = 0; i < 24 && bp; i++) { out.push(this.mem.read(bp + 8n, 8n).toString(16)); bp = this.mem.read(bp, 8n); } } catch {} console.error(`[clock#${this._ccN}] rip=${cpu.rip.toString(16)} chain=${out.join(',')}`); }
    if (this._mmapStat && nr === 234) { const ms = this._mmapStat; console.error(`[mmapstat@tgkill] mmap n=${ms.mmapN} ${ms.mmapB >> 20n}MB munmap n=${ms.munmapN} ${ms.munmapB >> 20n}MB mmapNext=${this.mmapNext?.toString(16)} base=${this._mmapBase?.toString(16)} holes=${(this._mmapHoles ?? []).map(([l, h]) => l.toString(16) + '+' + ((h - l) >> 20n) + 'MB').join(',')} bySize=${[...ms.bySize].sort((x, y) => y[1] - x[1]).slice(0, 16).map(([k, v]) => k + 'x' + v).join(' ')}`); }
    if (ENV.OXWASM_SCTRACE && this._ctor?.argv?.[0]?.includes('opencode')) {
      const t = this.threads[this.ti], r = cpu.regs;
      const line = `${t?.id} ${nr} ${a1.toString(16)} ${a2.toString(16)} ${a3.toString(16)} d=${this.stats.disp} sp=${r[4].toString(16)} bp=${r[5].toString(16)} bx=${r[3].toString(16)} r12=${r[12].toString(16)} r13=${r[13].toString(16)} r14=${r[14].toString(16)} r15=${r[15].toString(16)}`;
      const buf = (this._sct ??= []); buf.push(line);
      if (buf.length >= 500) { process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_SCTRACE, buf.join('\n') + '\n'); buf.length = 0; }
    }
    if (ENV.OXWASM_MMAPTRACE && nr === 9 && a2 >= BigInt('0x' + ENV.OXWASM_MMAPTRACE) && a2 < BigInt('0x' + (ENV.OXWASM_MMAPTRACE_MAX || 'ffffffffffffff')) && this._ctor?.argv?.[0]?.includes('opencode') && (this._mtN = (this._mtN | 0) + 1) <= 3) {   // who asks for a huge mapping: the guest's rbp chain
      const out = []; try { let bp = cpu.regs[5]; for (let i = 0; i < 24 && bp; i++) { out.push('0x' + this.mem.read(bp + 8n, 8n).toString(16)); bp = this.mem.read(bp, 8n); } } catch {}
      console.error(`[mmaptrace] len=${a2.toString(16)} prot=${cpu.regs[2].toString(16)} flags=${cpu.regs[10].toString(16)} rbp-chain: ${out.join(' ')}`); }
    // strace ring: the last few hundred (nr, args, ret) tuples, kept only when
    // switched on - reading a silent exit 1 out of a guest needs the tail of
    // its syscall history, not a fault address
    const ret = this.strace
      ? (v) => { cpu.regs[0] = BigInt.asUintN(64, v);
                 if (ENV.OXWASM_ERRLOG && BigInt.asIntN(64, v) < 0n && BigInt.asIntN(64, v) > -4096n && ![-2n, -11n, -110n, -4n, -17n, -20n, -21n, -25n].includes(BigInt.asIntN(64, v)) && this._ctor?.argv?.[0]?.includes('opencode')) process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_ERRLOG, `${this.threads[this.ti]?.id} nr=${nr} a=${a1.toString(16)},${a2.toString(16)},${a3.toString(16)} -> ${BigInt.asIntN(64, v)} rip=${cpu.rip.toString(16)}\n`);
                 if (ENV.OXWASM_MMAPLOG && (nr === 9 || nr === 11 || nr === 25 || nr === 28 || nr === 12) && this._ctor?.argv?.[0]?.includes('opencode')) process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_MMAPLOG, `${nr} hint=${a1.toString(16)} len=${a2.toString(16)} prot=${a3.toString(16)} flags=${cpu.regs[10].toString(16)} -> ${BigInt.asUintN(64, v).toString(16)} next=${this.mmapNext?.toString(16)}` + (nr === 9 && a2 >= 0x4000000n ? ' chain=' + (() => { const out = []; try { let bp = cpu.regs[5]; for (let i = 0; i < 20 && bp; i++) { out.push(this.mem.read(bp + 8n, 8n).toString(16)); bp = this.mem.read(bp, 8n); } } catch {} return out.join(','); })() : '') + '\n');
                 if (ENV.OXWASM_MMAPTRACE && nr === 9 && v === -12n) { const out = []; try { let bp = cpu.regs[5]; for (let i = 0; i < 24 && bp; i++) { out.push('0x' + this.mem.read(bp + 8n, 8n).toString(16)); bp = this.mem.read(bp, 8n); } } catch {} console.error(`[mmap ENOMEM] len=${a2.toString(16)} prot=${a3.toString(16)} flags=${cpu.regs[10].toString(16)} mmapNext=${this.mmapNext?.toString(16)} memEnd=${(this.base + BigInt(this.mem?.size ?? 0)).toString(16)} rbp-chain: ${out.join(' ')}`); }
                 if (ENV.OXWASM_STRACE_SIGNAL && (nr === 234 || nr === 200 || nr === 62) && (ENV.OXWASM_STRACE_SIGNAL === 'all' || [5n, 6n, 7n, 11n].includes(nr === 234 ? a3 : a2))) console.error(`[signal syscall nr=${nr} args=${a1.toString(16)},${a2.toString(16)},${a3.toString(16)}] argv0=${this._ctor?.argv?.[0]} last:\n  ` + this.strace.slice(-(+ENV.OXWASM_STRACE_N || 3)).join('\n  ') + '\n  threads:' + this.threads.map((t, i) => { let self = '?', tid = '?'; try { self = this.mem.read(t.cpu.fsBase + 0x10n, 8n).toString(16); tid = this.mem.read(t.cpu.fsBase + 0x2d0n, 4n).toString(); } catch {} return `[${i}] id=${t.id} st=${t.state} fs=${t.cpu.fsBase?.toString(16)} self=${self} tcbtid=${tid}`; }).join(' ') + '\n  regs:' + [...cpu.regs].map((r, i) => i + '=' + r.toString(16)).join(' ') + '\n  ipbytes:' + (() => { try { let bp = cpu.regs[5]; for (let i = 0; i < 4; i++) bp = this.mem.read(bp, 8n); const off = this.mem.read(bp + 0x24n, 4n); const out = ['cfr=' + bp.toString(16), 'off=' + off.toString(16), 'callee=' + this.mem.read(bp + 0x10n, 8n).toString(16)]; const base = cpu.regs[13] + off; const b = []; for (let i = -24n; i < 16n; i++) b.push(Number(this.mem.read(base + i, 1n)).toString(16).padStart(2, '0')); return out.join(' ') + ' bytes:' + b.join(' '); } catch (e) { return String(e); } })() + '\n  rbpchain:' + (() => { const out = []; try { let bp = cpu.regs[5]; for (let i = 0; i < 16 && bp; i++) { out.push('0x' + this.mem.read(bp + 8n, 8n).toString(16)); bp = this.mem.read(bp, 8n); } } catch {} return out.join(' '); })() + '\n  stack:' + (() => { const out = []; try { const sp = cpu.regs[4]; for (let i = 0n; i < 200n; i++) { const w = this.mem.read(sp + i * 8n, 8n); const m = (this.maps ?? []).find((x) => w >= x.at && w < x.at + BigInt(x.len)); if (m) out.push(`${m.path}+0x${(w - m.at + BigInt(m.fileOff ?? 0)).toString(16)}`); else if (w >= 0x400000n && w < 0x520000n) out.push('exe 0x' + w.toString(16)); } } catch {} return '\n    ' + out.slice(0, 24).join('\n    '); })());
                 if (ENV.OXWASM_DBG_ERR && BigInt.asIntN(64, v) === BigInt(-ENV.OXWASM_DBG_ERR)) console.error(`[errno ${ENV.OXWASM_DBG_ERR}] tid=${this.threads[this.ti]?.id} nr=${nr} args=${a1.toString(16)},${a2.toString(16)},${a3.toString(16)} argv0=${this._ctor?.argv?.[0]}`);
                 let ps = '';   // decode the path argument of the fs family
                 try { if (nr === 257 || nr === 262) ps = ' "' + this.readPath(a2) + '"';
                       else if (nr === 2 || nr === 21 || nr === 89 || nr === 4 || nr === 6 || nr === 87 || nr === 82 || nr === 83 || nr === 59) ps = ' "' + this.readPath(a1) + '"';
                       else if (nr === 263 || nr === 264) ps = ' "' + this.readPath(a2) + '"'; } catch {}
                 this.strace.push(`[${this.threads[this.ti]?.id ?? 1}]${nr}(${a1.toString(16)},${a2.toString(16)},${a3.toString(16)})=${BigInt.asIntN(64, v)}${ps}`);
                 if (this.strace.length > (+ENV.OXWASM_STRACE_CAP || 400)) this.strace.shift(); }
      : (v) => { cpu.regs[0] = BigInt.asUintN(64, v); };
    // resolve a write target: stdout / stderr sink, or a pipe buffer
    const defSink = (fd) => this.fds.get(fd) ?? (fd === 1 ? { sink: 'out' } : fd === 2 ? { sink: 'err' } : undefined);
    const writeChunk = (fd, addr, len, nosig = false) => {   // nosig: MSG_NOSIGNAL (EPIPE without the signal)
      if (len <= 0) return;
      this.guardRange(addr, len);                          // payload may be .rodata
      const bytes = this.ram.slice(Number(addr - this.base), Number(addr - this.base) + len);
      const h = defSink(fd);
      if (h?.isdir || h?.lsock || h?.pidfd || h?.opath) return -9;   // EBADF: nothing to write to
      if (h?.sock?.conn) { h.sock.conn.write(bytes); this.wakeAllBlk(); return; }
      if (h?.sock) return -107;                              // ENOTCONN: a stream socket nobody connected
      if (h?.wpipe) {                                        // a pty end
        const T = (h.ptm ?? h.pts).termios;
        if (h.pts) {
          // program output: OPOST|ONLCR turns a bare \n into \r\n, which is
          // what makes a terminal's next line start at column 0
          if ((T.oflag & 1) && (T.oflag & 4) && bytes.includes(10)) {
            const out = [];
            for (const b of bytes) { if (b === 10) out.push(13); out.push(b); }
            h.wpipe.chunks.push(new Uint8Array(out)); h.wpipe.size = (h.wpipe.size ?? 0) + out.length;
          } else { h.wpipe.chunks.push(bytes); h.wpipe.size = (h.wpipe.size ?? 0) + bytes.length; }
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
        if (!pb.ext && !this._pipeReaderAlive(pb)) { if (!nosig) this.raiseSignal(13, null, { pid: 0, code: 0 }); return -32; }
        if (h.sk?.shutW) { if (!nosig) this.raiseSignal(13, null, { pid: 0, code: 0 }); return -32; }
        // A pipe holds 64KB: a writer that finds it full BLOCKS until a reader
        // drains it (EAGAIN if non-blocking). Without a bound, a compiled
        // `yes` pushed gigabytes of chunks before `head` ever ran.
        if ((pb.size ?? 0) >= (pb.cap ?? PIPE_CAP)) {
          if (h.nonblock) return -11;
          this.block(null); return -4096;                    // re-executed once woken
        }
        pb.chunks.push(bytes); pb.size = (pb.size ?? 0) + bytes.length; pb.wtot = (pb.wtot ?? 0) + bytes.length; this.wakeAllBlk(); return;
      }
      if (h?.ev) {                                           // eventfd: add to the counter
        let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] ?? 0);
        h.ev.count += v; this.wakeAllBlk(); return;
      }
      if (h?.devnull || h?.gen) return;                      // /dev/null, /dev/zero, /dev/urandom: discard, count as written
      if (h && h.bytes !== undefined && h.writable) {        // regular file opened for writing
        if (h.path) (this.dirtyFiles ??= new Set()).add(h.path);
        if (h.append) h.pos = h.bytes.length;                // O_APPEND: every write lands at the end
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
    if (this._shmAt?.length) this._shmSync(false);        // System V shared memory: local writes out, others' in
    try { switch (nr) {
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
        const nw = Number(BigInt.asIntN(32, a2));
        if (nw < 0 || nw >= 1048576) { ret(-9n); break; }     // EBADF: outside the descriptor range
        if (nr === 292 && nw === old) { ret(-22n); break; }   // dup3: EINVAL on the same descriptor
        if (nw === old) { ret(BigInt(nw)); break; }           // dup2 onto itself: nothing changes
        this.fds.set(nw, handle);
        if (nr === 292 && (Number(cpu.regs[2]) & 0x80000)) this.cloexec.add(nw); else this.cloexec.delete(nw);
        ret(BigInt(nw)); break; }
      case 285: {                                             // fallocate(fd, mode, off, len): grow the file (KEEP_SIZE and punch modes: no size change)
        const h = this.fds.get(Number(a1)); if (!h || h.bytes === undefined) { ret(-9n); break; }
        const mode = Number(a2), end = Number(a3) + Number(cpu.regs[10]);
        if (!(mode & 0x3) && end > h.bytes.length) this._growFile(h, end);
        ret(0n); break; }
      case 40: {                                              // sendfile(out_fd, in_fd, *off, count)
        const ho = this._sinkOf(Number(a1)), hi = this.fds.get(Number(a2)); if (!hi) { ret(-9n); break; } if (!ho || (hi.bytes === undefined && !hi.pipe)) { ret(-22n); break; }
        const off = a3 ? Number(this.mem.read(a3, 8n)) : undefined;
        const data = this._readBytes(hi, Number(cpu.regs[10]), off); if (data === undefined) { ret(-22n); break; } if (data === null) { ret(-11n); break; }
        const n = this._writeBytes(ho, data);
        if (a3) this.mem.write(a3, 8n, BigInt(off + n));
        ret(BigInt(n)); break; }
      case 326: {                                             // copy_file_range(fd_in, *off_in, fd_out, *off_out, len, flags)
        const hi = this.fds.get(Number(a1)), ho = this.fds.get(Number(a3)); if (!hi || !ho) { ret(-9n); break; }
        if (hi.bytes === undefined || ho.bytes === undefined) { ret(-22n); break; }
        const oi = a2 ? Number(this.mem.read(a2, 8n)) : undefined, oo = cpu.regs[10] ? Number(this.mem.read(cpu.regs[10], 8n)) : undefined;
        const data = this._readBytes(hi, Number(cpu.regs[8]), oi); const n = this._writeBytes(ho, data, oo);
        if (a2) this.mem.write(a2, 8n, BigInt(oi + n)); if (cpu.regs[10]) this.mem.write(cpu.regs[10], 8n, BigInt(oo + n));
        ret(BigInt(n)); break; }
      case 275: {                                             // splice(fd_in, *off_in, fd_out, *off_out, len, flags): one side is a pipe
        const hi = this.fds.get(Number(a1)), ho = this._sinkOf(Number(a3)); if (!hi) { ret(-9n); break; }
        if (!ho || (!hi.pipe && !ho.pipe) || (hi.bytes === undefined && !hi.pipe)) { ret(-22n); break; }
        if (Number(cpu.regs[8]) === 0) { ret(0n); break; }    // nothing asked: nothing moved, never a wait
        const oi = a2 ? Number(this.mem.read(a2, 8n)) : undefined, oo = cpu.regs[10] ? Number(this.mem.read(cpu.regs[10], 8n)) : undefined;
        const data = this._readBytes(hi, Number(cpu.regs[8]), oi); if (data === undefined) { ret(-22n); break; }
        if (data === null) { if (hi.nonblock || (Number(cpu.regs[9]) & 2)) { ret(-11n); break; } this.block(null); break; }
        const n = this._writeBytes(ho, data, oo); if (n === undefined) { ret(-22n); break; }
        if (a2) this.mem.write(a2, 8n, BigInt(oi + n)); if (cpu.regs[10]) this.mem.write(cpu.regs[10], 8n, BigInt(oo + n));
        ret(BigInt(n)); break; }
      case 319: {                                             // memfd_create(name, flags): an anonymous regular file
        const fd = this.allocFd(); this.fds.set(fd, { bytes: new Uint8Array(0), pos: 0, writable: true, memfd: this.readPath(a1) });
        if (Number(a2) & 1) this.cloexec.add(fd);             // MFD_CLOEXEC
        ret(BigInt(fd)); break; }
      case 253: case 294: {                                   // inotify_init / inotify_init1(flags)
        const fl = nr === 294 ? Number(a1) : 0, fd = this.allocFd();
        this.fds.set(fd, { ino: { watches: new Map(), next: 1, queue: [] }, nonblock: !!(fl & 0x800) });
        if (fl & 0x80000) this.cloexec.add(fd); (this._inotifyFds ??= new Set()).add(fd);
        ret(BigInt(fd)); break; }
      case 254: {                                             // inotify_add_watch(fd, path, mask)
        const h = this.fds.get(Number(a1)); if (!h?.ino) { ret(-22n); break; }
        const wp = this.norm(this.readPath(a2)); if (!this.isDir(wp) && this.files[wp] === undefined) { ret(-2n); break; }
        for (const [wd, w] of h.ino.watches) if (w.path === wp) { w.mask = Number(a3); ret(BigInt(wd)); break; }
        const wd = h.ino.next++; h.ino.watches.set(wd, { path: wp, mask: Number(a3) }); ret(BigInt(wd)); break; }
      case 255: {                                             // inotify_rm_watch(fd, wd)
        const h = this.fds.get(Number(a1)); if (!h?.ino || !h.ino.watches.delete(Number(a2))) { ret(-22n); break; } ret(0n); break; }
      case 22: case 293: {                                   // pipe / pipe2
        const buf = { chunks: [], pos: 0, off: 0, size: 0 };
        const rfd = this.allocFd(); this.fds.set(rfd, null); const wfd = this.allocFd(); this.fds.delete(rfd);
        const nb = nr === 293 && !!(Number(a2) & 0x800);        // pipe2(O_NONBLOCK): both ends (a read on an empty one blocked forever)
        this.fds.set(rfd, { pipe: buf, mode: 'r', nonblock: nb });
        this.fds.set(wfd, { pipe: buf, mode: 'w', nonblock: nb });
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
        const ty = Number(a2) & 0xff;
        this.fds.set(f1, { pipe: b1, peer: b2, mode: 'rw', nonblock: nb, sk: { fam: 1, type: ty, name: null, peername: null } });
        this.fds.set(f2, { pipe: b2, peer: b1, mode: 'rw', nonblock: nb, sk: { fam: 1, type: ty, name: null, peername: null } });
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
        const zeroAboveBefore = this._zeroAbove;
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
        if (off0 < 0 || off0 + Number(len) > this.ram.length) {   // ENOMEM: give back what was taken, or the failed probe still moved the arena
          if (fixedAt === null) { this._mmapGive(at, len); this._zeroAbove = zeroAboveBefore; }
          ret(-12n); break; }
        // A mapping is zeroed, but address space nothing has ever been mapped
        // at is still the zero page wasm gave us: only the part at or below the
        // high-water mark (the largest the arena has been, see mmapNext) can
        // hold stale bytes. Bun reserves gigabytes it never touches, and
        // zeroing them was a fifth of its startup.
        {
          const end0 = off0 + Number(len);
          const hw = zeroAboveBefore === undefined ? Infinity : Number(zeroAboveBefore - this.base);   // the mark before THIS mapping raised it
          if (off0 < hw) this.ram.fill(0, off0, Math.min(end0, hw));
          if (fixedAt !== null && this._zeroAbove !== undefined && at + len > this._zeroAbove) this._zeroAbove = at + len;
        }
        if ((flags & ANON) && (a3 & 4n)) this._jitMark(at, at + len, 1);   // a JIT's code cache: its instructions are re-checked when cached
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
          this.execRanges.push([at, at + len]); this._genCache = undefined; this._updateCodeWindow();   // library text: profiling must see it (prot untracked)
        } else if ((this.execAnon ?? EXEC_ANON) && (a3 & 4n)) {
          // Anonymous PROT_EXEC memory is a JIT's code cache (the JVM's
          // template interpreter lives in one). Without this the profiler
          // never sees it and javac interpreted 1.9M steps/s forever.
          // Opt-in: code written there can change without an munmap, and
          // the engine invalidates translations only on munmap/mremap.
          this.execRanges.push([at, at + len]); this._genCache = undefined; this._updateCodeWindow();
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
        this._invalidateCode(lo, hi);
        if (this.mem.jit !== null) this._jitMark(lo, hi, 0);
        ret(0n); break; }
      case 10: {                                             // mprotect(addr, len, prot): no page protection here, but
        // in exec-anon mode it is the JIT's W^X signal: a range made
        // executable becomes code the profiler may tier up (V8 maps code
        // pages RW and flips them RX, so the mmap never said PROT_EXEC), and
        // a range made writable-without-exec is about to be rewritten, so
        // its translations go. That makes W^X JITs sound under execAnon;
        // RWX code caches that rewrite in place stay the reason it is opt-in.
        if (a3 & 4n) this._jitMark(a1, a1 + align(a2, PAGE), 1);   // W^X JITs flip pages executable after writing them
        if (this.execAnon ?? EXEC_ANON) {
          const lo = a1, hi = a1 + align(a2, PAGE);
          if (a3 & 4n) { if (!this.execRanges.some(([a, b]) => a <= lo && hi <= b)) { this.execRanges.push([lo, hi]); this._ieCache = undefined; this._genCache = undefined; this._updateCodeWindow(); } }
          else if ((a3 & 2n) && this.execRanges.some(([a, b]) => a < hi && b > lo)) this._invalidateCode(lo, hi);
        }
        ret(0n); break; }
      case 273: ret(0n); break;                              // set_robust_list
      case 334: ret(a1 === 0n || Number(a2) < 32 || (Number(a2) & 31) ? -22n : -38n); break;   // rseq: EINVAL on bad arguments, else ENOSYS (glibc copes)
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
      case 89: case 267: {                                    // readlink(path, buf, sz) / readlinkat(dirfd, path, buf, sz)
        const lp = this.resolveParent(nr === 89 ? this.readPath(a1) : this.atPath(a1, a2)), buf = nr === 89 ? a2 : a3, sz = Number(nr === 89 ? a3 : cpu.regs[10]);
        const t = this._readlinkTarget(lp);
        if (typeof t === 'number') { ret(BigInt(t)); break; }
        const b = new TextEncoder().encode(t), n = Math.min(b.length, sz);
        this.jsnap(buf, n); this.ram.set(b.subarray(0, n), Number(buf - this.base)); ret(BigInt(n)); break; }
      case 318: {                                            // getrandom(buf, len, flags)
        const buf = a1, len = Number(a2), off = Number(buf - this.base);
        // len 0 touches nothing and answers 0 whatever the pointer: Rust std
        // probes availability with a zero-length buffer at a dangling
        // pointer (address 1), and copying zero bytes to a negative offset
        // threw a RangeError that killed rustc under cargo
        if (len === 0) { ret(0n); break; }
        if (off < 0 || off + len > this.ram.length) {         // a pointer outside guest memory: EFAULT, as the kernel answers
          if (!this._efaultNoted) { this._efaultNoted = true; console.error(`<getrandom EFAULT buf=${buf.toString(16)} len=${len} base=${this.base.toString(16)} ram=${this.ram.length.toString(16)} rip=${cpu.rip.toString(16)} tid=${this.threads[this.ti]?.id}>`); }
          ret(-14n); break; }
        const bytes = new Uint8Array(len);
        fillRandom(bytes.subarray(0, Math.min(len, 65536)));
        this.ram.set(bytes, off);
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
          const avail = h.pipe ? (h.pipe.size ?? 0) : h.dsock ? (h.dsock.queue[0]?.bytes.length ?? 0) : h.bytes !== undefined ? Math.max(0, h.bytes.length - h.pos) : 0;
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
          case 0x40045431: if (!h?.ptm) { ret(-25n); break; } h.ptm.locked = !!v.getUint32(off, true); ret(0n); break;   // TIOCSPTLCK
          case 0x80045439: if (!h?.ptm || !a3) { ret(-25n); break; } this.jsnap(a3, 4); v.setUint32(off, h.ptm.locked === false ? 0 : 1, true); ret(0n); break;   // TIOCGPTLCK
          case 0x5411: if (a3) { this.jsnap(a3, 4); v.setUint32(off, 0, true); } ret(0n); break;   // TIOCOUTQ: output drains at once
          case 0x5429: if (!pty || pty.sid === undefined) { ret(-25n); break; } if (a3) { this.jsnap(a3, 4); v.setUint32(off, pty.sid, true); } ret(0n); break;   // TIOCGSID
          case 0x5422: { const r = this._pgrec(this.threads[this.ti]); if (r.ctty !== pty || !pty) { ret(-25n); break; } r.ctty = null; if (r.sid === (this.threads[this.ti].proc?.pid ?? this.pid ?? 1)) { pty.sid = undefined; pty.pgrp = undefined; } ret(0n); break; }   // TIOCNOTTY: the leader gives it up
          case 0x5425: ret(0n); break;                                      // TCSBRKP
          case 0x5441: {                                     // TIOCGPTPEER
            if (!h?.ptm) { ret(-25n); break; }
            const fd = this.allocFd();
            this.fds.set(fd, this.ptsHandle(h.ptm));
            ret(BigInt(fd)); break; }
          case 0x540E: { const r = this._pgrec(this.threads[this.ti]); if (pty) { pty.sid = r.sid; pty.pgrp = r.pgid; r.ctty = pty; } ret(0n); break; }   // TIOCSCTTY: the caller's session takes the terminal
          case 0x540F: {                                     // TIOCGPGRP: the foreground group, ENOTTY on a pty no session owns
            if (pty && pty.pgrp === undefined) { ret(-25n); break; }
            if (a3) { this.jsnap(a3, 4); v.setUint32(off, pty ? pty.pgrp : this._pgrec(this.threads[this.ti]).pgid, true); } ret(0n); break; }
          case 0x5410: { if (pty) { if (pty.pgrp === undefined) { ret(-25n); break; } pty.pgrp = v.getUint32(off, true); } ret(0n); break; }   // TIOCSPGRP
          case 0x540B: { if (pty) { const q = Number(a3); if (q === 0 || q === 2) { pty.m2s.chunks.length = 0; pty.m2s.size = 0; (pty.line ??= []).length = 0; } if (q === 1 || q === 2) { pty.s2m.chunks.length = 0; pty.s2m.size = 0; } } ret(0n); break; }   // TCFLSH: TCIFLUSH / TCOFLUSH / TCIOFLUSH
          case 0x5409: ret(0n); break;                                      // TCSBRK
          default: this._noteIoctl(req, h); ret(-25n); break;
        }
        break; }
      case 158:                                              // arch_prctl
        if (Number(a1) === 0x1002) { cpu.fsBase = a2; ret(0n); } else ret(-22n);
        break;
      case 218: { const t = this.threads[this.ti]; t.ctid = a1; ret(BigInt(t.id)); break; }  // set_tid_address
      case 56: case 57: case 58: {                           // clone / fork / vfork
        if (ENV.OXWASM_CLONETRACE && this._ctor?.argv?.[0]?.includes('opencode')) console.error(`[clone] nr=${nr} flags=${a1.toString(16)} stack=${a2.toString(16)} disp=${this.stats.disp} rip=${this.cpu.rip.toString(16)}`);
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
          if (ENV.OXWASM_PROCTRACE) console.error("[fork] live=" + this._liveProcs() + " max=" + this._rootEng().maxProcs + " root=" + (this._rootEng() === this) + " depth=" + (this._iuDepth|0));
          if (this._liveProcs() >= this._rootEng().maxProcs) { ret(-11n); break; }   // EAGAIN: the sandbox's process limit (see _liveProcs)
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
        let path = this.readPath(a1);
        const readVec = (p) => { const out = [];
          for (let i = 0n; ; i += 8n) { const sp = this.mem.read(p + i, 8n); if (sp === 0n) break;
            out.push(this.readPath(sp)); } return out; };
        let argv = a2 ? readVec(a2) : [path];
        const envp = a3 ? readVec(a3) : [];
        let bytes = this.lookup(path);
        if (!bytes) { ret(-2n); break; }                     // ENOENT
        // `#!interpreter [arg]` scripts: the kernel re-executes the interpreter
        // with the script's path and the original arguments. Up to 5 levels.
        for (let depth = 0; bytes[0] === 0x23 && bytes[1] === 0x21; depth++) {
          if (depth >= 5) { ret(-40n); break; }              // ELOOP
          let eol = 2; while (eol < Math.min(bytes.length, 256) && bytes[eol] !== 10) eol++;
          const line = new TextDecoder().decode(bytes.subarray(2, eol)).trim();
          const sp = line.search(/\s/), interp = sp < 0 ? line : line.slice(0, sp), iarg = sp < 0 ? '' : line.slice(sp).trim();
          if (!interp) { ret(-8n); break; }                  // ENOEXEC
          const ib = this.lookup(interp);
          if (!ib) { ret(-2n); bytes = null; break; }
          argv = [interp, ...(iarg ? [iarg] : []), path, ...argv.slice(1)];
          path = interp; bytes = ib;
        }
        if (!bytes) break;
        // The child becomes its own engine: fresh memory image for the new
        // binary, the vfork-window fd table carried over so the wire pipes
        // the parent set up (dup2 before exec) connect the two engines.
        const ceng = new LinuxEngine(bytes, {
          argv, env: envp, files: this.files, mtimes: this.mtimes,
          memMB: this.childMemMB ?? 256, assembleWat: this.assembleWat,   // small: plug-ins are lean, and the tab already holds the parent's image
          aotCallThreshold: this.aotCallThreshold, aotLoopThreshold: this.aotLoopThreshold,
          xserver: this.xserver });
        if (this.strace) ceng.strace = [];                   // a traced parent traces its children
        if (this.childMemMB !== undefined) ceng.childMemMB = this.childMemMB;
        if (this._ncpu !== undefined) ceng._ncpu = this._ncpu;
        if (this.mem.cpuV2) ceng.mem.cpuV2 = true;
        if (this.unitStore) ceng.unitStore = this.unitStore;
        if (this.childUnitMaxFuncs !== undefined) { ceng.childUnitMaxFuncs = this.childUnitMaxFuncs; ceng.childUnitMaxInsns = this.childUnitMaxInsns; }   // grandchildren too
        if (this.shadowChildLib) { ceng.shadowLib = ceng.shadowChildLib = this.shadowChildLib; ceng.shadowMax = this.shadowMax; }   // the differential shadow covers exec'd programs
        if (this.chainSlow) ceng.chainSlow = true;   // grandchildren too (cargo -> rustc -> cc -> collect2 -> ld)
        if (this.assembleWatDeferred) { ceng.assembleWatDeferred = this.assembleWatDeferred; ceng.pumpAsm = this.pumpAsm; }
        ceng.sigign = new Set(t.proc?.sigign ?? this.sigign ?? []);   // exec keeps ignored signals ignored (handlers reset to default)
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
          ceng.unitBytes = (k) => cache.get(k.toString(16)) ?? ceng._diskUnit(k);   // this run's units, then the disk store
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
        (this.children ??= []).push({ pid: t.proc.pid, eng: ceng, exited: null, pp: t.proc.parent.proc ?? null });   // pp: the process that forked it (null = the main one)
        ceng.pid = t.proc.pid; ceng.ppid = this.pid ?? 1;
        { const r = this._pgrec(t); ceng.pgid = r.pgid; ceng.sid = r.sid; ceng.ctty = r.ctty ?? null; }
        t.state = 'dead'; this._killProcSiblings(t);
        this._pipeEofSweep(skipped);
        this._vforkRollback(t);
        t.proc.parent.state = 'run'; this._vforkThaw(t.proc.parent);   // vfork release
        if (this.onSpawn) this.onSpawn(t.proc.pid, path, argv);
        this.block(null); ret(0n); break; }
      case 61: {                                             // wait4(pid, status*, options, rusage)
        const pid = Number(BigInt.asIntN(32, a1)), opts = Number(a3);
        const kids = this.children ?? [];
        const me = this.threads[this.ti].proc ?? null;         // which process asks: a window child, or the main one
        const mine = kids.filter(c => (c.pp ?? null) === me && (pid <= 0 || c.pid === pid));   // only its own children (a subshell must not reap its parent's)
        if (!mine.length) { ret(-10n); break; }              // ECHILD
        if ((this.threads[this.ti].proc ?? this).nocldwait) {   // SA_NOCLDWAIT: children are reaped as they exit
          for (const c of mine) if (c.exited !== null || (c.eng && c.eng.exitCode !== null)) this.children.splice(this.children.indexOf(c), 1);
          ret(-10n); break; }
        const done = mine.find(c => c.exited !== null || (c.eng && c.eng.exitCode !== null));
        if (!done) {
          if (opts & 2) { const st = mine.find(c => c.eng?.stopEv); if (st) { const sig = st.eng.stopEv; st.eng.stopEv = null; st.eng._stopSeen = false;   // WUNTRACED: a stopped child, reported once
            if (a2) this.mem.write(a2, 4n, BigInt((sig << 8) | 0x7f)); ret(BigInt(st.pid)); break; } }
          if (opts & 8) { const ct = mine.find(c => c.eng?.contEv); if (ct) { ct.eng.contEv = false; ct.eng._contSeen = false;   // WCONTINUED
            if (a2) this.mem.write(a2, 4n, 0xffffn); ret(BigInt(ct.pid)); break; } }
          if (opts & 1) ret(0n); else this.block(null); break; }   // WNOHANG / block
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
      case 157: {                                            // prctl(option, ...)
        const op = Number(a1), t = this.threads[this.ti];
        if (op === 15 && ENV.OXWASM_CLONETRACE) { let n2 = ''; for (let i = 0; i < 15; i++) { const c = Number(this.mem.read(a2 + BigInt(i), 1n)); if (!c) break; n2 += String.fromCharCode(c); } console.error(`[prctl-name] ${n2} disp=${this.stats.disp} ti=${this.ti}`); }
        if (op === 15) { let nm = ''; for (let i = 0; i < 15; i++) { const c = Number(this.mem.read(a2 + BigInt(i), 1n)); if (!c) break; nm += String.fromCharCode(c); } t.comm = nm; }   // PR_SET_NAME
        else if (op === 16) { const nm = t.comm ?? this.argv?.[0]?.split('/').pop()?.slice(0, 15) ?? ''; this.jsnap(a2, 16); for (let i = 0; i < 16; i++) this.mem.write(a2 + BigInt(i), 1n, BigInt(i < nm.length ? nm.charCodeAt(i) : 0)); }   // PR_GET_NAME
        else if (op === 3) { ret(1n); break; }                // PR_GET_DUMPABLE
        else if (op === 30) { ret(50000n); break; }           // PR_GET_TIMERSLACK
        else if (op === 23) { ret(1n); break; }               // PR_CAPBSET_READ
        else if (op === 40 || op === 37 || op === 2) { if (a2) { this.jsnap(a2, 8); this.mem.write(a2, 8n, 0n); } ret(0n); break; }   // PR_GET_TID_ADDRESS / GET_CHILD_SUBREAPER / GET_PDEATHSIG
        else if (![1, 4, 7, 8, 21, 22, 29, 36, 38, 39, 41, 42, 0x59616d61, 0x53564d41].includes(op)) { ret(-22n); break; }   // EINVAL: an option Linux does not know either
        ret(0n); break; }
      case 135: {                                            // personality(persona): query with 0xffffffff, else set
        const cur = this._personality ?? 0; if (Number(a1 & 0xffffffffn) !== 0xffffffff) this._personality = Number(a1 & 0xffffffffn); ret(BigInt(cur)); break; }
      case 115: {                                            // getgroups(size, list*)
        const g = this._credOf().groups, n = Number(a1);
        if (n === 0) { ret(BigInt(g.length)); break; }
        if (n < g.length) { ret(-22n); break; }
        g.forEach((x, i) => { this.jsnap(a2 + BigInt(i * 4), 4); this.mem.write(a2 + BigInt(i * 4), 4n, BigInt(x)); }); ret(BigInt(g.length)); break; }
      case 140: ret(20n); break;                             // getpriority: nice 0 (the kernel's 20 - nice form)
      case 141: ret(0n); break;                              // setpriority
      case 100: {                                            // times(tms*): clock ticks (100 Hz) of wall time as user time
        const ticks = BigInt(Math.floor(this.nowMs() / 10));
        if (a1) { this.jsnap(a1, 32); this.mem.write(a1, 8n, ticks); this.mem.write(a1 + 8n, 8n, 0n); this.mem.write(a1 + 16n, 8n, 0n); this.mem.write(a1 + 24n, 8n, 0n); }
        ret(ticks); break; }
      case 129: case 297: {                                  // rt_sigqueueinfo(pid, sig, info*) / rt_tgsigqueueinfo(tgid, tid, sig, info*): a signal with a value
        const sig = Number(nr === 129 ? a2 : a3), ip = nr === 129 ? a3 : cpu.regs[10];
        if (sig < 1 || sig > 64) { ret(-22n); break; }
        const code = Number(BigInt.asIntN(32, this.mem.read(ip + 8n, 4n))), sival = this.mem.read(ip + 24n, 8n);
        const pid = Number(BigInt.asIntN(32, a1));
        const kid = (this.children ?? []).find(c => c.pid === pid && c.exited === null);
        if (kid) { kid.eng.raiseSignal(sig, null, { pid: 1, code, sival }); ret(0n); break; }
        const self = this.threads[this.ti].proc?.pid ?? this.pid ?? 1;
        if (pid > 1 && pid !== self) { ret(-3n); break; }    // ESRCH
        this.raiseSignal(sig, null, { pid: 1, code, sival }); ret(0n); break; }
      case 247: {                                            // waitid(idtype, id, infop*, options, rusage)
        const idtype = Number(a1), id = Number(BigInt.asIntN(32, a2)), opts = Number(cpu.regs[10]);
        const kids = this.children ?? [];
        const me = this.threads[this.ti].proc ?? null;
        const mine = kids.filter(c => (c.pp ?? null) === me && (idtype === 0 || (idtype === 1 && c.pid === id) || idtype === 2));   // P_ALL / P_PID / P_PGID (one group here)
        if (!mine.length) { ret(-10n); break; }              // ECHILD
        const done = (opts & 4) ? mine.find(c => c.exited !== null || (c.eng && c.eng.exitCode !== null)) : null;   // WEXITED
        if (!done) {
          if (opts & 2) { const st = mine.find(c => c.eng?.stopEv); if (st) { const sig = st.eng.stopEv; st.eng.stopEv = null; st.eng._stopSeen = false;   // WSTOPPED
            if (a3) this._writeSiginfo(a3, 17, { code: 5, pid: st.pid, status: sig }); ret(0n); break; } }
          if (opts & 8) { const ct = mine.find(c => c.eng?.contEv); if (ct) { ct.eng.contEv = false; ct.eng._contSeen = false;   // WCONTINUED
            if (a3) this._writeSiginfo(a3, 17, { code: 6, pid: ct.pid, status: 18 }); ret(0n); break; } }
          if (opts & 1) { if (a3) { this.jsnap(a3, 128); for (let o = 0n; o < 128n; o += 8n) this.mem.write(a3 + o, 8n, 0n); } ret(0n); } else this.block(null); break; }   // WNOHANG: si_pid 0
        const code = done.exited ?? done.eng.exitCode, tsig = done.sig ?? done.eng?.termSig;
        if (a3) this._writeSiginfo(a3, 17, { code: tsig ? 2 : 1, pid: done.pid, status: tsig ? (tsig & 0x7f) : (code & 0xff) });   // CLD_KILLED / CLD_EXITED
        if (!(opts & 0x01000000)) this.children.splice(this.children.indexOf(done), 1);   // WNOWAIT leaves it reapable
        ret(0n); break; }
      case 295: case 296: case 327: case 328: {              // preadv / pwritev (and the v2 forms): readv/writev at an offset that does not move the position
        const h = this.fds.get(Number(a1)); if (!h) { ret(-9n); break; }
        if (h.bytes === undefined) { ret(-29n); break; }     // ESPIPE
        const v = new DataView(this.wmem.buffer);
        let pos = Number(BigInt.asIntN(64, cpu.regs[10])); const cur = pos < 0; if (cur) pos = h.pos;
        let done = 0;
        for (let i = 0; i < Number(a3); i++) {
          const o = this.RAMOFF + Number(a2 - this.base) + i * 16;
          const bp = v.getBigUint64(o, true), l = Number(v.getBigUint64(o + 8, true)); if (!l) continue;
          if (nr === 296 || nr === 328) {
            if (!h.writable) { ret(-9n); break; }
            this.guardRange(bp, l); const bytes = this.ram.slice(Number(bp - this.base), Number(bp - this.base) + l);
            if (h.path) (this.dirtyFiles ??= new Set()).add(h.path);
            if (pos + done + l > h.bytes.length) this._growFile(h, pos + done + l);
            h.bytes.set(bytes, pos + done); this._mapsAbsorb(h.path, pos + done, bytes); done += l;
          } else {
            if (h.path && this.maps?.length) this._mapsFlushPath(h.path);
            const n = Math.max(0, Math.min(l, h.bytes.length - pos - done)); if (n <= 0) break;
            this.jsnap(bp, n); this.ram.set(h.bytes.subarray(pos + done, pos + done + n), Number(bp - this.base)); done += n; if (n < l) break;
          }
        }
        if (cur) h.pos = pos + done;
        ret(BigInt(done)); break; }
      case 204: {                                            // sched_getaffinity: ncpu CPUs
        const n = Math.min(Number(a2), 8);
        const o = this.RAMOFF + Number(a3 - this.base);
        new Uint8Array(this.wmem.buffer, o, n).fill(0);
        new DataView(this.wmem.buffer).setUint8(o, (1 << Math.min(this.ncpu, 8)) - 1);
        ret(8n); break; }
      case 60: case 231: {                                   // exit / exit_group
        // OXWASM_STRACE_EXIT=1 (with OXWASM_STRACE=1): a guest that exits non-zero without a word shows its last syscalls
        if (ENV.OXWASM_STRACE_EXIT && this.strace && (a1 & 0xffn) !== 0n && this._ctor?.argv?.[0]?.includes('opencode')) console.error(`[exit ${nr} code=${a1 & 0xffn} tid=${this.threads[this.ti]?.id} rip=${cpu.rip.toString(16)}] last:\n  ` + this.strace.slice(-(+ENV.OXWASM_STRACE_N || 40)).join('\n  '));
        if ((ENV.OXWASM_AOTSTOP || AOTSKIP) && this._ctor?.argv?.[0]?.includes('opencode')) console.error('[aotstop] exit total disp', this.stats.disp, 'skipped', this.stats.skipped || 0);
        if (this._shadowStats && this._ctor?.argv?.[0]?.includes('opencode')) { const st = this._shadowStats; console.error(`[shadow] tried=${st.tried} compared=${st.compared} aborted=${st.aborted} diverged=${st.diverged} noexit=${[...(st.noexit ?? [])].map(([k, v]) => k.toString(16) + ':' + v).join(',')} flagOnly=${[...(st.flagOnly ?? [])].map(([k, v]) => k + ':' + v).join(',')} abortedAt=${[...(st.abortedAt ?? [])].map(([k, v]) => k + ':' + v).join(',')}`); }
        if (ENV.OXWASM_DUMPMEM && this._ctor?.argv?.[0]?.includes('opencode')) { try { const [ah, lh, file] = ENV.OXWASM_DUMPMEM.split(':'); const at = BigInt('0x' + ah), len = parseInt(lh, 16); const out = new Uint8Array(len); for (let i = 0; i < len; i++) out[i] = Number(this.mem.read(at + BigInt(i), 1n)); process.getBuiltinModule('node:fs').writeFileSync(file, out); } catch (e) { console.error('[dumpmem]', e.message); } }
        if (this._mmapStat) { const ms = this._mmapStat; console.error(`[mmapstat] mmap n=${ms.mmapN} ${ms.mmapB >> 20n}MB munmap n=${ms.munmapN} ${ms.munmapB >> 20n}MB mremap=${ms.mremapN} mmapNext=${this.mmapNext?.toString(16)} base=${this._mmapBase?.toString(16)} holes=${this._mmapHoles?.length} holeMB=${(this._mmapHoles ?? []).reduce((t, [l, h]) => t + (h - l), 0n) >> 20n} bySize=${[...ms.bySize].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => k + 'x' + v).join(' ')}`); }
        if (ENV.OXWASM_SCTRACE && this._sct?.length) { process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_SCTRACE, this._sct.join('\n') + '\n'); this._sct.length = 0; }
        if (ENV.OXWASM_IHIST && globalThis.__ihist && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_IHIST)) { const b = new Map(); for (const [k, v] of globalThis.__ihist) { const kk = (BigInt(k) >> 6n << 6n).toString(16); b.set(kk, (b.get(kk) || 0) + v); } console.error('[ihist] ' + [...b].sort((x, y) => y[1] - x[1]).slice(0, 60).map(([k, v]) => k + '=' + v).join(' ')); }
        if (this.calloutLog && ENV.OXWASM_STATS && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_STATS)) console.error('[callouts] ' + [...this.calloutLog].sort((x, y) => y[1] - x[1]).slice(0, 30).map(([k, v]) => k + ' x' + v).join(' | '));
        if (this.deoptLog && ENV.OXWASM_STATS && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_STATS)) console.error('[deopts] ' + [...this.deoptLog].sort((x, y) => y[1] - x[1]).slice(0, 40).map(([k, v]) => k.toString(16) + ' x' + v).join(' '));
        if (ENV.OXWASM_STATS && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_STATS)) console.error('[aotfail] ' + this.hotFailures(30).slice(0, 40).map((f) => f.addr.toString(16) + ' x' + f.calls + ' ' + f.why).join(' | '));
        if (ENV.OXWASM_STATS && this._ctor?.argv?.[0]?.includes(ENV.OXWASM_STATS)) { const st = this.stats; console.error(`[stats] ${this._ctor.argv[0]} interp=${st.interpreted} aotRuns=${st.aotRuns} compiledRuns=${st.compiledRuns} units=${this.aotFns.size} syscalls=${Object.values(st.syscalls).reduce((x, y) => x + y, 0)} wallMs=${Math.round(this.nowMs())} sysMs=${JSON.stringify(Object.fromEntries(Object.entries(st.sysMs ?? {}).filter(([, v]) => v > 50).map(([k, v]) => [k, Math.round(v)])))} tiers=${JSON.stringify(st.tiers)} extra=${JSON.stringify(Object.fromEntries(Object.entries(st).filter(([k, v]) => typeof v === 'number' && !['interpreted', 'aotRuns', 'compiledRuns'].includes(k))))}`); }
        const t = this.threads[this.ti];
        if (this._shmAt?.length) this._shmExit(t);            // shared-memory attaches reach the segment before the image goes
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
          (this.children ??= []).push({ pid: t.proc.pid, eng: null, exited: Number(a1 & 0xffn), pp: t.proc.parent.proc ?? null });
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
      case 201: { const now = BigInt(Math.floor(Date.now() / 1000)); if (a1) { this.jsnap(a1, 8); this.mem.write(a1, 8n, now); } ret(now); break; }   // time(time_t*): the kernel stores through the pointer too
      case 309: {                                             // getcpu(cpu*, node*, tcache): one CPU, one node
        if (a1) this.mem.write(a1, 4n, 0n); if (a2) this.mem.write(a2, 4n, 0n); ret(0n); break; }
      case 188: case 189: case 190:                           // setxattr / lsetxattr / fsetxattr(path|fd, name, value, size, flags)
      case 191: case 192: case 193:                           // getxattr / lgetxattr / fgetxattr
      case 194: case 195: case 196:                           // listxattr / llistxattr / flistxattr
      case 197: case 198: case 199: {                         // removexattr / lremovexattr / fremovexattr
        // Extended attributes in the user namespace live per path in fsMeta;
        // the other namespaces answer as a filesystem without them would.
        const byFd = nr === 190 || nr === 193 || nr === 196 || nr === 199;
        const xp = byFd ? this.fds.get(Number(a1))?.path : this.norm(this.readPath(a1));
        if (xp === undefined || xp === null) { ret(-9n); break; }
        if (!byFd && this.files[xp] === undefined && !this.isDir(xp) && !this._fsMeta().links.has(xp)) { ret(-2n); break; }
        const xa = (this._fsMeta().xattrs ??= new Map()); const kind = nr <= 190 ? 'set' : nr <= 193 ? 'get' : nr <= 196 ? 'list' : 'remove';
        if (kind === 'list') { const names = [...(xa.get(xp)?.keys() ?? [])]; const blob = new TextEncoder().encode(names.map(n => n + '\0').join(''));
          if (Number(a3) === 0) { ret(BigInt(blob.length)); break; } if (blob.length > Number(a3)) { ret(-34n); break; }
          this.ram.set(blob, Number(a2 - this.base)); ret(BigInt(blob.length)); break; }
        const name = this.readPath(a2);
        if (!name.startsWith('user.')) { ret(kind === 'set' ? -95n : -61n); break; }   // ENOTSUP / ENODATA
        const attrs = xa.get(xp) ?? new Map();
        if (kind === 'set') { const fl = Number(cpu.regs[8]); if ((fl & 1) && attrs.has(name)) { ret(-17n); break; } if ((fl & 2) && !attrs.has(name)) { ret(-61n); break; }
          attrs.set(name, this.ram.slice(Number(a3 - this.base), Number(a3 - this.base) + Number(cpu.regs[10]))); xa.set(xp, attrs); ret(0n); break; }
        if (kind === 'remove') { if (!attrs.delete(name)) { ret(-61n); break; } ret(0n); break; }
        const v = attrs.get(name); if (v === undefined) { ret(-61n); break; }
        const cap = Number(cpu.regs[10]); if (cap === 0) { ret(BigInt(v.length)); break; } if (v.length > cap) { ret(-34n); break; }
        this.ram.set(v, Number(a3 - this.base)); ret(BigInt(v.length)); break; }
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
        if (nr === 230 && (Number(a1) > 9 || Number(a1) === 3)) { ret(-22n); break; }   // EINVAL: unknown clock, or CLOCK_THREAD_CPUTIME_ID
        const o = this.RAMOFF + Number(req - this.base);
        const v = new DataView(this.wmem.buffer);
        { const sec = v.getBigInt64(o, true), nsec = v.getBigInt64(o + 8, true);
          if (sec < 0n || nsec < 0n || nsec >= 1000000000n) { ret(-22n); break; } }   // EINVAL (a negative nsec became an endless sleep)
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
          // kill(pid): a process anywhere in the tree by pid; 0 the caller's
          // group; -1 everyone but the caller; -pgid a group (a shell's
          // `kill %1` is kill(-pgid) - it used to reach the shell itself)
          const pid = Number(BigInt.asIntN(32, a1)), self = this.threads[this.ti].proc?.pid ?? this.pid ?? 1, info = { pid: self, code: 0 };
          if (pid === 0 || pid < -1) { const n = this._signalPgrp(pid === 0 ? this._pgrec(this.threads[this.ti]).pgid : -pid, sig, info); ret(n ? 0n : -3n); break; }
          if (pid === -1) { this._signalAll(sig, info); ret(0n); break; }
          if (pid === self) { this.raiseSignal(sig, null, info); ret(0n); break; }
          const tgt = this._findProc(pid); if (!tgt) { ret(-3n); break; }   // ESRCH
          tgt.eng.raiseSignal(sig, tgt.thread ? tgt.thread.id : null, info);
        } else {
          const tid = Number(nr === 200 ? a1 : a2);
          if (!this.threads.some(t => t.id === tid) && tid > 1) { ret(-3n); break; }
          this.raiseSignal(sig, tid <= 1 ? this.threads[0].id : tid, { pid: 1, code: -6 });   // SI_TKILL
        }
        ret(0n); break; }
      // Credentials are tracked per process (inherited by children) so that
      // programs which drop privileges and then check the result (apt running
      // its download methods as _apt) see what they set. Nothing is enforced:
      // file access does not consult them.
      case 102: case 104: case 107: case 108: { const c = this._credOf(); ret(BigInt(nr === 102 ? c.ruid : nr === 107 ? c.euid : nr === 104 ? c.rgid : c.egid)); break; }
      case 105: case 106: case 113: case 114: case 117: case 119: {
        const c = this._credOf(), U = (x) => { const n = Number(x & 0xFFFFFFFFn); return n === 0xFFFFFFFF ? -1 : n; };
        const u = nr === 105 || nr === 113 || nr === 117, r = u ? 'ruid' : 'rgid', e = u ? 'euid' : 'egid', sv = u ? 'suid' : 'sgid';
        const root = c.euid === 0;
        if (nr === 105 || nr === 106) {
          const v = U(a1); if (v < 0) { ret(-22n); break; }
          if (root) { c[r] = c[e] = c[sv] = v; } else if (v === c[r] || v === c[sv]) c[e] = v; else { ret(-1n); break; }
        } else if (nr === 113 || nr === 114) {
          const rv = U(a1), ev = U(a2), ok = (x) => x < 0 || root || x === c[r] || x === c[e] || x === c[sv];
          if (!ok(rv) || !ok(ev)) { ret(-1n); break; }
          if (rv >= 0 || (ev >= 0 && ev !== c[r])) c[sv] = ev >= 0 ? ev : c[e];
          if (rv >= 0) c[r] = rv; if (ev >= 0) c[e] = ev;
        } else {
          const rv = U(a1), ev = U(a2), sx = U(a3), ok = (x) => x < 0 || root || x === c[r] || x === c[e] || x === c[sv];
          if (!ok(rv) || !ok(ev) || !ok(sx)) { ret(-1n); break; }
          if (rv >= 0) c[r] = rv; if (ev >= 0) c[e] = ev; if (sx >= 0) c[sv] = sx;
        }
        ret(0n); break; }
      case 118: case 120: {                                   // getresuid / getresgid(r*, e*, s*)
        const c = this._credOf(), vals = nr === 118 ? [c.ruid, c.euid, c.suid] : [c.rgid, c.egid, c.sgid];
        [a1, a2, a3].forEach((p, i) => { this.jsnap(p, 4); this.mem.write(p, 4n, BigInt(vals[i])); }); ret(0n); break; }
      case 116: {                                             // setgroups(size, list*)
        const n = Number(a1); if (n < 0 || n > 65536) { ret(-22n); break; }
        const c = this._credOf(); c.groups = []; for (let i = 0; i < n; i++) c.groups.push(Number(this.mem.read(a2 + BigInt(i * 4), 4n)));
        ret(0n); break; }
      // Credentials and ownership are single-user here: everything runs as
      // one uid, so these succeed rather than reporting ENOSYS. xterm calls
      // setegid() (i.e. setresgid) to drop privileges after opening its pty
      // and treats the failure as fatal — "setegid(0): Function not
      // implemented", then "Cannot chown /dev/pts/0".
      case 92: case 93: case 94: case 260:                             // chown / fchown / fchownat
        ret(0n); break;
      case 90: case 91: case 268: {                           // chmod / fchmod / fchmodat: the permission bits are remembered per path
        let p, mode; if (nr === 91) { const h = this.fds.get(Number(a1)); p = h?.path; mode = Number(a2); } else { p = this.norm(nr === 90 ? this.readPath(a1) : this.atPath(a1, a2)); mode = Number(nr === 90 ? a2 : a3); }
        if (p) (this._fsMeta().modes ??= new Map()).set(p, mode & 0o7777);
        ret(0n); break; }
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
        if (nr === 257) {                                     // a relative path needs a directory fd
          const dfd = Number(BigInt.asIntN(32, a1));
          if (dfd !== -100 && this.readPath(a2).charCodeAt(0) !== 47) { const dh = this.fds.get(dfd); if (!dh) { ret(-9n); break; } if (!dh.isdir) { ret(-20n); break; } } }   // EBADF / ENOTDIR
        const p = nr === 257 ? this.atPath(a1, a2) : this.readPath(a1);
        const flags = Number(nr === 257 ? a3 : a2);
        // O_TMPFILE (O_DIRECTORY|0x400000): an unnamed regular file in that directory.
        // apt writes the signed text it hands to gpgv through one; without this the
        // open "succeeded" as a directory and the first write failed with EBADF.
        if ((flags & 0x410000) === 0x410000 && this.isDir(p)) {
          const fd = this.allocFd();
          this.fds.set(fd, { bytes: new Uint8Array(0), pos: 0, writable: true, memfd: '(tmpfile)' });
          if (flags & 0x80000) this.cloexec.add(fd);
          ret(BigInt(fd)); break;
        }
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
          if (np === '/dev/tty') {                           // the controlling terminal: a pty this session took, else the host terminal, else ENXIO
            const r = this._pgrec(this.threads[this.ti]);
            if (r.ctty) { const fd = this.allocFd(); this.fds.set(fd, this.ptsHandle(r.ctty)); ret(BigInt(fd)); break; }
            if (!this.tty) { ret(-6n); break; }
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
          if (flags & 0x40) {                                 // O_CREAT: writable guest files, in a directory that exists
            { const np = this.norm(p), i = np.lastIndexOf('/'); if (i > 0 && !this.isDir(np.slice(0, i))) { ret(-2n); break; } }   // ENOENT (a bare name lives in the cwd)
            f = new Uint8Array(0);
            this.files[this.norm(p)] = f; this.fsBump();
            if (this.mtimes) this.mtimes[this.norm(p)] = Math.floor(this.nowMs() / 1000);
            this._inotify(this.norm(p), 0x100);                 // IN_CREATE
          } else { ret(-2n); break; }                         // ENOENT
        } else if ((flags & 0xc0) === 0xc0 && !(flags & 0x200000)) { ret(-17n); break; }   // O_CREAT|O_EXCL on an existing file: EEXIST
        else if ((flags & 0x200) && !(flags & 0x200000)) {    // O_TRUNC (O_PATH ignores it)
          f = new Uint8Array(0);
          this.files[this.norm(p)] = f;
        }
        const fd = this.allocFd();
        const wr = (flags & 3) !== 0 && !(flags & 0x200000);   // O_WRONLY / O_RDWR (an O_PATH descriptor does no I/O)
        this.fds.set(fd, { bytes: f, pos: (flags & 0x400) ? f.length : 0,
                           path: this.resolve(this.norm(p)), writable: wr, append: !!(flags & 0x400), opath: !!(flags & 0x200000) });
        ret(BigInt(fd)); break; }
      case 0: {                                               // read(fd, buf, len)
        const fd = Number(a1), h = this.fds.get(fd);
        if (!h) { ret(fd === 0 ? 0n : -9n); break; }          // stdin -> EOF
        if (h.opath) { ret(-9n); break; }                     // EBADF: O_PATH
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
          const r = this._pipeDrain(h, a2, Number(a3)); if (r !== null) ret(r); break;
        }
        if (h.ino) {                                          // inotify: struct inotify_event records
          const q = h.ino.queue; if (!q.length) { if (h.nonblock) { ret(-11n); break; } this.block(null); break; }
          const cap = Number(a3); let n = 0;
          while (q.length) { const e = q[0], nb = new TextEncoder().encode(e.name), len = nb.length ? ((nb.length + 1 + 15) & ~15) : 0;
            if (n + 16 + len > cap) break; q.shift();
            const o = this.RAMOFF + Number(a2 - this.base) + n; this.jsnap(a2 + BigInt(n), 16 + len);
            const dv = new DataView(this.wmem.buffer); dv.setInt32(o, e.wd, true); dv.setUint32(o + 4, e.mask, true); dv.setUint32(o + 8, 0, true); dv.setUint32(o + 12, len, true);
            new Uint8Array(this.wmem.buffer, o + 16, len).fill(0); if (len) new Uint8Array(this.wmem.buffer, o + 16, len).set(nb); n += 16 + len; }
          if (n === 0 && q.length) { ret(-22n); break; }      // buffer smaller than one event
          ret(BigInt(n)); break;
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
          if (h.gen === 'zero') dst.fill(0); else for (let i = 0; i < n; i += 65536) fillRandom(dst.subarray(i, Math.min(n, i + 65536)));
          h.pos += n; ret(BigInt(n)); break;
        }
        if (h.isdir) { ret(-21n); break; }                    // EISDIR: a directory reads through getdents64 only
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
        if (!ch && cfd > 2) { ret(-9n); break; }              // EBADF (0-2 are the implicit terminal handles)
        this.fds.delete(cfd); this.cloexec.delete(cfd);
        if (ch?.pipe && (ch.mode === 'w' || ch.peer)) this._pipeEofSweep([ch]);
        if (ch?.sk?.name && !this._handleAlive(ch)) this._sockUnreg(ch);
        if (ch && this._fsMeta().flocks?.size) this._flockRelease(ch);
        if (ch && this._fsMeta().rlocks?.size) this._rlockClose(ch);
        ret(0n); break; }                                     // close
      case 436: {                                             // close_range(first, last, flags)
        const first = Number(a1), last = Math.min(Number(BigInt.asUintN(32, a2)), 1 << 20), fl = Number(a3);
        for (const fd of [...this.fds.keys()]) if (fd >= first && fd <= last) {
          if (fl & 4) { this.cloexec.add(fd); continue; }     // CLOSE_RANGE_CLOEXEC
          const ch = this.fds.get(fd); this.fds.delete(fd); this.cloexec.delete(fd);
          if (ch?.pipe && (ch.mode === 'w' || ch.peer)) this._pipeEofSweep([ch]);
          if (ch?.sk?.name && !this._handleAlive(ch)) this._sockUnreg(ch);
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
        const np = w === 0 ? Number(off) : w === 1 ? h.pos + Number(off) : h.bytes.length + Number(off);
        if (np < 0 || w > 4) { ret(-22n); break; }           // EINVAL (SEEK_DATA/SEEK_HOLE fold into the end/current forms above)
        h.pos = np; ret(BigInt(h.pos)); break; }
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
                     this._fsMeta().links.has(this.resolveParent(p))) {
            statPath = this.resolveParent(p);
            size = this._fsMeta().links.get(statPath).length; mode = 0o120777;
          } else if (this._ptyStat(this.norm(p))) {
            const ps = this._ptyStat(this.norm(p)); this.writeStat(cpu.regs[2], this.norm(p), 0, ps.mode, ps.rdev, ps.ino); ret(0n); break;
          } else if (this.isTtyPath(p)) {
            this.writeStat(cpu.regs[2], '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break;
          } else {
            const f = this.lookup(p);
            if (f !== undefined) { size = f.length; mode = this.fileMode(f, p); }
            else if (this.isDir(p)) { size = 4096; mode = 0o040755; }
            else if (this._fifoAt(p)) { size = 0; mode = 0o010644; }
            else if (this._sockAt(p)) { size = 0; mode = 0o140755; }
            else { ret(-2n); break; }                         // ENOENT
            statPath = this.resolve(this.norm(p));
          }
        } else {
          const h = this.fds.get(Number(a1));
          if (this.tty && (Number(a1) <= 2 || h?.istty)) {     // terminal: match stat("/dev/pts/0")
            this.writeStat(a2, '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break; }
          if (!h && Number(a1) > 2) { ret(-9n); break; }      // EBADF
          if (h?.pts || h?.ptm) { const ps = this._ptyStat(h.pts ? '/dev/pts/' + h.pts.n : '/dev/ptmx'); if (ps) { this.writeStat(a2, h.path, 0, ps.mode, ps.rdev, ps.ino); ret(0n); break; } }   // a pty end: the same numbers stat(path) gives
          if (h?.gen) { size = 0; mode = 0o020666; }                        // /dev/zero, /dev/urandom
          else if (h?.tfd || h?.sfd) { size = 0; mode = 0o0100600; }       // anon inode
          else if (h?.bytes) { size = h.bytes.length; mode = this.fileMode(h.bytes, h.path); statPath = h.path ? this.resolve(this.norm(h.path)) : null; }  // regular file
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
          const lp = this.resolveParent(p), t = this._fsMeta().links.get(lp);
          if (t !== undefined) { this.writeStat(a2, lp, t.length, 0o120777); ret(0n); break; }
        }
        if (this.debugPollAfter != null && this.nowMs() > this.debugPollAfter) {
          if (this.nowMs() - (this._dbgStatLast ?? 0) > 5000) { this._dbgStatLast = this.nowMs();
            console.error(`<statwd thr=${this.threads?.[this.ti]?.id} ${nr===6?'lstat':'stat'} ${p}>`); } }
        if (this._ptyStat(this.norm(p))) { const ps = this._ptyStat(this.norm(p)); this.writeStat(a2, this.norm(p), 0, ps.mode, ps.rdev, ps.ino); ret(0n); break; }
        if (this.isTtyPath(p)) {
          this.writeStat(a2, '/dev/pts/0', 0, 0o020620, 0x8800n, 1001n); ret(0n); break; }
        const f = this.lookup(p);
        if (f === undefined && !this.isDir(p)) {
          if (this._fifoAt(p)) { this.writeStat(a2, p, 0, 0o010644); ret(0n); break; }
          if (this._sockAt(p)) { this.writeStat(a2, p, 0, 0o140755); ret(0n); break; }
          ret(-2n); break; }                                  // ENOENT
        { const rp = this.resolve(this.norm(p)); this.writeStat(a2, rp, f ? f.length : 4096, f ? this.fileMode(f, rp) : 0o040755); }
        ret(0n); break; }
      case 17: {                                              // pread64(fd, buf, count, off)
        { const hh = this.fds.get(Number(a1)); if (hh?.bytes !== undefined) for (const m of this.maps ?? []) if (m.shared && m.h === hh) this._writeBackMap(m); }   // a MAP_SHARED view of this file (memfd): absorb its pages first
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
        const off = h.append ? h.bytes.length : Number(cpu.regs[10]);   // O_APPEND ignores the offset (Linux's documented bug)
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
      case 21: case 269: case 439: {                          // access / faccessat / faccessat2: existence, and X_OK against the file's mode bits
        const p = nr === 21 ? this.readPath(a1) : this.atPath(a1, a2), mode = Number(nr === 21 ? a2 : a3);
        const f = this.lookup(p);
        if (f === undefined && !this.isDir(p) && !this._fifoAt(p) && !this._sockAt(p)) { ret(-2n); break; }
        if ((mode & 1) && f !== undefined && !(this.fileMode(f, this.norm(p)) & 0o111)) { ret(-13n); break; }   // EACCES
        ret(0n); break; }
      case 63: {                                              // uname
        const put = (o, s) => { const b = new TextEncoder().encode(s + '\0');
          this.ram.set(b, Number(a1 - this.base) + o); };
        this.jsnap(a1, 390);                                  // the zero-fill covers the whole struct
        this.ram.fill(0, Number(a1 - this.base), Number(a1 - this.base) + 390);
        put(0, 'Linux'); put(65, 'oxwasm'); put(130, '6.1.0'); put(195, '#1 oxwasm');
        put(260, 'x86_64'); ret(0n); break; }
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
              if (ENV.OXWASM_FUTEXTRACE) { const v = new DataView(this.wmem.buffer); console.error(`[futex wait] tid=${this.threads[this.ti]?.id} addr=${a1.toString(16)} op=${a2.toString(16)} ts=${v.getBigUint64(o, true)}.${v.getBigUint64(o + 8, true)} now=${Date.now()} engine=${this.nowMs().toFixed(1)}`); }
              const v = new DataView(this.wmem.buffer);
              let ms = Number(v.getBigUint64(o, true)) * 1000 + Number(v.getBigUint64(o + 8, true)) / 1e6;
              if (op === 9) {                                 // WAIT_BITSET: absolute time
                if (ms > 1e11) ms = ms - Date.now() + this.nowMs();   // realtime epoch -> engine clock
              } else ms = this.nowMs() + ms;                  // WAIT: relative
              this._deadline = ms;
            } else if (this.nowMs() >= this._deadline) { if (ENV.OXWASM_FUTEXTRACE) { const o = this.RAMOFF + Number(tp - this.base), v = new DataView(this.wmem.buffer); console.error(`[futex ETIMEDOUT] tid=${this.threads[this.ti]?.id} addr=${a1.toString(16)} op=${a2.toString(16)} ts=${v.getBigUint64(o, true)}.${v.getBigUint64(o + 8, true)} now=${Date.now()} engine=${this.nowMs().toFixed(1)} deadline=${this._deadline.toFixed(1)} rip=${cpu.rip.toString(16)}`); } this._deadline = null; ret(-110n); break; }   // ETIMEDOUT
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
        if (tfd === Number(a1)) { ret(-22n); break; }         // EINVAL: an epoll fd cannot watch itself
        const th = this.fds.get(tfd); if (!th && tfd > 2) { ret(-9n); break; }   // EBADF
        if (op === 2) { ret(h.ep.interest.delete(tfd) ? 0n : -2n); break; }   // DEL: ENOENT when not registered
        if (th && (th.bytes !== undefined || th.isdir)) { ret(-1n); break; }   // EPERM: regular files and directories do not poll
        // epoll_event is packed on x86-64: u32 events + u64 data = 12 bytes
        const v = new DataView(this.wmem.buffer), o = this.RAMOFF + Number(cpu.regs[10] - this.base);
        const events = v.getUint32(o, true), data = v.getBigUint64(o + 4, true);
        if (op === 1 && h.ep.interest.has(tfd)) { ret(-17n); break; }  // ADD -> EEXIST
        if (op === 3 && !h.ep.interest.has(tfd)) { ret(-2n); break; }  // MOD -> ENOENT
        h.ep.interest.set(tfd, { events, data, rep: undefined, off: false }); ret(0n); break; }
      case 232: case 281: {                                   // epoll_wait / epoll_pwait
        const h = this.fds.get(Number(a1));
        if (!h?.ep) { ret(-9n); break; }
        const maxev = Number(a3);
        const timeoutMs = Number(BigInt.asIntN(32, cpu.regs[10] & 0xFFFFFFFFn));
        const readyR = (t) => !t ? false
          : t.pts ? this._ptsReady(t)
          : t.lsock ? t.lsock.backlog.length > 0
          : t.dsock ? t.dsock.queue.length > 0
          : t.pidfd ? this._pidDone(t.pidfd)
          : t.sock ? !!(t.sock.conn && t.sock.conn.readable())
          : t.ino ? t.ino.queue.length > 0
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
          if (it.off) continue;                               // EPOLLONESHOT reported once; MOD re-arms
          let re = 0;
          if ((it.events & 1) && readyR(t)) re |= 1;          // EPOLLIN
          { const cs = t.sk?.connecting?.conn.state;
            if ((it.events & 4) && cs !== 'connecting') re |= 4;   // EPOLLOUT: writable unless a connect is in flight
            if (cs === 'error') re |= 0x1c; }
          if (re && (it.events & 0x80000000)) {               // EPOLLET: only when something arrived since the last report
            const key = t.pipe ? `${t.pipe.wtot ?? 0}:${t.pipe.rtot ?? 0}:${!!t.pipe.weof}` : t.ev ? String(t.ev.count) : t.dsock ? t.dsock.queue.length : t.lsock ? t.lsock.backlog.length : t.ino ? t.ino.queue.length : t.tfd ? t.tfd.fired : Math.random();
            if (key === it.rep) re = 0; else it.rep = key; }
          if (re) { v.setUint32(base + n * 12, re, true); v.setBigUint64(base + n * 12 + 4, it.data, true); n++; if (it.events & 0x40000000) it.off = true; }
        }
        const now = this.nowMs();
        if (n > 0 || timeoutMs === 0 || (this._deadline != null && now >= this._deadline)) {
          // OXWASM_EPOLLSPIN=1: a wait that keeps returning without ever blocking is reported once with
          // what it reports and why (an fd that stays ready, a zero timeout, a deadline already past)
          if (ENV.OXWASM_EPOLLSPIN) { h.ep.spin = (h.ep.spin | 0) + 1; if (h.ep.spin === 20000) { const why = []; for (const [tfd, it] of h.ep.interest) { const t = this.fds.get(tfd); why.push(`fd${tfd}:${t ? Object.keys(t).filter((k) => ['pts','lsock','dsock','pidfd','sock','ino','pipe','ev','tfd','sfd','bytes'].includes(k) && t[k]).join('/') : 'closed'} ev=${it.events.toString(16)} ready=${t ? readyR(t) : '-'}${t?.pipe ? ` pipe(chunks=${t.pipe.chunks.length} weof=${!!t.pipe.weof})` : ''}${t?.ev ? ` evcount=${t.ev.count}` : ''}${t?.tfd ? ' timerfd' : ''}`); } console.error(`[epollspin] tid=${this.threads[this.ti]?.id} epfd=${a1} n=${n} timeout=${timeoutMs} deadline=${this._deadline} now=${now} ${why.join(' | ')}`); } }
          this._deadline = null; ret(BigInt(n)); break;
        }
        if (ENV.OXWASM_EPOLLSPIN) h.ep.spin = 0;
        this._deadline ??= (timeoutMs < 0 ? Infinity : now + timeoutMs);
        this.block(this._capByTimerfd(this._deadline, h.ep.interest.keys())); break; }
      case 13: {                                              // rt_sigaction(sig, act*, oldact*, sz)
        const sig = Number(a1);
        if (sig < 1 || sig > 64 || sig === 9 || sig === 19) { ret(-22n); break; }   // EINVAL
        // A fork child still in its vfork window shares this engine, but its
        // handlers are its own: posix_spawn (make, cargo) resets the
        // spawnattr signals to SIG_DFL in the child before exec, and doing
        // that on the parent's table erased make's SIGCHLD handler, so the
        // second job's exit was discarded and make waited in pselect6 forever.
        const tcur = this.threads[this.ti];
        const acts = tcur.proc ? (tcur.proc.sigact ??= new Map(this.sigact ?? [])) : (this.sigact ??= new Map());
        const ign = tcur.proc ? (tcur.proc.sigign ??= new Set(this.sigign ?? [])) : (this.sigign ??= new Set());
        if (a3) {                                             // report the old action
          const o = acts.get(sig) ?? { handler: 0n, flags: 0n, restorer: 0n, mask: 0n };
          this.jsnap(a3, 32);
          this.mem.write(a3, 8n, o.handler); this.mem.write(a3 + 8n, 8n, o.flags);
          this.mem.write(a3 + 16n, 8n, o.restorer); this.mem.write(a3 + 24n, 8n, o.mask);
        }
        if (a2) {
          const act = { handler: this.mem.read(a2, 8n), flags: this.mem.read(a2 + 8n, 8n),
                        restorer: this.mem.read(a2 + 16n, 8n), mask: this.mem.read(a2 + 24n, 8n) };
          if (sig === 17) (tcur.proc ?? this).nocldwait = !!(act.flags & 2n);   // SA_NOCLDWAIT survives a SIG_DFL disposition (which stores nothing)
          if (act.handler === 0n || act.handler === 1n) acts.delete(sig); else acts.set(sig, act);
          if (act.handler === 1n) ign.add(sig); else ign.delete(sig);
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
        dv.setUint16(o + 80, 1 + (this.children?.length ?? 0), true);   // procs: this process and its children
        dv.setUint16(o + 72, 8, true);                        // procs
        dv.setUint32(o + 100, 1, true);                       // mem_unit
        ret(0n); break; }
      case 332: {                                             // statx(dirfd, path, flags, mask, buf): the fstatat answer in the statx layout
        const flags = Number(a3), buf = cpu.regs[8];
        if (flags & ~0x7900) { ret(-22n); break; }             // EINVAL: bits statx does not take
        const saved = [cpu.regs[0], cpu.regs[7], cpu.regs[6], cpu.regs[2], cpu.regs[10], cpu.regs[8]];
        cpu.regs[0] = 262n; cpu.regs[2] = buf; cpu.regs[10] = BigInt(flags & 0x1100);   // newfstatat(dirfd, path, buf, flags) into the statx buffer as scratch
        this.syscall(cpu);
        const r = BigInt.asIntN(64, cpu.regs[0]);
        [, cpu.regs[7], cpu.regs[6], cpu.regs[2], cpu.regs[10], cpu.regs[8]] = saved;
        if (r < 0n || this.blocked) { ret(r); break; }
        const st = this.ram.slice(Number(buf - this.base), Number(buf - this.base) + 144), sv = new DataView(st.buffer, st.byteOffset, 144);
        this.jsnap(buf, 256); const o = this.RAMOFF + Number(buf - this.base); new Uint8Array(this.wmem.buffer, o, 256).fill(0);
        const v = new DataView(this.wmem.buffer);
        v.setUint32(o, 0x7ff, true); v.setUint32(o + 4, sv.getUint32(56, true), true);                    // stx_mask (the basic fields), blksize
        v.setUint32(o + 16, Number(sv.getBigUint64(16, true)), true); v.setUint32(o + 20, sv.getUint32(28, true), true); v.setUint32(o + 24, sv.getUint32(32, true), true);   // nlink uid gid
        v.setUint16(o + 28, sv.getUint32(24, true) & 0xffff, true);                                         // mode
        v.setBigUint64(o + 32, sv.getBigUint64(8, true), true); v.setBigUint64(o + 40, sv.getBigUint64(48, true), true); v.setBigUint64(o + 48, sv.getBigUint64(64, true), true);   // ino size blocks
        for (const [so, to] of [[72, 64], [104, 96], [88, 112]]) { v.setBigInt64(o + to, sv.getBigInt64(so, true), true); v.setUint32(o + to + 8, Number(sv.getBigUint64(so + 8, true)), true); }   // atime ctime mtime
        const rdev = sv.getBigUint64(40, true), dev = sv.getBigUint64(0, true);
        v.setUint32(o + 128, Number((rdev >> 8n) & 0xfffn), true); v.setUint32(o + 132, Number(rdev & 0xffn), true); v.setUint32(o + 136, Number((dev >> 8n) & 0xfffn), true); v.setUint32(o + 140, Number(dev & 0xffn), true);
        ret(0n); break; }
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
          v.setUint8(base + off + 18, this._dtype(h.path, name, isdir));  // DT_DIR / DT_LNK / DT_REG
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
          v.setUint8(base + off + reclen - 1, this._dtype(h.path, name, isdir));   // DT_DIR / DT_LNK / DT_REG
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
        if (cmd === 3) { ret(BigInt(2 | ((h?.sock?.nonblock || h?.nonblock) ? 0x800 : 0))); break; }   // F_GETFL: O_RDWR (+O_NONBLOCK on a nonblocking socket or pipe)
        if (cmd === 1032) { ret(h?.pipe ? BigInt(h.pipe.cap ?? PIPE_CAP) : -9n); break; }   // F_GETPIPE_SZ
        if (cmd === 1031) { if (!h?.pipe) { ret(-9n); break; } let sz = 4096; while (sz < Number(a3)) sz <<= 1; if (sz > (1 << 20)) { ret(-1n); break; } h.pipe.cap = sz; ret(BigInt(sz)); break; }   // F_SETPIPE_SZ: pages, a power of two, capped
        if (cmd === 4) { if (h?.sock) h.sock.nonblock = !!(Number(a3) & 0x800); if (h?.pipe || h?.dsock || h?.lsock) h.nonblock = !!(Number(a3) & 0x800); ret(0n); break; }  // F_SETFL
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
        if (a1 & (PAGE - 1n)) { ret(-22n); break; }         // EINVAL: the start must be page-aligned
        if (a3 === 4n && a2 > 0n) this._madvDontneed(a1, align(a1 + a2, PAGE));
        ret(0n); break; }
      case 149: case 150: case 151: case 152: ret(0n); break;   // mlock/munlock/mlockall/munlockall: nothing swaps here (gpg's "insecure memory" warning otherwise)
      case 110: ret(BigInt(this.threads[this.ti].proc ? (this.pid ?? 1) : (this.ppid ?? 0))); break;   // getppid
      // Job control: a shell loops on getpgrp() != tcgetpgrp(fd) until they
      // agree, so these must match what TIOCGPGRP reports. Leaving getpgrp
      // unimplemented made dash spin forever — 1.28M ioctls in one run.
      case 111: ret(BigInt(this._pgrec(this.threads[this.ti]).pgid)); break;   // getpgrp
      case 121: case 124: {                                   // getpgid(pid) / getsid(pid): self, or a child
        const r = this._pgrecOf(Number(BigInt.asIntN(32, a1))); if (!r) { ret(-3n); break; }   // ESRCH
        ret(BigInt(nr === 121 ? r.pgid : r.sid)); break; }
      case 109: {                                             // setpgid(pid, pgid)
        const self = this.threads[this.ti].proc?.pid ?? this.pid ?? 1, pid = Number(BigInt.asIntN(32, a1)) || self;
        const r = this._pgrecOf(pid); if (!r) { ret(-3n); break; }
        r.pgid = Number(BigInt.asIntN(32, a2)) || pid; ret(0n); break; }
      case 112: {                                             // setsid: a new session, unless the caller already leads a group
        const t = this.threads[this.ti], r = this._pgrec(t), pid = t.proc?.pid ?? this.pid ?? 1;
        if (r.pgid === pid) { ret(-1n); break; }              // EPERM
        r.sid = r.pgid = pid; r.ctty = null; ret(BigInt(pid)); break; }
      case 186: ret(BigInt(this.threads[this.ti].id)); break;  // gettid
      case 83: case 258: {                                    // mkdir / mkdirat
        const p = this.norm(nr === 83 ? this.readPath(a1) : this.atPath(a1, a2));
        if (this.isDir(p) || this.files[p] !== undefined) { ret(-17n); break; } // EEXIST
        { const i = p.lastIndexOf('/'); if (i > 0 && !this.isDir(p.slice(0, i))) { ret(this.files[p.slice(0, i)] !== undefined ? -20n : -2n); break; } }   // ENOTDIR / ENOENT
        this._fsMeta().dirs.add(p); this.fsBump();
        if (this.mtimes) this.mtimes[p] = Math.floor(Date.now() / 1000);
        this._inotify(p, 0x100 | 0x40000000);                   // IN_CREATE | IN_ISDIR
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
        if (lm.has(p)) { lm.delete(p); this.fsBump(); this._inotify(p, 0x200); ret(0n); break; }   // the link, not its target
        if (this.files[p] !== undefined) this._inotify(p, 0x200);   // IN_DELETE (the removal itself follows)
        if (this._fsMeta().fifos?.delete(p)) { this.fsBump(); ret(0n); break; }
        { const sp = this.resolve(p); if (this._fsMeta().socks?.delete(sp)) { this._sockReg().delete('unix:' + sp); this.fsBump(); ret(0n); break; } }
        if (this.files[p] === undefined) { ret(this.isDir(p) ? -21n : -2n); break; }  // EISDIR
        const g = this._fsMeta().hard?.get(p); if (g) { g.delete(p); this._fsMeta().hard.delete(p); }
        delete this.files[p]; this.fsBump(); ret(0n); break; }
      case 76: {                                              // truncate(path, len)
        const p = this.resolve(this.norm(this.readPath(a1))), f = this.files[p];
        if (f === undefined) { ret(this.isDir(p) ? -21n : -2n); break; }   // EISDIR / ENOENT
        const len = Number(BigInt.asIntN(64, a2)); if (len < 0) { ret(-22n); break; }
        const nb = new Uint8Array(len); nb.set(f.subarray(0, Math.min(len, f.length))); this.files[p] = nb;
        for (const [, h] of this.fds) if (h?.bytes === f) h.bytes = nb;   // open descriptors follow the new buffer
        this.fsBump(); (this.dirtyFiles ??= new Set()).add(p); ret(0n); break; }
      case 77: {                                              // ftruncate(fd, len)
        const h = this.fds.get(Number(a1));
        if (!h || h.bytes === undefined) { ret(-9n); break; }
        const len = Number(a2);
        const nb = new Uint8Array(len);
        nb.set(h.bytes.subarray(0, Math.min(len, h.bytes.length)));
        h.bytes = nb; if (h.path && this.files[h.path] !== undefined) this.files[h.path] = nb;
        ret(0n); break; }
      case 82: {                                              // rename(old, new)
        ret(this._rename(this.norm(this.readPath(a1)), this.norm(this.readPath(a2)), 0)); break; }
      case 264: {                                             // renameat(olddirfd, old, newdirfd, new)
        ret(this._rename(this.norm(this.atPath(a1, a2)), this.norm(this.atPath(a3, cpu.regs[10])), 0)); break; }
      case 316: {                                             // renameat2(olddirfd, old, newdirfd, new, flags)
        ret(this._rename(this.norm(this.atPath(a1, a2)), this.norm(this.atPath(a3, cpu.regs[10])), Number(cpu.regs[8]))); break; }
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
        // The arena is a bump allocator: the topmost mapping can simply grow in place.
        // Without this a doubling allocator (apt's package cache) moved - and so
        // abandoned - its whole old copy at every step and ran the arena out.
        if (a1 + oldLen === this.mmapNext) {
          const o0 = Number(a1 - this.base);
          if (o0 >= 0 && o0 + Number(newLen) <= this.ram.length) {
            this.ram.fill(0, o0 + Number(oldLen), o0 + Number(newLen));
            this.mmapNext = a1 + newLen;
            for (const m of this.maps ?? []) if (m.at === a1) m.len = newLen;
            ret(a1); break;
          }
        }
        if (!(flags & 1)) { ret(-12n); break; }                // no MREMAP_MAYMOVE: cannot grow here (ENOMEM)
        const at = this.mmapNext; this.mmapNext += newLen;
        const o0 = Number(at - this.base);
        if (o0 < 0 || o0 + Number(newLen) > this.ram.length) { ret(-12n); break; }
        this.ram.fill(0, o0, o0 + Number(newLen));
        this.ram.copyWithin(o0, Number(a1 - this.base), Number(a1 - this.base) + Number(oldLen));
        for (const m of this.maps ?? []) if (m.at === a1) { m.at = at; m.len = newLen; }   // the record follows the pages
        for (const t of this.threads) t.cpu.icache?.clear();
        this._invalidateCode(a1, a1 + oldLen);
        ret(at); break; }
      case 26: {                                              // msync(addr, len, flags)
        for (const m of this.maps ?? []) if (m.shared && m.at < a1 + a2 && m.at + m.len > a1) this._writeBackMap(m);
        ret(0n); break; }

      // ---- sockets: the display connection (AF_UNIX -> in-process X server) ----
      case 41: {                                              // socket(domain, type, proto)
        // Local sockets only: AF_UNIX (filesystem and abstract names) and
        // AF_INET on the loopback. A stream socket is an unconnected `sock`
        // handle until connect/accept turn it into a crossed pipe pair (the
        // socketpair shape); a datagram socket is a queue of messages. The
        // X server connection keeps its own `sock.conn` transport.
        const fam = Number(a1), ty = Number(a2) & 0xff;
        if (fam !== 1 && fam !== 2) { ret(-97n); break; }     // EAFNOSUPPORT
        if (ty !== 1 && ty !== 2) { ret(-93n); break; }       // EPROTONOSUPPORT
        const fd = this.allocFd(), nb = !!(Number(a2) & 0x800);
        const sk = { fam, type: ty, name: null, peername: null };
        this.fds.set(fd, ty === 2 ? { dsock: { queue: [] }, nonblock: nb, sk } : { sock: { conn: null, nonblock: nb }, sk });
        if (Number(a2) & 0x80000) this.cloexec.add(fd);
        ret(BigInt(fd)); break; }
      case 49: {                                              // bind(fd, sockaddr*, len)
        const h = this.fds.get(Number(a1)); if (!h?.sk) { ret(h ? -88n : -9n); break; }
        const sa = this._readSockaddr(a2, Number(a3)); if (sa.fam !== h.sk.fam) { ret(-22n); break; }
        if (h.sk.name) { ret(-22n); break; }                  // EINVAL: already bound
        if (sa.fam === 2 && !sa.port) sa.port = this._ephemeralPort();
        const key = this._sockKey(sa), reg = this._sockReg();
        if (reg.has(key) && this._handleAlive(reg.get(key).h)) { ret(-98n); break; }   // EADDRINUSE
        if (sa.fam === 1 && !sa.abstract && (this.files[this.norm(sa.path)] !== undefined || this.isDir(sa.path) || this._sockAt(sa.path))) { ret(-98n); break; }
        h.sk.name = sa.fam === 2 ? { fam: 2, port: sa.port } : { fam: 1, path: sa.path, abstract: sa.abstract };
        reg.set(key, { h });
        if (sa.fam === 1 && !sa.abstract && sa.path) { const m = this._fsMeta(); (m.socks ??= new Map()).set(this.resolve(this.norm(sa.path)), h); this.fsBump(); this._inotify(this.norm(sa.path), 0x100); }
        ret(0n); break; }
      case 50: {                                              // listen(fd, backlog)
        const h = this.fds.get(Number(a1)); if (!h?.sk) { ret(h ? -88n : -9n); break; }
        if (h.sk.type !== 1) { ret(-95n); break; }            // EOPNOTSUPP
        if (h.pipe) { ret(-22n); break; }                     // already connected
        if (!h.sk.name) {                                     // an unbound AF_INET listener gets an ephemeral port
          if (h.sk.fam !== 2) { ret(-22n); break; }
          const port = this._ephemeralPort(); h.sk.name = { fam: 2, port }; this._sockReg().set(`inet:${port}`, { h }); }
        h.lsock ??= { backlog: [] }; ret(0n); break; }
      case 43: case 288: {                                    // accept(fd, addr*, len*) / accept4(..., flags)
        const h = this.fds.get(Number(a1)); if (!h?.sk) { ret(h ? -88n : -9n); break; }
        if (!h.lsock) { ret(-22n); break; }
        if (!h.lsock.backlog.length) { if (h.sock?.nonblock || h.nonblock) ret(-11n); else this.block(null); break; }
        const nh = h.lsock.backlog.shift(), fl = nr === 288 ? Number(cpu.regs[10]) : 0;
        nh.nonblock = !!(fl & 0x800);
        const fd = this.allocFd(); this.fds.set(fd, nh); if (fl & 0x80000) this.cloexec.add(fd);
        if (a2) this._writeSockaddr(a2, a3, nh.sk.peername, nh.sk.fam);
        this._wakeTree(); ret(BigInt(fd)); break; }
      case 42: {                                              // connect(fd, sockaddr*, len)
        const h = this.fds.get(Number(a1));
        if (!h?.sk && !h?.sock) { ret(h ? -88n : -9n); break; }   // ENOTSOCK
        const sa = this._readSockaddr(a2, Number(a3));
        // the X server: filesystem ("/tmp/.X11-unix/X0\0") and abstract ("\0/tmp/...") forms
        if (sa.fam === 1 && /^\/tmp\/\.X11-unix\/X\d+$/.test(sa.path) && this.xserver && h.sock) {
          h.sock.conn = this.xserver.connect(); ret(0n); break;
        }
        if (h.dsock) { h.sk.peer = this._sockKey(sa); h.sk.peerSa = sa; ret(0n); break; }   // a datagram default destination
        if (h.sk?.connecting) {                                 // a connect in flight to a real host: re-executed once woken
          const c = h.sk.connecting;
          if (c.conn.state === 'connecting') { if (h.nonblock || h.sock?.nonblock) ret(-114n); else this.block(null); break; }   // EALREADY / wait
          h.sk.connecting = null;
          ret(c.conn.state === 'open' ? 0n : BigInt(-(c.conn.err || 111))); break; }
        if (h.pipe || h.sock?.conn) { ret(-106n); break; }    // EISCONN
        if (sa.fam === 2 && this._external(sa.ip) && this._net()) {   // a real address: bridge to the host's network
          const nb = !!(h.sock?.nonblock || h.nonblock);
          const b1 = { chunks: [], pos: 0, off: 0, size: 0 }, b2 = { chunks: [], pos: 0, off: 0, size: 0, ext: true };
          if (!h.sk.name) h.sk.name = { fam: 2, port: this._ephemeralPort(), ip: this._net().localIp };
          const conn = this._net().tcp(sa.ip, sa.port);
          delete h.sock; h.pipe = b1; h.peer = b2; h.mode = 'rw'; h.nonblock = nb; h.sk.peername = { fam: 2, port: sa.port, ip: sa.ip };
          (this._netRoot()._netConns ??= []).push({ h, b1, b2, conn, ended: false });
          h.sk.connecting = { conn };
          if (nb) { ret(-115n); break; }                      // EINPROGRESS: poll for writable, then SO_ERROR
          this.block(null); break; }
        const key = this._sockKey(sa), reg = this._sockReg(), ent = reg.get(key);
        if (ent && !this._handleAlive(ent.h)) reg.delete(key);   // a listener whose process is gone
        if (!ent || !ent.h.lsock || !this._handleAlive(ent.h)) {
          ret(sa.fam === 1 && !sa.abstract && !this._sockAt(sa.path) ? -2n : -111n); break; }   // ENOENT: no such socket file; ECONNREFUSED
        // a connected pair: two crossed pipe buffers, this end here, the other queued for accept
        const b1 = { chunks: [], pos: 0, off: 0, size: 0 }, b2 = { chunks: [], pos: 0, off: 0, size: 0 };
        const nb = !!(h.sock?.nonblock || h.nonblock);
        if (sa.fam === 2 && !h.sk.name) h.sk.name = { fam: 2, port: this._ephemeralPort() };
        delete h.sock; h.pipe = b1; h.peer = b2; h.mode = 'rw'; h.nonblock = nb; h.sk.peername = ent.h.sk.name;
        ent.h.lsock.backlog.push({ pipe: b2, peer: b1, mode: 'rw', nonblock: false, sk: { fam: sa.fam, type: 1, name: ent.h.sk.name, peername: h.sk.name } });
        this._wakeTree(); ret(0n); break; }
      case 44: {                                              // sendto(fd, buf, len, flags, addr*, addrlen)
        const h = this.fds.get(Number(a1)), fl = Number(cpu.regs[10]);
        if (h?.sock?.conn) {
          const b = this.ram.slice(Number(a2 - this.base), Number(a2 - this.base) + Number(a3));
          h.sock.conn.write(b); ret(a3); break;
        }
        if (h?.dsock) { ret(this._dgramSend(h, a2, Number(a3), cpu.regs[8] ? this._readSockaddr(cpu.regs[8], Number(cpu.regs[9])) : null)); break; }
        if (!h?.pipe && !h?.sock) { ret(h ? -88n : -9n); break; }   // ENOTSOCK
        if (h.sock) { ret(-107n); break; }                    // ENOTCONN
        if (h.sk?.shutW) { if (!(fl & 0x4000)) this.raiseSignal(13, null, { pid: 0, code: 0 }); ret(-32n); break; }   // EPIPE after shutdown(SHUT_WR)
        const r = writeChunk(Number(a1), a2, Number(a3), !!(fl & 0x4000)); if (r === -4096) break; ret(r === undefined ? a3 : BigInt(r)); break; }
      case 45: {                                              // recvfrom(fd, buf, len, flags, addr*, len*)
        const h = this.fds.get(Number(a1)), fl = Number(cpu.regs[10]);
        if (h?.dsock) { const r = this._dgramRecv(h, a2, Number(a3), fl, cpu.regs[8], cpu.regs[9]); if (r !== null) ret(r); break; }
        if (h?.pipe) {                                        // a connected stream end (std reads its spawn error channel with recv)
          const nb = h.nonblock || !!(fl & 0x40);             // MSG_DONTWAIT
          const r = (fl & 2) ? this._pipePeek(h, a2, Number(a3), nb) : this._pipeDrain({ ...h, nonblock: nb }, a2, Number(a3)); if (r !== null) ret(r); break;
        }
        if (!h?.sock && !h?.sk) { ret(h ? -88n : -9n); break; }
        if (!h?.sock?.conn) { ret(-107n); break; }            // ENOTCONN
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
        else if (h?.dsock) {                                  // a datagram: the iov joined, to msg_name or the connected peer
          const all = new Uint8Array(total); { let off = 0; for (const b of parts) { all.set(b, off); off += b.length; } }
          const np = v.getBigUint64(mo, true), nl = v.getUint32(mo + 8, true);
          ret(this._dgramSendBytes(h, all, np ? this._readSockaddr(np, nl) : null)); break; }
        else if (h?.pipe && h.sk?.shutW) { if (!(Number(a3) & 0x4000)) this.raiseSignal(13, null, { pid: 0, code: 0 }); ret(-32n); break; }
        else { if (h?.sock) { ret(-107n); break; }             // ENOTCONN
               // SCM_RIGHTS: the passed descriptors ride with the first byte
               // of this message and are delivered by the recvmsg that consumes it
               const cp = v.getBigUint64(mo + 32, true), cl = Number(v.getBigUint64(mo + 40, true));
               const rights = h?.pipe && cp && cl >= 16 ? this._cmsgRights(cp, cl) : null;
               if (rights === -9) { ret(-9n); break; }
               if (rights?.length) { const pb = h.peer ?? h.pipe; (pb.rights ??= []).push({ at: pb.wtot ?? 0, fds: rights }); }
               for (let i = 0; i < iovn; i++) {
                 const o = this.RAMOFF + Number(iovp - this.base) + i * 16;
                 const r = writeChunk(Number(a1), v.getBigUint64(o, true), Number(v.getBigUint64(o + 8, true)), !!(Number(a3) & 0x4000));
                 if (r !== undefined && r < 0) { ret(BigInt(r)); total = -1; break; } }
               if (total < 0) break; }
        ret(BigInt(total)); break; }
      case 307: {                                             // sendmmsg(fd, mmsghdr*, vlen, flags): glibc's resolver sends A and AAAA together
        const h = this.fds.get(Number(a1));
        if (!h?.dsock) { ret(h ? -38n : -9n); break; }
        const v = new DataView(this.wmem.buffer), vlen = Math.min(Number(a3), 1024);
        let sent = 0, err = 0n;
        for (let k = 0; k < vlen; k++) {
          const mh = a2 + BigInt(k * 64), mo = this.RAMOFF + Number(mh - this.base);
          const iovp = v.getBigUint64(mo + 16, true), iovn = Number(v.getBigUint64(mo + 24, true));
          const parts = []; let total = 0;
          for (let i = 0; i < iovn; i++) {
            const o = this.RAMOFF + Number(iovp - this.base) + i * 16;
            const p = v.getBigUint64(o, true), l = Number(v.getBigUint64(o + 8, true));
            parts.push(this.ram.slice(Number(p - this.base), Number(p - this.base) + l)); total += l;
          }
          const all = new Uint8Array(total); { let off = 0; for (const b of parts) { all.set(b, off); off += b.length; } }
          const np = v.getBigUint64(mo, true), nl = v.getUint32(mo + 8, true);
          const r = this._dgramSendBytes(h, all, np ? this._readSockaddr(np, nl) : null);
          if (r < 0n) { err = r; break; }
          this.jsnap(mh + 56n, 4); this.mem.write(mh + 56n, 4n, BigInt(total)); sent++;
        }
        ret(sent ? BigInt(sent) : err); break; }
      case 47: {                                              // recvmsg(fd, msghdr*, flags)
        const h = this.fds.get(Number(a1)), fl = Number(a3);
        if (!h?.sock && !h?.pipe && !h?.dsock) { ret(h ? -88n : -9n); break; }
        const v = new DataView(this.wmem.buffer);
        const mo = this.RAMOFF + Number(a2 - this.base);
        const iovp = v.getBigUint64(mo + 16, true), iovn = Number(v.getBigUint64(mo + 24, true));
        let want = 0; const list = [];
        for (let i = 0; i < iovn; i++) {
          const o = this.RAMOFF + Number(iovp - this.base) + i * 16;
          const p = v.getBigUint64(o, true), l = Number(v.getBigUint64(o + 8, true));
          list.push([p, l]); want += l;
        }
        const cl = Number(v.getBigUint64(mo + 40, true)), cp = cl ? v.getBigUint64(mo + 32, true) : 0n;
        v.setUint32(mo + 48, 0, true);                        // msg_flags
        if (h.dsock) {                                        // one datagram, spread over the iov
          const q = h.dsock.queue;
          if (!q.length) { if (h.nonblock || (fl & 0x40)) ret(-11n); else this.block(null); break; }
          const d = (fl & 2) ? q[0] : q.shift(); let off = 0;
          for (const [p, l] of list) { if (off >= d.bytes.length) break; const take = Math.min(l, d.bytes.length - off); this.jsnap(p, take); this.ram.set(d.bytes.subarray(off, off + take), Number(p - this.base)); off += take; }
          if (off < d.bytes.length) v.setUint32(mo + 48, 0x20, true);   // MSG_TRUNC
          const np = v.getBigUint64(mo, true); if (np) { const nl = v.getUint32(mo + 8, true); this.jsnap(a2 + 8n, 4); this._writeSockaddr(np, null, d.from, h.sk.fam, nl, (n) => v.setUint32(mo + 8, n, true)); }
          v.setBigUint64(mo + 40, 0n, true); ret(BigInt((fl & 0x20) ? d.bytes.length : off)); break; }
        if (h.pipe) {                                         // a connected stream end
          const nb = h.nonblock || !!(fl & 0x40), pb = h.pipe, before = pb.rtot ?? 0;
          // stop at a message that carries descriptors so its ancillary data
          // is delivered with its own bytes and not merged into a neighbour's
          let cap = want;
          if (pb.rights?.length) for (const r of pb.rights) { if (r.at > before) cap = Math.min(cap, r.at - before); }
          let got = 0, blocked = false;
          for (const [p, l] of list) { if (got >= cap) break;
            const r = (fl & 2) ? this._pipePeek(h, p, Math.min(l, cap - got), true) : this._pipeDrain({ ...h, nonblock: true }, p, Math.min(l, cap - got));
            if (r === null || r < 0n) break; got += Number(r); if (Number(r) < Math.min(l, cap - got + Number(r))) break; }
          if (got === 0 && want > 0 && !pb.weof) { if (nb) { ret(-11n); break; } this.block(null); break; }
          let clen = 0;
          if (pb.rights?.length && !(fl & 2)) {
            const after = pb.rtot ?? 0, due = pb.rights.filter(r => r.at >= before && r.at < after);
            pb.rights = pb.rights.filter(r => !(r.at >= before && r.at < after));
            for (const r of due) {
              const need = 16 + r.fds.length * 4;
              if (!cp || cl - clen < need) { v.setUint32(mo + 48, v.getUint32(mo + 48, true) | 8, true); continue; }   // MSG_CTRUNC: the descriptors are dropped
              const fds = r.fds.map(hh => { const fd = this.allocFd(); this.fds.set(fd, hh); if (fl & 0x40000000) this.cloexec.add(fd); return fd; });   // MSG_CMSG_CLOEXEC
              this.jsnap(cp + BigInt(clen), need); const o = this.RAMOFF + Number(cp - this.base) + clen;
              v.setBigUint64(o, BigInt(need), true); v.setUint32(o + 8, 1, true); v.setUint32(o + 12, 1, true);   // SOL_SOCKET, SCM_RIGHTS
              for (let i = 0; i < fds.length; i++) v.setUint32(o + 16 + i * 4, fds[i], true);
              clen += (need + 7) & ~7; } }
          v.setBigUint64(mo + 40, BigInt(Math.min(clen, cl)), true);
          ret(BigInt(got)); break; }
        if (!h.sock.conn) { ret(-107n); break; }              // ENOTCONN
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
        if (h.pipe) {                                         // a pipe or a connected stream socket
          let got = 0, blocked = false;
          for (const [p, l] of list) { const r = this._pipeDrain(got ? { ...h, nonblock: true } : h, p, l);
            if (r === null) { blocked = true; break; } if (r < 0n) { if (!got) got = Number(r); break; } got += Number(r); if (Number(r) < l) break; }
          if (!blocked) ret(BigInt(got)); break; }
        if (!h.bytes) { ret(-9n); break; }
        let got = 0;
        for (const [p, l] of list) {
          const n = Math.min(l, h.bytes.length - h.pos); if (n <= 0) break;
          this.jsnap(p, n); this.ram.set(h.bytes.subarray(h.pos, h.pos + n), Number(p - this.base));
          h.pos += n; got += n;
        }
        ret(BigInt(got)); break; }
      case 48: {                                              // shutdown(fd, how)
        const h = this.fds.get(Number(a1)); if (!h?.sk && !h?.sock && !h?.pipe) { ret(h ? -88n : -9n); break; }
        if (!h.pipe && !h.sock?.conn && !h.dsock) { ret(-107n); break; }   // ENOTCONN
        const how = Number(a2);
        if (h.pipe && how !== 0) { (h.sk ??= {}).shutW = true; if (h.peer) h.peer.weof = true; }   // the other end reads EOF, our writes get EPIPE
        if (h.pipe && how !== 1) { (h.sk ??= {}).shutR = true; h.pipe.weof = true; }
        this._wakeTree(); ret(0n); break; }
      case 51: case 52: {                                     // getsockname / getpeername
        const h = this.fds.get(Number(a1)); if (!h?.sk && !h?.sock && !h?.pipe) { ret(h ? -88n : -9n); break; }
        if (h.sock?.conn && !h.sk?.name) { this._writeSockaddr(a2, a3, { fam: 1, path: '/tmp/.X11-unix/X0' }, 1); ret(0n); break; }
        if (nr === 52 && !h.pipe && !h.sk?.peer) { ret(-107n); break; }   // ENOTCONN
        const nm = nr === 51 ? h.sk?.name : (h.sk?.peername ?? (h.sk?.peer ? this._sockReg().get(h.sk.peer)?.h.sk.name : null));
        this._writeSockaddr(a2, a3, nm, h.sk?.fam ?? 1); ret(0n); break; }
      case 54: ret(0n); break;                                // setsockopt
      case 55: {                                              // getsockopt(fd, level, opt, val*, len*)
        const h = this.fds.get(Number(a1)); if (!h?.sk && !h?.sock && !h?.pipe) { ret(h ? -88n : -9n); break; }
        const lvl = Number(a2), opt = Number(a3);
        const val = lvl !== 1 ? 0 : opt === 4 ? (h.sk?.connecting?.conn.state === 'error' ? (h.sk.connecting.conn.err || 111) : 0) : opt === 3 ? (h.sk?.type ?? 1) : opt === 30 ? (h.lsock ? 1 : 0) : (opt === 7 || opt === 8) ? 212992 : 0;   // SO_TYPE, SO_ACCEPTCONN, SO_SNDBUF/RCVBUF; SO_ERROR and the rest read 0
        const vo = this.RAMOFF + Number(cpu.regs[10] - this.base);
        const lo = this.RAMOFF + Number(cpu.regs[8] - this.base);
        const v = new DataView(this.wmem.buffer);
        this.jsnap(cpu.regs[10], 4); this.jsnap(cpu.regs[8], 4);
        v.setUint32(vo, val, true); v.setUint32(lo, 4, true);
        ret(0n); break; }
      case 143: { this.jsnap(a2, 4); this.mem.write(a2, 4n, 0n); ret(0n); break; }   // sched_getparam: priority 0
      case 144: case 145: ret(0n); break;                    // sched_setscheduler / sched_getscheduler: SCHED_OTHER
      case 146: ret(Number(a1) === 1 || Number(a1) === 2 ? 99n : 0n); break;   // sched_get_priority_max: FIFO/RR 99, else 0
      case 147: ret(Number(a1) === 1 || Number(a1) === 2 ? 1n : 0n); break;    // sched_get_priority_min
      case 148: { this.jsnap(a2, 16); this.mem.write(a2, 8n, 0n); this.mem.write(a2 + 8n, 8n, 4000000n); ret(0n); break; }   // sched_rr_get_interval: 4 ms

      // ---- System V IPC: shared memory, semaphore sets, message queues ----
      // One registry for the process tree (in the fs metadata every engine
      // shares). A shared-memory attach is a range of this engine's RAM with a
      // copy of the segment; local writes reach the segment and other
      // processes' writes reach the copy at syscall boundaries (_shmSync).
      case 29: {                                             // shmget(key, size, flg)
        const ipc = this._ipc(), key = Number(BigInt.asIntN(32, a1)), size = Number(a2), flg = Number(a3);
        let seg = key ? [...ipc.shm.values()].find(x => x.key === key) : null;
        if (seg) { if ((flg & 0xc00) === 0xc00) { ret(-17n); break; } if (size > seg.size) { ret(-22n); break; } ret(BigInt(seg.id)); break; }   // IPC_CREAT|IPC_EXCL: EEXIST
        if (key && !(flg & 0x200)) { ret(-2n); break; }       // no IPC_CREAT: ENOENT
        if (size <= 0) { ret(-22n); break; }
        seg = { id: ipc.next++, key, size, bytes: new Uint8Array(size), v: 0, nattch: 0, mode: flg & 0o777, cpid: this.pid ?? 1 };
        ipc.shm.set(seg.id, seg); ret(BigInt(seg.id)); break; }
      case 30: {                                             // shmat(id, addr, flg)
        const seg = this._ipc().shm.get(Number(a1)); if (!seg) { ret(-22n); break; }
        const len = align(BigInt(seg.size), PAGE), at = this._mmapTake(len), o = Number(at - this.base);
        if (o < 0 || o + Number(len) > this.ram.length) { ret(-12n); break; }
        this._shmSync(true);                                  // our other attaches of this segment reach it first
        this.ram.fill(0, o, o + Number(len)); this.ram.set(seg.bytes, o);
        (this._shmAt ??= []).push({ seg, at, len: seg.size, v: seg.v, proc: this.threads[this.ti].proc ?? null }); seg.nattch++;
        for (const t of this.threads) t.cpu.icache?.clear();
        ret(at); break; }
      case 67: {                                             // shmdt(addr)
        const i = (this._shmAt ?? []).findIndex(m => m.at === a1); if (i < 0) { ret(-22n); break; }
        this._shmSync(true); const m = this._shmAt.splice(i, 1)[0]; m.seg.nattch--;
        this._unmapRange(m.at, m.at + align(BigInt(m.len), PAGE)); ret(0n); break; }
      case 31: {                                             // shmctl(id, cmd, buf)
        const ipc = this._ipc(), seg = ipc.shm.get(Number(a1)), cmd = Number(a2) & 0xff; if (!seg) { ret(-22n); break; }
        if (cmd === 0) { ipc.shm.delete(seg.id); ret(0n); break; }   // IPC_RMID: the id is gone, attaches live on
        if (cmd === 2) {                                      // IPC_STAT: shmid_ds
          this._ipcPerm(a3, seg); this.mem.write(a3 + 48n, 8n, BigInt(seg.size)); this.mem.write(a3 + 80n, 4n, BigInt(seg.cpid)); this.mem.write(a3 + 84n, 4n, 0n); this.mem.write(a3 + 88n, 8n, BigInt(seg.nattch)); ret(0n); break; }
        if (cmd === 1) { ret(0n); break; }                    // IPC_SET
        ret(-22n); break; }
      case 64: {                                             // semget(key, nsems, flg)
        const ipc = this._ipc(), key = Number(BigInt.asIntN(32, a1)), n = Number(a2), flg = Number(a3);
        let set = key ? [...ipc.sem.values()].find(x => x.key === key) : null;
        if (set) { if ((flg & 0xc00) === 0xc00) { ret(-17n); break; } if (n > set.vals.length) { ret(-22n); break; } ret(BigInt(set.id)); break; }
        if (key && !(flg & 0x200)) { ret(-2n); break; }
        if (n <= 0 || n > 32000) { ret(-22n); break; }
        set = { id: ipc.next++, key, vals: new Int32Array(n), mode: flg & 0o777 }; ipc.sem.set(set.id, set); ret(BigInt(set.id)); break; }
      case 65: case 220: {                                   // semop(id, sops*, n) / semtimedop(..., timeout*)
        const set = this._ipc().sem.get(Number(a1)); if (!set) { ret(-22n); break; }
        const n = Number(a3), ops = [];
        for (let i = 0; i < n; i++) { const o = a2 + BigInt(i * 6); ops.push({ num: Number(this.mem.read(o, 2n)), op: Number(BigInt.asIntN(16, this.mem.read(o + 2n, 2n))), flg: Number(this.mem.read(o + 4n, 2n)) }); }
        if (ops.some(x => x.num >= set.vals.length)) { ret(-27n); break; }   // EFBIG
        const would = ops.find(x => (x.op < 0 && set.vals[x.num] + x.op < 0) || (x.op === 0 && set.vals[x.num] !== 0));
        if (would) { if (would.flg & 0x800) { ret(-11n); break; } this.block(null); break; }   // IPC_NOWAIT: EAGAIN; else wait for a change
        for (const x of ops) set.vals[x.num] += x.op;
        this._wakeTree(); ret(0n); break; }
      case 66: {                                             // semctl(id, num, cmd, arg)
        const ipc = this._ipc(), set = ipc.sem.get(Number(a1)), num = Number(a2), cmd = Number(a3) & 0xff, arg = cpu.regs[10];
        if (!set) { ret(-22n); break; }
        switch (cmd) {
          case 0: ipc.sem.delete(set.id); this._wakeTree(); ret(0n); break;       // IPC_RMID
          case 1: ret(0n); break;                                                  // IPC_SET
          case 2: this._ipcPerm(arg, set); this.mem.write(arg + 88n, 8n, BigInt(set.vals.length)); ret(0n); break;   // IPC_STAT: semid_ds
          case 11: case 14: case 15: ret(0n); break;                                // GETPID / GETNCNT / GETZCNT
          case 12: ret(num < set.vals.length ? BigInt(set.vals[num]) : -22n); break;   // GETVAL
          case 13: for (let i = 0; i < set.vals.length; i++) this.mem.write(arg + BigInt(i * 2), 2n, BigInt(set.vals[i] & 0xffff)); ret(0n); break;   // GETALL
          case 16: if (num >= set.vals.length) { ret(-22n); break; } set.vals[num] = Number(BigInt.asIntN(32, arg & 0xffffffffn)); this._wakeTree(); ret(0n); break;   // SETVAL
          case 17: for (let i = 0; i < set.vals.length; i++) set.vals[i] = Number(this.mem.read(arg + BigInt(i * 2), 2n)); this._wakeTree(); ret(0n); break;   // SETALL
          default: ret(-22n);
        } break; }
      case 68: {                                             // msgget(key, flg)
        const ipc = this._ipc(), key = Number(BigInt.asIntN(32, a1)), flg = Number(a2);
        let q = key ? [...ipc.msg.values()].find(x => x.key === key) : null;
        if (q) { if ((flg & 0xc00) === 0xc00) { ret(-17n); break; } ret(BigInt(q.id)); break; }
        if (key && !(flg & 0x200)) { ret(-2n); break; }
        q = { id: ipc.next++, key, msgs: [], bytes: 0, mode: flg & 0o777 }; ipc.msg.set(q.id, q); ret(BigInt(q.id)); break; }
      case 69: {                                             // msgsnd(id, msgp, sz, flg)
        const q = this._ipc().msg.get(Number(a1)); if (!q) { ret(-22n); break; }
        const sz = Number(a3), type = BigInt.asIntN(64, this.mem.read(a2, 8n));
        if (sz > 8192 || type <= 0n) { ret(-22n); break; }
        if (q.bytes + sz > 16384) { if (Number(cpu.regs[10]) & 0x800) { ret(-11n); break; } this.block(null); break; }
        const o = Number(a2 - this.base) + 8; q.msgs.push({ type, bytes: this.ram.slice(o, o + sz) }); q.bytes += sz;
        this._wakeTree(); ret(0n); break; }
      case 70: {                                             // msgrcv(id, msgp, sz, type, flg)
        const q = this._ipc().msg.get(Number(a1)); if (!q) { ret(-22n); break; }
        const sz = Number(a3), type = BigInt.asIntN(64, cpu.regs[10]), flg = Number(cpu.regs[8]);
        let i = -1;
        if (type === 0n) i = q.msgs.length ? 0 : -1;
        else if (type > 0n) i = q.msgs.findIndex(m => m.type === type);
        else { let best = -1; for (let k = 0; k < q.msgs.length; k++) if (q.msgs[k].type <= -type && (best < 0 || q.msgs[k].type < q.msgs[best].type)) best = k; i = best; }
        if (i < 0) { if (flg & 0x800) { ret(-42n); break; } this.block(null); break; }   // ENOMSG
        const m = q.msgs[i];
        if (m.bytes.length > sz && !(flg & 0x1000)) { ret(-7n); break; }   // E2BIG unless MSG_NOERROR
        q.msgs.splice(i, 1); q.bytes -= m.bytes.length; const n = Math.min(sz, m.bytes.length);
        this.jsnap(a2, 8 + n); this.mem.write(a2, 8n, m.type); this.ram.set(m.bytes.subarray(0, n), Number(a2 - this.base) + 8);
        this._wakeTree(); ret(BigInt(n)); break; }
      case 71: {                                             // msgctl(id, cmd, buf)
        const ipc = this._ipc(), q = ipc.msg.get(Number(a1)), cmd = Number(a2) & 0xff; if (!q) { ret(-22n); break; }
        if (cmd === 0) { ipc.msg.delete(q.id); this._wakeTree(); ret(0n); break; }
        if (cmd === 2) { this._ipcPerm(a3, q); this.mem.write(a3 + 72n, 8n, BigInt(q.bytes)); this.mem.write(a3 + 80n, 8n, BigInt(q.msgs.length)); this.mem.write(a3 + 88n, 8n, 16384n); ret(0n); break; }   // msqid_ds
        if (cmd === 1) { ret(0n); break; }
        ret(-22n); break; }
      // ---- POSIX message queues: a named priority queue behind a descriptor ----
      case 240: {                                            // mq_open(name, oflag, mode, attr*)
        const name = this.readPath(a1).replace(/^\/+/, ''), fl = Number(a2), reg = (this._fsMeta().mqs ??= new Map());
        let q = reg.get(name);
        if (q && (fl & 0xc0) === 0xc0) { ret(-17n); break; }
        if (!q) { if (!(fl & 0x40)) { ret(-2n); break; }
          let maxmsg = 10, msgsize = 8192;
          if (cpu.regs[10]) { maxmsg = Number(this.mem.read(cpu.regs[10] + 8n, 8n)); msgsize = Number(this.mem.read(cpu.regs[10] + 16n, 8n)); if (maxmsg <= 0 || msgsize <= 0) { ret(-22n); break; } }
          q = { name, maxmsg, msgsize, msgs: [] }; reg.set(name, q); }
        const fd = this.allocFd(); this.fds.set(fd, { mq: q, nonblock: !!(fl & 0x800), path: '/dev/mqueue/' + name }); this.cloexec.add(fd); ret(BigInt(fd)); break; }
      case 241: { const name = this.readPath(a1).replace(/^\/+/, ''); ret(this._fsMeta().mqs?.delete(name) ? 0n : -2n); break; }   // mq_unlink
      case 242: {                                            // mq_timedsend(mqd, msg*, len, prio, timeout*)
        const h = this.fds.get(Number(a1)); if (!h?.mq) { ret(-9n); break; }
        const q = h.mq, len = Number(a3), prio = Number(cpu.regs[10]);
        if (len > q.msgsize) { ret(-90n); break; }             // EMSGSIZE
        if (q.msgs.length >= q.maxmsg) { if (h.nonblock) { ret(-11n); break; } if (this._mqTimeout(cpu.regs[8])) { ret(-110n); break; } this.block(null); break; }
        const o = Number(a2 - this.base), m = { prio, bytes: this.ram.slice(o, o + len) };
        let i = q.msgs.findIndex(x => x.prio < prio); if (i < 0) i = q.msgs.length; q.msgs.splice(i, 0, m);
        this._deadline = null; this._wakeTree(); ret(0n); break; }
      case 243: {                                            // mq_timedreceive(mqd, msg*, len, prio*, timeout*)
        const h = this.fds.get(Number(a1)); if (!h?.mq) { ret(-9n); break; }
        const q = h.mq, len = Number(a3);
        if (len < q.msgsize) { ret(-90n); break; }
        if (!q.msgs.length) { if (h.nonblock) { ret(-11n); break; } if (this._mqTimeout(cpu.regs[8])) { ret(-110n); break; } this.block(null); break; }
        const m = q.msgs.shift(); this.jsnap(a2, m.bytes.length); this.ram.set(m.bytes, Number(a2 - this.base));
        if (cpu.regs[10]) { this.jsnap(cpu.regs[10], 4); this.mem.write(cpu.regs[10], 4n, BigInt(m.prio)); }
        this._deadline = null; this._wakeTree(); ret(BigInt(m.bytes.length)); break; }
      case 245: {                                            // mq_getsetattr(mqd, new*, old*)
        const h = this.fds.get(Number(a1)); if (!h?.mq) { ret(-9n); break; }
        if (a3) { this.jsnap(a3, 32); this.mem.write(a3, 8n, h.nonblock ? 0x800n : 0n); this.mem.write(a3 + 8n, 8n, BigInt(h.mq.maxmsg)); this.mem.write(a3 + 16n, 8n, BigInt(h.mq.msgsize)); this.mem.write(a3 + 24n, 8n, BigInt(h.mq.msgs.length)); }
        if (a2) h.nonblock = !!(Number(this.mem.read(a2, 8n)) & 0x800);
        ret(0n); break; }
      // ---- pipes: tee and vmsplice ----
      case 276: {                                            // tee(fd_in, fd_out, len, flags): copy without consuming
        const hi = this.fds.get(Number(a1)), ho = this.fds.get(Number(a2)); if (!hi || !ho) { ret(-9n); break; }
        if (!hi.pipe || !ho.pipe) { ret(-22n); break; }
        const want = Number(a3), avail = []; let got = 0, off = hi.pipe.off; if (!want) { ret(0n); break; }
        for (const c of hi.pipe.chunks) { if (got >= want) break; const take = Math.min(c.length - off, want - got); avail.push(c.subarray(off, off + take)); got += take; off = 0; }
        if (!got) { if (hi.pipe.weof) { ret(0n); break; } if (hi.nonblock || (Number(cpu.regs[10]) & 2)) { ret(-11n); break; } this.block(null); break; }
        const out = new Uint8Array(got); { let o = 0; for (const b of avail) { out.set(b, o); o += b.length; } }
        const n = this._writeBytes(ho, out); if (n === undefined) { ret(-22n); break; } ret(BigInt(n)); break; }
      case 278: {                                            // vmsplice(fd, iov*, n, flags): user pages into a pipe
        const h = this.fds.get(Number(a1)); if (!h) { ret(-9n); break; } if (!h.pipe) { ret(-9n); break; }
        const v = new DataView(this.wmem.buffer), parts = []; let total = 0;
        for (let i = 0; i < Number(a3); i++) { const o = this.RAMOFF + Number(a2 - this.base) + i * 16; const p = v.getBigUint64(o, true), l = Number(v.getBigUint64(o + 8, true)); parts.push(this.ram.slice(Number(p - this.base), Number(p - this.base) + l)); total += l; }
        const all = new Uint8Array(total); { let o = 0; for (const b of parts) { all.set(b, o); o += b.length; } }
        const n = this._writeBytes(h, all); if (n === undefined) { ret(-22n); break; } ret(BigInt(n)); break; }
      // ---- hardening probes: the answers Linux gives, so feature tests take the same branch ----
      case 317: { const op = Number(a1); ret(op === 1 || op === 2 ? 0n : -22n); break; }   // seccomp: a filter "installs", GET_ACTION_AVAIL ok, the rest EINVAL
      case 324: ret(Number(a1) === 0 ? 0x1ffn : 0n); break;   // membarrier: QUERY answers the command mask
      case 272: { const f = Number(a1); ret(f === 0 || !(f & ~0x40600) ? 0n : (f & 0x7e020000) ? -1n : -22n); break; }   // unshare: FILES/FS/SYSVSEM fine, namespaces EPERM, else EINVAL
      case 434: {                                             // pidfd_open(pid, flags): a handle that polls readable once the child has exited
        const fd = this.allocFd(); this.fds.set(fd, { pidfd: Number(a1) }); this.cloexec.add(fd); ret(BigInt(fd)); break; }

      // ---- poll / select: the guest's event wait, mapped onto engine.blocked ----
      case 7: case 271: {                                     // poll / ppoll
        const nfds = Number(a2), v = new DataView(this.wmem.buffer);
        let timeoutMs;
        if (nr === 7) timeoutMs = Number(BigInt.asIntN(32, a3 & 0xFFFFFFFFn));
        else if (a3 === 0n) timeoutMs = -1;
        else { const o = this.RAMOFF + Number(a3 - this.base);
               timeoutMs = Number(v.getBigUint64(o, true)) * 1000 + Number(v.getBigUint64(o + 8, true)) / 1e6; }
        // ppoll's sigmask (r10): the wait runs under it and the caller's mask
        // comes back afterwards - through the signal frame when a signal
        // interrupts (see _sigDeliver's savedMask), in line when an fd is
        // ready or the timeout expires. make -j2 blocks SIGCHLD and waits in
        // pselect6 with a mask that admits it; ignoring the mask left the
        // signal pending forever and the build parked after its first two
        // recipes.
        const tmask = nr === 271 && cpu.regs[10] ? this.mem.read(cpu.regs[10], 8n) : null;
        const unmask = this._waitMaskIn(cpu, tmask); if (unmask === 'sig') break;
        const readyR = (h) => !h ? false
          : h.isdir ? true
          : h.mq ? h.mq.msgs.length > 0
          : h.pts ? this._ptsReady(h)
          : h.lsock ? h.lsock.backlog.length > 0
          : h.dsock ? h.dsock.queue.length > 0
          : h.pidfd ? this._pidDone(h.pidfd)
          : h.sock ? !!(h.sock.conn && h.sock.conn.readable())
          : h.ino ? h.ino.queue.length > 0
          : h.pipe ? (h.pipe.chunks.length > 0 || !!h.pipe.weof)
          : h.ev ? h.ev.count > 0n
          : h.tfd ? this._tfdReady(h.tfd)
          : h.sfd ? this._sfdReady(h.sfd)
          : !!h.bytes;                                        // regular file: always ready (EOF too)
        const base = this.RAMOFF + Number(a1 - this.base);
        this.jsnap(a1, nfds * 8);                             // revents go back into the caller's array
        let ready = 0; const polled = [];
        for (let i = 0; i < nfds; i++) {
          const o = base + i * 8;
          const fd = v.getInt32(o, true), ev = v.getUint16(o + 4, true);
          let re = 0;
          if (fd >= 0) { polled.push(fd);
            const h = this.fds.get(fd);
            if (!h && fd > 2) re = 0x20;                      // POLLNVAL
            else { if ((ev & 1) && readyR(h)) re |= 1;        // POLLIN
                   const cs = h?.sk?.connecting?.conn.state;
                   if ((ev & 4) && cs !== 'connecting') re |= 4;   // POLLOUT: writable unless a connect is in flight
                   if (cs === 'error') re |= 0x1c; }               // POLLOUT|POLLERR|POLLHUP
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
          this._deadline = null; unmask(); ret(BigInt(ready)); break;
        }
        this._deadline ??= (timeoutMs < 0 ? Infinity : now + timeoutMs);
        this.block(this._capByTimerfd(this._deadline, polled)); break; }
      case 23: case 270: {                                    // select / pselect6
        const nfds = Number(a1), v = new DataView(this.wmem.buffer);
        const rp = a2, wp = a3, ep = cpu.regs[10], tp = cpu.regs[8];
        let timeoutMs = -1;
        if (tp !== 0n) {
          const o = this.RAMOFF + Number(tp - this.base);
          const sec = Number(v.getBigUint64(o, true)), sub = Number(v.getBigUint64(o + 8, true));
          timeoutMs = nr === 23 ? sec * 1000 + sub / 1000 : sec * 1000 + sub / 1e6;
        }
        let tmask = null;                                    // pselect6: r9 -> { const sigset_t *ss; size_t ss_len }
        if (nr === 270 && cpu.regs[9]) { const ssp = this.mem.read(cpu.regs[9], 8n); if (ssp) tmask = this.mem.read(ssp, 8n); }
        const unmask = this._waitMaskIn(cpu, tmask); if (unmask === 'sig') break;
        const readyR = (h) => !h ? false
          : h.isdir ? true
          : h.mq ? h.mq.msgs.length > 0
          : h.pts ? this._ptsReady(h)
          : h.lsock ? h.lsock.backlog.length > 0
          : h.dsock ? h.dsock.queue.length > 0
          : h.pidfd ? this._pidDone(h.pidfd)
          : h.sock ? !!(h.sock.conn && h.sock.conn.readable())
          : h.ino ? h.ino.queue.length > 0
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
        const wr = scan(wp).filter(fd => this.fds.get(fd)?.sk?.connecting?.conn.state !== 'connecting');   // writable unless a connect is in flight
        const now = this.nowMs();
        if (rd.length + wr.length > 0 || timeoutMs === 0 || (this._deadline != null && now >= this._deadline)) {
          this._deadline = null;
          const store = (ptr, set) => { if (ptr === 0n) return;
            const o = this.RAMOFF + Number(ptr - this.base);
            new Uint8Array(this.wmem.buffer, o, 128).fill(0);
            for (const fd of set) v.setUint8(o + (fd >> 3), v.getUint8(o + (fd >> 3)) | (1 << (fd & 7))); };
          store(rp, rd); store(wp, wr); store(ep, []);
          unmask(); ret(BigInt(rd.length + wr.length)); break;
        }
        this._deadline ??= (timeoutMs < 0 ? Infinity : now + timeoutMs);
        this.block(this._capByTimerfd(this._deadline, (rp ? scan(rp) : []).concat(wp ? scan(wp) : []))); break; }
      default:
        ret(-38n);                                           // ENOSYS
        (this.unknown ||= new Set()).add(nr);
    } } catch (e) { if (e instanceof PathErr) ret(-BigInt(e.errno)); else throw e; }
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
  // A wait with a temporary signal mask (ppoll, pselect6). Installs the mask
  // (SIGKILL/SIGSTOP stay unblockable), delivers a newly admitted pending
  // signal at once (EINTR; the frame restores the caller's mask), and
  // returns the function that puts the caller's mask back on a normal
  // return. Re-executions of a blocked wait keep the first saved mask.
  _waitMaskIn(cpu, tmask) {
    if (tmask === null) return () => {};
    const t = this._ts(this.threads[this.ti]);
    t.suspendOld ??= t.sigmask;
    t.sigmask = tmask & ~((1n << 8n) | (1n << 18n));
    const sig = this._sigDeliverable(t);
    if (sig) { if (globalThis.__sigtrace) console.error(`<waitmask sig=${sig} pending=${t.pending.toString(16)} tmask=${tmask.toString(16)} old=${t.suspendOld.toString(16)}>`); this._deadline = null; cpu.regs[0] = BigInt.asUintN(64, -4n); this._sigDeliver(cpu, t, sig, cpu.rip); return 'sig'; }   // EINTR after the handler; the wait's deadline goes with it
    return () => { if (t.suspendOld !== null) { t.sigmask = t.suspendOld; t.suspendOld = null; } };
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
    if (this._execed) {
      // A tail-exec'd process is its replacement: a signal to the old image
      // goes to the replacement engine, and the image mirrors the stop /
      // continue state so its own parent's wait4 sees the job stop.
      const r = this._execed;
      if (r.eng && r.exited === null && r.eng.exitCode === null) {
        r.eng.raiseSignal(sig, null, info);
        if (r.eng.stopped && !this.stopped) { this.stopped = r.eng.stopped; this.stopEv = r.eng.stopped; }
        else if (!r.eng.stopped && this.stopped) { this.stopped = null; this.contEv = true; }
      }
      return;
    }
    const bit = 1n << BigInt(sig - 1);
    const act = this.sigact?.get(sig);
    if (globalThis.__sigtrace) console.error(`<raise0 sig=${sig} tid=${tid} act=${act ? act.handler?.toString(16) : 'none'} ignored=${!act && this._sigDefaultIgnored(sig)} ign=[${[...(this.sigign ?? [])].join(',')}] label=${this._label ?? 'main'}>`);
    // Job control. SIGCONT resumes a stopped process whatever its disposition;
    // SIGSTOP always stops; SIGTSTP/SIGTTIN/SIGTTOU stop when neither caught
    // nor ignored. A stopped child engine is skipped by its parent's pump
    // until continued, and its parent's wait4 sees WIFSTOPPED / WIFCONTINUED.
    // (Only a child engine can stop: the root has nobody to continue it.)
    if (sig === 18 && this.stopped) { this.stopped = null; this.contEv = true; }
    if ((sig === 19 || (sig >= 20 && sig <= 22 && !act && !this.sigign?.has(sig))) && this.parentEng) {
      this.stopped = sig; this.stopEv = sig; return; }
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
    // SIG_IGN / default-ignore: discarded - unless every thread blocks it, in
    // which case it stays pending like Linux's ("blocked signals are never
    // ignored"): script(1) takes SIGCHLD through a signalfd with the signal
    // blocked and SIG_DFL, and a discarded SIGCHLD left it polling forever
    if (!act && this._sigDefaultIgnored(sig) && !(t.sigmask & bit)) return;
    if (globalThis.__sigtrace) console.error(`<raise sig=${sig} -> tid=${t.id} st=${t.state} cur=${this.threads[this.ti].id} mask=${t.sigmask.toString(16)}>`);
    // no handler and deliverable now: the default action (terminate) applies
    // at once. Blocked, it stays pending — for sigprocmask to unblock later,
    // or for sigtimedwait / signalfd to consume.
    if (!act && !(t.sigmask & bit) && !(this.stopped && sig !== 9)) { this._terminate(sig); return; }   // stopped: it waits for the continue
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
      (this.children ??= []).push({ pid: t.proc.pid, eng: null, exited: 128 + sig, sig, pp: t.proc.parent.proc ?? null });
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
    if ((sig === 19 || sig === 20 || sig === 21 || sig === 22) && !this.parentEng) return true;   // stop signals: the root has nobody to continue it; a child stops (raiseSignal)
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
  // The deadline a wait sleeps to, capped by the next expiry of the timerfds it WATCHES (`fds`): a
  // wait must wake when one of its own timerfds expires, nothing else. It used to be capped by every
  // timerfd in the process: a one-shot timerfd that had expired, owned and polled by another thread
  // (Bun's event loop timer, with that thread blocked in a futex), kept its past expiry, and an
  // epoll_pwait on a different epoll fd blocked to that past time, woke at once with nothing ready,
  // blocked again - a livelock at full speed that starved every other thread (opencode, in roughly
  // one run in three). Expired timers are ticked first so an unread one-shot never yields a past
  // deadline; one that has fired is ready and was reported by the readiness scan.
  _capByTimerfd(dl, fds) {
    let e = dl === Infinity ? null : dl;
    for (const fd of fds) {
      const t = this.fds.get(fd)?.tfd; if (!t || t.at == null) continue;
      this._tfdTick(t);
      if (t.at != null) e = e == null ? t.at : Math.min(e, t.at);
    }
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
           if (info.sival !== undefined) this.mem.write(addr + 24n, 8n, info.sival);   // si_value (sigqueue)
           else if (sig === 17) this.mem.write(addr + 24n, 4n, BigInt(info.status ?? 0)); }
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
    if (globalThis.__sigtrace) console.error(`<sigentry nr=${nr} sig=${sig} eintr=${t.eintr} pending=${t.pending.toString(16)} mask=${t.sigmask.toString(16)} act=${!!act} flags=${act?.flags?.toString(16)} rip=${cpu.rip.toString(16)}>`);
    if (!act) { t.eintr = false; this._sigDefault(t, sig); return this.exitCode !== null; }
    if (t.eintr) {
      t.eintr = false;
      // pause/sigsuspend always return EINTR; others restart under SA_RESTART
      // signal(7): select/pselect6, poll/ppoll, epoll_wait/epoll_pwait,
      // nanosleep/clock_nanosleep, pause and sigsuspend are never restarted
      // after a handler, whatever SA_RESTART says. make -j2 waits in
      // pselect6 with SA_RESTART on its SIGCHLD handler: restarting it ran
      // the handler and went back to sleep, and the finished job was never
      // reaped.
      const restart = (act.flags & 0x10000000n) && !NORESTART.has(nr);
      if (restart) this._sigDeliver(cpu, t, sig, BigInt.asUintN(64, cpu.rip - 2n));
      else { if (SLEEPY.has(nr)) this._deadline = null;   // the wait is over: a later timed wait must not inherit this one's deadline (an interrupted ppoll left Infinity behind and the next 30 ms ppoll never returned)
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
    if (cpu === this.cpu) this.xmmFresh();                                       // the frame save below reads cpu.xmm
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
           if (info.sival !== undefined) w(968, 8, info.sival);                 // si_value (sigqueue)
           else if (sig === 17) w(968, 4, BigInt(info.status ?? 0)); }          // si_status
    if (globalThis.__sigtrace) console.error(`<deliver sig=${sig} tid=${t.id} handler=${act.handler.toString(16)} savedRip=${savedRip.toString(16)} rsp0=${cpu.regs[4].toString(16)} frame=${F.toString(16)} alt=${onAlt} flags=${act.flags.toString(16)}>`);
    // The kernel saves the FPU/SSE state in the frame (uc_mcontext.fpstate) and
    // restores it on sigreturn; the handler is free to clobber every xmm. The
    // frame here has fpstate=0, so keep the state engine-side, keyed by the
    // frame, and restore it in _sigreturn. (JSC's thread-suspend handler runs
    // C that uses xmm; the interrupted LLInt resumed with its doubles gone.)
    (t._fpSaves ??= new Map()).set(F, { xmm: cpu.xmm.slice(), mxcsr: cpu.mxcsr, fcw: cpu.fcw, x87: cpu.x87 ? cpu.x87.slice?.() ?? cpu.x87 : undefined, top: cpu.x87top });
    if (t._fpSaves.size > 64) t._fpSaves.delete(t._fpSaves.keys().next().value);
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
    const fp = t._fpSaves?.get(BigInt.asUintN(64, uc - 8n));
    if (fp) { t._fpSaves.delete(BigInt.asUintN(64, uc - 8n)); for (let i = 0; i < 16; i++) cpu.xmm[i] = fp.xmm[i]; cpu.mxcsr = fp.mxcsr; cpu.fcw = fp.fcw; if (fp.x87 !== undefined) cpu.x87 = fp.x87; if (fp.top !== undefined) cpu.x87top = fp.top; }
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
    const _r0 = ENV.OXWASM_PROCTRACE ? process.memoryUsage().rss : 0;
    const ceng = new LinuxEngine(o.elfBytes, {
      argv: o.argv, env: o.env, memMB: o.memMB, threshold: o.threshold, files: this.files,
      assembleWat: o.assembleWat, aotCallThreshold: o.aotCallThreshold, aotLoopThreshold: o.aotLoopThreshold,
      xserver: o.xserver, mtimes: o.mtimes, tty: o.tty, ttyRows: o.ttyRows, ttyCols: o.ttyCols, stdin: o.stdin });
    if (this.strace) ceng.strace = [];                       // a traced parent traces its children
    if (this.childMemMB !== undefined) ceng.childMemMB = this.childMemMB;
        if (this._ncpu !== undefined) ceng._ncpu = this._ncpu;
        if (this.mem.cpuV2) ceng.mem.cpuV2 = true;
        if (this.unitStore) ceng.unitStore = this.unitStore;
        if (this.childUnitMaxFuncs !== undefined) { ceng.childUnitMaxFuncs = this.childUnitMaxFuncs; ceng.childUnitMaxInsns = this.childUnitMaxInsns; }   // grandchildren too
        if (this.shadowChildLib) { ceng.shadowLib = ceng.shadowChildLib = this.shadowChildLib; ceng.shadowMax = this.shadowMax; }   // the differential shadow covers exec'd programs
        if (this.chainSlow) ceng.chainSlow = true;
    if (this.execAnon !== undefined) ceng.execAnon = this.execAnon;
    if (this.assembleWatDeferred) { ceng.assembleWatDeferred = this.assembleWatDeferred; ceng.pumpAsm = this.pumpAsm; }
    if (this.onChildEngine) { ceng.onChildEngine = this.onChildEngine; this.onChildEngine(ceng, o.argv); }
    // record locks the child took inside its window are owned by its proc
    // record; from here on its identity is the new engine (it conflicted
    // with its own lock otherwise - F_SETLKW spun forever after the parent
    // unlocked)
    for (const L of this._fsMeta().rlocks?.values() ?? []) for (const x of L) if (x.owner === t.proc) x.owner = ceng;
    const _r1 = ENV.OXWASM_PROCTRACE ? process.memoryUsage().rss : 0;
    this._copyLiveRam(ceng);                                 // the child's view, before rollback (live ranges only)
    if (this.mem.jit !== null) { ceng.mem.jit = this.mem.jit.slice(); ceng.mem.jitBase = this.mem.jitBase; }   // its JIT pages too
    if (ENV.OXWASM_PROCTRACE) { const r2 = process.memoryUsage().rss; console.error(`[mat] engine=${(_r1 - _r0) >> 20}MB copy=${(r2 - _r1) >> 20}MB units=${this.unitStore ? 'y' : 'n'}`); }
    ceng.brk = this.brk; ceng.mmapNext = this.mmapNext; ceng._mmapBase = this._mmapBase; ceng._mmapHoles = (this._mmapHoles || []).map(h => [h[0], h[1]]);
    ceng.execRanges = this.execRanges.slice();
    if (this.execRangesStatic) ceng.execRangesStatic = this.execRangesStatic.slice();
    ceng.maps = (this.maps ?? []).map(m => ({ ...m }));
    ceng.cwd = this.cwd;                                     // the child's cwd (its chdir stays with it)
    ceng.fds = t.proc.fds; ceng.cloexec = new Set(this.cloexec);
    ceng.sigact = new Map(t.proc.sigact ?? this.sigact ?? []); ceng.sigign = new Set(t.proc.sigign ?? this.sigign ?? []);   // the window's own dispositions go with it
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
    (this.children ??= []).push({ pid: t.proc.pid, eng: ceng, exited: null, pp: parent.proc ?? null });
    ceng.pid = t.proc.pid; ceng.ppid = this.pid ?? 1;
    { const r = this._pgrec(t); ceng.pgid = r.pgid; ceng.sid = r.sid; ceng.ctty = r.ctty ?? null; }
    if (this._shmAt?.length) { this._shmSync(true); ceng._shmAt = this._shmAt.filter(m => m.proc === t.proc || m.proc === null).map(m => ({ ...m, proc: null })); for (const m of ceng._shmAt) m.seg.nattch++; }
    // children the window forked before it was materialised are ITS children:
    // a bash subshell (`cd d && cmd &`) forks cmd and blocks in wait4, which
    // is what materialises it - and with the record left behind here it saw
    // ECHILD, exited, and its parent's `kill %1` found no such job
    if (this.children.some(c => c.pp === t.proc)) {
      const mine = this.children.filter(c => c.pp === t.proc); this.children = this.children.filter(c => c.pp !== t.proc);
      ceng.children = mine; for (const c of mine) { c.pp = null; if (c.eng) c.eng.parentEng = ceng; }
    }
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
  // Live processes in the whole sandbox (every engine in the tree plus the
  // fork children still inside their vfork window). A materialised fork is a
  // new engine with its own memory and a copy of the parent's live RAM: ~60 MB
  // of host RSS per sleeping child of a python process, and a fork bomb
  // reached 12 GB before its 40 s timeout. fork/clone refuse with EAGAIN past
  // maxProcs, which is what RLIMIT_NPROC / a cgroup pids limit does.
  _rootEng() { let r = this; while (r.parentEng) r = r.parentEng; return r; }
  _liveProcs() {
    const root = this._rootEng();
    const seen = new Set(); let n = 0;
    const scan = (e) => { if (seen.has(e)) return; seen.add(e);
      if (e.exitCode === null) n++;
      for (const x of e.threads) if (x.proc && x.state !== 'dead') n++;
      for (const c of e.children ?? []) if (c.eng && c.exited === null) scan(c.eng); };
    scan(root);
    return n;
  }
  // Grow a written file to `end` bytes. The file array is an exact-length
  // VIEW over a backing buffer with spare capacity, so appending 8KB at a
  // time copies the file once per doubling, not once per write: exact
  // reallocation was O(n^2) - vim writing 14MB in 8KB chunks spent 3.4s of
  // a 6s run copying 12GB. Every consumer takes the view's length and
  // byteOffset (parseElf, DataView, Buffer.from), so the capacity is invisible.
  // A guest that writes without limit would be spending the HOST's memory:
  // files live in this process. Growth is charged against a quota and refused
  // with ENOSPC past it. The running count only ever over-estimates (it does
  // not credit deletes), so when it crosses the quota the true size of what
  // the guest has written is recomputed before refusing.
  _chargeDisk(added) {
    const root = this._netRoot(), q = root._diskQuota;
    if (!q || added <= 0) return;
    root._diskUsed = (root._diskUsed ?? 0) + added;
    if (root._diskUsed <= q) return;
    let real = 0;
    for (const p of root.dirtyFiles ?? []) real += root.files[p]?.length ?? 0;
    // unnamed files (memfd, O_TMPFILE) live only in descriptor tables
    const seen = new Set(), eseen = new Set();
    const scan = (e) => {
      if (eseen.has(e)) return; eseen.add(e);
      const tables = [e.fds]; if (e._mainFds) tables.push(e._mainFds);
      for (const t of e.threads ?? []) if (t.proc?.fds) tables.push(t.proc.fds);
      for (const tb of tables) for (const [, h] of tb) if (h?.memfd !== undefined && !seen.has(h)) { seen.add(h); real += h.bytes?.length ?? 0; }
      for (const c of e.children ?? []) if (c.eng) scan(c.eng);
    };
    scan(root);
    root._diskUsed = real;
    if (real > q) throw new PathErr(28);                     // ENOSPC
  }
  _growFile(h, end) {
    const old = h.bytes;
    this._chargeDisk(end - old.length);
    const nb = (old.byteOffset + end <= old.buffer.byteLength)
      ? new Uint8Array(old.buffer, old.byteOffset, end)
      : (() => { const b = new Uint8Array(Math.max(end, old.length * 2, 4096)); b.set(old); return b.subarray(0, end); })();
    h.bytes = nb;
    if (h.path !== undefined) {                              // an unnamed file (memfd, O_TMPFILE) is in no table
      this.files[h.path] = nb;                               // growable buffer: refresh the map ref
      this._hardRefresh(h.path, nb);                         // ... and every hard-link alias
    }
  }
  // every function entry the engine knows of, kept incrementally: rebuilding
  // it from the three maps per unit translation was 2.6% of a clang run
  // (41k entries x 1,800 units). Unmapped code leaves stale entries behind,
  // which only means a call's fall-through may be cut at an address that
  // was an entry; a snapshot restore or a funcref-table reset starts over.
  _knownEntries() {
    if (!this._entries) { const e = this._entries = new Set();
      for (const k of this.aotCalls.keys()) e.add(k.toString());
      for (const k of this.aotFns.keys()) e.add(k.toString());
      for (const k of this._ftSeen) e.add(k.toString()); }
    return this._entries;
  }
  _entryAdd(k) { if (this._entries) this._entries.add(k.toString()); }
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
    const B = this.base, L = this.ram.length, src = this.ram, dst = ceng.ram;
    // The child's memory is fresh (zero beyond the static image), so a 64KB
    // chunk that is all zero in the parent need not be written: writing it
    // commits that page in the child. The ranges below are mostly untouched
    // address space (a 64MB stack window, the arena's reserve), and copying
    // them cost ~120 MB of host RSS per fork child of a python process.
    const w = new BigUint64Array(src.buffer, src.byteOffset, Math.floor(L / 8));   // (no 32-bit shifts: guest RAM can exceed 2 GB)
    const zero = (a, e) => { for (let i = a / 8, n = e / 8; i < n; i++) if (w[i] !== 0n) return false; return true; };
    const cp = (lo, hi, sparse = true) => {
      lo = Math.max(0, Number(lo - B)); hi = Math.min(L, Number(hi - B)); if (hi <= lo) return;
      if (!sparse) { dst.set(src.subarray(lo, hi), lo); return; }
      for (let a = lo - lo % 65536; a < hi; a += 65536) {
        const s = Math.max(a, lo), e = Math.min(hi, a + 65536);
        if (s % 8 === 0 && e % 8 === 0 && zero(s, e)) continue;
        dst.set(src.subarray(s, e), s);
      }
    };
    cp(B, this._brk0 ?? this.brk, false);                                  // the static image (the child's fresh load is not zero there)
    cp(this._brk0 ?? this.brk, this.brk + 65536n);                         // heap
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
    if (this._vforkSaved) { this.aotBudget = this._vforkBudget; this._vforkBudget = undefined; this._vforkSaved = false; }
  }

  // read(2)/recv(2) on a pipe or socketpair end: copy out what is buffered;
  // empty means EOF only once the writing side is gone (weof - set when a
  // process holding the write end exits or closes it), otherwise BLOCK like
  // a real pipe (EAGAIN when non-blocking) - the plug-in wire protocol reads
  // before data arrives. Returns the count, -11n, or null after arranging
  // the block (the syscall re-executes once woken).
  // Byte-level transfer for the fd-to-fd syscalls (sendfile, splice,
  // copy_file_range): a regular file at its position or an explicit offset,
  // or a pipe end. _readBytes answers null when a pipe read would block.
  _readBytes(h, want, off) {
    if (h.bytes !== undefined) { const p = off ?? h.pos; const n = Math.max(0, Math.min(want, h.bytes.length - p)); const out = h.bytes.slice(p, p + n); if (off === undefined) h.pos = p + n; return out; }
    if (h.pipe) {
      const parts = []; let got = 0;
      while (got < want && h.pipe.chunks.length) { const c = h.pipe.chunks[0], avail = c.length - h.pipe.off, take = Math.min(avail, want - got);
        parts.push(c.subarray(h.pipe.off, h.pipe.off + take)); got += take; h.pipe.off += take;
        if (h.pipe.off >= c.length) { h.pipe.chunks.shift(); h.pipe.off = 0; } }
      if (got > 0) { h.pipe.size = Math.max(0, (h.pipe.size ?? 0) - got); this.wakeAllBlk(); }
      else if (!h.pipe.weof && this._pipeWriterAlive(h.pipe)) return null;
      const out = new Uint8Array(got); let o = 0; for (const q of parts) { out.set(q, o); o += q.length; } return out;
    }
    return undefined;
  }
  _writeBytes(h, bytes, off) {
    if (h.bytes !== undefined) { const p = off ?? h.pos, end = p + bytes.length; if (end > h.bytes.length) this._growFile(h, end); h.bytes.set(bytes, p); if (h.path) this._mapsAbsorb(h.path, p, bytes); if (off === undefined) h.pos = end; return bytes.length; }
    if (h.wpipe) {                                            // a pty end: the slave writes the screen, the master types - never its own read queue
      const T = (h.ptm ?? h.pts).termios;
      if (h.pts) {
        let out = bytes.slice();
        if ((T.oflag & 1) && (T.oflag & 4) && out.includes(10)) { const o = []; for (const b of out) { if (b === 10) o.push(13); o.push(b); } out = new Uint8Array(o); }
        h.wpipe.chunks.push(out); h.wpipe.size = (h.wpipe.size ?? 0) + out.length;
      } else this.ttyInput(h.ptm, bytes.slice());
      this.wakeAllBlk(); return bytes.length;
    }
    if (h.pipe) { const pb = h.peer ?? h.pipe; pb.chunks.push(bytes.slice()); pb.size = (pb.size ?? 0) + bytes.length; this.wakeAllBlk(); return bytes.length; }
    if (h.sink) {                                             // stdout / stderr, on the root engine like writeChunk
      let root = this; while (root.parentEng) root = root.parentEng;
      const str = new TextDecoder().decode(bytes);
      if (h.sink === 'err') { (root.stderr ||= []).push(str); (root.stderrBytes ||= []).push(bytes.slice()); }
      else { root.stdout.push(str); root.stdoutBytes.push(bytes.slice()); }
      return bytes.length;
    }
    return undefined;
  }
  // the fd-to-fd syscalls resolve their destination like write(2) does (fds 1
  // and 2 without a handle are the default sinks) and must know BEFORE reading
  // whether the sink is one they can feed - busybox's cat sendfiles to stdout
  // and falls back to read/write on EINVAL, which found the input consumed
  _sinkOf(fd) { const h = this.fds.get(fd) ?? (fd === 1 ? { sink: 'out' } : fd === 2 ? { sink: 'err' } : undefined); return h && (h.bytes !== undefined || h.pipe || h.sink) ? h : null; }
  // inotify: an event for `path` (a file created, deleted or moved) reaches
  // every watch on its parent directory whose mask wants it
  _inotify(path, mask) {
    if (!this._inotifyFds || this._inotifyFds.size === 0) return;
    const i = path.lastIndexOf('/'), dir = i > 0 ? path.slice(0, i) : '/', name = path.slice(i + 1);
    for (const fd of this._inotifyFds) { const h = this.fds.get(fd); if (!h?.ino) { this._inotifyFds.delete(fd); continue; }
      for (const [wd, w] of h.ino.watches) if (w.path === dir && (w.mask & mask)) h.ino.queue.push({ wd, mask, name }); }
    this.wakeAllBlk();
  }
  _pipeDrain(h, addr, want) {
    let dst = Number(addr - this.base), got = 0;
    if (h.pts) {                                            // a pty slave: an EOF marker answers 0 once; raw mode waits for VMIN bytes
      if (h.pipe.chunks.length && h.pipe.chunks[0].length === 0) { h.pipe.chunks.shift(); return 0n; }
      const T = h.pts.termios;
      if (!(T.lflag & 2) && (h.pipe.size ?? 0) < Math.max(1, T.cc[6]) && !h.pipe.weof) { if (h.nonblock) return -11n; this.block(null); return null; }
    }
    while (got < want && h.pipe.chunks.length) {
      const c = h.pipe.chunks[0], avail = c.length - h.pipe.off;
      const take = Math.min(avail, want - got);
      this.jsnap(this.base + BigInt(dst), take);
      this.ram.set(c.subarray(h.pipe.off, h.pipe.off + take), dst);
      dst += take; got += take; h.pipe.off += take;
      if (h.pipe.off >= c.length) { h.pipe.chunks.shift(); h.pipe.off = 0; }
    }
    if (got > 0) { h.pipe.size = Math.max(0, (h.pipe.size ?? 0) - got); h.pipe.rtot = (h.pipe.rtot ?? 0) + got; this.wakeAllBlk(); }   // a blocked writer may fit now
    if (got === 0 && want > 0 && !h.pipe.weof) {
      if (h.nonblock) return -11n;
      this.block(null); return null;
    }
    return BigInt(got);
  }
  // --- System V IPC and process groups ---------------------------------------
  _ipc() { const m = this._fsMeta(); return m.ipc ??= { shm: new Map(), sem: new Map(), msg: new Map(), next: 1 }; }
  _ipcPerm(addr, o) {                           // struct ipc_perm (48 bytes): key uid gid cuid cgid mode seq
    this.jsnap(addr, 112); for (let i = 0n; i < 112n; i += 8n) this.mem.write(addr + i, 8n, 0n);
    this.mem.write(addr, 4n, BigInt.asUintN(32, BigInt(o.key ?? 0))); this.mem.write(addr + 20n, 2n, BigInt(o.mode ?? 0o600));
  }
  _shmSync(force) {                             // an attach's bytes and its segment agree at syscall boundaries
    for (const m of this._shmAt ?? []) {
      const seg = m.seg, o = Number(m.at - this.base), ram = this.ram.subarray(o, o + m.len);
      if (m.v !== seg.v) { ram.set(seg.bytes); m.v = seg.v; continue; }   // someone else wrote: take theirs
      if (!force && m.len > (1 << 20)) continue;                          // a large segment is only compared at attach, detach, exit and fork
      let diff = false; for (let i = 0; i < m.len; i++) if (ram[i] !== seg.bytes[i]) { diff = true; break; }
      if (diff) { seg.bytes.set(ram); seg.v++; m.v = seg.v; }
    }
  }
  _shmExit(t) {                                 // a process is leaving: push its attaches, drop them
    this._shmSync(true);
    const mine = t.proc ? this._shmAt.filter(m => m.proc === t.proc) : this._shmAt.slice();
    for (const m of mine) { m.seg.nattch--; this._shmAt.splice(this._shmAt.indexOf(m), 1); if (t.proc) this._unmapRange(m.at, m.at + align(BigInt(m.len), PAGE)); }
  }
  _mqTimeout(tp) {                              // an absolute CLOCK_REALTIME timeout for the mq calls: true once it has passed
    if (!tp) return false;
    const abs = Number(this.mem.read(tp, 8n)) * 1000 + Number(this.mem.read(tp + 8n, 8n)) / 1e6, now = this.nowMs();
    this._deadline ??= abs - Date.now() + now;
    if (now >= this._deadline) { this._deadline = null; return true; }
    return false;
  }
  _pgrec(t) {                                   // the {pgid, sid} record of the calling process (a window child, or this engine)
    const o = t.proc ?? this;
    if (o.pgid === undefined) { const p = t.proc ? this._pgrec(t.proc.parent) : null; o.pgid = p ? p.pgid : (this.pid ?? 1); o.sid = p ? p.sid : o.pgid; }
    return o;
  }
  _pgrecOf(pid) {                               // by pid: the caller, a window child, or a child engine
    const self = this.threads[this.ti];
    if (pid === 0 || pid === (self.proc?.pid ?? this.pid ?? 1)) return this._pgrec(self);
    const w = this.threads.find(x => x.proc?.pid === pid && x.state !== 'dead'); if (w) return this._pgrec(w);
    const c = (this.children ?? []).find(c => c.pid === pid && c.eng); if (c) { const e = c.eng; if (e.pgid === undefined) { const r = this._pgrec(self); e.pgid = r.pgid; e.sid = r.sid; } return e; }
    return null;
  }
  _pipePeek(h, addr, want, nb) {                // MSG_PEEK: copy without consuming
    let dst = Number(addr - this.base), got = 0, off = h.pipe.off;
    for (const c of h.pipe.chunks) { if (got >= want) break; const take = Math.min(c.length - off, want - got);
      this.jsnap(this.base + BigInt(dst), take); this.ram.set(c.subarray(off, off + take), dst); dst += take; got += take; off = 0; }
    if (got === 0 && want > 0 && !h.pipe.weof) { if (nb) return -11n; this.block(null); return null; }
    return BigInt(got);
  }
  // --- local sockets: a process-tree registry of bound names -------------
  _sockReg() { const m = this._fsMeta(); return m.sockReg ??= new Map(); }
  _sockKey(sa) { return sa.fam === 2 ? `inet:${sa.port}` : sa.abstract ? `unix@${sa.path}` : `unix:${this.resolve(this.norm(sa.path))}`; }
  _sockAt(p) { return !!p && !!this._fsMeta().socks?.has(this.resolve(this.norm(p))); }
  _ephemeralPort() { const m = this._fsMeta(); m.nextPort = (m.nextPort ?? 40000) + 1; return m.nextPort; }
  _wakeTree() { this.wakeAllBlk(); let root = this; while (root.parentEng) root = root.parentEng; if (root !== this) root.wakeAllBlk(); }
  _readSockaddr(addr, len) {
    const o = Number(addr - this.base), fam = this.ram[o] | (this.ram[o + 1] << 8);
    if (fam === 2) return { fam, port: (this.ram[o + 2] << 8) | this.ram[o + 3], ip: `${this.ram[o + 4]}.${this.ram[o + 5]}.${this.ram[o + 6]}.${this.ram[o + 7]}` };
    let path = '';                                            // filesystem, or abstract ("\0name")
    for (let i = 2; i < len; i++) { const c = this.ram[o + i]; if (c === 0 && path) break; if (c !== 0) path += String.fromCharCode(c); }
    return { fam, path, abstract: len > 3 && this.ram[o + 2] === 0 };
  }
  // write a sockaddr for `nm` ({fam, port} or {fam, path}; null = unnamed) into addr,
  // truncated to *lenp, and store the full length in *lenp (or via setLen)
  _writeSockaddr(addr, lenp, nm, fam, cap = null, setLen = null) {
    let bytes;
    if ((nm?.fam ?? fam) === 2) { bytes = new Uint8Array(16); bytes[0] = 2; const port = nm?.port ?? 0; bytes[2] = port >> 8; bytes[3] = port & 255; if (nm?.ip) nm.ip.split('.').forEach((x, i) => { bytes[4 + i] = +x; }); else { bytes[4] = 127; bytes[7] = 1; } }
    else { const p = nm?.path ?? ''; bytes = new Uint8Array(2 + (p ? p.length + 1 + (nm?.abstract ? 1 : 0) : 0)); bytes[0] = 1; for (let i = 0; i < p.length; i++) bytes[2 + (nm?.abstract ? 1 : 0) + i] = p.charCodeAt(i); if (nm?.abstract) bytes = bytes.subarray(0, bytes.length - 1); }
    if (cap === null) cap = lenp ? Number(this.mem.read(lenp, 4n)) : 0;
    const n = Math.min(cap, bytes.length);
    if (n) { this.jsnap(addr, n); this.ram.set(bytes.subarray(0, n), Number(addr - this.base)); }
    if (setLen) setLen(bytes.length); else if (lenp) { this.jsnap(lenp, 4); this.mem.write(lenp, 4n, BigInt(bytes.length)); }
  }
  _cmsgRights(cp, cl) {                         // SCM_RIGHTS entries of a msg_control block -> handles (-9 for a bad fd)
    const v = new DataView(this.wmem.buffer), base = this.RAMOFF + Number(cp - this.base), out = [];
    for (let off = 0; off + 16 <= cl;) {
      const len = Number(v.getBigUint64(base + off, true)); if (len < 16 || off + len > cl) break;
      if (v.getUint32(base + off + 8, true) === 1 && v.getUint32(base + off + 12, true) === 1)
        for (let i = 0; i < (len - 16) >> 2; i++) { const h = this.fds.get(v.getInt32(base + off + 16 + i * 4, true)); if (!h) return -9; out.push(h); }
      off += (len + 7) & ~7;
    }
    return out;
  }
  _dgramSend(h, addr, len, sa) { this.guardRange(addr, len); return this._dgramSendBytes(h, this.ram.slice(Number(addr - this.base), Number(addr - this.base) + len), sa); }
  // A connection from OUTSIDE the guest into one of its listening sockets: the host side of
  // getHost(). The guest sees an ordinary accepted connection (a crossed pipe pair, exactly
  // what connect() builds between two guest sockets); the host holds the other ends.
  //   returns { write(bytes), end(), onData, onEnd } or null if nothing listens on `port`
  openInbound(port) {
    const ent = this._sockReg().get(`inet:${port}`);
    if (!ent || !ent.h.lsock || !this._handleAlive(ent.h)) return null;
    const b1 = { chunks: [], pos: 0, off: 0, size: 0, ext: true }, b2 = { chunks: [], pos: 0, off: 0, size: 0 };
    const root = this._netRoot();
    const conn = {
      onData: null, onEnd: null, closed: false,
      write: (bytes) => { b2.chunks.push(bytes.slice()); b2.size = (b2.size ?? 0) + bytes.length; root.wakeAllBlk(); },
      end: () => { b2.weof = true; root.wakeAllBlk(); },
      _b1: b1,
    };
    ent.h.lsock.backlog.push({ pipe: b2, peer: b1, mode: 'rw', nonblock: false,
      sk: { fam: 2, type: 1, name: ent.h.sk.name, peername: { fam: 2, port: this._ephemeralPort(), ip: '10.0.2.2' } } });
    (root._inbound ??= []).push(conn);
    this._wakeTree();
    return conn;
  }
  _external(ip) { return !!ip && !ip.startsWith('127.') && ip !== '0.0.0.0'; }
  _credOf() {
    return this._cred ??= this.parentEng ? { ...this.parentEng._credOf(), groups: [...this.parentEng._credOf().groups] }
      : { ruid: 0, euid: 0, suid: 0, rgid: 0, egid: 0, sgid: 0, groups: [] };
  }
  _netRoot() { let r = this; while (r.parentEng) r = r.parentEng; return r; }
  _net() { let r = this; while (r.parentEng) r = r.parentEng; return r._netProvider ?? null; }
  // move bytes between the guest's socket buffers and the host connections.
  // Called by the host between slices; returns true if anything moved.
  netPump() {
    let moved = false;
    for (const c of this._netConns ?? []) {
      const { conn, b1, b2 } = c;
      if (conn.state === 'connecting') continue;
      if (conn.state === 'error') { if (!b1.weof) { b1.weof = true; moved = true; } continue; }
      while (b2.chunks.length) { const ch = b2.chunks.shift(); b2.off = 0; if (ch.length) conn.write(ch); b2.size = Math.max(0, (b2.size ?? 0) - ch.length); moved = true; }
      if (b2.weof && !c.ended) { conn.end(); c.ended = true; moved = true; }
      while (conn.rx.length) { const ch = conn.rx.shift(); b1.chunks.push(ch); b1.size = (b1.size ?? 0) + ch.length; b1.wtot = (b1.wtot ?? 0) + ch.length; moved = true; }
      if (conn.eof && !b1.weof) { b1.weof = true; moved = true; }
    }
    if (this._netConns) this._netConns = this._netConns.filter((c) => !(c.conn.state !== 'connecting' && (c.conn.eof || c.conn.state === 'error') && c.b1.weof && !c.conn.rx.length));
    for (const c of this._inbound ?? []) {
      const b1 = c._b1;
      while (b1.chunks.length) { const ch = b1.chunks.shift(); b1.off = 0; b1.size = Math.max(0, (b1.size ?? 0) - ch.length); if (ch.length) c.onData?.(ch); moved = true; }
      if (b1.weof && !c.closed) { c.closed = true; c.onEnd?.(); moved = true; }
    }
    if (this._inbound) this._inbound = this._inbound.filter((c) => !c.closed);
    for (const u of this._netUdp ?? []) {
      for (const d of u.sock.queue.splice(0)) { u.h.dsock.queue.push({ bytes: d.bytes, from: { fam: 2, port: d.port, ip: d.ip } }); moved = true; }
    }
    if (moved) this.wakeAllBlk();
    return moved;
  }
  _dgramSendBytes(h, bytes, sa) {
    const dst = sa ?? h.sk.peerSa;
    if (dst?.fam === 2 && this._external(dst.ip) && this._net()) {
      if (!h.sk.name) h.sk.name = { fam: 2, port: this._ephemeralPort(), ip: this._net().localIp };
      if (!h.udpBridge) { h.udpBridge = this._net().udp(); (this._netRoot()._netUdp ??= []).push({ h, sock: h.udpBridge }); }
      h.udpBridge.send(bytes, dst.ip, dst.port); return BigInt(bytes.length);
    }
    const key = sa ? this._sockKey(sa) : h.sk.peer; if (!key) return -89n;   // EDESTADDRREQ
    const reg = this._sockReg(), ent = reg.get(key);
    if (ent && !this._handleAlive(ent.h)) reg.delete(key);
    if (!ent || !ent.h.dsock || !this._handleAlive(ent.h)) {
      if (h.sk.fam === 1) return sa && !sa.abstract && !this._sockAt(sa.path) ? -2n : -111n;
      return BigInt(bytes.length); }                          // UDP to a port nobody listens on: sent, dropped
    if (!h.sk.name && h.sk.fam === 2) h.sk.name = { fam: 2, port: this._ephemeralPort() };   // autobind so a reply can come back
    ent.h.dsock.queue.push({ bytes, from: h.sk.name }); this._wakeTree(); return BigInt(bytes.length);
  }
  _dgramRecv(h, addr, len, fl, ap, alp) {
    const q = h.dsock.queue;
    if (!q.length) { if (h.nonblock || (fl & 0x40)) return -11n; this.block(null); return null; }
    const d = (fl & 2) ? q[0] : q.shift(), n = Math.min(len, d.bytes.length);   // MSG_PEEK keeps it queued
    if (n) { this.jsnap(addr, n); this.ram.set(d.bytes.subarray(0, n), Number(addr - this.base)); }
    if (ap) this._writeSockaddr(ap, alp, d.from, h.sk.fam);
    return BigInt((fl & 0x20) ? d.bytes.length : n);          // MSG_TRUNC reports the datagram's full size
  }
  _handleAlive(h) {                             // some fd in the process tree still refers to this handle
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set();
    const scan = (e) => {
      if (seen.has(e)) return false; seen.add(e);
      const tables = [e.fds]; if (e._mainFds) tables.push(e._mainFds);
      for (const t of e.threads ?? []) if (t.state !== 'dead' && t.proc?.fds) tables.push(t.proc.fds);
      for (const tb of tables) for (const [, x] of tb) if (x === h) return true;
      for (const c of e.children ?? []) if (c.eng && c.exited === null && c.eng.exitCode === null && scan(c.eng)) return true;
      return false;
    };
    return scan(root);
  }
  _sockUnreg(h) {                               // the last fd on a bound socket closed: its name is free again (the socket file stays)
    const reg = this._sockReg(); for (const [k, e] of reg) if (e.h === h) reg.delete(k);
  }
  _pidDone(pid) {                               // pidfd readiness: the child has exited
    let root = this; while (root.parentEng) root = root.parentEng;
    const f = (e) => { for (const c of e.children ?? []) { if (c.pid === pid) return c.exited !== null || !c.eng || c.eng.exitCode !== null; if (c.eng) { const r = f(c.eng); if (r !== undefined) return r; } } return undefined; };
    return f(root) ?? true;
  }
  _pipeWriterAlive(buf) {
    let root = this; while (root.parentEng) root = root.parentEng;
    const seen = new Set();
    const scan = (e) => {
      if (seen.has(e)) return false; seen.add(e);
      const tables = [e.fds];
      if (e._mainFds) tables.push(e._mainFds);
      for (const t of e.threads ?? []) if (t.state !== 'dead' && t.proc?.fds) tables.push(t.proc.fds);
      for (const tb of tables) for (const [, h] of tb) { if ((h?.pipe === buf && h.mode === 'w') || h?.peer === buf) return true;
        if (h?.lsock) for (const x of h.lsock.backlog) if (x.peer === buf) return true; }   // a connection nobody has accepted yet
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
      for (const tb of tables) for (const [, h] of tb) { if (h?.pipe === buf && h.mode !== 'w') return true;   // 'r', or a socketpair end ('rw')
        if (h?.lsock) for (const x of h.lsock.backlog) if (x.pipe === buf) return true; }
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
      if (e.stopEv && !e._stopSeen) { e._stopSeen = true; this.raiseSignal(17, null, { pid: c.pid, code: 5, status: e.stopEv }); }   // CLD_STOPPED
      if (e.contEv && !e._contSeen) { e._contSeen = true; this.raiseSignal(17, null, { pid: c.pid, code: 6, status: 18 }); }         // CLD_CONTINUED
      if (e.exitCode === null && !e.stopped) {
        if (e.blocked) e.wake();
        try { e.run(3e5); } catch (err) { c.exited = 127; c.error = err.message; c.errorStack = err.stack; if (ENV.OXWASM_CHILD_ERRORS) {
          const rip = e.cpu?.rip ?? e.threads?.[e.ti]?.cpu?.rip;
          const m = (e.maps ?? []).find((x) => rip !== undefined && rip >= x.at && rip < x.at + BigInt(x.len));
          console.error("[child engine error]", err.message, "argv0=" + (e._ctor?.argv?.slice(0, 3).join(" ")), "rip=" + rip?.toString(16), e.strace ? "\n  last syscalls: " + e.strace.slice(-70).join(" ") : "", m ? `in ${m.path}+${(rip - m.at + BigInt(m.fileOff ?? 0)).toString(16)}` : "");
        } }   // errorStack: where in the engine a child died (tooling)
      }
      if (c.exited === null && e.exitCode !== null) {
        c.exited = e.exitCode;
        this._ptyHangup(e);
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
    if (this.pumpAsm) this.pumpAsm();
    if (this._execed) {                // main process tail-exec'd: pump the replacement
      this.pumpChildren();
      const c = this._execed;
      if (c.exited !== null) { this.exitCode = c.exited; if (c.eng?.termSig) this.termSig = c.eng.termSig; }   // a signal death is the process's death (a job killed by SIGTERM is "Terminated", not "Exit 143")
      else this.block(this.nowMs() + 2);
      return 0;
    }
    let out = this._run1(maxSteps);
    for (let round = 0; round < 64; round++) {
      if (this.exitCode !== null || !this.blocked) break;
      const live = (this.children ?? []).filter(c => c.exited === null && c.eng.exitCode === null && !c.eng.stopped);   // a stopped child is not runnable
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
      for (const c of this.children) if (c.exited === null && c.eng && c.eng.exitCode === null && !c.eng.stopped) {   // a stopped child sets no deadline (it looked runnable and spun the host)
        const cd = c.eng.blocked ? c.eng.blocked.deadline : this.nowMs();
        if (cd != null && (dl == null || cd < dl)) dl = cd;
      }
      this.blocked.deadline = dl == null ? this.nowMs() + 2 : dl;
    }
    return out;
  }

  // Slice preemption for a parent whose children are separate engines: the
  // host pumps them only between run() slices, and a slice ends on a step
  // budget that compiled code never burns. A parent spinning through
  // non-blocking syscalls in compiled code (python's Pool: three threads in
  // poll/wait4/clock_gettime, 2.2M calls) never blocked as a whole, so its
  // workers never ran - a livelock the vfork budget bug had been hiding by
  // keeping every such parent interpreted. With live child engines, a slice
  // older than 50 ms is cut at the next syscall (or callout hop, or 4096
  // nested interpreter steps): an immediate-deadline block unwinds to the
  // host, which pumps the children and resumes at the next instruction.
  _kidsDue() {
    return this.children !== undefined && this.children.length !== 0 && this._sliceT0 !== undefined &&
      performance.now() - this._sliceT0 > 50 &&
      this.children.some(c => c.exited === null && c.eng !== undefined && c.eng !== null && c.eng.exitCode === null && !c.eng.stopped);
  }
  _run1(maxSteps = 5e9) {
    let steps = 0;
    this._sliceT0 = performance.now();
    // true top level (never nested): clear the wasm-frame budget word so
    // taxes leaked by unwound chains can't accumulate across slices
    (this._ftdv ??= new DataView(this.wmem.buffer)).setUint32(FTMAP + 8, 0, true);
    if (this.children?.some(c => c.exited === null)) this.pumpChildren();
    try {
      let branched = true;    // compiled entries are branch targets: only look up after a branch
      while (steps++ < maxSteps && this.exitCode === null) {
        if ((steps & 0x3FFFF) === 0 || ((steps & 0x3FF) === 0 && this._rotateDue())) {
          if (this.threads.length > 1) { this.rotate(); branched = true; }   // preemption quantum (steps, or the wall-clock quantum)
          if (this.itimer?.at != null) this._checkAlarm();
        }
        if (this._sigAny && this._sigPoll()) branched = true;     // asynchronous delivery at an insn boundary
        const key = this.cpu.rip;
        let f = branched && !this._aotOff ? this.aotFns.get(key) : undefined;
        if (globalThis.__dbgRip !== undefined && key === globalThis.__dbgRip && ((this._dbgN = (this._dbgN | 0) + 1) & 0xFFFFF) === 1) console.error(`<dbgrip ${key.toString(16)} branched=${branched} f=${typeof f} has=${this.aotFns.has(key)} budget=${this.aotBudget} n=${this._dbgN}>`);
        // OXWASM_DISPSTAT: why an rip with a compiled unit was NOT dispatched.
        // A hot loop head can hold a real export and still run interpreted,
        // and no existing counter separates "no unit" from "unit, but the
        // lookup was skipped" or "unit, but the budget refused it".
        if (DISPSTAT) { if (!branched && this.aotFns.get(key)) this.stats.noLook = (this.stats.noLook || 0) + 1; }
        if (f && this.aotBudget !== undefined && --this.aotBudget < 0) { f = null; this.stats.dispBudget = (this.stats.dispBudget || 0) + 1; }
        if (f) { if (this.ripTrace !== undefined) { this.ripTrace[this.ripTraceI++ & 65535] = -key; }   // negative = AOT entry
                 this.cpu.rip = this.dispatchMaybeShadow(f);
                 if (this.ripTrace !== undefined) { this.ripTrace[this.ripTraceI++ & 65535] = -this.cpu.rip; }  // AOT exit
                 branched = true;
                 if (this.blocked) { if (this.park()) continue; break; }
                 if (this.itimer?.at != null) this._checkAlarm();
                 if (this._sigAny) this._sigPoll();
                 if (this.sliceDeadline != null && performance.now() > this.sliceDeadline) break;
                 if (this._rotateDue()) this.rotate();   // a compiled loop that yielded is one step however long it ran: check the quantum here
                 continue; }
        const c = branched ? this.compiled.get(key) : undefined;
        if (c) {
          for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
          c.run();
          for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
          this.cpu.rip = c.exit; this.stats.compiledRuns++; branched = true; continue;
        }
        const before = this.cpu.rip;
        if (this.ripTrace !== undefined && before >= this._rtLo && before < this._rtHi) this.ripTrace[this.ripTraceI++ & 65535] = before;
      if (this._ripLog !== undefined && this._ripLog.has(before)) this._ripHit(before);

        let insn;
        this._cleanSync = false;
        if (BREAKS !== null && BREAKS.has(this.cpu.rip)) this._onBreak();
        try { insn = this.cpu.step(); }
        catch (e) { if (e === EXIT) break;
          if (e.pending) {                 // streamed page not here yet: rewind
            this.cpu.rip = before;         // and retry the instruction shortly
            this.blocked = { deadline: this.nowMs() + 40 };
            break;
          }
          e.rip = before; throw e; }
        this.stats.interpreted++;
        if (globalThis.__ihist !== undefined && (this.stats.interpreted & 63) === 0) { const h = globalThis.__ihist, k = this.cpu.rip; h.set(k, (h.get(k) || 0) + 1); }
        branched = BRANCHY.has(insn.mnem) || this.cpu.rip !== before + BigInt(insn.len);
        if (this.onProgress && this.stats.interpreted % 2e7 === 0) this.onProgress('run');
        if (this.blocked) { this.cpu.rip = before;            // re-execute the syscall on resume
                            branched = true;
                            if (this.park()) continue; break; }
        if ((steps & 0xFFF) === 0 && this.sliceDeadline != null && performance.now() > this.sliceDeadline) break;
        // Deferred units register from pumpAsm(), which ran only at run()
        // entry and at the next tier-up: once every hot root was submitted,
        // a long interpreted stretch never pumped again, and perl's op
        // dispatcher ran its whole loop interpreted with its own compiled
        // unit sitting in the broker's fifo (38 s against 11 s synchronous;
        // the unit came back at t=9 s and registered at t=38 s, the end).
        // Pump every 2^18 steps while anything is in flight.
        if ((steps & 0x3FFFF) === 0 && this.pumpAsm && this._inflight && this._inflight.size) this.pumpAsm();
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

  // bisect aids (env): OXWASM_FNVETO_FILE = file of hex entries never compiled; OXWASM_FNDUMP = file the considered entries are written to at exit
  _envVeto(c) {
    if (typeof process === 'undefined') return false;
    if (this._ev === undefined) {
      const f = ENV.OXWASM_FNVETO_FILE;
      this._ev = f ? new Set(process.getBuiltinModule('node:fs').readFileSync(f, 'utf8').split(/\s+/).filter(Boolean)) : null;
      const fa = ENV.OXWASM_FNALLOW_FILE;
      this._ea = fa ? new Set(process.getBuiltinModule('node:fs').readFileSync(fa, 'utf8').split(/\s+/).filter(Boolean)) : null;
      if (ENV.OXWASM_FNDUMP && !globalThis.__fnDump) globalThis.__fnDump = new Set();
    }
    if (globalThis.__fnDump) { const h = BigInt(c).toString(16); if (!globalThis.__fnDump.has(h)) { globalThis.__fnDump.add(h); process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_FNDUMP, h + '\n'); } }
    const hx = BigInt(c).toString(16);
    if (ENV.OXWASM_DUMPFN && ENV.OXWASM_DUMPFN.split(',').includes(hx)) { const b = new Uint8Array(0x600); for (let i = 0; i < b.length; i++) { try { b[i] = Number(this.mem.read(BigInt(c) + BigInt(i), 1n)); } catch { break; } } process.getBuiltinModule('node:fs').writeFileSync(ENV.OXWASM_DUMPDIR + '/fn_' + hx + '.bin', b); const m = (this.maps ?? []).find((x) => BigInt(c) >= x.at && BigInt(c) < x.at + BigInt(x.len)); console.error(`[dumpfn] ${hx} map=${m ? m.path + '+0x' + (BigInt(c) - m.at + BigInt(m.fileOff ?? 0)).toString(16) : 'anon'} execRanges=${(this.execRanges ?? []).filter(([x, y]) => BigInt(c) >= x && BigInt(c) < y).map(([x, y]) => x.toString(16) + '-' + y.toString(16)).join(',')}`); }
    return (this._ev ? this._ev.has(hx) : false) || (this._ea ? !this._ea.has(hx) : false);
  }

  _onBreak() {
    const c = this.cpu, r = c.regs, q = (a, n = 8n) => { try { return this.mem.read(a, n).toString(16); } catch { return '?'; } };
    // OXWASM_BREAK_RANGEADDR=hex: report only when [vm.lastStackTop, rsp) (JSC sanitizeStackForVM's zeroing range,
    // rdi = VM) covers that address - the one call that wipes a live frame among tens of thousands
    if (ENV.OXWASM_BREAK_RANGEADDR) { const X = BigInt('0x' + ENV.OXWASM_BREAK_RANGEADDR); let lst; try { lst = this.mem.read(r[7] + 0x1f830n, 8n); } catch { return; } if (!(lst <= X && X < r[4])) return; }
    // OXWASM_BREAK_VMTOP=1: report only when vm.topCallFrame (VM+0x20, rdi = VM) lies BELOW rsp - a live JS
    // frame under the stack pointer, which sanitizeStackForVM then zeroes. Legit calls have it above.
    if (ENV.OXWASM_BREAK_VMTOP) { let top; try { top = this.mem.read(r[7] + 0x20n, 8n); } catch { return; } if (!(top !== 0n && top < r[4])) return; }
    // OXWASM_BREAK_GREP=text: print every place the text occurs in guest memory, with context (an error
    // message the guest built, a string an unhandled rejection carries)
    if (ENV.OXWASM_BREAK_GREP) try { const pat = new TextEncoder().encode(ENV.OXWASM_BREAK_GREP), ram = new Uint8Array(this.wmem.buffer, this.RAMOFF, this.ram.length); let n = 0, i = 0; const out = []; while (n < 40 && (i = ram.indexOf(pat[0], i)) >= 0) { let ok = true; for (let j = 1; j < pat.length; j++) if (ram[i + j] !== pat[j]) { ok = false; break; } if (ok && i < +(ENV.OXWASM_BREAK_GREP_MIN || 0x8000000)) { i += pat.length; continue; }   // skip the static image: error-message templates
        if (ok) { n++; const lo = Math.max(0, i - 80), hi = Math.min(ram.length, i + 160); let txt = ''; for (let k = lo; k < hi; k++) { const b = ram[k]; txt += (b >= 32 && b < 127) ? String.fromCharCode(b) : (b === 0 ? '' : '.'); } out.push(`${(this.base + BigInt(i)).toString(16)}: ${txt}`); i += pat.length; } else i++; } console.error(`[grep "${ENV.OXWASM_BREAK_GREP}"] ${n} hits\n  ` + out.join('\n  ')); } catch (e) { console.error('[grep] failed: ' + e.message); }
    const names = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15'];
    let out = `[break ${c.rip.toString(16)}] tid=${this.threads[this.ti]?.id} disp=${this.stats.disp} ` + names.map((n, i) => `${n}=${r[i].toString(16)}`).join(' ') + ` [rdi+1f830]=${q(r[7] + 0x1f830n)} vmtop=${q(r[7] + 0x20n)} [rsp]=${q(r[4])} [rsp+8]=${q(r[4] + 8n)} fs=${c.fsBase?.toString(16)}\n`;
    // JSC call frames up the rbp chain: return pc, CodeBlock slot (+0x10), callee (+0x18), argc/callSiteIndex (+0x20/+0x24)
    let f = r[5];
    for (let k = 0; k < 14 && f > 0x1000n; k++) {
      out += `  frame rbp=${f.toString(16)} ret=${q(f + 8n)} cb=${q(f + 0x10n)} callee=${q(f + 0x18n)} argc=${q(f + 0x20n, 4n)} site=${q(f + 0x24n, 4n)}\n`;
      let nf; try { nf = this.mem.read(f, 8n); } catch { break; } if (nf <= f) break; f = nf;
    }
    // OXWASM_BREAK_CB=hexsite: dump the CodeBlock of every JS frame (heap pointer in +0x10) and, for each
    // heap-pointer field in it, the bytecode bytes at pointer+site - the base among them is the instruction stream
    // OXWASM_BREAK_TABLES=1: JSC LLInt opcode maps (narrow / wide16 / wide32 at 0x5bdc000 + k*0x800): entries 0, 1, 0x52
    if (ENV.OXWASM_BREAK_TABLES) { for (let t = 0; t < 3; t++) { const base = 0x5bdc000n + BigInt(t) * 0x800n; out += `  optable${t}: [0]=${q(base)} [1]=${q(base + 8n)} [0x52]=${q(base + 0x52n * 8n)} [0x53]=${q(base + 0x53n * 8n)} [0x51]=${q(base + 0x51n * 8n)}\n`; } }
    if (ENV.OXWASM_BREAK_CB) {
      const site = BigInt('0x' + ENV.OXWASM_BREAK_CB); let f2 = r[5];
      for (let k = 0; k < 14 && f2 > 0x1000n; k++) {
        let cb; try { cb = this.mem.read(f2 + 0x10n, 8n); } catch { break; }
        if (cb >= 0x59000000n && cb < 0x6c000000n) {
          out += `  codeblock frame=${f2.toString(16)} cb=${cb.toString(16)}:`;
          for (let w = 0; w < 32; w++) { const v = this.mem.read(cb + BigInt(w * 8), 8n); out += ` [${(w * 8).toString(16)}]=${v.toString(16)}`;
            if (v >= 0x59000000n && v < 0x6c000000n && w > 0) { let bs = ''; for (let b = -8n; b < 12n; b++) bs += q(v + site + b, 1n).padStart(2, '0') + (b === -1n ? '|' : ' '); out += `{@+site: ${bs}}`; } }
          out += '\n';
        }
        let nf; try { nf = this.mem.read(f2, 8n); } catch { break; } if (nf <= f2) break; f2 = nf;
      }
    }
    if (this._ripLogRing !== undefined) { this._ripLogFlush(); out += '  riplog:\n    ' + this._ripLogRing.join('\n    ') + '\n'; }
    if (this._dring !== undefined) { const r = this._dring, n = r.length, i0 = this._dringI | 0; const lines = []; for (let i = 0; i < n; i++) { const e = r[(i0 + i) % n]; if (e) lines.push(e); } out += '  dispring:\n    ' + lines.join('\n    ') + '\n'; }
    if (this.ripTrace !== undefined) { const n = +(ENV.OXWASM_RIPTRACE_N || 160), seq = []; for (let i = n; i >= 1; i--) { const v = this.ripTrace[(this.ripTraceI - i) & 65535]; seq.push(v < 0n ? 'A' + (-v).toString(16) : v.toString(16)); } out += '  riptrace (A=aot entry/exit): ' + seq.join(' ') + '\n'; }
    console.error(out);
  }


  // Diagnosis: OXWASM_WATCHPAGE=hex (with OXWASM_STOREGUARD=1 for compiled stores) logs every store into that
  // 4K page: interpreter stores through Memory.watch, compiled stores through the store guard window.
  _armWatchPage(page) {
    this._watchArmed = true; this._watchPage = page & ~4095n;
    const dv = new DataView(this.wmem.buffer);
    dv.setUint32(CWLO_SLOT, this.RAMOFF + Number(this._watchPage - this.base), true);
    dv.setUint32(CWLEN_SLOT, 4096, true);
    new Uint8Array(this.wmem.buffer).fill(0, CWMAP, CWMAP + CWMAP_PAGES);
    new Uint8Array(this.wmem.buffer)[CWMAP] = 1;
    this.mem.watchLo = this._watchPage; this.mem.watchHi = this._watchPage + 4096n;
    this.mem.watch = (addr, n, v) => this._watchLog(addr, n, v, 'interp rip=' + this.cpu.rip.toString(16));
    console.error(`[watch armed] page=${this._watchPage.toString(16)} storeguard=${STOREGUARD}`);
  }
  _watchLog(addr, n, v, how) {
    // OXWASM_WATCHADDR=hex[:len]: within the watched page, log only stores overlapping this range
    // (a compiled store reports its address only; it is taken as 8 bytes)
    if (ENV.OXWASM_WATCHADDR) { const [ah, lh] = ENV.OXWASM_WATCHADDR.split(':'); const wa = BigInt('0x' + ah), wl = BigInt(lh || '8'); const nn = BigInt(n || 8); if (!(addr < wa + wl && addr + nn > wa)) return; }
    const line = `[watch] tid=${this.threads[this.ti]?.id} ${how} addr=${addr.toString(16)} n=${n} v=${(typeof v === 'bigint' ? v : BigInt(v || 0)).toString(16)} lastEntry=${this._lastEntry?.toString(16)} disp=${this.stats.disp}`;
    if (ENV.OXWASM_WATCHLOG) process.getBuiltinModule('node:fs').appendFileSync(ENV.OXWASM_WATCHLOG, line + '\n'); else console.error(line);
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
