// Differential: repe/repne cmps + scas (babl/libc memcmp/strlen paths).
// Flags come from the LAST element pair; rsi/rdi/rcx must land exactly.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
const CODE = 0x400000n, SENT = 0xdeadbee0n, BUFA = 0x410000n, BUFB = 0x412000n;
const CASES = [
  ['repe-cmpsb-eq',  'repe cmpsb', 'AAAAAAAA', 'AAAAAAAA', 8],
  ['repe-cmpsb-df3', 'repe cmpsb', 'AAAABAAA', 'AAAACAAA', 8],
  ['repne-scasb-find', 'repne scasb', null, 'xxxxxxZy', 8],
  ['repne-scasb-nofind', 'repne scasb', null, 'xxxxxxxx', 8],
  ['cmpsw-plain', 'cmpsw', 'ABCD', 'ABCE', 0],
  ['repe-cmpsq', 'repe cmpsq', 'AAAAAAAABBBBBBBB', 'AAAAAAAABBBBBBBC', 2],
];
let pass = 0, fail = 0;
for (const [name, body, sa, sb, cnt] of CASES) {
  const asm = `BITS 64\n${body}\nseta al\nsetb bl\nsete r8b\nret\n`;
  writeFileSync('/tmp/st.asm', asm);
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/st.bin', '/tmp/st.asm']);
  const bin = readFileSync('/tmp/st.bin'); const code = new Uint8Array(0x20000); code.set(bin);
  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) { console.log(`SKIP ${name}: ${e.message}`); fail++; continue; }
  writeFileSync('/tmp/st.wat', r.wat); execFileSync('wat2wasm', ['/tmp/st.wat', '-o', '/tmp/st.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/st.wasm'));

  const m = new Memory([{ base: CODE, bytes: code.slice() }]); const cpu = new CPU(m);
  for (let i = 0; i < 16; i++) cpu.regs[i] = 0n;
  if (sa) for (let i = 0; i < sa.length; i++) m.write(BUFA + BigInt(i), 1n, BigInt(sa.charCodeAt(i)));
  for (let i = 0; i < sb.length; i++) m.write(BUFB + BigInt(i), 1n, BigInt(sb.charCodeAt(i)));
  cpu.regs[6] = BUFA; cpu.regs[7] = BUFB; cpu.regs[1] = BigInt(cnt); cpu.regs[0] = 0x5An;  // 'Z' for scas
  cpu.regs[4] = CODE + 0x800n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 200) throw new Error('runaway'); }
  const want = [0,1,3,6,7,8].map(i => BigInt.asUintN(64, cpu.regs[i]));

  const wmem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(mod, { js: { mem: wmem }, env: { syscall: stub, callout: stub, deopt: stub } });
  const rv = new BigInt64Array(wmem.buffer, 0, 16);
  for (let i = 0; i < 16; i++) rv[i] = 0n;
  const dv = new DataView(wmem.buffer);
  if (sa) for (let i = 0; i < sa.length; i++) dv.setUint8(Number(BUFA - CODE) + 0x10000 + i - 0x10000 + Number(BUFA-CODE), 0);
  // buffers: guest addr - CODE = offset in wasm memory (ramBase 0, guestBase CODE)
  if (sa) for (let i = 0; i < sa.length; i++) dv.setUint8(Number(BUFA - CODE) + i, sa.charCodeAt(i));
  for (let i = 0; i < sb.length; i++) dv.setUint8(Number(BUFB - CODE) + i, sb.charCodeAt(i));
  rv[6] = BigInt.asIntN(64, BUFA); rv[7] = BigInt.asIntN(64, BUFB); rv[1] = BigInt(cnt); rv[0] = 0x5An;
  rv[4] = BigInt.asIntN(64, CODE + 0x800n);
  dv.setBigUint64(0x800, SENT, true);
  inst.exports[r.entryName]();
  const got = [0,1,3,6,7,8].map(i => BigInt.asUintN(64, rv[i]));
  if (got.every((x, i) => x === want[i])) pass++;
  else { fail++; console.log(`MISMATCH ${name}: interp=${want.map(x=>x.toString(16))} aot=${got.map(x=>x.toString(16))}`); }
}
console.log(`\n${pass}/${pass+fail} cmps/scas results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
