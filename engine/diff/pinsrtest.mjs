// Differential: pinsrw / pextrw, the 16-bit lane moves.
//
// The interpreter has had both for a long time and the emitter refused them,
// which mattered out of proportion to two instructions: a unit whose ENTRY is
// unsupported is refused whole, so a function opening with one ran interpreted
// along with everything it called. Ten of the sweep's remaining hot refusals
// were `AOT sse op c4`.
//
// Every lane index is covered, because a lane op is exactly the shape where an
// off-by-one is invisible on lane 0 and wrong everywhere else.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, DATA = 0x400800n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/pi.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/pi.bin', '/tmp/pi.asm']);
  const b = readFileSync('/tmp/pi.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};

// xmm0 is seeded from memory so both engines start from the same 128 bits
const SEED = 'movdqu xmm0, [0x400800]\n';
const CASES = [];
for (let lane = 0; lane < 8; lane++) {
  // insert from a register, then read the whole vector back out
  CASES.push([`pinsrw-reg-l${lane}`,
    `${SEED}pinsrw xmm0, edi, ${lane}\nmovdqu [0x400810], xmm0\nmov rax, [0x400810]\nxor rax, [0x400818]\nret`]);
  // insert from memory
  CASES.push([`pinsrw-mem-l${lane}`,
    `${SEED}mov [0x400820], di\npinsrw xmm0, word [0x400820], ${lane}\nmovdqu [0x400810], xmm0\nmov rax, [0x400810]\nxor rax, [0x400818]\nret`]);
  // extract into a GPR
  CASES.push([`pextrw-l${lane}`, `${SEED}pextrw eax, xmm0, ${lane}\nret`]);
}

let pass = 0, fail = 0, refused = 0;
for (const [name, body] of CASES) {
  const code = asm(body);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; console.log(`  REFUSED ${name}: ${e.message.slice(0, 60)}`); continue; }
  writeFileSync('/tmp/pi.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/pi.wat', '-o', '/tmp/pi.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/pi.wasm'));
  for (const seedHi of [0x0123456789ABCDEFn, 0xFFFFFFFFFFFFFFFFn]) {
    for (const w of [0n, 0x1234n, 0xFFFFn, 0xBEEFn]) {
      const seedLo = 0xFEDCBA9876543210n;
      const plant = (writeU64) => { writeU64(0x800, seedLo); writeU64(0x808, seedHi); };

      const m = new Memory([{ base: CODE, bytes: code.slice() }]);
      plant((off, v) => m.write(CODE + BigInt(off), 8n, v));
      const cpu = new CPU(m);
      for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
      cpu.regs[7] = w;                                   // rdi: the word to insert
      cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 400) throw new Error('runaway ' + name); }
      const oracle = BigInt.asUintN(64, cpu.regs[0]);

      const mem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                   env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
      const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
      new Uint8Array(mem.buffer).set(code, 0);
      plant((off, v) => dv.setBigUint64(off, v, true));
      for (let q = 0; q < 16; q++) rv[q] = 0n;
      rv[7] = BigInt.asIntN(64, w);
      rv[4] = BigInt.asIntN(64, CODE + 0x700n);
      dv.setBigUint64(0x700, SENT, true);
      inst.exports[r.entryName]();
      const aot = BigInt.asUintN(64, rv[0]);
      if (aot === oracle) pass++;
      else { fail++; if (fail <= 8) console.log(`  MISMATCH ${name} w=${w.toString(16)} hi=${seedHi.toString(16)}: oracle=${oracle.toString(16)} aot=${aot.toString(16)}`); }
    }
  }
}
console.log(`\n${pass}/${pass + fail} pinsrw/pextrw lane results bit-exact (AOT vs interpreter), all 8 lanes`);
if (refused) console.log(`${refused} refused`);
if (fail || refused) process.exit(1);
