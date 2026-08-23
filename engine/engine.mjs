// oxwasm M3 — the tiering engine. Ties the pieces into one runnable whole:
//   * tier 0  interpreter (interp.mjs) — the correctness oracle, runs cold
//             code and everything the JITs decline.
//   * tier 1  superblock loop JIT (jit2.mjs) — hot integer/memory loops.
//   * tier 1v SIMD vectorizer (jitsimd.mjs) — hot elementwise pixel loops.
//
// One WebAssembly.Memory is the canonical guest state: the 16-entry i64
// register file at offset 0, guest RAM mapped at RAMOFF. The interpreter
// reads/writes guest RAM through a Uint8Array view over that same buffer, so
// interpreter and compiled code share memory with no copying; only the 16
// registers are synced around a compiled-block call.
//
// Dispatch: interpret instruction by instruction, profiling backward branch
// targets. When a loop head crosses the hotness threshold, compile it (SIMD
// first, then superblock); thereafter, reaching that head runs the compiled
// wasm to completion and resumes interpreting at the loop's exit.
import { CPU, Memory } from './interp.mjs';
import { compileLoop } from './jit2.mjs';
import { compileVectorLoop } from './jitsimd.mjs';
import { decode } from './decode.mjs';

const CODE_BASE = 0x10000000n;

export class Engine {
  constructor(codeBytes, { entry, guestBase, ramBytes, threshold = 8 }) {
    this.RAMOFF = 1 << 20;                       // guest RAM at 1MB into wasm mem
    const need = this.RAMOFF + ramBytes;
    const pages = Math.max(256, Math.ceil(need / 65536) + 16);
    this.wmem = new WebAssembly.Memory({ initial: pages });
    this.regview = new BigInt64Array(this.wmem.buffer, 0, 16);
    this.ramView = new Uint8Array(this.wmem.buffer, this.RAMOFF, ramBytes);
    this.code = codeBytes;
    this.guestBase = guestBase;
    this.mem = new Memory([{ base: CODE_BASE, bytes: codeBytes }, { base: guestBase, bytes: this.ramView }]);
    this.cpu = new CPU(this.mem);
    this.cpu.rip = entry;
    this.profile = new Map();
    this.compiled = new Map();
    this.threshold = threshold;
    this.stats = { interpreted: 0, compiledRuns: 0, tiers: {} };
  }

  _tryCompile(headStr, head) {
    const opts = { guestBase: this.guestBase, ramBase: this.RAMOFF };
    let blk = compileVectorLoop(this.mem, head, opts), kind = 'simd';
    if (!blk) { blk = compileLoop(this.mem, head, opts); kind = 'superblock'; }
    if (!blk) { this.compiled.set(headStr, null); return; }   // give up, keep interpreting
    // the compiled loop exits to the instruction after its terminating jcc
    let rip = head, exit = null;
    while (rip < CODE_BASE + BigInt(this.code.length)) {
      const insn = decode((i) => Number(this.mem.read(rip + BigInt(i), 1n)), rip);
      rip += BigInt(insn.len);
      if (insn.mnem === 'jcc') { exit = rip; break; }
    }
    const inst = new WebAssembly.Instance(new WebAssembly.Module(blk.wasm), { js: { mem: this.wmem } });
    this.compiled.set(headStr, { run: inst.exports.run, exit, kind });
    this.stats.tiers[kind] = (this.stats.tiers[kind] || 0) + 1;
  }

  _runCompiled(c) {
    for (let r = 0; r < 16; r++) this.regview[r] = BigInt.asIntN(64, this.cpu.regs[r]);
    c.run();
    for (let r = 0; r < 16; r++) this.cpu.regs[r] = BigInt.asUintN(64, this.regview[r]);
    this.cpu.rip = c.exit;
    this.stats.compiledRuns++;
  }

  run(maxSteps = 1e9) {
    const end = CODE_BASE + BigInt(this.code.length);
    let steps = 0;
    while (steps++ < maxSteps) {
      if (this.cpu.rip < CODE_BASE || this.cpu.rip >= end || this.cpu.halted) break;
      const key = this.cpu.rip.toString();
      const c = this.compiled.get(key);
      if (c) { this._runCompiled(c); continue; }
      const before = this.cpu.rip;
      const insn = this.cpu.step();
      this.stats.interpreted++;
      if (insn.mnem === 'jcc' && this.cpu.rip < before) {   // taken backward branch
        const head = this.cpu.rip, hk = head.toString();
        if (!this.compiled.has(hk)) {
          const n = (this.profile.get(hk) || 0) + 1;
          this.profile.set(hk, n);
          if (n >= this.threshold) this._tryCompile(hk, head);
        }
      }
    }
    return this.stats;
  }
}
