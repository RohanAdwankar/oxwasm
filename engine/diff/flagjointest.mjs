// Differential: flags produced in one block and read in another, where the
// two paths in produced them DIFFERENTLY.
//
// The lazy flag model keeps flags as operands plus a kind - `cmp` leaves
// {kind:'sub'}, `test` leaves {kind:'logic'} - and a consumer turns kind plus
// condition into an expression. That works while one kind reaches the
// consumer. Where two paths join and disagree, there is no kind to name, and
// the translator refused the whole function: "cross-block flags for setcc" was
// the largest single refusal class diff/fuzzaot.mjs reported, 653 of 2153 on a
// 10000-program run.
//
// The join now materializes the real EFLAGS word into $fbits at each producer
// and the consumer reads the bit it wants. This checks that word against the
// CPU, which is the only oracle that settles it: PF and AF and the overflow
// rules are exactly where a re-derivation can be plausible and wrong.
//
// One instruction sequence is used three ways - native, interpreted and
// translated - so there is nothing to keep in step. It takes its buffer in a
// register, which is what lets the same bytes run as a guest function and as a
// called procedure on the host.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const CC = ['e','ne','b','ae','be','a','l','ge','le','g','s','ns','o','no','p','np'];
// producer pairs that leave DIFFERENT lazy kinds on the two paths
const PAIRS = [
  ['cmp rax, rbx',  'add rdx, rax'],    // sub    / add
  ['test rax, rbx', 'cmp rdx, rax'],    // logic  / sub
  ['add rax, rbx',  'and rdx, rax'],    // add    / logic
  ['shl rax, 1',    'cmp rdx, rbx'],    // shiftf / sub
  ['sub rax, rbx',  'xor rdx, rax'],    // sub    / logic
  // adc/sbb keep their carry in a local of their own and derive the rest, and
  // comis writes ZF, PF and CF from a FLOAT compare with no result at all -
  // three kinds whose word is built differently from the five above
  ['adc rax, rbx',  'cmp rdx, rax'],    // adc    / sub
  ['sbb rax, rbx',  'test rdx, rdx'],   // sbb    / logic
  ['comisd xmm0, xmm1',  'cmp rax, rbx'],   // fcmp / sub
  ['ucomisd xmm0, xmm1', 'add rdx, rax'],   // fcmp / add
  ['ucomisd xmm0, xmm1', 'adc rdx, rax'],   // fcmp / adc
];
const M = (1n << 64n) - 1n;
const SETS = [                          // rcx picks the path; 0 takes the second producer
  [1n, 1n, 0n, 5n],
  [1n, 1n, 1n, 5n],
  [0x8000000000000000n, 1n, 1n, 0x8000000000000000n],
  [0x8000000000000000n, 1n, 0n, 0x8000000000000000n],
  [5n, 7n, 0n, 0n],
  [M, 1n, 3n, 0x7FFFFFFFFFFFFFFFn],
  [0n, 0n, 1n, 0n],
  [0x7FFFFFFFFFFFFFFFn, M, 0n, 1n],
];

// rdi holds the buffer natively; the guest form points r12 at a fixed address.
const body = (a, b, cc, ptr) => [
  'push rbx', 'push r12', `mov r12, ${ptr}`,
  'mov rax, [r12]', 'mov rbx, [r12+8]', 'mov rcx, [r12+16]', 'mov rdx, [r12+24]',
  // the same two values as doubles, so a float compare has NaNs, zeros of both
  // signs and a denormal to work with without a second operand table
  'movq xmm0, [r12]', 'movq xmm1, [r12+8]',
  'test rcx, rcx', 'jz .second',
  a, 'jmp .join',
  '.second:', b,
  '.join:', `set${cc} al`, 'mov [r12+0x100], al',
  'pop r12', 'pop rbx', 'ret',
].join('\n');

let bad = 0, n = 0, refused = 0;
for (const [pa, pb] of PAIRS) {
  // hardware: one object holding all 16 conditions, called from a C main
  const asm = ['BITS 64', 'section .note.GNU-stack noalloc noexec nowrite progbits', 'section .text'];
  for (const cc of CC) asm.push(`global probe_${cc}`, `probe_${cc}:`, body(pa, pb, cc, 'rdi'));
  writeFileSync('/tmp/fj.asm', asm.join('\n') + '\n');
  execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/fj.o', '/tmp/fj.asm']);
  const decl = CC.map((cc) => `extern void probe_${cc}(void*);`).join('\n');
  const calls = CC.map((cc) => `  for(int s=0;s<${SETS.length};s++){ld(s); probe_${cc}(b); __builtin_printf("%02x\\n", b[0x100]);}`).join('\n');
  const sets = SETS.map(([a, b2, c, d]) => `{0x${a.toString(16)}ULL,0x${b2.toString(16)}ULL,0x${c.toString(16)}ULL,0x${d.toString(16)}ULL}`).join(',');
  writeFileSync('/tmp/fj.c', `unsigned char b[512] __attribute__((aligned(64)));
static const unsigned long long S[${SETS.length}][4]={${sets}};
static void ld(int s){unsigned long long*q=(unsigned long long*)b; for(int i=0;i<4;i++) q[i]=S[s][i]; b[0x100]=0xAA;}
${decl}
int main(){
${calls}
  return 0;}`);
  execFileSync('gcc', ['-O1', '-o', '/tmp/fjbin', '/tmp/fj.c', '/tmp/fj.o']);
  const hw = execFileSync('/tmp/fjbin').toString().trim().split('\n');

  for (let ci = 0; ci < CC.length; ci++) {
    const cc = CC[ci];
    writeFileSync('/tmp/fj1.asm', 'BITS 64\n' + body(pa, pb, cc, `0x${BUF.toString(16)}`) + '\n');
    execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/fj1.bin', '/tmp/fj1.asm']);
    const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/fj1.bin'));
    let r;
    try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
    catch (e) { refused++; console.log(`  REFUSED ${pa} / ${pb} set${cc}: ${e.message.slice(0, 60)}`); continue; }
    writeFileSync('/tmp/fj1.wat', r.wat);
    execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/fj1.wat', '-o', '/tmp/fj1.wasm']);
    const mod = new WebAssembly.Module(readFileSync('/tmp/fj1.wasm'));

    for (let s = 0; s < SETS.length; s++) {
      const want = hw[ci * SETS.length + s];
      const m = new Memory([{ base: CODE, bytes: code.slice() }]);
      SETS[s].forEach((v, i) => m.write(BUF + BigInt(8 * i), 8n, v));
      m.write(BUF + 0x100n, 1n, 0xAAn);
      const cpu = new CPU(m);
      for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
      cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
      let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 200) throw new Error('runaway'); }
      const it = Number(m.read(BUF + 0x100n, 1n)).toString(16).padStart(2, '0');

      const mem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                   env: { syscall: stub, callout: stub, deopt: stub, loophot: stub } });
      const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer), u8 = new Uint8Array(mem.buffer);
      u8.set(code, 0);
      const off = Number(BUF - CODE);
      SETS[s].forEach((v, i) => dv.setBigUint64(off + 8 * i, v, true));
      u8[off + 0x100] = 0xAA;
      for (let q = 0; q < 16; q++) rv[q] = 0n;
      rv[4] = BigInt.asIntN(64, CODE + 0x1000n);
      dv.setBigUint64(0x1000, SENT, true);
      inst.exports[r.entryName]();
      const ao = u8[off + 0x100].toString(16).padStart(2, '0');

      n++;
      if (want !== it || want !== ao) { bad++;
        console.log(`  set${cc} after [${pa}] / [${pb}] on ${SETS[s].map((v) => v.toString(16)).join(' ')}` +
          `\n      hw ${want}` + (it !== want ? ` interp ${it}` : '') + (ao !== want ? ` aot ${ao}` : '')); }
    }
  }
}
console.log(`\n${n - bad}/${n} cross-block flag joins match hardware in BOTH engines ` +
            `(${PAIRS.length} kind pairs x ${CC.length} conditions x ${SETS.length} operand sets)`);
if (refused) console.log(`${refused} REFUSED - the join is the point of this test`);
if (bad || refused) process.exit(1);
