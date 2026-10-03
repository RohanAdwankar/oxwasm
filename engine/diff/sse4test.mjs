// Differential: the SSSE3 / SSE4.1 ops (0F 38 / 0F 3A maps) and popcnt against
// hardware. numpy 2.x is built for x86-64-v2, so its baseline code uses all of
// them; the interpreter models them and the AOT tier hands them back to it.
//
// Every form runs over random vectors plus edge patterns (all-ones, sign bits,
// zero, saturation boundaries, float ties and specials) and is compared bit for
// bit with the CPU running the same instruction. ptest is compared through the
// ZF and CF it sets.
import { CPU, Memory } from '../interp.mjs';
import { compileFunctionWat } from '../aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
const r64 = () => (BigInt(rnd()) << 33n) ^ (BigInt(rnd()) << 11n) ^ BigInt(rnd());
const ONES = (1n << 128n) - 1n;
const f32 = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return BigInt(b.getUint32(0, true)); };
const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
const vec = (...q) => q[0] | (q[1] << 64n);
const EDGE = [0n, ONES, 0x80808080808080808080808080808080n, 0x7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7fn,
  0x80000000800000008000000080000000n, 0x7fffffff7fffffff7fffffff7fffffffn, 0x80008000800080008000800080008000n,
  0x7fff7fff7fff7fff7fff7fff7fff7fffn, 0x00010002000300040005000600070008n, 0x0102030405060708090a0b0c0d0e0f00n];
const FLT = [[0.5, 1.5, 2.5, -0.5], [-1.5, -2.5, 3.49, -3.49], [NaN, Infinity, -Infinity, -0], [1e30, -1e30, 8388609, 0.1]];
const vecs = [...EDGE];
for (let i = 0; i < 24; i++) vecs.push(vec(r64(), r64()));
for (const r of FLT) vecs.push(r.reduce((a, x, i) => a | (f32(x) << BigInt(32 * i)), 0n));
for (const r of FLT) vecs.push(vec(f64(r[0]), f64(r[1])), vec(f64(r[2]), f64(r[3])));
const PAIRS = [];
for (let i = 0; i < vecs.length; i++) PAIRS.push([vecs[i], vecs[(i * 7 + 3) % vecs.length]]);

const FORMS = [];
for (const o of ['pshufb', 'phaddw', 'phaddd', 'phaddsw', 'phsubw', 'phsubd', 'phsubsw', 'pmaddubsw', 'psignb', 'psignw', 'psignd',
                 'pmulhrsw', 'pabsb', 'pabsw', 'pabsd', 'pmuldq', 'pcmpeqq', 'pcmpgtq', 'packusdw', 'pmulld', 'phminposuw',
                 'pminsb', 'pminsd', 'pminuw', 'pminud', 'pmaxsb', 'pmaxsd', 'pmaxuw', 'pmaxud',
                 'pmovsxbw', 'pmovsxbd', 'pmovsxbq', 'pmovsxwd', 'pmovsxwq', 'pmovsxdq',
                 'pmovzxbw', 'pmovzxbd', 'pmovzxbq', 'pmovzxwd', 'pmovzxwq', 'pmovzxdq',
                 'pblendvb', 'blendvps', 'blendvpd', 'ptest']) FORMS.push([o, `${o} xmm0, xmm1`]);
for (const o of ['pmovsxbw', 'pmovzxwd', 'pmovsxdq']) FORMS.push([o + '-mem', `${o} xmm0, [rsp-64]`, true]);
for (const o of ['roundps', 'roundpd']) for (const m of [0, 1, 2, 3, 8, 9, 10, 11]) FORMS.push([`${o} ${m}`, `${o} xmm0, xmm1, ${m}`]);
for (const o of ['roundss', 'roundsd']) for (const m of [0, 1, 2, 3, 12]) FORMS.push([`${o} ${m}`, `${o} xmm0, xmm1, ${m}`]);
for (const m of [0, 5, 10, 15]) FORMS.push([`blendps ${m}`, `blendps xmm0, xmm1, ${m}`]);
for (const m of [0, 1, 2, 3]) FORMS.push([`blendpd ${m}`, `blendpd xmm0, xmm1, ${m}`]);
for (const m of [0, 0x55, 0xa3, 0xff]) FORMS.push([`pblendw ${m}`, `pblendw xmm0, xmm1, ${m}`]);
for (const m of [0, 1, 4, 8, 15, 16, 17, 31, 32]) FORMS.push([`palignr ${m}`, `palignr xmm0, xmm1, ${m}`]);
for (const m of [0, 1, 7, 15]) FORMS.push([`pextrb ${m}`, `pextrb eax, xmm1, ${m}\nmovd xmm0, eax`], [`pinsrb ${m}`, `mov eax, 0x1b2c3d5e\npinsrb xmm0, eax, ${m}`]);
for (const m of [0, 3, 7]) FORMS.push([`pextrw ${m}`, `pextrw eax, xmm1, ${m}\nmovd xmm0, eax`]);
for (const m of [0, 1, 3]) FORMS.push([`pextrd ${m}`, `pextrd eax, xmm1, ${m}\nmovd xmm0, eax`], [`extractps ${m}`, `extractps eax, xmm1, ${m}\nmovd xmm0, eax`],
  [`pinsrd ${m}`, `mov eax, 0x89abcdef\npinsrd xmm0, eax, ${m}`]);
for (const m of [0, 1]) FORMS.push([`pextrq ${m}`, `pextrq rax, xmm1, ${m}\nmovq xmm0, rax`], [`pinsrq ${m}`, `mov rax, 0x1122334455667788\npinsrq xmm0, rax, ${m}`]);
for (const m of [0x00, 0x10, 0x4d, 0xb0, 0xff, 0x9a]) FORMS.push([`insertps ${m.toString(16)}`, `insertps xmm0, xmm1, ${m}`]);
FORMS.push(['insertps-mem', 'insertps xmm0, [rsp-64], 0x20', true]);
FORMS.push(['popcnt32', 'popcnt eax, [rsp-64]\nmovd xmm0, eax', true], ['popcnt64', 'popcnt rax, [rsp-64]\nmovq xmm0, rax', true]);

const hex = (v) => v.toString(16).padStart(32, '0');
const fmt = (v) => hex(v & ONES);
let bad = 0, n = 0, aotForms = 0, aotSkipped = 0, aotN = 0;
for (const [name, body, memForm] of FORMS) {
  // hardware: one program, all pairs
  const table = PAIRS.map(([a, b]) => `{0x${(a & (2n**64n-1n)).toString(16)}ULL,0x${(a >> 64n).toString(16)}ULL,0x${(b & (2n**64n-1n)).toString(16)}ULL,0x${(b >> 64n).toString(16)}ULL}`).join(',');
  const asmBody = body.replace(/\n/g, '\\n\\t').replace(/\[rsp-64\]/g, '[%%rsp-64]');
  const C = `#include <string.h>
unsigned long long T[][4]={${table}};
int main(){ for(int i=0;i<${PAIRS.length};i++){ unsigned long long o[4]={0,0,0,0}, ff[1]={0}; unsigned long long s[4];
   memcpy(s,T[i],32);
   asm volatile("movdqu (%1),%%xmm0\\n\\tmovdqu 16(%1),%%xmm1\\n\\tmovdqu 16(%1),%%xmm7\\n\\t"
     "movdqu %%xmm7,-64(%%rsp)\\n\\t" "movdqu (%1),%%xmm0\\n\\t"
     ".intel_syntax noprefix\\n\\t${asmBody}\\n\\t.att_syntax\\n\\t"
     "pushfq\\n\\tpop %%rcx\\n\\tmovq %%rcx,(%2)\\n\\tmovdqu %%xmm0,(%0)"
     ::"r"(o),"r"(s),"r"(ff):"xmm0","xmm1","xmm7","rax","rcx","memory");
   __builtin_printf("%016llx%016llx %llx\\n", o[1], o[0], ff[0]&0x41); } return 0; }`;
  writeFileSync('/tmp/s4.c', C);
  try { execFileSync('gcc', ['-O0', '-mno-red-zone', '-o', '/tmp/s4bin', '/tmp/s4.c'], { stdio: ['ignore', 'ignore', 'pipe'] }); }
  catch (e) { console.log(`  gcc failed for ${name}: ${String(e.stderr).slice(0, 200)}`); bad++; continue; }
  const hw = execFileSync('/tmp/s4bin').toString().trim().split('\n');

  const pre = `movdqu xmm0, [0x420000]\nmovdqu xmm1, [0x420010]\nmovdqu [rsp-64], xmm1\nmovdqu xmm0, [0x420000]\n`;
  writeFileSync('/tmp/s4.asm', 'BITS 64\n' + pre + body + '\npushfq\npop rcx\nmov [0x420120], rcx\nmovdqu [0x420100], xmm0\nret');
  execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/s4.bin', '/tmp/s4.asm']);
  const code = new Uint8Array(0x30000); code.set(readFileSync('/tmp/s4.bin'));
  let mism = 0;
  PAIRS.forEach(([a, b], k) => {
    const m = new Memory([{ base: CODE, bytes: code.slice() }]);
    m.write(BUF, 8n, a & (2n**64n-1n)); m.write(BUF + 8n, 8n, a >> 64n);
    m.write(BUF + 16n, 8n, b & (2n**64n-1n)); m.write(BUF + 24n, 8n, b >> 64n);
    const cpu = new CPU(m); cpu.mem.cpuV2 = true;
    for (let q = 0; q < 16; q++) cpu.regs[q] = 0n;
    cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
    let g = 0; while (cpu.rip !== SENT) { cpu.step(); if (++g > 60) throw new Error('runaway ' + name); }
    const got = hex((m.read(BUF + 0x108n, 8n) << 64n) | m.read(BUF + 0x100n, 8n));
    const gf = (m.read(BUF + 0x120n, 8n) & 0x41n).toString(16);
    const [hv, hf] = hw[k].split(' ');
    const ptest = name === 'ptest';
    n++;
    if (hv !== got && !ptest || (ptest && hf !== gf)) { mism++; if (mism <= 2) console.log(`  ${name} a=${hex(a)} b=${hex(b)}\n      hw     ${hv} ${hf}\n      interp ${got} ${gf}`); }
  });
  if (mism) { bad++; console.log(`  ${name}: ${mism}/${PAIRS.length} mismatches`); }

  // the compiled tier, for the forms it emits (flags are not captured here: no pushfq in a unit)
  if (name !== 'ptest') {
    writeFileSync('/tmp/s4a.asm', 'BITS 64\n' + pre + body + '\nmovdqu [0x420100], xmm0\nret');
    execFileSync('nasm', ['-f', 'bin', '-o', '/tmp/s4a.bin', '/tmp/s4a.asm']);
    const acode = new Uint8Array(0x30000); acode.set(readFileSync('/tmp/s4a.bin'));
    let unit = null;
    try { unit = compileFunctionWat(new Memory([{ base: CODE, bytes: acode }]), CODE, { guestBase: CODE, ramBase: 0 }); } catch (e) { unit = null; }
    if (!unit) { aotSkipped++; continue; }
    writeFileSync('/tmp/s4a.wat', unit.wat);
    execFileSync('wat2wasm', ['--enable-tail-call', '/tmp/s4a.wat', '-o', '/tmp/s4a.wasm']);
    const mod = new WebAssembly.Module(readFileSync('/tmp/s4a.wasm'));
    let amism = 0, escaped = false;
    for (let k = 0; k < PAIRS.length && !escaped; k++) {
      const [a, b] = PAIRS[k];
      const mem = new WebAssembly.Memory({ initial: 4096 });
      const stub = () => { throw new Error('escape'); };
      const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                                   env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
      const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer);
      new Uint8Array(mem.buffer).set(acode, 0);
      const off = Number(BUF - CODE);
      dv.setBigUint64(off, a & (2n**64n-1n), true); dv.setBigUint64(off + 8, a >> 64n, true);
      dv.setBigUint64(off + 16, b & (2n**64n-1n), true); dv.setBigUint64(off + 24, b >> 64n, true);
      for (let q = 0; q < 16; q++) rv[q] = 0n;
      rv[4] = BigInt.asIntN(64, CODE + 0x1000n); dv.setBigUint64(0x1000, SENT, true);
      try { inst.exports[unit.entryName](); } catch (e) { if (String(e.message).includes('escape')) { escaped = true; break; } throw e; }
      const got = hex((dv.getBigUint64(off + 0x108, true) << 64n) | dv.getBigUint64(off + 0x100, true));
      const [hv] = hw[k].split(' ');
      aotN++;
      if (hv !== got) { amism++; if (amism <= 2) console.log(`  ${name} (compiled) a=${hex(a)} b=${hex(b)}\n      hw   ${hv}\n      aot  ${got}`); }
    }
    if (escaped) aotSkipped++; else { aotForms++; if (amism) { bad++; console.log(`  ${name} (compiled): ${amism}/${PAIRS.length} mismatches`); } }
  }
}
console.log(`\n${FORMS.length - bad}/${FORMS.length} SSSE3/SSE4.1 forms bit-exact against hardware (${n} vector cases)`);
console.log(`${aotForms} forms also checked in the compiled tier (${aotN} vector cases); ${aotSkipped} stay interpreter-only`);
if (bad) process.exit(1);
