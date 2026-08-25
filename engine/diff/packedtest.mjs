// Differential test: SSE2 packed-integer ops vs the real CPU (via ./stepper).
// The stepper compares GPRs, so each case stores the vector result to memory
// and loads it back into GPRs. Inputs: directed patterns (the constants
// pixman's blend loops actually use: 0x0080 bias, 0x0101 reciprocal, byte
// masks/alphas) plus the scratch page's pseudo-random bytes.
// pixman's over_n_8_8888 produced silently-wrong output on the engine —
// packed multiplies/saturating adds must be bit-exact, not just "not crash".
import { runCase } from './run.mjs';

const A = 0x20000100, B = 0x20000180;   // input staging in scratch

// 16-byte patterns written via 2 qword movs each
const PATTERNS = {
  rand:  null,                                    // leave the scratch pattern
  zeros: [0x0000000000000000n, 0x0000000000000000n],
  ones:  [0xFFFFFFFFFFFFFFFFn, 0xFFFFFFFFFFFFFFFFn],
  bias:  [0x0080008000800080n, 0x0080008000800080n], // pixman round bias
  recip: [0x0101010101010101n, 0x0101010101010101n], // pixman /255 multiplier
  signs: [0x7F80FF017FFF8000n, 0x00FF7F808001FE7Fn], // saturation edges
  alpha: [0x00E1005500AA00FFn, 0x001C000000800042n], // word alphas 0..255
};

const setup = (name, addr) => {
  const p = PATTERNS[name];
  if (!p) return '';
  return `mov rax, 0x${p[0].toString(16)}\nmov [rbx+${addr - 0x20000000}], rax\n` +
         `mov rax, 0x${p[1].toString(16)}\nmov [rbx+${addr - 0x20000000 + 8}], rax\n`;
};

const harness = (op, pa, pb) => `mov rbx, 0x20000000
${setup(pa, A)}${setup(pb, B)}movdqu xmm0, [rbx+0x100]
movdqu xmm1, [rbx+0x180]
${op}
movdqu [rbx+0x400], xmm0
movdqu [rbx+0x410], xmm1
mov rax, [rbx+0x400]
mov rcx, [rbx+0x408]
mov rdx, [rbx+0x410]
mov rsi, [rbx+0x418]
self: jmp self`;

const OPS2 = [   // op xmm0, xmm1
  'punpcklbw','punpckhbw','punpcklwd','punpckhwd','punpckldq','punpckhdq',
  'punpcklqdq','punpckhqdq','packuswb','packsswb','packssdw',
  'paddb','paddw','paddd','paddq','psubb','psubw','psubd','psubq',
  'paddsb','paddsw','paddusb','paddusw','psubsb','psubsw','psubusb','psubusw',
  'pmullw','pmulhw','pmulhuw','pmuludq','pmaddwd',
  'pavgb','pavgw','psadbw',
  'pcmpeqb','pcmpeqw','pcmpeqd','pcmpgtb','pcmpgtw','pcmpgtd',
  'pminub','pmaxub','pminsw','pmaxsw',
  'pand','pandn','por','pxor',
  'psllw','pslld','psllq','psrlw','psrld','psrlq','psraw','psrad',
];
const OPS_IMM = [   // [mnemonic, imm list, 3-operand form?]
  ['pshuflw', [0x00, 0x1B, 0xE4], true], ['pshufhw', [0x00, 0x1B], true], ['pshufd', [0x00, 0x4E, 0x1B], true],
  ['psllw', [1, 7, 15, 16]], ['psrlw', [1, 8, 15, 16]], ['psraw', [1, 8, 15, 16]],
  ['pslld', [1, 31, 32]], ['psrld', [1, 31, 32]], ['psrad', [1, 31, 32]],
  ['psllq', [1, 63, 64]], ['psrlq', [1, 63, 64]],
  ['pslldq', [1, 4, 15, 16]], ['psrldq', [1, 4, 15, 16]],
];
const PAIRS = [['rand','rand'], ['alpha','recip'], ['bias','recip'], ['signs','signs'],
               ['ones','recip'], ['rand','zeros'], ['signs','recip']];

let pass = 0; const fails = [], unsupported = new Set();
const check = (name, asm) => {
  const r = runCase(name, asm, { maxSteps: 40 });
  if (r.ok) pass++;
  else if (r.err && /unsupported|unimplemented/.test(r.err)) unsupported.add(name.split(' ')[0]);
  else fails.push(r);
};

for (const op of OPS2)
  for (const [pa, pb] of PAIRS)
    check(`${op} ${pa}/${pb}`, harness(`${op} xmm0, xmm1`, pa, pb));
for (const [op, imms, three] of OPS_IMM)
  for (const imm of imms)
    for (const [pa, pb] of [['rand','rand'], ['signs','signs'], ['alpha','recip']])
      check(`${op}-i${imm} ${pa}/${pb}`,
            harness(three ? `${op} xmm0, xmm1, ${imm}` : `${op} xmm0, ${imm}`, pa, pb));
// GPR-destination forms
for (const [pa, pb] of PAIRS) {
  check(`pmovmskb ${pa}/${pb}`, harness('pmovmskb eax, xmm1', pa, pb));
  check(`pextrw ${pa}/${pb}`, harness('pextrw eax, xmm1, 3', pa, pb));
  check(`pinsrw ${pa}/${pb}`, harness('pinsrw xmm0, edx, 5', pa, pb));
}

for (const f of fails.slice(0, 12))
  console.log(`MISMATCH ${f.name} step=${f.step} ${f.field}: hw=${f.hw} interp=${f.interp}` +
              (f.err ? ` err=${f.err}` : ''));
if (unsupported.size) console.log('unsupported:', [...unsupported].join(' '));
console.log(`\n${pass}/${pass + fails.length} packed-op results bit-exact vs hardware` +
            ` (${fails.length} mismatches, ${unsupported.size} unsupported forms)`);
if (fails.length || unsupported.size) process.exit(1);

// ---- AOT lane: the same ops through compileFunctionWat vs the (hardware-
// verified) interpreter. Catches wasm-emit bugs like pshuflw/hw compiled
// with pshufd lane indices.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, SENT = 0xdeadbee0n;
const AOT_OPS = [
  'punpcklbw xmm0, xmm1', 'punpckhbw xmm0, xmm1', 'punpcklwd xmm0, xmm1', 'punpckhwd xmm0, xmm1',
  'packuswb xmm0, xmm1', 'pmullw xmm0, xmm1', 'pmulhuw xmm0, xmm1', 'pmulhw xmm0, xmm1',
  'paddusb xmm0, xmm1', 'paddusw xmm0, xmm1', 'psubusb xmm0, xmm1', 'psubusw xmm0, xmm1',
  'pshufd xmm0, xmm1, 0x00', 'pshufd xmm0, xmm1, 0x1B', 'pshufd xmm0, xmm1, 0x4E',
  'pshuflw xmm0, xmm1, 0x00', 'pshuflw xmm0, xmm1, 0x1B', 'pshuflw xmm0, xmm1, 0xE4',
  'pshufhw xmm0, xmm1, 0x00', 'pshufhw xmm0, xmm1, 0x1B',
];
const VECS = [
  [0x00E1005500AA00FFn, 0x001C000000800042n, 0x0101010101010101n, 0x0101010101010101n],
  [0x8081828384858687n, 0x88898a8b8c8d8e8fn, 0x0080008000800080n, 0x0080008000800080n],
  [0x7F80FF017FFF8000n, 0x00FF7F808001FE7Fn, 0xFFFFFFFFFFFFFFFFn, 0x0123456789ABCDEFn],
];
let apass = 0, afail = 0;
for (const opAsm of AOT_OPS) {
  writeFileSync('/tmp/pk.asm', `BITS 64\n${opAsm}\nret\n`);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/pk.bin', '/tmp/pk.asm']);
  const bin = readFileSync('/tmp/pk.bin'); const code = new Uint8Array(0x1000); code.set(bin);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { console.log(`AOT SKIP ${opAsm}: ${e.message}`); continue; }
  writeFileSync('/tmp/pk.wat', r.wat); execFileSync('wat2wasm', ['/tmp/pk.wat', '-o', '/tmp/pk.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/pk.wasm'));
  for (const [a0, a1, b0, b1] of VECS) {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    const cpu = new CPU(m);
    for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
    cpu.xmm[0] = a0 | (a1 << 64n); cpu.xmm[1] = b0 | (b1 << 64n);
    cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 50) throw new Error('runaway'); }
    const want = cpu.xmm[0];

    const wmem = new WebAssembly.Memory({ initial: 4096 });
    const stub = () => { throw new Error('escape'); };
    const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
    const rv = new BigInt64Array(wmem.buffer, 0, 16);
    const xv = new BigInt64Array(wmem.buffer, 256, 32);
    for (let i = 0; i < 16; i++) rv[i] = 0n;
    xv[0] = BigInt.asIntN(64, a0); xv[1] = BigInt.asIntN(64, a1);
    xv[2] = BigInt.asIntN(64, b0); xv[3] = BigInt.asIntN(64, b1);
    rv[4] = BigInt.asIntN(64, CODE + 0x800n);
    new DataView(wmem.buffer).setBigUint64(0x800, SENT, true);
    inst.exports[r.entryName]();
    const got = BigInt.asUintN(64, xv[0]) | (BigInt.asUintN(64, xv[1]) << 64n);
    if (got === want) apass++;
    else { afail++; console.log(`AOT MISMATCH ${opAsm}: interp=${want.toString(16)} aot=${got.toString(16)}`); }
  }
}
console.log(`${apass}/${apass + afail} AOT packed-op results bit-exact vs interpreter`);
if (afail) process.exit(1);
