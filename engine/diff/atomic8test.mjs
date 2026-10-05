// Differential: narrow (8/16-bit) locked RMW forms in the interpreter and the
// COMPILED tier against hardware, checking the NEIGHBOURING bytes too. A byte
// lock word (WTF::Lock, glibc's low-level locks) sits next to other fields;
// an operation emitted at the wrong width corrupts them silently.
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
const MEM0 = [0x5a, 0x01, 0xa5, 0x7f, 0x11, 0x22, 0x33, 0x44, 0x80, 0x81, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87];
const forms = [
  'mov al, 0x01\nmov cl, 0x03\nlock cmpxchg [rbx+0x41], cl',          // byte, matches -> stores 3
  'mov al, 0x02\nmov cl, 0x03\nlock cmpxchg [rbx+0x41], cl',          // byte, mismatch -> al = old
  'mov ax, 0xa501\nmov cx, 0x1234\nlock cmpxchg [rbx+0x41], cx',      // word match
  'mov ax, 0x0000\nmov cx, 0x1234\nlock cmpxchg [rbx+0x41], cx',      // word mismatch
  'mov cl, 0x9c\nxchg [rbx+0x41], cl',
  'mov cx, 0x9c9d\nxchg [rbx+0x42], cx',
  'lock or byte [rbx+0x41], 0x02',
  'lock and byte [rbx+0x41], 0xfd',
  'lock xor byte [rbx+0x43], 0xff',
  'mov cl, 0x10\nlock xadd [rbx+0x41], cl',
  'mov cx, 0x1000\nlock xadd [rbx+0x42], cx',
  'lock add byte [rbx+0x40], 0x7f',
  'lock sub word [rbx+0x40], 0x0102',
  'lock inc byte [rbx+0x43]',
  'lock dec word [rbx+0x44]',
  'lock bts dword [rbx+0x44], 5',
  'lock btr dword [rbx+0x44], 0',
  'lock btc word [rbx+0x46], 1',
  'mov cl, 0x5a\nlock cmpxchg [rbx+0x40], cl\nsetz dl\nmov [rbx+0x4e], dl',
  'lock or qword [rbx+0x48], 0x100',
];
let bad = 0, n = 0;
for (const f of forms) {
  const body = `xor eax, eax\nxor ecx, ecx\nxor edx, edx\n${f}\nmov [rbx+0x50], rax\nmov [rbx+0x58], rcx\nmov [rbx+0x60], rdx\nret`;
  writeFileSync('/tmp/at8.asm', 'BITS 64\nsection .text\nglobal fn\nfn:\nmov rbx, rdi\n' + body + '\n');
  execFileSync('nasm', ['-f', 'elf64', '-o', '/tmp/at8.o', '/tmp/at8.asm']);
  writeFileSync('/tmp/at8.c', `#include <stdio.h>\n#include <string.h>\nextern void fn(char*);\nint main(){ static char b[256] __attribute__((aligned(16))); unsigned char m[16]={${MEM0}}; memcpy(b+0x40,m,16); fn(b); for(int i=0x40;i<0x68;i++) printf("%02x",(unsigned char)b[i]); printf("\\n"); return 0; }`);
  execFileSync('gcc', ['-O1', '-no-pie', '-Wl,-z,noexecstack', '-o', '/tmp/at8bin', '/tmp/at8.c', '/tmp/at8.o']);
  const hw = execFileSync('/tmp/at8bin').toString().trim();
  writeFileSync('/tmp/at8g.asm', 'BITS 64\norg 0x400000\nmov rbx, 0x420000\n' + body + '\n');
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/at8g.bin', '/tmp/at8g.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/at8g.bin'));
  const hex = (get) => { let s = ''; for (let i = 0x40; i < 0x68; i++) s += get(i).toString(16).padStart(2, '0'); return s; };
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  for (let i = 0; i < 16; i++) m.write(BUF + 0x40n + BigInt(i), 1n, BigInt(MEM0[i]));
  const cpu = new CPU(m); for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 40) throw new Error('runaway'); }
  const it = hex((i) => Number(m.read(BUF + BigInt(i), 1n)));
  const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/at8.wat', r.wat); execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/at8.wat', '-o', '/tmp/at8.wasm']);
  const mem = new WebAssembly.Memory({ initial: 4096 }); const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(new WebAssembly.Module(readFileSync('/tmp/at8.wasm')), { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) }, env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
  const u8 = new Uint8Array(mem.buffer), dv = new DataView(mem.buffer), rv = new BigInt64Array(mem.buffer, 0, 16);
  u8.set(code, 0); const off = Number(BUF - CODE); u8.set(MEM0, off + 0x40);
  for (let q = 0; q < 16; q++) rv[q] = 0n; rv[4] = BigInt.asIntN(64, CODE + 0x1000n); dv.setBigUint64(0x1000, SENT, true);
  let esc = ''; try { inst.exports[r.entryName](); } catch (e) { esc = ' (compiled tier escaped: ' + e.message + ')'; }
  const ao = hex((i) => u8[off + i]);
  n++; if (hw !== it || hw !== ao) { bad++; console.log(`  ${f.replace(/\n/g, '; ')}${esc}\n    hw  ${hw}\n    int ${it}\n    aot ${ao}`); }
}
console.log(`${n - bad}/${n} narrow locked RMW forms match hardware (interpreter and compiled tier)`);
process.exit(bad ? 1 : 0);
