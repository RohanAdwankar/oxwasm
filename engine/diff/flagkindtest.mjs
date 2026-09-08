// Differential: every flag PRODUCER against every flag CONSUMER.
//
// The invariant is compile-or-refuse: the translator may decline a function
// (it stays interpreted, which is correct and only slower), but anything it
// accepts must agree with the interpreter bit for bit. Refusing is a
// performance bug; answering wrongly is a correctness bug, and this tells them
// apart.
//
// It exists because they were being confused. and/or/xor/test clear CF and OF;
// a shift sets CF to the last bit shifted out; bsf/bsr leave CF undefined. All
// three shared one flag kind, so `shr rax,1; adc rbx,0` compiled with CF=0 and
// returned the wrong answer, while `and rax,rsi; jc` was refused outright.
// Nothing caught either: no test paired a producer with a consumer it did not
// already expect to work, and the sweep only compares program output, which is
// identical when a function is merely refused.
//
// The cases are generated from the two lists, so adding a producer or a
// consumer covers every combination rather than the one that broke.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/fk.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/fk.bin', '/tmp/fk.asm']);
  const b = readFileSync('/tmp/fk.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};

// each leaves flags set and rax holding something the consumer can also read
const PRODUCERS = [
  ['and',   'and rax, rsi'],
  ['or',    'or rax, rsi'],
  ['xor',   'xor rax, rsi'],
  ['test',  'test rax, rsi'],
  ['add',   'add rax, rsi'],
  ['sub',   'sub rax, rsi'],
  ['cmp',   'cmp rax, rsi'],
  ['inc',   'inc rax'],
  ['dec',   'dec rax'],
  ['shl1',  'shl rax, 1'],
  ['shr1',  'shr rax, 1'],
  ['shr3',  'shr rax, 3'],
  ['sar1',  'sar rax, 1'],
  ['imul2', 'imul rax, rsi'],
  ['imul3', 'imul rax, rsi, 7'],
  ['bsf',   'bsf rax, rsi'],
  ['bsr',   'bsr rax, rsi'],
  ['bt',    'bt rax, rsi'],
];
// each turns the flags into a value in rax, so a wrong flag is a wrong answer
const CONSUMERS = [
  ['jc',   `jc t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['jbe',  `jbe t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['ja',   `ja t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['jo',   `jo t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['jz',   `jz t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['js',   `js t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['jl',   `jl t\n mov rax, 1\n ret\nt: mov rax, 2\n ret`],
  ['setc', `setc al\n movzx rax, al\n ret`],
  ['seta', `seta al\n movzx rax, al\n ret`],
  ['adc',  `mov rbx, 0\n adc rbx, 0\n mov rax, rbx\n ret`],
  ['sbb',  `mov rbx, 5\n sbb rbx, 0\n mov rax, rbx\n ret`],
  ['cmovb',`mov rbx, 9\n cmovb rax, rbx\n ret`],
];
// values chosen to exercise each width's carry and overflow edges, not just 64's
const V = [0n, 1n, 2n, 3n, 0xFFn, 0x7FFFn, 0x8000n, 0x7FFFFFFFn, 0x80000000n,
           0xFFFFFFFFn, 0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn];

let pass = 0, wrong = 0, refused = 0;
const wrongCases = [], refusedCases = [];
for (const [pn, pbody] of PRODUCERS) for (const [cn, cbody] of CONSUMERS) {
  const name = `${pn}-${cn}`;
  const code = asm(`mov rax, rdi\n${pbody}\n${cbody}\n`);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; refusedCases.push(`${name}: ${e.message.slice(0, 48)}`); continue; }
  writeFileSync('/tmp/fk.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/fk.wat', '-o', '/tmp/fk.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/fk.wasm'));
  for (const a of V) for (const b of V) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[7] = a; cpu.regs[6] = b;
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 500) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b);
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    inst.exports[r.entryName]();
    const aot = BigInt.asUintN(64, rv[0]);
    if (aot === oracle) pass++;
    else { wrong++; if (wrongCases.length < 8) wrongCases.push(`${name} rdi=${a.toString(16)} rsi=${b.toString(16)}: oracle=${oracle} aot=${aot}`); }
  }
}
for (const w of wrongCases) console.log('  WRONG ' + w);
// A refusal is reported, never failed: it is the translator declining, and the
// interpreter still produces the right answer. The count is the standing bill
// for how much of this matrix the AOT tier cannot yet take.
console.log(`\n${pass}/${pass + wrong} compiled flag producer/consumer pairs bit-exact (AOT vs interpreter)`);
console.log(`${refused} of ${PRODUCERS.length * CONSUMERS.length} pairs refused (interpreted, correct but slower)`);
if (refused) console.log('  ' + refusedCases.slice(0, 6).join('\n  '));
if (wrong) process.exit(1);
