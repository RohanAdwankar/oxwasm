// Random programs, translated and interpreted, compared.
//
// Every AOT test in this suite is DIRECTED: someone thought of an instruction
// and wrote a case for it. `cases.mjs` fuzzes too, but it compares the
// interpreter against hardware - it validates the oracle, not the translator.
// Nothing generated random programs and asked whether the two engines agree.
//
// Both correctness bugs this session found live in that gap. Overlapping
// `rep movsb` was wrong for a year because no test copied overlapping ranges;
// the dropped PF and AF at an escape were wrong because no bare-unit test ever
// escapes. Both were found by reading code, which does not scale.
//
// Flags are checked THROUGH BEHAVIOUR rather than by inspection. Comparing
// EFLAGS directly means knowing which bits each instruction leaves undefined,
// which is where a mask quietly hides a real difference - `cases.mjs` masks AF
// out entirely, which is one reason the AF bug survived. Instead the generated
// programs BRANCH on their flags, so a wrong CF or OF takes a different path
// and lands in the registers, where an unmasked comparison sees it.
//
//   node fuzzaot.mjs [N] [firstSeed]
import { compileFunctionWat, CWLO_SLOT, CWLEN_SLOT } from '../aot_wat.mjs';
import { CPU, Memory } from '../interp.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const N = Number(process.argv[2] || 300);
const SEED0 = Number(process.argv[3] || 1);
const CODE = 0x400000n, BUF = 0x420000n, SENT = 0xdeadbee0n, SPAN = 512;

let seed = 0n;
const rnd = (n) => { seed ^= (seed << 13n) & 0xFFFFFFFFn; seed ^= seed >> 17n;
                     seed ^= (seed << 5n) & 0xFFFFFFFFn; return Number(seed % BigInt(n)); };
const pick = (a) => a[rnd(a.length)];

// r12 holds the scratch base and is never a destination; rsp is left alone.
// rcx/rsi/rdi are used by the string ops, so they are written before each one.
const R64 = ['rax', 'rbx', 'rdx', 'rsi', 'rdi', 'r8', 'r9', 'r10', 'r11', 'r13', 'r14', 'r15'];
const R32 = ['eax', 'ebx', 'edx', 'esi', 'edi', 'r8d', 'r9d', 'r10d', 'r11d', 'r13d'];
const R8 = ['al', 'bl', 'dl', 'sil', 'dil', 'r8b', 'r9b', 'r10b'];
const CC = ['e', 'ne', 'l', 'ge', 'le', 'g', 'b', 'ae', 'be', 'a', 's', 'ns', 'o', 'no'];
const XR = ['xmm0', 'xmm1', 'xmm2', 'xmm3', 'xmm4', 'xmm5'];
// The SSE surface is large and only DIRECTED-tested: every vector case in this
// suite covers one instruction someone thought of. These are the integer and
// float forms the emitter claims, generated against each other so a lane or a
// saturation rule that is wrong in combination shows up.
const SSE_INT = ['paddb','paddw','paddd','paddq','psubb','psubw','psubd','psubq',
                 'pand','pandn','por','pxor','pcmpeqb','pcmpeqw','pcmpeqd',
                 'pcmpgtb','pcmpgtw','pcmpgtd','pminub','pmaxub','pavgb','pavgw',
                 'paddusb','paddusw','psubusb','psubusw','paddsb','psubsb',
                 'punpcklbw','punpckhbw','punpcklwd','punpckldq','punpcklqdq','pmullw','pmulhw'];
const SSE_FLT = ['addps','subps','mulps','minps','maxps','divps','sqrtps',
                 'addpd','subpd','mulpd','minpd','maxpd','divpd','sqrtpd',
                 'andps','orps','xorps','unpcklps','unpckhps','cvtps2pd','cvtpd2ps','cvtdq2ps','cvttps2dq'];
// the wide and cross-lane forms, where a lane index or a widening rule is easy
// to get wrong and impossible to notice from a narrow test
const SSE_WIDE = ['pmuludq','psadbw','pmaddwd','packsswb','packuswb','packssdw',
                  'pmulhuw','punpckhwd','punpckhdq','punpckhqdq','pavgb','pavgw'];

// a flag producer the lazy model carries: sub/add/logic kinds over full or
// narrow widths, which is the set cond() knows how to read
const prod = () => pick([
  () => `${pick(['add','sub','and','or','xor','cmp','test'])} ${pick(R64)}, ${pick(R64)}`,
  () => `${pick(['add','sub','and','or','xor','cmp'])} ${pick(R32)}, ${pick(R32)}`,
  () => `${pick(['add','sub','and','or','xor','cmp'])} ${pick(R8)}, ${pick(R8)}`,
  () => `cmp ${pick(R64)}, ${(rnd(2) ? -1 : 1) * rnd(4096)}`,
])();

function program(id) {
  const L = [`mov r12, 0x${BUF.toString(16)}`];
  // both engines start their vector registers from the same buffer bytes
  XR.forEach((x, i) => L.push(`movdqu ${x}, [r12+${16 * i}]`));
  let lab = 0;
  const n = 10 + rnd(14);
  for (let i = 0; i < n; i++) {
    switch (rnd(34)) {
      case 0: L.push(`mov ${pick(R64)}, ${(rnd(2) ? -1 : 1) * rnd(0x7fffffff)}`); break;
      case 1: L.push(`${pick(['add','sub','and','or','xor','cmp','test'])} ${pick(R64)}, ${pick(R64)}`); break;
      case 2: L.push(`${pick(['add','sub','and','or','xor','cmp'])} ${pick(R32)}, ${pick(R32)}`); break;
      case 3: L.push(`${pick(['add','sub','and','or','xor','cmp'])} ${pick(R8)}, ${pick(R8)}`); break;
      case 4: L.push(`mov ${pick(R64)}, [r12+${rnd(SPAN - 8)}]`); break;
      case 5: L.push(`mov [r12+${rnd(SPAN - 8)}], ${pick(R64)}`); break;
      case 6: L.push(`lea ${pick(R64)}, [r12+${rnd(SPAN - 8)}]`); break;
      case 7: L.push(`${pick(['movzx','movsx'])} ${pick(R64)}, byte [r12+${rnd(SPAN - 1)}]`); break;
      case 8: L.push(`${pick(['shl','shr','sar','rol','ror'])} ${pick(R64)}, ${rnd(63) + 1}`); break;
      case 9: L.push(`${pick(['inc','dec','neg','not'])} ${pick(R64)}`); break;
      // Flag CONSUMERS, each preceded by a MODELLED producer in the same
      // block. Without that, 48 of 60 generated programs were refused for
      // "cross-block flags" - the translator declining safely, and a fuzzer
      // that gets refused is testing nothing. The refusal path is worth
      // exercising, but not with four fifths of the budget.
      case 10: L.push(prod(), `${pick(['adc','sbb'])} ${pick(R64)}, ${pick(R64)}`); break;
      case 11: L.push(prod(), `set${pick(CC)} ${pick(R8)}`); break;
      case 12: L.push(prod(), `cmov${pick(CC)} ${pick(R64)}, ${pick(R64)}`); break;
      // a branch on the flags: this is how a wrong flag becomes a wrong
      // register, which an unmasked comparison can see
      case 13: { const t = `L${id}_${lab++}`;
        L.push(prod(), `j${pick(CC)} ${t}`, `${pick(['add','xor'])} ${pick(R64)}, ${pick(R64)}`, `${t}:`); break; }
      // a bounded backward loop, so the CFG is not a straight line
      case 14: { const t = `B${id}_${lab++}`;
        L.push(`mov rcx, ${1 + rnd(6)}`, `${t}:`, `${pick(['add','xor','sub'])} ${pick(R64)}, ${pick(R64)}`,
               `dec rcx`, `jnz ${t}`); break; }   // dec/jnz IS the producer here
      // string ops with pointers that may OVERLAP, in either direction, which
      // is the shape that was wrong and that nothing else generates
      // vector work: the registers are seeded from the scratch buffer, so both
      // engines start from the same 128 bits, and written back at the end
      case 16: L.push(`movdqu ${pick(XR)}, [r12+${rnd(SPAN - 16)}]`); break;
      // register and MEMORY source forms: the emitter reads a memory operand
      // through a different path (a v128 load) and nothing generated that
      case 17: L.push(rnd(3) ? `${pick(SSE_INT)} ${pick(XR)}, ${pick(XR)}`
                             : `${pick(SSE_INT)} ${pick(XR)}, [r12+${rnd(SPAN - 16)}]`); break;
      case 18: L.push(rnd(3) ? `${pick(SSE_FLT)} ${pick(XR)}, ${pick(XR)}`
                             : `${pick(SSE_FLT)} ${pick(XR)}, [r12+${rnd(SPAN - 16)}]`); break;
      case 19: L.push(`pshufd ${pick(XR)}, ${pick(XR)}, ${rnd(256)}`); break;
      // packed shifts, by an immediate and by an OPERAND. The second form has
      // its own rule - the count is the whole low quadword and a count at or
      // past the lane width wipes the register, where wasm would take it
      // modulo the width - and the vector registers are seeded from buffer
      // bytes, so the counts these produce are mostly enormous, which is the
      // half of the rule an immediate can never reach.
      case 20: { const sh = pick(['psllw','pslld','psllq','psrlw','psrld','psrlq','psraw','psrad']);
        L.push(rnd(2) ? `${sh} ${pick(XR)}, ${rnd(20)}`
                      : `${sh} ${pick(XR)}, ${rnd(2) ? pick(XR) : `[r12+${rnd(SPAN - 16)}]`}`); break; }
      case 21: L.push(`movdqu [r12+${rnd(SPAN - 16)}], ${pick(XR)}`); break;
      case 22: L.push(`${pick(SSE_WIDE)} ${pick(XR)}, ${pick(XR)}`); break;
      case 23: L.push(`${pick(['pshuflw','pshufhw'])} ${pick(XR)}, ${pick(XR)}, ${rnd(256)}`); break;
      // the GPR<->xmm moves, and the mask extract, which cross the two files
      case 24: L.push(pick([`movd ${pick(XR)}, ${pick(R32)}`, `movq ${pick(XR)}, ${pick(R64)}`,
                            `movd ${pick(R32)}, ${pick(XR)}`, `movq ${pick(R64)}, ${pick(XR)}`,
                            `pmovmskb ${pick(R32)}, ${pick(XR)}`,
                            `pinsrw ${pick(XR)}, ${pick(R32)}, ${rnd(8)}`,
                            `pextrw ${pick(R32)}, ${pick(XR)}, ${rnd(8)}`])); break;
      // Addressing beyond [base+disp]: an index register, a scale, and a
      // negative displacement, which is a different path through wasmAddr
      // than anything above generated.
      case 25: { const sc = pick([1,2,4,8]), d = rnd(64);
        L.push(`mov rbx, ${rnd(16)}`, rnd(2) ? `mov ${pick(R64)}, [r12+rbx*${sc}+${d}]`
                                            : `mov [r12+rbx*${sc}+${d}], ${pick(R64)}`); break; }
      // narrow memory traffic: byte and word loads and stores, where the
      // emitter's masking is separate code from the 32/64-bit forms
      case 26: L.push(pick([`mov ${pick(R8)}, [r12+${rnd(SPAN-1)}]`, `mov [r12+${rnd(SPAN-1)}], ${pick(R8)}`,
                            `mov ${pick(R32)}, [r12+${rnd(SPAN-4)}]`, `mov [r12+${rnd(SPAN-4)}], ${pick(R32)}`,
                            `movzx ${pick(R64)}, word [r12+${rnd(SPAN-2)}]`,
                            `movsx ${pick(R64)}, word [r12+${rnd(SPAN-2)}]`,
                            `movsxd ${pick(R64)}, dword [r12+${rnd(SPAN-4)}]`])); break;
      // bit tests, double-precision shifts, byte swaps and exchanges
      case 27: L.push(pick([`bt ${pick(R64)}, ${rnd(64)}`, `bts ${pick(R64)}, ${rnd(64)}`,
                            `btr ${pick(R64)}, ${rnd(64)}`, `btc ${pick(R64)}, ${rnd(64)}`,
                            `bswap ${pick(R64)}`, `bswap ${pick(R32)}`,
                            `xchg ${pick(R64)}, ${pick(R64)}`,
                            `shld ${pick(R64)}, ${pick(R64)}, ${rnd(63)+1}`,
                            `shrd ${pick(R64)}, ${pick(R64)}, ${rnd(63)+1}`,
                            `bsf ${pick(R64)}, ${pick(R64)}`, `bsr ${pick(R64)}, ${pick(R64)}`,
                            `popcnt ${pick(R64)}, ${pick(R64)}`, `tzcnt ${pick(R64)}, ${pick(R64)}`,
                            `lzcnt ${pick(R64)}, ${pick(R64)}`])); break;
      // the widening multiply and the sign-extension pair. div is left out:
      // a random divisor faults more often than it computes, and a fault is
      // the interpreter's answer rather than a comparison.
      case 28: L.push(pick([`imul ${pick(R64)}`, `mul ${pick(R64)}`, `cqo`, `cdq`, `cwde`, `cdqe`,
                            `imul ${pick(R64)}, ${pick(R64)}, ${(rnd(2)?-1:1)*rnd(4096)}`])); break;
      // read-modify-write to memory, and the atomics
      case 29: L.push(pick([`${pick(['add','sub','and','or','xor'])} [r12+${rnd(SPAN-8)}], ${pick(R64)}`,
                            `${pick(['add','sub','and','or','xor'])} ${pick(R64)}, [r12+${rnd(SPAN-8)}]`,
                            `inc qword [r12+${rnd(SPAN-8)}]`, `dec qword [r12+${rnd(SPAN-8)}]`,
                            `xadd [r12+${rnd(SPAN-8)}], ${pick(R64)}`,
                            `lock xadd [r12+${rnd(SPAN-8)}], ${pick(R64)}`])); break;
      case 15: { const off = rnd(SPAN - 96), d = rnd(33) - 16;
        L.push(`lea rsi, [r12+${off}]`, `lea rdi, [r12+${Math.max(0, off + d)}]`, `mov rcx, ${rnd(12)}`,
               `cld`, pick(['rep movsb', 'rep stosb', 'rep movsq', 'repe cmpsb', 'repne scasb',
                            'rep movsw', 'rep movsd', 'rep stosw', 'rep stosd', 'rep stosq',
                            'repe cmpsw', 'repe cmpsd', 'repne scasw', 'repne scasd', 'repne scasq',
                            'movsb', 'stosb', 'cmpsb', 'scasb'])); break; }
      // cmpxchg, whose flag and register effects depend on whether it matched
      case 30: L.push(`mov rax, [r12+${rnd(SPAN-8)}]`,
                      pick([`cmpxchg [r12+${rnd(SPAN-8)}], ${pick(R64)}`,
                            `lock cmpxchg [r12+${rnd(SPAN-8)}], ${pick(R64)}`,
                            `cmpxchg ${pick(R64)}, ${pick(R64)}`])); break;
      // vector loads and stores at MISALIGNED addresses, including ones that
      // straddle a 4K boundary - a different path in the address arithmetic
      case 31: { const near = 4096 - 8 + rnd(16);
        L.push(`lea rbx, [r12+${Math.min(near, SPAN - 16)}]`,
               pick([`movdqu ${pick(XR)}, [r12+${rnd(SPAN-16)+1}]`,
                     `movdqu [r12+${rnd(SPAN-16)+1}], ${pick(XR)}`,
                     `movups ${pick(XR)}, [r12+${rnd(SPAN-16)+3}]`,
                     `movq ${pick(XR)}, [r12+${rnd(SPAN-8)+1}]`,
                     `movd ${pick(XR)}, dword [r12+${rnd(SPAN-4)+1}]`,
                     `movhps ${pick(XR)}, [r12+${rnd(SPAN-8)+1}]`,
                     `movlps ${pick(XR)}, [r12+${rnd(SPAN-8)+1}]`])); break; }
      // fs-segment accesses. Every glibc binary in the sweep reads its stack
      // canary through one, and the emitter reaches the base by a path nothing
      // else here takes: a runtime load of regfile slot 16 folded into the
      // address, where the interpreter adds a GUEST address and the AOT adds a
      // WASM offset. The two only agree because the displacement carries the
      // correction, and that agreement was untested.
      case 32: L.push(pick([`mov ${pick(R64)}, [fs:${rnd(SPAN-8)}]`,
                            `mov [fs:${rnd(SPAN-8)}], ${pick(R64)}`,
                            `mov ${pick(R32)}, [fs:${rnd(SPAN-4)}]`,
                            `mov ${pick(R8)}, [fs:${rnd(SPAN-1)}]`,
                            `mov [fs:${rnd(SPAN-1)}], ${pick(R8)}`,
                            `movzx ${pick(R64)}, word [fs:${rnd(SPAN-2)}]`,
                            `${pick(['add','sub','and','or','xor','cmp'])} ${pick(R64)}, [fs:${rnd(SPAN-8)}]`,
                            `${pick(['add','sub','and','or','xor'])} [fs:${rnd(SPAN-8)}], ${pick(R64)}`,
                            `movdqu ${pick(XR)}, [fs:${rnd(SPAN-16)}]`,
                            `movdqu [fs:${rnd(SPAN-16)}], ${pick(XR)}`])); break;
      // A consumer two paths reach, where ONE OF THEM DESTROYED THE FLAGS.
      // Every diamond above produces flags on both arms; this one produces on
      // the taken arm and clobbers on the other, which is the shape where an
      // answer derived from either arm alone is wrong half the time. The
      // translator must refuse it, and it did until a join was added that
      // treated the clobbered path as if it simply had no flags - Go's
      // memeqbody (`sub; shl %cl; sete` entered by a `je`) then answered
      // false for every 1-7 byte string. The breadth sweep caught that; this
      // generator could not, because it only ever shifted by an immediate.
      case 33: { const t = `K${id}_${lab++}`;
        L.push(prod(), `j${pick(CC)} ${t}`,
               `mov rcx, ${rnd(70)}`,
               pick([`shl ${pick(R64)}, cl`, `shr ${pick(R64)}, cl`, `sar ${pick(R64)}, cl`,
                     `rol ${pick(R64)}, cl`, `ror ${pick(R64)}, cl`,
                     `rol ${pick(R64)}, ${rnd(63)+1}`, `ror ${pick(R64)}, ${rnd(63)+1}`,
                     `shld ${pick(R64)}, ${pick(R64)}, ${rnd(63)+1}`,
                     `shrd ${pick(R64)}, ${pick(R64)}, ${rnd(63)+1}`,
                     `clc`, `stc`]),
               `${t}:`,
               pick([`set${pick(CC)} ${pick(R8)}`, `cmov${pick(CC)} ${pick(R64)}, ${pick(R64)}`,
                     `adc ${pick(R64)}, ${pick(R64)}`, `sbb ${pick(R64)}, ${pick(R64)}`])); break; }
    }
  }
  // observe the flags one last time through defined means, and spill every
  // vector register so a wrong lane lands in the compared buffer
  L.push(`set${pick(CC)} r15b`);
  XR.forEach((x, i) => L.push(`movdqu [r12+${SPAN - 16 * (i + 1)}], ${x}`));
  return L.join('\n') + '\nret';
}

// Temporary files carry the pid: two fuzz runs at different seeds are the
// obvious way to use a spare core, and sharing /tmp/fz.wat between them made
// one of them assemble the other's half-written module and report an ENGINE
// failure ("empty module") that did not exist.
const T = (ext) => `/tmp/fz.${process.pid}.${ext}`;
const asmOf = (body) => {
  writeFileSync(T('asm'), 'BITS 64\n' + body);
  execFileSync('nasm', ['-f', 'bin', '-o', T('bin'), T('asm')]);
  const b = readFileSync(T('bin')); const c = new Uint8Array(0x30000); c.set(b); return c;
};
const seedByte = (i) => (i * 31 + 7) & 0xFF;

let pass = 0, fail = 0, refused = 0, escaped = 0;
// Why the generator's programs get refused. A fuzzer that refuses most of what
// it makes is testing almost nothing, and without this line that looks
// identical to a fuzzer that is passing.
const why = new Map();
for (let k = 0; k < N; k++) {
  seed = BigInt(SEED0 + k) * 2654435761n % 0xFFFFFFFFn || 1n;
  const body = program(k);
  let code;
  try { code = asmOf(body); } catch { continue; }        // a shape nasm rejects is not the engine's problem

  let r;
  try { r = compileFunctionWat(new Memory([{ base: CODE, bytes: code }]), CODE, { guestBase: CODE, ramBase: 0 }); }
  catch (e) {                                             // refusing is always allowed; answering wrongly is not
    refused++;
    const k = e.message.replace(/@.*/, '').replace(/0x[0-9a-f]+/gi, '').trim();
    why.set(k, (why.get(k) || 0) + 1);
    continue;
  }
  writeFileSync(T('wat'), r.wat);
  try { execFileSync('wat2wasm', ['--enable-tail-call', T('wat'), '-o', T('wasm')]); }
  catch (e) { fail++; console.log(`  ASSEMBLY FAILED for case ${k}: ${String(e.message).slice(0, 120)}\n${body}\n`); continue; }
  const mod = new WebAssembly.Module(readFileSync(T('wasm')));

  // oracle
  const m = new Memory([{ base: CODE, bytes: code.slice() }]);
  for (let i = 0; i < SPAN; i++) m.write(BUF + BigInt(i), 1n, BigInt(seedByte(i)));
  const cpu = new CPU(m);
  for (let q = 0; q < 16; q++) cpu.regs[q] = 0x0101010101010100n + BigInt(q);
  cpu.regs[4] = CODE + 0x1000n; m.write(cpu.regs[4], 8n, SENT); cpu.rip = CODE;
  cpu.fsBase = BUF;                                       // so [fs:disp] lands in the compared buffer
  let g = 0, ran = true;
  try { while (cpu.rip !== SENT) { cpu.step(); if (++g > 20000) { ran = false; break; } } }
  catch { ran = false; }
  if (!ran) continue;                                     // a runaway or a fault is this generator's fault
  const wantR = []; for (let q = 0; q < 16; q++) wantR.push(BigInt.asUintN(64, cpu.regs[q]));
  const wantM = []; for (let i = 0; i < SPAN; i++) wantM.push(Number(m.read(BUF + BigInt(i), 1n)));

  // translated
  const mem = new WebAssembly.Memory({ initial: 4096 });
  const stub = () => { const e = new Error('escape'); e.escape = true; throw e; };
  const inst = new WebAssembly.Instance(mod, { js: { mem, ftab: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }) },
                                               env: { syscall: stub, callout: stub, deopt: stub, loophot: stub, codewrite: stub } });
  const rv = new BigInt64Array(mem.buffer, 0, 16), dv = new DataView(mem.buffer), u8 = new Uint8Array(mem.buffer);
  u8.set(code, 0);
  const bufOff = Number(BUF - CODE);
  for (let i = 0; i < SPAN; i++) u8[bufOff + i] = seedByte(i);
  for (let q = 0; q < 16; q++) rv[q] = BigInt.asIntN(64, 0x0101010101010100n + BigInt(q));
  rv[4] = BigInt.asIntN(64, CODE + 0x1000n);
  // slot 16 of the regfile, the fs base the emitter loads at every fs access.
  // It holds the GUEST base: the emitter folds the guest->wasm correction into
  // the displacement constant, so the raw guest value is what belongs here.
  dv.setBigUint64(128, BUF, true);
  // The code image is loaded at offset 0, so it lands on the regfile slots
  // too. Under OXWASM_STOREGUARD the store guard reads its window from two of
  // them, and program bytes there make it a random window: 22 of 120 programs
  // "escaped" on a callout that should never have fired. Zero it - an empty
  // window is what a bare unit means.
  dv.setUint32(CWLO_SLOT, 0, true); dv.setUint32(CWLEN_SLOT, 0, true);
  dv.setBigUint64(0x1000, SENT, true);
  try { inst.exports[r.entryName](); }
  catch (e) { if (e.escape) { escaped++; continue; } throw e; }   // a unit may escape mid-way; that is the interpreter's answer, not a wrong one

  const gotR = []; for (let q = 0; q < 16; q++) gotR.push(BigInt.asUintN(64, rv[q]));
  const gotM = []; for (let i = 0; i < SPAN; i++) gotM.push(u8[bufOff + i]);
  const RN = ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi','r8','r9','r10','r11','r12','r13','r14','r15'];
  const rBad = gotR.findIndex((v, i) => v !== wantR[i]);
  const mBad = gotM.findIndex((v, i) => v !== wantM[i]);
  if (rBad < 0 && mBad < 0) { pass++; continue; }
  fail++;
  const what = rBad >= 0 ? `${RN[rBad]}: oracle ${wantR[rBad].toString(16)} aot ${gotR[rBad].toString(16)}`
                         : `buffer byte ${mBad}: oracle ${wantM[mBad]} aot ${gotM[mBad]}`;
  console.log(`  MISMATCH case ${k} (seed ${SEED0 + k}) ${what}\n${body}\n`);
  if (fail >= 3) break;
}
console.log(`\n${pass}/${pass + fail} random programs agree (AOT vs interpreter), ` +
            `${refused} refused, ${escaped} escaped mid-unit`);
for (const [k, v] of [...why].sort((a, b) => b[1] - a[1]).slice(0, 8))
  console.log(`  refused ${String(v).padStart(4)}  ${k}`);
if (fail) process.exit(1);
