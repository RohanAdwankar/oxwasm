// Differential: `pop [mem]` where the address is rsp-based.
//
// Intel grp1a computes the address AFTER rsp is incremented, so `pop qword
// [rsp]` writes the popped value to the slot ABOVE the one it came from. The
// emitter wrote before incrementing, which is the wrong order, so it refused
// the shape outright and sent every function containing one to the
// interpreter - 11,967 calls in the node-net case.
//
// The ordering is checked against THIS CPU, not taken from the manual, because
// getting it backwards is silent: both orders produce a plausible value and
// the wrong one only shows up on the slot nobody looks at. Then the AOT is
// checked against the interpreter as usual.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
// Each body runs with 0x1111/0x2222/0x3333 pushed and rbx holding the stack
// pointer at that moment, then reports one slot so a mis-ordered write shows.
const CASES = [
  ['pop-rsp',      'pop qword [rsp]',                 8],
  ['pop-rsp8',     'pop qword [rsp+8]',               8],
  ['pop-rsp-idx',  'mov rcx, 8\npop qword [rsp+rcx]', 8],
  ['pop-rsp16',    'pop qword [rsp+16]',             16],
  ['pop-reg',      'pop rdx\nmov [rbx+8], rdx',       8],   // the ordinary shape, as a control
];
// Six slots, not three: `pop qword [rsp+16]` writes two slots above where it
// read, and with a shallow stack that lands on the return address - the test
// then jumps to 0x1111 and the failure looks like an engine fault.
const PROLOGUE = ['0x6666','0x5555','0x4444','0x3333','0x2222','0x1111']
  .map(v => `mov rax, ${v}\npush rax\n`).join('') + 'mov rbx, rsp\n';
const UNWIND = 'mov rsp, rbx\nadd rsp, 48\n';

const native = (body, slot) => {
  writeFileSync('/tmp/pt.asm', `BITS 64\nglobal _start\nsection .text\n_start:\n${PROLOGUE}${body}\n` +
    `mov rdi, [rbx+${slot}]\nand rdi, 0xff\nmov rax, 60\nsyscall\n`);
  execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/pt.o', '/tmp/pt.asm']);
  execFileSync('ld', ['-o', '/tmp/pt', '/tmp/pt.o']);
  try { execFileSync('/tmp/pt'); return 0; } catch (e) { return e.status; }
};

let pass = 0, fail = 0;
for (const [name, body, slot] of CASES) {
  const hw = native(body, slot);

  writeFileSync('/tmp/pt2.asm', `BITS 64\n${PROLOGUE}${body}\nmov rax, [rbx+${slot}]\nand rax, 0xff\n` +
    `${UNWIND}ret\n`);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/pt2.bin', '/tmp/pt2.asm']);
  const b = readFileSync('/tmp/pt2.bin'); const code = new Uint8Array(0x1000); code.set(b);

  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  const cpu = new CPU(m);
  for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 400) throw new Error('runaway ' + name); }
  const sw = Number(BigInt.asUintN(64, cpu.regs[0]));

  let aot = null, why = '';
  try {
    const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
    writeFileSync('/tmp/pt2.wat', r.wat);
    execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/pt2.wat', '-o', '/tmp/pt2.wasm']);
    const mod = new WebAssembly.Module(readFileSync('/tmp/pt2.wasm'));
    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    inst.exports[r.entryName]();
    aot = Number(BigInt.asUintN(64, rv[0]));
  } catch (e) { why = e.message.slice(0, 50); }

  if (hw === sw && aot === hw) { pass++; }
  else {
    fail++;
    console.log(`  MISMATCH ${name}: hardware=0x${hw.toString(16)} interpreter=0x${sw.toString(16)} ` +
                (aot === null ? `aot=REFUSED (${why})` : `aot=0x${aot.toString(16)}`));
  }
}
for (const f of ['/tmp/pt.asm','/tmp/pt.o','/tmp/pt','/tmp/pt2.asm','/tmp/pt2.bin','/tmp/pt2.wat','/tmp/pt2.wasm'])
  try { unlinkSync(f); } catch {}
console.log(`\n${pass}/${pass + fail} pop [rsp-based] cases agree across hardware, interpreter and AOT`);
if (fail) process.exit(1);
