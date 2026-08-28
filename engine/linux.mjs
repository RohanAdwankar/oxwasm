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
const SHADOW_ABORT = { shadowAbort: true };
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
                          assembleWat = null, aotCallThreshold = 12, aotLoopThreshold = 40,
                          xserver = null, mtimes = {} } = {}) {
    this.files = files;                       // path -> Uint8Array (read-only)
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
    this.exitCode = null;
    this.stdout = [];
    this.stdoutBytes = [];                    // raw chunks — binary-safe (gzip -c etc.)
    // ---- tier-2: runtime whole-function AOT ----
    // assembleWat: (watText) -> Uint8Array of wasm; injected because the text
    // assembler differs by host (wat2wasm CLI under node, wabt.js in a page).
    this.assembleWat = assembleWat;
    this.aotFns = new Map();                  // ripStr -> wasm export
    this.aotFailed = new Set();
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
    const k = t.toString();
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

  // Compile the call-graph closure rooted at `entry` (a function entry or a
  // loop head — the translator only needs "runs forward to this frame's ret")
  // and register every function the unit produced for dispatch.
  tierUpAot(entry) {
    const k = entry.toString();
    if (this.aotFns.has(k) || this.aotFailed.has(k)) return;
    if (this.isTrampoline(entry)) { this.aotFailed.add(k); return; }
    const un = (this._unitN = (this._unitN || 0) + 1);   // bisect aid: veto unit N -> stays interpreted
    if (this.unitFilter && !this.unitFilter(un, entry)) { this.aotFailed.add(k); return; }
    try {
      const unit = compileUnitWat(this.mem, entry, { guestBase: this.base, ramBase: this.RAMOFF });
      if (this.onUnitWat) this.onUnitWat(un, entry, unit);
      const bytes = this.assembleWat(unit.wat);
      const inst = new WebAssembly.Instance(new WebAssembly.Module(bytes), { js: { mem: this.wmem }, env: this.aotEnv() });
      for (const a of unit.funcs) {
        const ak = a.toString();
        if (!this.aotFns.has(ak)) this.aotFns.set(ak, inst.exports['f_' + a.toString(16)]);
      }
      if (!this.aotFns.has(k)) throw new Error('entry missing from unit');
      this.stats.tiers.aot = (this.stats.tiers.aot || 0) + 1;
    } catch (e) { this.aotFailed.add(k);
      if (this.onAotFail) this.onAotFail(entry, e.message);
    }
  }

  // GPRs at 0..127, fs base at 128, the 16 xmm registers at 256..511 (16B
  // each, low 64 then high 64) — the AOT reads/writes v128 there directly.
  syncOut() { for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
              this.fsview[0] = BigInt.asIntN(64, this.cpu.fsBase || 0n);
              const x = this.xmmview; const M = (1n << 64n) - 1n;
              for (let r = 0; r < 16; r++) { const v = this.cpu.xmm[r] || 0n;
                x[r*2] = BigInt.asIntN(64, v & M); x[r*2+1] = BigInt.asIntN(64, (v >> 64n) & M); } }
  syncIn()  { for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
              this.cpu.fsBase = BigInt.asUintN(64, this.fsview[0]);
              const x = this.xmmview;
              for (let r = 0; r < 16; r++) this.cpu.xmm[r] = BigInt.asUintN(64, x[r*2]) | (BigInt.asUintN(64, x[r*2+1]) << 64n); }

  // Run one compiled function; a deopt inside it (or its wasm callees)
  // unwinds here and execution state is already in the regfile/guest stack.
  // Returns the rip to continue at.
  dispatchAot(f) {
    this.syncOut();
    try { const exit = f(); this.syncIn(); this.stats.aotRuns++;
      if (this.onProgress && this.stats.aotRuns % 4e6 === 0) this.onProgress('aot');
      return BigInt.asUintN(64, exit); }
    catch (e) { if (e instanceof DeoptUnwind) { this.syncIn(); return BigInt.asUintN(64, e.rip); }
                if (e instanceof BlockUnwind) { this.syncIn(); return BigInt.asUintN(64, e.rip); }
                throw e; }
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
    if (!this.shadowRange || this._shadowBusy ||
        this.cpu.rip < this.shadowRange[0] || this.cpu.rip >= this.shadowRange[1])
      return this.dispatchAot(f);
    const k = this.cpu.rip.toString();
    const n = (this._shadowClean ??= new Map()).get(k) ?? 0;
    if (n >= 50) return this.dispatchAot(f);            // exonerated after 50 clean passes
    this._shadowClean.set(k, n + 1);
    return this.shadowDispatch(f);
  }

  // Interpret (dispatching into compiled functions when rip lands on one)
  // until `done()` — used by the callout escape.
  interpUntil(done) {
    let guard = 0;
    while (!done()) {
      let f = this.aotFns.get(this.cpu.rip.toString());
      if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
      if (f) { this.cpu.rip = this.dispatchMaybeShadow(f);
               if (this.blocked) throw new BlockUnwind(this.cpu.rip);
               continue; }
      const before = this.cpu.rip;
      const insn = this.cpu.step(); this.stats.interpreted++;
      if (this.onProgress && this.stats.interpreted % 2e7 === 0) this.onProgress('callout');
      if (this.exitCode !== null) throw EXIT;
      if (this.blocked) { this.cpu.rip = before; throw new BlockUnwind(before); }
      // profile back-edges here too: a callout can nest arbitrarily deep and
      // run for millions of steps — without tier-up, everything under it
      // would stay interpreted forever (GIMP's babl LUT init lives here)
      if (insn.mnem === 'jcc' && this.cpu.rip < before && this.inExec(this.cpu.rip)) {
        const hk = this.cpu.rip.toString();
        const n = (this.profile.get(hk) || 0) + 1;
        this.profile.set(hk, n);
        if (this.assembleWat && n >= this.aotLoopThreshold && !this.aotFns.has(hk) && !this.aotFailed.has(hk))
          this.tierUpAot(this.cpu.rip);
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
        // The caller (compiled code) already spilled the whole register file to
        // memory before the call, and the guest return address is on the guest
        // stack. rsp lives in the regfile at slot 4.
        const rsp0 = BigInt.asUintN(64, this.regview[4]);
        if (rsp0 < 0x10000n && this.onBadRsp) this.onBadRsp(target, rsp0);
        const retAddr = this.mem.read(rsp0, 8n);
        const rspExit = BigInt.asUintN(64, rsp0 + 8n);
        let f = this.aotFns.get(target.toString());
        if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
        if (this.chainSlow) f = null;                       // diagnostic: disable wasm-to-wasm fastpath
        if (f) {
          // Target is compiled: run it wasm-to-wasm over the shared register
          // file — NO BigInt cpu<->memory sync (the expensive part). It reads
          // and writes the same regfile memory the caller will reload from.
          try { this.stats.aotRuns++;
            const exit = BigInt.asUintN(64, f());
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
        this.syncIn(); this.cpu.rip = target;
        this.interpUntil(() => this.cpu.rip === retAddr && this.cpu.regs[4] === rspExit);
        this.syncOut();
        return BigInt.asIntN(64, retAddr);
      },
      // rsp0 is unused: the frames unwind, they are not interpreted under.
      // Profile the landing so an indirect jump that only runs inside AOT code
      // (a compiled trampoline, a jump table) still tiers up its target.
      deopt: (rip, _rsp0) => { const t = BigInt.asUintN(64, rip);
        if (this.inExec(t)) this.profileTarget(t); throw new DeoptUnwind(t); },
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
  norm(p) { return p.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/').replace(/^\.\//, ''); }
  lookup(p) { p = this.norm(p); return this.files[p]; }
  // a guest path is a directory iff some provided file lives under it
  isDir(p) {
    p = this.norm(p);
    if (p === '/' ) return true;
    const pre = p.endsWith('/') ? p : p + '/';
    if (this._dirset === undefined) {
      this._dirset = new Set();
      for (const k of Object.keys(this.files)) {
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
    return [...names.entries()];
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
    if (t.state !== 'dead') {
      t.state = 'blk'; t.dl = this.blocked?.deadline ?? null;
      t.futex = this._futexAddr; t._dl = this._deadline;
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
      const bytes = this.ram.slice(Number(addr - this.base), Number(addr - this.base) + len);
      const h = defSink(fd);
      if (h?.sock?.conn) { h.sock.conn.write(bytes); this.wakeAllBlk(); return; }
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
      if (h?.sink === 'err') { (this.stderr ||= []).push(str); (this.stderrBytes ||= []).push(bytes); }
      else { this.stdout.push(str); this.stdoutBytes.push(bytes); }
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
        if (nr === 32) { const fd = this.allocFd(); this.fds.set(fd, handle); ret(BigInt(fd)); break; }
        const nw = Number(a2); this.fds.set(nw, handle); ret(BigInt(nw)); break; }
      case 22: case 293: {                                   // pipe / pipe2
        const buf = { chunks: [], pos: 0, off: 0 };
        const rfd = this.allocFd(); this.fds.set(rfd, null); const wfd = this.allocFd(); this.fds.delete(rfd);
        this.fds.set(rfd, { pipe: buf, mode: 'r' });
        this.fds.set(wfd, { pipe: buf, mode: 'w' });
        const v = new DataView(this.wmem.buffer), o = this.RAMOFF + Number(a1 - this.base);
        v.setUint32(o, rfd, true); v.setUint32(o + 4, wfd, true);
        ret(0n); break; }
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
          (this.maps ??= []).push({ at, len, path: h.path ?? '?', fileOff: fo });
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
      case 16: ret(-25n); break;                             // ioctl -> ENOTTY
      case 158:                                              // arch_prctl
        if (Number(a1) === 0x1002) { cpu.fsBase = a2; ret(0n); } else ret(-22n);
        break;
      case 218: { const t = this.threads[this.ti]; t.ctid = a1; ret(BigInt(t.id)); break; }  // set_tid_address
      case 56: {                                             // clone: threads only (CLONE_VM)
        const flags = Number(a1 & 0xffffffffn);
        if (!(flags & 0x100)) { ret(-38n); break; }          // a real fork -> ENOSYS (callers fall back or fail)
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
      case 24: ret(0n); break;                               // sched_yield (quantum rotation covers fairness)
      case 273: ret(0n); break;                              // set_robust_list
      case 157: ret(0n); break;                              // prctl (PR_SET_NAME etc.)
      case 204: {                                            // sched_getaffinity: one CPU
        const n = Math.min(Number(a2), 8);
        const o = this.RAMOFF + Number(a3 - this.base);
        new Uint8Array(this.wmem.buffer, o, n).fill(0);
        new DataView(this.wmem.buffer).setUint8(o, 1);
        ret(8n); break; }
      case 60: {                                             // exit: THREAD exit
        const t = this.threads[this.ti];
        if (this.threads.filter(x => x.state !== 'dead').length <= 1) {
          this.exitCode = Number(a1 & 0xffn); cpu.halted = true; ret(0n); break;
        }
        t.state = 'dead';
        if (t.ctid) { this.mem.write(t.ctid, 4n, 0n); this.futexWake(t.ctid, 1 << 30); }
        this.block(null); ret(0n); break; }                  // park() skips dead threads
      case 231:                                              // exit_group: whole process
        this.exitCode = Number(a1 & 0xffn); cpu.halted = true; ret(0n); break;
      case 228: {                                            // clock_gettime(clk, ts*)
        const clk = Number(a1), o = this.RAMOFF + Number(a2 - this.base);
        const v = new DataView(this.wmem.buffer);
        const ms = (clk === 0 || clk === 5 || clk === 6) ? Date.now() : this.nowMs();
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
      case 105: case 106: ret(0n); break;                     // setuid/setgid
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
        const p = this.readPath(nr === 257 ? a2 : a1);
        const flags = Number(nr === 257 ? a3 : a2);
        let f = this.lookup(p);
        if (f === undefined) {
          if (this.isDir(p)) {                                // O_DIRECTORY / readdir scans
            const fd = this.allocFd();
            this.fds.set(fd, { isdir: true, path: this.norm(p), pos: 0 });
            ret(BigInt(fd)); break;
          }
          if (flags & 0x40) {                                 // O_CREAT: writable guest files
            f = new Uint8Array(0);
            this.files[this.norm(p)] = f;
            if (this.mtimes) this.mtimes[this.norm(p)] = Math.floor(this.nowMs() / 1000);
          } else { ret(-2n); break; }                         // ENOENT
        } else if (flags & 0x200) {                           // O_TRUNC
          f = new Uint8Array(0);
          this.files[this.norm(p)] = f;
        }
        const fd = this.allocFd();
        const wr = (flags & 3) !== 0;                         // O_WRONLY / O_RDWR
        this.fds.set(fd, { bytes: f, pos: (flags & 0x400) ? f.length : 0, path: this.norm(p), writable: wr });
        ret(BigInt(fd)); break; }
      case 0: {                                               // read(fd, buf, len)
        const fd = Number(a1), h = this.fds.get(fd);
        if (!h) { ret(fd === 0 ? 0n : -9n); break; }          // stdin -> EOF
        if (h.sock) {                                         // stream socket (X connection)
          const c = h.sock.conn;
          if (!c) { ret(-107n); break; }                      // ENOTCONN
          const data = c.read(Number(a3));
          if (data === null) { if (h.sock.nonblock) ret(-11n); else this.block(null); break; }
          this.ram.set(data, Number(a2 - this.base));
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
            this.ram.set(c.subarray(h.pipe.off, h.pipe.off + take), dst);
            dst += take; got += take; h.pipe.off += take;
            if (h.pipe.off >= c.length) { h.pipe.chunks.shift(); h.pipe.off = 0; }
          }
          ret(BigInt(got)); break;                            // 0 => EOF (writer done)
        }
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
        let size = null, mode = 0o020620, statPath = null;    // default: char dev (tty)
        if (isAt) {
          const p = this.readPath(a2);
          if (p === '' && (cpu.regs[10] & 0x1000n)) {         // AT_EMPTY_PATH: stat the fd
            const h = this.fds.get(Number(a1));
            if (h) { size = h.bytes.length; mode = 0o100755; statPath = h.path ?? null; }
          } else {
            const f = this.lookup(p);
            if (f !== undefined) { size = f.length; mode = 0o100755; }
            else if (this.isDir(p)) { size = 4096; mode = 0o040755; }
            else { ret(-2n); break; }                         // ENOENT
            statPath = p;
          }
        } else {
          const h = this.fds.get(Number(a1));
          if (h?.bytes) { size = h.bytes.length; mode = 0o100755; statPath = h.path ?? null; }  // regular file
          else if (h?.pipe) { size = 0; mode = 0o010600; }                 // FIFO
          else if (h?.sock) { size = 0; mode = 0o140777; }                 // socket
          else if (h?.isdir) { size = 4096; mode = 0o040755; statPath = h.path; }
          // sink/tty: leave mode as the char-device default
        }
        const buf = isAt ? cpu.regs[2] : a2;
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
        if (this.debugPollAfter != null && this.nowMs() > this.debugPollAfter) {
          if (this.nowMs() - (this._dbgStatLast ?? 0) > 5000) { this._dbgStatLast = this.nowMs();
            console.error(`<statwd thr=${this.threads?.[this.ti]?.id} ${nr===6?'lstat':'stat'} ${p}>`); } }
        const f = this.lookup(p);
        if (f === undefined && !this.isDir(p)) { ret(-2n); break; }   // ENOENT
        const off = this.RAMOFF + Number(a2 - this.base);
        new Uint8Array(this.wmem.buffer, off, 144).fill(0);
        const v = new DataView(this.wmem.buffer);
        const size = f ? f.length : 4096;
        v.setBigUint64(off + 0, 8n, true);
        v.setBigUint64(off + 8, this.inoOf(p), true);
        v.setBigUint64(off + 16, 1n, true);
        v.setUint32(off + 24, f ? 0o100755 : 0o040755, true);
        v.setBigUint64(off + 48, BigInt(size), true);
        v.setBigUint64(off + 56, 4096n, true);
        v.setBigUint64(off + 64, BigInt(Math.ceil(size / 512)), true);
        const mt = BigInt(this.mtimeOf(p));
        v.setBigUint64(off + 72, mt, true);                   // st_atime
        v.setBigUint64(off + 88, mt, true);                   // st_mtime
        v.setBigUint64(off + 104, mt, true);                  // st_ctime
        ret(0n); break; }
      case 17: {                                              // pread64(fd, buf, count, off)
        const h = this.fds.get(Number(a1));
        if (!h) { ret(-9n); break; }
        const fo = Number(cpu.regs[10]);
        const n = Math.min(Number(a3), Math.max(0, h.bytes.length - fo));
        if (n > 0) this.ram.set(h.bytes.subarray(fo, fo + n), Number(a2 - this.base));
        ret(BigInt(n)); break; }
      case 21: { const p = this.readPath(a1); ret(this.lookup(p) !== undefined || this.isDir(p) ? 0n : -2n); break; }   // access
      case 269: { const p = this.readPath(a2); ret(this.lookup(p) !== undefined || this.isDir(p) ? 0n : -2n); break; }  // faccessat
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
        if (cmd === 4) { if (h?.sock) h.sock.nonblock = !!(Number(a3) & 0x800); ret(0n); break; }  // F_SETFL
        if (cmd === 0 || cmd === 1030) {                      // F_DUPFD / F_DUPFD_CLOEXEC
          if (!h) { ret(-9n); break; }
          let fd = Number(a3); while (this.fds.has(fd)) fd++;
          this.fds.set(fd, h); ret(BigInt(fd)); break;
        }
        ret(0n); break; }                                     // F_GETFD/F_SETFD/...
      case 28: ret(0n); break;                                // madvise
      case 110: ret(0n); break;                               // getppid
      case 186: ret(BigInt(this.threads[this.ti].id)); break;  // gettid
      case 83: ret(0n); break;                                // mkdir: pretend created
      case 87: case 263: {                                    // unlink / unlinkat (open fds keep their buffer)
        const p = this.norm(this.readPath(nr === 87 ? a1 : a2));
        if (this.files[p] === undefined) { ret(-2n); break; }
        delete this.files[p]; ret(0n); break; }
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
        this.files[pn] = this.files[po]; delete this.files[po]; ret(0n); break; }
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
          this.ram.set(data.subarray(off, off + take), Number(p - this.base)); off += take; }
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
            this.ram.set(data.subarray(off, off + take), Number(p - this.base)); off += take; }
          ret(BigInt(data.length)); break;
        }
        if (!h.bytes) { ret(-9n); break; }
        let got = 0;
        for (const [p, l] of list) {
          const n = Math.min(l, h.bytes.length - h.pos); if (n <= 0) break;
          this.ram.set(h.bytes.subarray(h.pos, h.pos + n), Number(p - this.base));
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
          : h.pipe ? h.pipe.chunks.length > 0
          : h.ev ? h.ev.count > 0n
          : !!h.bytes;                                        // regular file: always ready (EOF too)
        const base = this.RAMOFF + Number(a1 - this.base);
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
          : h.pipe ? h.pipe.chunks.length > 0
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

  inExec(rip) { return this.execRanges.some(([a, b]) => rip >= a && rip < b); }

  run(maxSteps = 5e9) {
    let steps = 0;
    try {
      while (steps++ < maxSteps && this.exitCode === null) {
        if ((steps & 0x3FFFF) === 0 && this.threads.length > 1) this.rotate();   // preemption quantum
        const key = this.cpu.rip.toString();
        let f = this.aotFns.get(key);
        if (f && this.aotBudget !== undefined && --this.aotBudget < 0) f = null;
        if (f) { this.cpu.rip = this.dispatchMaybeShadow(f);
                 if (this.blocked) { if (this.park()) continue; break; }
                 continue; }
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
        if (this.onProgress && this.stats.interpreted % 2e7 === 0) this.onProgress('run');
        if (this.blocked) { this.cpu.rip = before;            // re-execute the syscall on resume
                            if (this.park()) continue; break; }
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
