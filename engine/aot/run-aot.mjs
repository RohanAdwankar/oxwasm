import { LinuxEngine } from '../linux.mjs';
import { compileFunctionWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const dataPath = process.argv[2] || '/tmp/big.bin';
const elf = new Uint8Array(readFileSync('aot/md5-native'));
const eng = new LinuxEngine(elf, { argv: ['md5', dataPath], files: { [dataPath]: new Uint8Array(readFileSync(dataPath)) }, memMB: 512 });
const entry = BigInt('0x' + execFileSync('bash', ['-c', "nm aot/md5-native | awk '/ T md5_blocks$/{print $1}'"]).toString().trim());

const { wat, blocks } = compileFunctionWat(eng.mem, entry, { guestBase: eng.base, ramBase: eng.RAMOFF });
writeFileSync('/tmp/md5_blocks.wat', wat);
execFileSync('wat2wasm', ['/tmp/md5_blocks.wat', '-o', '/tmp/md5_blocks.wasm']);
const wasm = new Uint8Array(readFileSync('/tmp/md5_blocks.wasm'));
console.log('AOT:', blocks, 'basic blocks ->', wasm.length, 'bytes wasm');
const inst = new WebAssembly.Instance(new WebAssembly.Module(wasm), { js: { mem: eng.wmem } });

let entryRegs = null;
eng.compiled.set(entry.toString(), { isFunc: true, run: () => {
  if (!entryRegs) entryRegs = Array.from(eng.regview);   // snapshot args (rdi/rsi/rdx etc.)
  inst.exports.run();
}});

// drive to completion (AOT function runs once; rest interpreted)
let steps = 0;
while (eng.exitCode === null && steps++ < 5e9) {
  const c = eng.compiled.get(eng.cpu.rip.toString());
  if (c && c.isFunc) { for (let r=0;r<16;r++) eng.regview[r]=BigInt.asIntN(64,eng.cpu.regs[r]);
    c.run(); for (let r=0;r<16;r++) eng.cpu.regs[r]=BigInt.asUintN(64,eng.regview[r]);
    eng.cpu.rip = eng.cpu.pop(); continue; }
  const before = eng.cpu.rip; try { eng.cpu.step(); } catch(e){ e.rip=before; throw e; }
}
console.log('digest:', eng.stdout.join(''));

// isolate AOT function timing: restore entry regs, run, best-of-8
let best = 1e18;
for (let i = 0; i < 8; i++) {
  for (let r = 0; r < 16; r++) eng.regview[r] = entryRegs[r];
  const t = process.hrtime.bigint(); inst.exports.run(); const ns = Number(process.hrtime.bigint()-t);
  if (ns < best) best = ns;
}
console.log(`AOT md5_blocks (64MB): ${(best/1e6).toFixed(1)} ms`);
