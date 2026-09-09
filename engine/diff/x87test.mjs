// Differential: the x87 stack, interpreter against the CPU.
//
// x87 is the one instruction family with NO differential coverage at all. The
// translator refuses every x87 instruction, so a unit escapes to the
// interpreter and the interpreter's answer is the engine's answer - and
// nothing has ever checked that answer against hardware. The breadth sweep
// only says that 170 programs produce the right bytes, which is a weak claim
// about a family used mostly by libm and by long-double printf.
//
// The hardware oracle single-steps with ptrace and reports rip, the GPRs and
// the flags. It does not report the x87 registers, so every case here moves
// its result into a GPR - store to memory and load it back - and the
// comparison the harness already does covers it.
//
// The interpreter keeps x87 values as JS doubles where hardware keeps 80-bit
// extended, so this is deliberately confined to what the two can agree on
// exactly: values representable as doubles, and operations whose result is
// too. Where they cannot agree the difference is real and worth a separate
// result rather than a masked one.
import { runCase } from './run.mjs';

const S = '0x20000400';                       // scratch, well clear of the code
// Materialise a double bit pattern in memory and push it.
const push = (bits, off = 0) => `mov rax, 0x${bits.toString(16)}\nmov [${S}+${off}], rax\nfld qword [${S}+${off}]`;
const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
// Pop the top of the stack into rax as raw bits.
const pop = 'fstp qword [' + S + '+64]\nmov rax, [' + S + '+64]';
// ... and as a 64-bit integer, which is a different conversion path
const popi = 'fistp qword [' + S + '+64]\nmov rax, [' + S + '+64]';

// Values every one of which is exactly representable as a double, so the
// interpreter's doubles and the CPU's 80-bit registers hold the same number.
const V = [1.0, 2.0, 0.5, -3.0, 1024.0, -0.25, 0.0, -0.0, 7.5, 1e300, 1e-300, 3.0];
const cases = [];

// arithmetic, both operand orders, register and memory forms
for (const [op, mem] of [['fadd', 'fadd'], ['fsub', 'fsub'], ['fmul', 'fmul'],
                         ['fdiv', 'fdiv'], ['fsubr', 'fsubr'], ['fdivr', 'fdivr']]) {
  for (let i = 0; i < V.length; i++) {
    const a = V[i], b = V[(i * 5 + 3) % V.length];
    cases.push([`${op}-st-${i}`, `${push(f64(a), 0)}\n${push(f64(b), 8)}\n${op}p st1, st0\n${pop}`]);
    cases.push([`${mem}-mem-${i}`, `${push(f64(a), 0)}\nmov rbx, 0x${f64(b).toString(16)}\nmov [${S}+8], rbx\n` +
                                   `${mem} qword [${S}+8]\n${pop}`]);
  }
}

// the unary operations, where hardware and a double agree exactly
for (const [op, vals] of [['fabs', V], ['fchs', V], ['fsqrt', [1.0, 4.0, 0.25, 1024.0, 0.0, 2.25]],
                          ['frndint', [1.5, 2.5, -1.5, -2.5, 0.5, -0.5, 3.49, -3.49]]]) {
  vals.forEach((v, i) => cases.push([`${op}-${i}`, `${push(f64(v), 0)}\n${op}\n${pop}`]));
}

// the constant loads
for (const [op, i] of [['fldz', 0], ['fld1', 1]])
  cases.push([`${op}`, `${op}\n${pop}`]);

// stack motion: fxch and fld st(i) reach registers a straight-line test misses
cases.push(['fxch', `${push(f64(3.0), 0)}\n${push(f64(5.0), 8)}\nfxch st1\n${pop}`]);
cases.push(['fld-sti', `${push(f64(3.0), 0)}\n${push(f64(5.0), 8)}\nfld st1\n${pop}`]);
cases.push(['ffree-pop', `${push(f64(3.0), 0)}\n${push(f64(5.0), 8)}\nfstp st0\n${pop}`]);

// integer conversion, both directions. fild reads a signed integer; fistp
// rounds to nearest-even, which is where a naive implementation goes wrong in
// exactly the way cvtps2dq did.
for (const n of [0n, 1n, -1n, 42n, -42n, 1n << 40n, -(1n << 40n), 0x7FFFFFFFn]) {
  cases.push([`fild-${n}`, `mov rax, ${n}\nmov [${S}], rax\nfild qword [${S}]\n${pop}`]);
}
for (const v of [0.5, 1.5, 2.5, -0.5, -1.5, -2.5, 3.49, -3.49, 1024.0, -7.0]) {
  cases.push([`fistp-${v}`, `${push(f64(v), 0)}\n${popi}`]);
}

// comparisons, which write the flags directly (fucomi) or the status word
// (fucom + fnstsw). Both reach a GPR, so both are checked.
for (let i = 0; i < V.length; i++) {
  const a = V[i], b = V[(i * 7 + 5) % V.length];
  cases.push([`fucomi-${i}`, `${push(f64(a), 0)}\n${push(f64(b), 8)}\nfxch st1\nfucomi st1\n` +
                             `setb al\nsete bl\nsetp cl\nmovzx rax, al\nmovzx rbx, bl\nmovzx rcx, cl`]);
  cases.push([`fnstsw-${i}`, `${push(f64(a), 0)}\n${push(f64(b), 8)}\nfxch st1\nfucom st1\nfnstsw ax\nmovzx rax, ax`]);
}

// the NARROW memory forms, which are their own conversion path: a 32-bit
// float on the way in and out, and 16- and 32-bit integers both ways
const f32 = (x) => { const b = new DataView(new ArrayBuffer(4)); b.setFloat32(0, x, true); return BigInt(b.getUint32(0, true)); };
for (const v of [1.0, -2.5, 0.5, 1024.0, -0.0, 3.5]) {
  cases.push([`fld32-${v}`, `mov eax, 0x${f32(v).toString(16)}\nmov [${S}], eax\nfld dword [${S}]\n${pop}`]);
  cases.push([`fst32-${v}`, `${push(f64(v), 0)}\nfstp dword [${S}+64]\nmov eax, [${S}+64]\nmov rax, rax`]);
}
for (const n of [0n, 1n, -1n, 32767n, -32768n]) {
  cases.push([`fild16-${n}`, `mov ax, ${n}\nmov [${S}], ax\nfild word [${S}]\n${pop}`]);
}
for (const n of [0n, 1n, -1n, 2147483647n, -2147483648n]) {
  cases.push([`fild32-${n}`, `mov eax, ${n}\nmov [${S}], eax\nfild dword [${S}]\n${pop}`]);
}
for (const v of [1.5, -1.5, 2.5, 1024.0, -7.0]) {
  cases.push([`fistp32-${v}`, `${push(f64(v), 0)}\nfistp dword [${S}+64]\nmov eax, [${S}+64]\nmovsx rax, eax`]);
  cases.push([`fisttp-${v}`, `${push(f64(v), 0)}\nfisttp qword [${S}+64]\nmov rax, [${S}+64]`]);
}

// fscale and fxtract are exact on powers of two; fprem is exact whenever the
// remainder is representable, which for these operands it is
for (const [a, e] of [[1.0, 3n], [3.5, -2n], [1024.0, -10n], [-2.0, 5n]])
  cases.push([`fscale-${a}-${e}`, `mov rax, ${e}\nmov [${S}+16], rax\nfild qword [${S}+16]\n` +
                                  `${push(f64(a), 0)}\nfscale\n${pop}`]);
for (const v of [8.0, 3.5, -0.125, 1024.0, 1.0, -0.0, 5e-324]) {
  cases.push([`fxtract-sig-${v}`, `${push(f64(v), 0)}\nfxtract\n${pop}`]);      // significand on top
  // ... and the EXPONENT underneath it, which a test that only pops the top
  // never sees: half of fxtract's answer would have been unchecked.
  cases.push([`fxtract-exp-${v}`, `${push(f64(v), 0)}\nfxtract\nfstp st0\n${pop}`]);
}
for (const [a, b] of [[7.0, 2.0], [-7.0, 2.0], [1024.0, 3.0], [0.5, 0.25]])
  cases.push([`fprem-${a}-${b}`, `${push(f64(b), 0)}\n${push(f64(a), 8)}\nfprem\n${pop}`]);

// The ROUNDING MODE, which nothing has checked against hardware: the control
// word's RC field steers frndint and fistp, and the interpreter reads the
// same two bits from its own copy of the word.
for (const [rc, name] of [[0, 'near'], [1, 'down'], [2, 'up'], [3, 'trunc']]) {
  const cw = 0x037F | (rc << 10);
  for (const v of [1.5, -1.5, 2.5, -2.5, 0.5, -0.5, 3.49, -3.49]) {
    cases.push([`rc-${name}-rnd-${v}`,
      `mov ax, 0x${cw.toString(16)}\nmov [${S}+32], ax\nfldcw [${S}+32]\n${push(f64(v), 0)}\nfrndint\n${pop}`]);
    cases.push([`rc-${name}-fistp-${v}`,
      `mov ax, 0x${cw.toString(16)}\nmov [${S}+32], ax\nfldcw [${S}+32]\n${push(f64(v), 0)}\n${popi}`]);
  }
}

let pass = 0, fail = 0, steps = 0;
const bad = [];
for (const [name, asm] of cases) {
  const r = runCase(name, asm + '\nret');
  if (r.ok) { pass++; steps += r.steps; }
  else { fail++; bad.push(r); }
}
for (const r of bad.slice(0, 12)) console.log('  FAIL ' + JSON.stringify(r));
console.log(`\n${pass}/${pass + fail} x87 cases match hardware (interpreter), ${steps} instructions verified`);
if (fail) process.exit(1);
