// Differential test for in-unit jump tables: an indirect `jmp` through a
// compiler-emitted table (dense switch / computed goto) is resolved against
// the function's own block map at runtime instead of deopting to the
// interpreter per iteration. Two shapes are exercised:
//   vm1: dense switch  -> `jmp *table(,%idx,8)` (table named in the operand)
//   vm2: computed goto -> load-from-table then `jmp *reg` (table traced from
//        the defining mov/lea chain above the jump)
// Both are checked bit-exact against the hardware-verified interpreter, and
// the test FAILS if the translator did not actually engage the resolver
// (so codegen drift can't silently turn this back into a deopt-per-op test).
import { LinuxEngine } from '../linux.mjs';
import { compileUnitWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'jtab-'));
const C = `#include <stdint.h>
__attribute__((noinline))
uint64_t vm1(const uint8_t* p, uint64_t len, uint64_t seed){
  uint64_t a = seed, b = 0x9e3779b97f4a7c15ULL, i = 0;
  while (i < len) {
    switch (p[i] & 7) {
      case 0: a += b; break;
      case 1: a ^= a >> 13; break;
      case 2: a *= 6364136223846793005ULL; break;
      case 3: b = (b << 7) | (b >> 57); break;
      case 4: a -= b; break;
      case 5: b ^= a; break;
      case 6: a = (a << 3) | (a >> 61); break;
      case 7: b += 0x2545F4914F6CDD1DULL; break;
    }
    i++;
  }
  return a ^ b;
}
__attribute__((noinline))
uint64_t vm2(const uint8_t* p, uint64_t len, uint64_t seed){
  static void* tab[8] = {&&o0,&&o1,&&o2,&&o3,&&o4,&&o5,&&o6,&&o7};
  uint64_t a = seed, b = 0x2545F4914F6CDD1DULL, i = 0;
  #define NEXT do { if (i >= len) return a ^ b; goto *tab[p[i++] & 7]; } while (0)
  NEXT;
  o0: a += b;                          NEXT;
  o1: a ^= a >> 9;                     NEXT;
  o2: a *= 2862933555777941757ULL;     NEXT;
  o3: b = (b << 13) | (b >> 51);       NEXT;
  o4: a -= b ^ i;                      NEXT;
  o5: b ^= a + i;                      NEXT;
  o6: a = (a << 5) | (a >> 59);        NEXT;
  o7: b += a >> 3;                     NEXT;
}
int _start(){ return 0; }`;
writeFileSync(join(dir, 'vm.c'), C);
execFileSync('gcc', ['-O2', '-static', '-nostdlib', '-fno-pie', '-no-pie', '-o', join(dir, 'vm'), join(dir, 'vm.c')]);
const elf = new Uint8Array(readFileSync(join(dir, 'vm')));
const sym = (name) => BigInt('0x' + execFileSync('nm', [join(dir, 'vm')]).toString()
  .split('\n').find(l => new RegExp(' [Tt] ' + name + '$').test(l)).trim().split(/\s+/)[0]);

const mk = () => new LinuxEngine(elf, { argv: ['vm'], files: {}, memMB: 256 });
const SENT = 0xdeadbee0n;
let pass = 0, fail = 0;
for (const name of ['vm1', 'vm2']) {
  const entry = sym(name);
  const eng0 = mk();
  const unit = compileUnitWat(eng0.mem, entry, { guestBase: eng0.base, ramBase: eng0.RAMOFF });
  if (!unit.wat.includes('$jtr_' + entry.toString(16))) {
    console.log(`SETUP FAIL: ${name} compiled without a jump-table resolver`); process.exit(1);
  }
  writeFileSync(join(dir, name + '.wat'), unit.wat);
  execFileSync('wat2wasm', [join(dir, name + '.wat'), '-o', join(dir, name + '.wasm')]);
  const mod = new WebAssembly.Module(readFileSync(join(dir, name + '.wasm')));
  const entryName = 'f_' + entry.toString(16);

  // opcode strings: sweep lengths and mixes, including every opcode alone
  const progs = [];
  for (let op = 0; op < 8; op++) progs.push(new Uint8Array(12).fill(op));
  let x = 12345;
  const rnd = () => (x = (x * 1103515245 + 12321) >>> 0) & 0xFF;
  for (const len of [1, 2, 3, 7, 33, 200]) progs.push(Uint8Array.from({length: len}, rnd));
  const seeds = [1n, 0xffffffffn, 0xdeadbeefcafebaben, (1n << 64n) - 1n];

  for (const prog of progs) for (const seed of seeds) {
    // oracle: interpreter
    const e = mk(); const cpu = e.cpu;
    for (let r = 0; r < 16; r++) cpu.regs[r] = 0n;
    const rsp = ((e.base + BigInt(e.ram.length) - 4096n) & ~0xFn) - 8n;
    const pbuf = rsp - 1024n;
    for (let i = 0; i < prog.length; i++) e.mem.write(pbuf + BigInt(i), 1n, BigInt(prog[i]));
    cpu.regs[4] = rsp; cpu.regs[7] = pbuf; cpu.regs[6] = BigInt(prog.length); cpu.regs[2] = seed;
    e.mem.write(rsp, 8n, SENT); cpu.rip = entry;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 1e6) throw new Error('runaway'); }
    const oracle = BigInt.asUintN(64, cpu.regs[0]);

    // AOT
    const e2 = mk();
    const inst = new WebAssembly.Instance(mod, e2.aotImports());
    for (let r = 0; r < 16; r++) e2.regview[r] = 0n;
    for (let i = 0; i < prog.length; i++) e2.mem.write(pbuf + BigInt(i), 1n, BigInt(prog[i]));
    e2.regview[4] = BigInt.asIntN(64, rsp); e2.regview[7] = BigInt.asIntN(64, pbuf);
    e2.regview[6] = BigInt(prog.length); e2.regview[2] = BigInt.asIntN(64, seed);
    new DataView(e2.wmem.buffer).setBigUint64(e2.RAMOFF + Number(rsp - e2.base), SENT, true);
    const exit = BigInt.asUintN(64, inst.exports[entryName]());
    if (exit !== SENT) { fail++; console.log(`FAIL exit ${name} len=${prog.length} seed=${seed.toString(16)} exit=${exit.toString(16)}`); continue; }
    const aot = BigInt.asUintN(64, e2.regview[0]);
    if (aot === oracle) pass++;
    else { fail++; console.log(`MISMATCH ${name} len=${prog.length} seed=${seed.toString(16)}: oracle=${oracle.toString(16)} aot=${aot.toString(16)}`); }
  }
}
console.log(`\n${pass}/${pass + fail} jump-table (switch + computed-goto) results bit-exact (AOT vs interpreter)`);
if (fail) process.exit(1);
