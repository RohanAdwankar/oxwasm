// Whole-program AOT: compile everything reachable from the ELF entry point as
// one translation unit and run it start-to-finish in wasm, with the escapes
// wired to the live engine — syscalls serviced from the regfile, callout /
// deopt falling back to the interpreter. Output and exit code must equal the
// native run's.
import { LinuxEngine } from '../linux.mjs';
import { compileUnitWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const binPath = process.argv[2] || '/tmp/unitprog';
const elf = new Uint8Array(readFileSync(binPath));
const eng = new LinuxEngine(elf, { argv: [binPath], files: {}, memMB: 512 });
const entry = eng.entry;

const t0 = process.hrtime.bigint();
const unit = compileUnitWat(eng.mem, entry, { guestBase: eng.base, ramBase: eng.RAMOFF });
writeFileSync('/tmp/unit.wat', unit.wat);
execFileSync('wat2wasm', ['/tmp/unit.wat', '-o', '/tmp/unit.wasm']);
const mod = new WebAssembly.Module(readFileSync('/tmp/unit.wasm'));
console.log(`[unit] ${unit.funcs.length} functions (${unit.poisoned.length} poisoned), ${unit.blocks} blocks, ` +
            `${readFileSync('/tmp/unit.wasm').length} bytes wasm, compiled in ${(Number(process.hrtime.bigint()-t0)/1e6).toFixed(1)} ms`);

class ExitTrap extends Error {}
const cpu = eng.cpu;
const syncToCpu = () => { for (let r = 0; r < 16; r++) cpu.regs[r] = BigInt.asUintN(64, eng.regview[r]); };
const syncFromCpu = () => { for (let r = 0; r < 16; r++) eng.regview[r] = BigInt.asIntN(64, cpu.regs[r]); };

const exportsByAddr = new Map();   // filled after instantiation
const env = {
  syscall() {
    syncToCpu();
    eng.syscall(cpu);
    if (eng.exitCode !== null) throw new ExitTrap();
    syncFromCpu();
  },
  callout(target) {
    target = BigInt.asUintN(64, target);
    const fast = exportsByAddr.get(target.toString());
    if (fast) return fast();                       // target is compiled: stay in wasm
    // interpret the callee until it returns to the address the caller pushed
    syncToCpu();
    const retAddr = eng.mem.read(cpu.regs[4], 8n);
    const rspExit = BigInt.asUintN(64, cpu.regs[4] + 8n);
    cpu.rip = target;
    let guard = 0;
    while (!(cpu.rip === retAddr && cpu.regs[4] === rspExit)) {
      const fast2 = exportsByAddr.get(cpu.rip.toString());
      if (fast2) { syncFromCpu(); cpu.rip = BigInt.asUintN(64, fast2()); syncToCpu(); continue; }
      cpu.step();
      if (eng.exitCode !== null) throw new ExitTrap();
      if (++guard > 2e9) throw new Error('callout runaway');
    }
    syncFromCpu();
    return BigInt.asIntN(64, retAddr);
  },
  deopt(rip, rsp0) {
    // resume this frame in the interpreter until it exits (rsp rises above rsp0)
    syncToCpu();
    cpu.rip = BigInt.asUintN(64, rip); rsp0 = BigInt.asUintN(64, rsp0);
    let guard = 0;
    while (cpu.regs[4] <= rsp0) {
      const fast = exportsByAddr.get(cpu.rip.toString());
      if (fast) { syncFromCpu(); cpu.rip = BigInt.asUintN(64, fast()); syncToCpu(); continue; }
      cpu.step();
      if (eng.exitCode !== null) throw new ExitTrap();
      if (++guard > 2e9) throw new Error('deopt runaway');
    }
    syncFromCpu();
    return BigInt.asIntN(64, cpu.rip);
  },
};
const inst = new WebAssembly.Instance(mod, { js: { mem: eng.wmem }, env });
for (const a of unit.funcs) exportsByAddr.set(a.toString(), inst.exports['f_' + a.toString(16)]);

// _start never returns (exit syscall unwinds); plant a sentinel anyway
syncFromCpu();
const tr = process.hrtime.bigint();
try {
  eng.regview[4] = BigInt.asIntN(64, cpu.regs[4] - 8n);
  new DataView(eng.wmem.buffer).setBigUint64(eng.RAMOFF + Number(BigInt.asUintN(64, eng.regview[4]) - eng.base), 0xdeadbee0n, true);
  inst.exports[unit.entryName]();
  throw new Error('program returned from _start');
} catch (e) { if (!(e instanceof ExitTrap)) throw e; }
console.log(`[unit] ran in ${(Number(process.hrtime.bigint()-tr)/1e6).toFixed(2)} ms`);
process.stdout.write('stdout: ' + eng.stdout.join(''));
console.log('exit:', eng.exitCode);
