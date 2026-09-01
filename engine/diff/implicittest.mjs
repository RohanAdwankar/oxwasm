// Differential: instructions with IMPLICIT register operands must mark those
// registers for the analyzer, or a unit slice that starts there reads a
// zero-initialised wasm local instead of the regfile.
//
// The motivating miss: `leave` reads and writes rbp with no explicit operand,
// and the register scan lumped it in with call/ret (implicit r4 only, always
// seen). jq's jv_free dispatches through a computed goto whose cases all
// funnel into a bare `leave; ret` tail; the tiering compiled that two-
// instruction slice as its own unit, rbp got no entry reload, rsp was set
// from the zero local, and the pop walked off the wasm memory 23k
// instructions into jq's startup.
//
// Each case is a slice whose ENTRY instruction touches its registers only
// implicitly; interp and AOT run it from the same register file and must
// agree on every listed register.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
// name, nasm body, registers to compare (by index)
const CASES = [
  // rbp points at a fake frame: [rbp] = saved rbp, [rbp+8] = return address
  ['leave-entry', 'leave\nret\n', [4, 5]],
  // implicit rax/rdx pair at entry (cdq's rdx write depends on unreloaded rax)
  ['cdq-entry', 'cdq\nmov rbx, rdx\nret\n', [0, 2, 3]],
  // rep movsb at entry: rsi/rdi/rcx all implicit
  ['movs-entry', 'rep movsb\nret\n', [1, 6, 7]],
];

let pass = 0, fail = 0;
for (const [name, asm, cmpRegs] of CASES) {
  writeFileSync('/tmp/imp.asm', 'BITS 64\n' + asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/imp.bin', '/tmp/imp.asm']);
  const bin = readFileSync('/tmp/imp.bin');
  const code = new Uint8Array(0x10000); code.set(bin);

  const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/imp.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/imp.wat', '-o', '/tmp/imp.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/imp.wasm'));

  // the frame: rsp low, rbp above it holding {saved rbp, return address}
  const seed = (regs) => {
    regs[4] = CODE + 0x800n;                        // rsp
    regs[5] = CODE + 0x900n;                        // rbp -> fake frame
    regs[0] = 0x1234567890n; regs[2] = 0n; regs[3] = 0x777n;
    regs[1] = 4n;                                   // rcx: rep count
    regs[6] = CODE + 0xa00n; regs[7] = CODE + 0xb00n;  // rsi, rdi
  };
  const frame = (write) => {                        // write(addr, val64)
    write(CODE + 0x900n, 0x5a5a5a5an);              // saved rbp
    write(CODE + 0x908n, SENT);                     // return address for ret
    write(CODE + 0x800n, SENT);                     // plain-ret path
    write(CODE + 0xa00n, 0x1122334455667788n);      // movs source bytes
  };

  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  const cpu = new CPU(m);
  for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
  seed(cpu.regs); frame((a, v) => m.write(a, 8n, v)); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 40) throw new Error('runaway ' + name); }
  const want = cmpRegs.map(i => BigInt.asUintN(64, cpu.regs[i]));

  const wmem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
  const rv = new BigInt64Array(wmem.buffer, 0, 16);
  for (let i = 0; i < 16; i++) rv[i] = 0n;
  const regs = new Array(16).fill(0n); seed(regs);
  for (let i = 0; i < 16; i++) rv[i] = BigInt.asIntN(64, regs[i]);
  const dv = new DataView(wmem.buffer);
  frame((a, v) => dv.setBigUint64(Number(a - CODE), v, true));   // this harness maps guest CODE to wasm offset 0
  inst.exports[r.entryName]();
  const got = cmpRegs.map(i => BigInt.asUintN(64, rv[i]));
  if (got.every((x, i) => x === want[i])) pass++;
  else { fail++;
    console.log(`AOT MISMATCH ${name}: interp ${want.map(x=>x.toString(16))} aot ${got.map(x=>x.toString(16))}`); }
}
console.log(`${pass}/${CASES.length} implicit-operand slices bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
