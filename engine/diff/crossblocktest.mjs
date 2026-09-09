// Differential: flags that cross a BASIC BLOCK boundary.
//
// Every other flag test in this directory puts the producer and the consumer
// in the same block, so none of them exercises the part of the translator that
// decides what flags reach a block from its predecessors - blkFlagIn, inDefs,
// matProducers. That analysis is where a flag kind can disagree with the code
// that actually wrote $fa/$fb, and a consumer then reads a value no producer on
// its path materialized.
//
// Three shapes, because they stress different parts of that analysis:
//   straight  producer, unconditional jump, consumer      - one reaching def
//   diamond   the same producer on both arms of a branch  - two defs, one kind
//   mixed     a different producer on each arm            - two kinds, must refuse
//
// The invariant is the same as flagkindtest's: the translator may refuse, but
// whatever it accepts must match the interpreter bit for bit.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const asm = (body) => {
  writeFileSync('/tmp/cb.asm', 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/cb.bin', '/tmp/cb.asm']);
  const b = readFileSync('/tmp/cb.bin'); const c = new Uint8Array(0x1000); c.set(b); return c;
};

const PRODUCERS = [
  ['shl1',  'shl rax, 1'],
  ['shr1',  'shr rax, 1'],
  ['shr3',  'shr rax, 3'],
  ['sar1',  'sar rax, 1'],
  ['shl32', 'shl eax, 1'],
  ['shr32', 'shr eax, 3'],
  ['and',   'and rax, rsi'],
  ['sub',   'sub rax, rsi'],
  ['add',   'add rax, rsi'],
  ['inc',   'inc rax'],
  ['dec',   'dec rax'],
  ['imul2', 'imul rax, rsi'],
  ['bsf',   'bsf rax, rsi'],
];
const CONSUMERS = [
  ['jo',   'jo t\n mov rax, 1\n ret\nt: mov rax, 2\n ret'],
  ['jc',   'jc t\n mov rax, 1\n ret\nt: mov rax, 2\n ret'],
  ['jbe',  'jbe t\n mov rax, 1\n ret\nt: mov rax, 2\n ret'],
  ['jl',   'jl t\n mov rax, 1\n ret\nt: mov rax, 2\n ret'],
  ['jle',  'jle t\n mov rax, 1\n ret\nt: mov rax, 2\n ret'],
  ['jz',   'jz t\n mov rax, 1\n ret\nt: mov rax, 2\n ret'],
  ['adc',  'mov rbx, 0\n adc rbx, 0\n mov rax, rbx\n ret'],
  ['setc', 'setc al\n movzx rax, al\n ret'],
];
// `L` and `A` are labels the shapes place; the producer runs on rax seeded
// from rdi so both arms compute from the same input.
const SHAPES = {
  straight: (p, c) => `mov rax, rdi\n${p}\njmp L\nL:\n${c}\n`,
  diamond:  (p, c) => `mov rax, rdi\ntest rdx, rdx\njz A\n${p}\njmp L\nA:\n${p}\nL:\n${c}\n`,
  mixed:    (p, c) => `mov rax, rdi\ntest rdx, rdx\njz A\n${p}\njmp L\nA:\ncmp rax, rsi\nL:\n${c}\n`,
};
const V = [0n, 1n, 3n, 0x7FFFn, 0x8000n, 0x7FFFFFFFn, 0x80000000n,
           0x8000000000000000n, 0xFFFFFFFFFFFFFFFFn];

let pass = 0, wrong = 0, refused = 0;
const wrongCases = [], refusedCases = [];
for (const [sname, shape] of Object.entries(SHAPES))
for (const [pn, pbody] of PRODUCERS) for (const [cn, cbody] of CONSUMERS) {
  const name = `${sname}/${pn}-${cn}`;
  const code = asm(shape(pbody, cbody));
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { refused++; refusedCases.push(`${name}: ${e.message.slice(0, 44)}`); continue; }
  writeFileSync('/tmp/cb.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/cb.wat', '-o', '/tmp/cb.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/cb.wasm'));
  for (const a of V) for (const b of V) for (const d of [0n, 1n]) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[7] = a; cpu.regs[6] = b; cpu.regs[2] = d;   // rdi, rsi, rdx
    cpu.regs[4] = CODE + 0x700n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 600) throw new Error('runaway ' + name); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);

    const mem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                 env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
    const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
    new Uint8Array(mem.buffer).set(code, 0);
    for (let q = 0; q < 16; q++) rv[q] = 0n;
    rv[7] = BigInt.asIntN(64, a); rv[6] = BigInt.asIntN(64, b); rv[2] = BigInt.asIntN(64, d);
    rv[4] = BigInt.asIntN(64, CODE + 0x700n);
    dv.setBigUint64(0x700, SENT, true);
    inst.exports[r.entryName]();
    const aot = BigInt.asUintN(64, rv[0]);
    if (aot === oracle) pass++;
    else { wrong++; if (wrongCases.length < 10)
      wrongCases.push(`${name} rdi=${a.toString(16)} rsi=${b.toString(16)} rdx=${d}: oracle=${oracle} aot=${aot}`); }
  }
}
for (const w of wrongCases) console.log('  WRONG ' + w);
console.log(`\n${pass}/${pass + wrong} cross-block flag pairs bit-exact (AOT vs interpreter)`);
console.log(`${refused} of ${Object.keys(SHAPES).length * PRODUCERS.length * CONSUMERS.length} refused (interpreted, correct but slower)`);
if (refused) console.log('  ' + refusedCases.slice(0, 6).join('\n  '));
if (wrong) process.exit(1);
