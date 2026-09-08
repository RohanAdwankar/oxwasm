// Differential: the EFLAGS a compiled unit hands the interpreter at an escape.
//
// A unit that escapes (pushf, cpuid, x87, a zero-count rep scan) stores the
// flags it was carrying lazily into EFLAGS_SLOT, and syncIn applies them to
// cpu.f. That store is built from $fa/$fb/$fr, and it materializes CF, ZF, SF
// and OF - but not PF, and not AF. syncIn assigns all six unconditionally, so
// every escape used to force the interpreter's PF and AF to zero.
//
// That is invisible to every bare-unit differential in this suite, because a
// bare unit never escapes: the fixture's deopt import throws. It needs a real
// guest, tiered hot enough that the function actually compiles, escaping on
// each iteration and then READING the flags the interpreter now holds.
//
// `pushf` is the probe because it is on the deopt list (the lazy model cannot
// build a full RFLAGS word inline) AND the interpreter decodes it - so `cmp;
// pushf; pop` sets flags inside the unit, escapes, and reads back exactly what
// the handover delivered. Hardware is the oracle: the same static binary runs
// natively on this host.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'eflags-'));
let asmN = 0, inlinePushf = 0;
const assembleWat = (wat) => {
  // ESTICKY_SLOT is loaded by exactly one thing: an inline pushf. Counting it
  // is how this test knows the compiled path is being taken rather than
  // everything quietly falling back to the escape.
  if (wat.includes('(i32.const 160)')) inlinePushf++;
  const w = join(dir, `u${asmN++}`); writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  return new Uint8Array(readFileSync(w + '.wasm'));
};

// The operand pairs are chosen so PF and AF actually vary: parity is over the
// low byte of the result, AF over a borrow out of bit 3. A probe whose flags
// happen to be zero everywhere would pass against a handover that drops them.
const C = `typedef unsigned long u64;
static void wr(const char *b, long n){
  asm volatile("syscall" :: "a"(1L), "D"(1L), "S"(b), "d"(n) : "rcx","r11","memory");
}
static void ex(long c){ asm volatile("syscall" :: "a"(60L), "D"(c)); __builtin_unreachable(); }

// cmp inside the unit, pushf forces the escape, pop reads what the
// interpreter is now holding. noinline so it is its own compilable function.
__attribute__((noinline)) static u64 probe(u64 a, u64 b){
  u64 f;
  asm volatile("cmpq %2, %1\\n\\tpushfq\\n\\tpopq %0" : "=r"(f) : "r"(a), "r"(b) : "cc");
  return f & 0x8D5UL;                       // CF PF AF ZF SF OF
}
// same shape for a LOGIC producer, whose CF/OF are cleared but whose PF is not
__attribute__((noinline)) static u64 probeAnd(u64 a, u64 b){
  u64 f;
  asm volatile("andq %2, %1\\n\\tpushfq\\n\\tpopq %0" : "=r"(f) : "r"(a), "r"(b) : "cc");
  return f & 0x8D5UL;
}
// and for an ADD producer, where AF is a carry out of bit 3 rather than a borrow
__attribute__((noinline)) static u64 probeAdd(u64 a, u64 b){
  u64 f;
  asm volatile("addq %2, %1\\n\\tpushfq\\n\\tpopq %0" : "=r"(f) : "r"(a), "r"(b) : "cc");
  return f & 0x8D5UL;
}

// a SHIFT producer: CF is the last bit out and PF is the parity of the
// result, both defined; AF after a shift is architecturally undefined, so the
// mask below drops it for this probe alone rather than pretending either
// engine owes an answer for it.
__attribute__((noinline)) static u64 probeShl(u64 a){
  u64 f;
  asm volatile("shlq $3, %1\\n\\tpushfq\\n\\tpopq %0" : "=r"(f) : "r"(a) : "cc");
  return f & 0x8C5UL;                       // CF PF ZF SF OF, no AF
}

// The ESCAPE probe. pushf compiles inline now, so a cmp/pushf pair no
// longer leaves the unit and no longer tests the handover at all. cpuid is
// still a deopt and does not touch flags, so cmp/cpuid/pushf sets the
// flags inside the unit, escapes, and reads them back in the interpreter -
// which is the shape the handover exists for. eax is loaded with mov, not xor,
// because xor would clobber the flags being probed.
__attribute__((noinline)) static u64 probeEsc(u64 a, u64 b){
  u64 f;
  asm volatile("movl $0, %%eax\\n\\tcmpq %2, %1\\n\\tcpuid\\n\\tpushfq\\n\\tpopq %0"
               : "=r"(f) : "r"(a), "r"(b) : "cc","rax","rbx","rcx","rdx");
  return f & 0x8D5UL;
}
__attribute__((noinline)) static u64 probeEscAdd(u64 a, u64 b){
  u64 f;
  asm volatile("movl $0, %%eax\\n\\taddq %2, %1\\n\\tcpuid\\n\\tpushfq\\n\\tpopq %0"
               : "=r"(f) : "r"(a), "r"(b) : "cc","rax","rbx","rcx","rdx");
  return f & 0x8D5UL;
}

// DF and the sticky ID bit are part of the RFLAGS word an inline pushf builds,
// and neither is reachable from the arithmetic probes above: without these two
// the emitter could hardcode both to zero and every digest would still match.
// DF comes from DF_SLOT; the ID bit is whatever a popf last stored, which is
// engine state the unit reads out of ESTICKY_SLOT.
__attribute__((noinline)) static u64 probeDf(u64 a, u64 b){
  u64 f;
  asm volatile("cmpq %2, %1\\n\\tstd\\n\\tpushfq\\n\\tpopq %0\\n\\tcld" : "=r"(f) : "r"(a), "r"(b) : "cc");
  return f & 0xCD5UL;                       // CF PF AF ZF SF DF OF
}
__attribute__((noinline)) static u64 probeId(u64 a, u64 b){
  u64 f;
  asm volatile("cmpq %2, %1\\n\\tpushfq\\n\\tpopq %0" : "=r"(f) : "r"(a), "r"(b) : "cc");
  return f & 0x2008D5UL;                    // the arithmetic flags plus ID (21)
}

int _start(void){
  // set the ID bit once, through popf, so every later pushf must carry it
  { u64 v = 0x200202UL; asm volatile("pushq %0\\n\\tpopfq" :: "r"(v) : "cc"); }
  u64 h = 0xcbf29ce484222325UL;
  // enough iterations that the tier compiles each probe; the accumulator folds
  // every flag word in, so one wrong PF anywhere changes the printed digest
  for (u64 i = 0; i < 300000; i++) {
    u64 a = i * 0x9E3779B97F4A7C15UL, b = (i ^ (i << 7)) * 0xff51afd7ed558ccdUL;
    h = (h ^ probe(a, b))    * 0x100000001b3UL;
    h = (h ^ probeAnd(a, b)) * 0x100000001b3UL;
    h = (h ^ probeAdd(a, b)) * 0x100000001b3UL;
    // small operands too: AF and PF are low-bit properties and large random
    // words hit them in only a few patterns
    h = (h ^ probe(i & 0x3F, (i >> 3) & 0x3F))    * 0x100000001b3UL;
    h = (h ^ probeAdd(i & 0x3F, (i >> 3) & 0x3F)) * 0x100000001b3UL;
    h = (h ^ probeShl(a)) * 0x100000001b3UL;
    h = (h ^ probeShl(i & 0xFF)) * 0x100000001b3UL;
    h = (h ^ probeEsc(a, b)) * 0x100000001b3UL;
    h = (h ^ probeEsc(i & 0x3F, (i >> 3) & 0x3F)) * 0x100000001b3UL;
    h = (h ^ probeEscAdd(i & 0x3F, (i >> 3) & 0x3F)) * 0x100000001b3UL;
    h = (h ^ probeDf(a, b)) * 0x100000001b3UL;
    h = (h ^ probeId(a, b)) * 0x100000001b3UL;
  }
  char out[17];
  for (int k = 0; k < 16; k++) out[k] = "0123456789abcdef"[(h >> (60 - 4*k)) & 15];
  out[16] = 10;
  wr(out, 17);
  ex(0);
  return 0;
}`;
writeFileSync(join(dir, 'ef.c'), C);
execFileSync('gcc', ['-O2', '-static', '-nostdlib', '-fno-stack-protector', '-o', join(dir, 'ef'), join(dir, 'ef.c')]);

// hardware oracle
const native = execFileSync(join(dir, 'ef')).toString();

const elf = new Uint8Array(readFileSync(join(dir, 'ef')));
const eng = new LinuxEngine(elf, { argv: ['ef'], files: {}, memMB: 256, assembleWat, aotCallThreshold: 8, aotLoopThreshold: 8 });
const t0 = Date.now();
while (eng.exitCode === null && Date.now() - t0 < 300000) { eng.run(5e7); if (eng.blocked) eng.wake(); }
const got = eng.stdout.join('');

// A pass proves nothing if the probes never compiled: the interpreter alone
// has always had PF and AF right, so an all-interpreted run agrees with
// hardware whatever the handover does. The count that matters is DEOPTS, not
// aotRuns - each probe is a unit that runs one instruction and escapes, so it
// never completes an AOT run, and gating on aotRuns passes an untested engine.
const deopts = eng.stats.deopts || 0;
const ok = eng.exitCode === 0 && got === native;
if (!ok) {
  console.log(`EFLAGS FAIL exit=${eng.exitCode} engine=${JSON.stringify(got)} hardware=${JSON.stringify(native)}`);
  process.exit(1);
}
if (deopts < 100000) { console.log(`EFLAGS FAIL: only ${deopts} deopts - this run never exercised the handover`); process.exit(1); }
if (!inlinePushf) { console.log('EFLAGS FAIL: no unit compiled a pushf inline - only the escape path was tested'); process.exit(1); }
console.log(`EFLAGS exact vs hardware: ${inlinePushf} units with an inline pushf, ${deopts} escape handovers (digest ${native.trim()})`);
