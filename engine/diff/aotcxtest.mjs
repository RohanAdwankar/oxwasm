// Differential: cmpxchg8b / cmpxchg16b / popcnt in the COMPILED tier against
// hardware and the interpreter (registers, memory, and ZF read back with setz).
import { compileFunctionWat } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n, M64 = (1n << 64n) - 1n;
let bad = 0, n = 0;
const run = (name, body, setup, hwC) => {
  writeFileSync('/tmp/ax.asm', 'BITS 64\n' + body + '\nret');
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/ax.bin', '/tmp/ax.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/ax.bin'));
  const r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 });
  writeFileSync('/tmp/ax.wat', r.wat);
  execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/ax.wat', '-o', '/tmp/ax.wasm']);
  const mod = new WebAssembly.Module(readFileSync('/tmp/ax.wasm'));
  writeFileSync('/tmp/ax.c', hwC);
  execFileSync('gcc', ['-O1', '-msse4.2', '-mpopcnt', '-mcx16', '-o', '/tmp/axbin', '/tmp/ax.c']);
  const hw = execFileSync('/tmp/axbin').toString().trim();
  // interpreter
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  for (const [o, v] of setup.mem) m.write(BUF + BigInt(o), 8n, v);
  const cpu = new CPU(m);
  for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
  for (const [q, v] of setup.regs) cpu.regs[q] = v;
  cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 20) throw new Error('runaway'); }
  const fmt = (a, d, mem0, mem1, z) => [a, d, mem0, mem1, z].map((v) => v.toString(16)).join(' ');
  const it = fmt(m.read(BUF + 0x300n, 8n) & setup.mask, m.read(BUF + 0x308n, 8n) & setup.mask, m.read(BUF, 8n), m.read(BUF + 8n, 8n), m.read(BUF + 0x200n, 1n));
  // compiled
  const mem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { throw new Error('escape'); };
  const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                               env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
  const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
  new Uint8Array(mem.buffer).set(code, 0);
  const off = Number(BUF - CODE);
  for (const [o, v] of setup.mem) dv.setBigUint64(off + o, v, true);
  for (let q = 0; q < 16; q++) rv[q] = 0n;
  for (const [q, v] of setup.regs) rv[q] = BigInt.asIntN(64, v);
  rv[4] = BigInt.asIntN(64, CODE + 0x1000n); dv.setBigUint64(0x1000, SENT, true);
  inst.exports[r.entryName]();
  const ao = fmt(dv.getBigUint64(off + 0x300, true) & setup.mask, dv.getBigUint64(off + 0x308, true) & setup.mask, dv.getBigUint64(off, true), dv.getBigUint64(off + 8, true), BigInt(dv.getUint8(off + 0x200)));
  n++; if (hw !== it || hw !== ao) { bad++; console.log(`  ${name}\n    hw  ${hw}\n    int ${it}\n    aot ${ao}`); }
};

for (const wide of [false, true]) for (const eq of [true, false]) {
  const mask = wide ? M64 : 0xFFFFFFFFn;
  const mem = [0x1122334455667788n & mask, 0x99aabbccddeeff00n & mask];
  const rax = eq ? mem[0] : (mem[0] ^ 1n) & mask, rdx = mem[1], rbx = 0x0123456789abcdefn & mask, rcx = 0xfedcba9876543210n & mask;
  const op = wide ? 'cmpxchg16b' : 'cmpxchg8b';
  const C = wide
    ? `#include <stdio.h>\nint main(){ unsigned long long m[2] __attribute__((aligned(16)))={0x${mem[0].toString(16)}ULL,0x${mem[1].toString(16)}ULL}; unsigned long long a=0x${rax.toString(16)}ULL,d=0x${rdx.toString(16)}ULL,b=0x${rbx.toString(16)}ULL,c=0x${rcx.toString(16)}ULL; unsigned char z;
        asm volatile("lock cmpxchg16b %1; setz %2":"+a"(a),"+m"(m),"=q"(z),"+d"(d):"b"(b),"c"(c):"cc"); printf("%llx %llx %llx %llx %x\\n",a,d,m[0],m[1],z); return 0; }`
    : `#include <stdio.h>\nint main(){ unsigned long long m[2] __attribute__((aligned(16)))={0x${mem[0].toString(16)}ULL,0x${mem[1].toString(16)}ULL}; unsigned a=0x${rax.toString(16)},d=0x${rdx.toString(16)},b=(unsigned)0x${rbx.toString(16)},c=(unsigned)0x${rcx.toString(16)}; unsigned char z;
        asm volatile("lock cmpxchg8b %1; setz %2":"+a"(a),"+m"(m[0]),"=q"(z),"+d"(d):"b"(b),"c"(c):"cc"); printf("%x %x %llx %llx %x\\n",a,d,m[0],m[1],z); return 0; }`;
  // 8b compares/stores 32-bit halves of one qword: lay the pair out as a single qword
  const setup = { regs: [[0, rax], [2, rdx], [3, rbx], [1, rcx]], mem: wide ? [[0, mem[0]], [8, mem[1]]] : [[0, (mem[1] << 32n) | mem[0]], [8, 0n]], mask };
  const c8 = wide ? C : C.replace(/m\[0\]=.*?m\[1\]/, '');
  run(`lock ${op} eq=${eq}`, `mov rax, 0x${rax.toString(16)}\nmov rdx, 0x${rdx.toString(16)}\nmov rbx, 0x${rbx.toString(16)}\nmov rcx, 0x${rcx.toString(16)}\nlock ${op} [0x420000]\nsetz byte [0x420200]\nmov [0x420300], rax\nmov [0x420308], rdx`, setup, wide ? C : `#include <stdio.h>\nint main(){ unsigned long long m[2] __attribute__((aligned(16)))={0x${((mem[1] << 32n) | mem[0]).toString(16)}ULL,0}; unsigned a=0x${rax.toString(16)},d=0x${rdx.toString(16)},b=(unsigned)0x${rbx.toString(16)},c=(unsigned)0x${rcx.toString(16)}; unsigned char z;
        asm volatile("lock cmpxchg8b %1; setz %2":"+a"(a),"+m"(m[0]),"=q"(z),"+d"(d):"b"(b),"c"(c):"cc"); printf("%x %x %llx %llx %x\\n",a,d,m[0],m[1],z); return 0; }`);
}
console.log(`\n${n - bad}/${n} cmpxchg8b/16b results match hardware in the interpreter AND the compiled tier`);
process.exit(bad ? 1 : 0);
