// Differential: the SSE3 duplicates movsldup / movshdup / movddup (F3/F2 0F 12,
// F3 0F 16) in the interpreter and the COMPILED tier against hardware, register
// and memory operands. Found via Bun with its JIT on: ICU's uhash computes its
// resize high-water mark as length*ratio, vectorised by gcc through movsldup;
// the compiled tier treated the F3 form as movhlps and produced 0, so the table
// rehashed on every insert until the process died of ENOMEM.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const SRC = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x10];
const DST = [0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf];
let bad = 0, n = 0;
const forms = [
  ['movsldup xmm0, xmm1', 'movsldup xmm0, [rbx+0x40]'],
  ['movshdup xmm0, xmm1', 'movshdup xmm0, [rbx+0x40]'],
  ['movddup xmm0, xmm1', 'movddup xmm0, [rbx+0x40]'],
  ['movhlps xmm0, xmm1', 'movlps xmm0, [rbx+0x40]'],
  ['movlhps xmm0, xmm1', 'movhps xmm0, [rbx+0x40]'],
].flat();
for (const op of forms) {
  const body = `movdqu xmm0, [rbx+0x50]\nmovdqu xmm1, [rbx+0x40]\n${op}\nmovdqu [rbx+0x60], xmm0\nret`;
  // hardware
  writeFileSync('/tmp/dups.asm', 'BITS 64\nsection .text\nglobal fn\nfn:\nmov rbx, rdi\n' + body + '\n');
  execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/dups.o', '/tmp/dups.asm']);
  writeFileSync('/tmp/dups.c', `#include <stdio.h>\n#include <string.h>\nextern void fn(char*);\nint main(){ static char b[256] __attribute__((aligned(16))); unsigned char s[16]={${SRC}}, d[16]={${DST}}; memcpy(b+0x40,s,16); memcpy(b+0x50,d,16); fn(b); for(int i=0;i<16;i++) printf("%02x",(unsigned char)b[0x60+i]); printf("\\n"); return 0; }`);
  execFileSync('gcc', ['-O1', '-no-pie', '-Wl,-z,noexecstack', '-o', '/tmp/dupsbin', '/tmp/dups.c', '/tmp/dups.o']);
  const hw = execFileSync('/tmp/dupsbin').toString().trim();
  // guest image
  writeFileSync('/tmp/dupsg.asm', 'BITS 64\norg 0x400000\nmov rbx, 0x420000\n' + body + '\n');
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/dupsg.bin', '/tmp/dupsg.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/dupsg.bin'));
  const hex = (get) => { let s = ''; for (let i = 0; i < 16; i++) s += get(i).toString(16).padStart(2, '0'); return s; };
  // interpreter
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  for (let i = 0; i < 16; i++) { m.write(BUF + 0x40n + BigInt(i), 1n, BigInt(SRC[i])); m.write(BUF + 0x50n + BigInt(i), 1n, BigInt(DST[i])); }
  const cpu = new CPU(m); for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 20) throw new Error('runaway'); }
  const it = hex((i) => Number(m.read(BUF + 0x60n + BigInt(i), 1n)));
  // compiled
  const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/dups.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/dups.wat', '-o', '/tmp/dups.wasm']);
  const mem = new WebAssembly.Memory({ initial: 4096 }); const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync('/tmp/dups.wasm')), { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
  const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer), rv = new BigInt64Array(mem.buffer, 0, 16);
  u8.set(code, 0); const off = Number(BUF - CODE); u8.set(SRC, off + 0x40); u8.set(DST, off + 0x50);
  for (let q = 0; q < 16; q++) rv[q] = 0n; rv[4] = BigInt.asIntN(64, CODE + 0x1000n); dv.setBigUint64(0x1000, SENT, true);
  inst.exports[r.entryName]();
  const ao = hex((i) => u8[off + 0x60 + i]);
  n++; if (hw !== it || hw !== ao) { bad++; console.log(`  ${op}\n    hw  ${hw}\n    int ${it}\n    aot ${ao}`); }
}
console.log(`${n - bad}/${n} SSE3 duplicate forms match hardware (interpreter and compiled tier)`);
process.exit(bad ? 1 : 0);
