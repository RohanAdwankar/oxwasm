// How far apart are the interpreter's x87 and a real one?
//
// diff/x87test.mjs is exact by construction: it only asks questions a JS
// double and an 80-bit register can answer identically. That leaves the
// interesting half unmeasured - the transcendentals, and any operation whose
// intermediate needs more than 53 bits of significand. Hardware computes those
// in 80 bits and rounds once on the way out; the interpreter computes in 64
// and rounds at every step.
//
// This is a REPORT, not a test. It runs the same case both ways, takes the
// difference in units in the last place of the double they both store, and
// prints the distribution. A number here is not a bug: it is the size of a
// known and unavoidable gap, and knowing it is what makes it possible to say
// whether a guest could notice.
//
// The bound at the end is checked, though. A gap that grows past what is
// recorded means something changed that was not meant to.
//
//   node x87gap.mjs
import { runCase } from './run.mjs';

const S = '0x20000400';
const f64 = (x) => { const b = new DataView(new ArrayBuffer(8)); b.setFloat64(0, x, true); return b.getBigUint64(0, true); };
const push = (bits, off = 0) => `mov rax, 0x${bits.toString(16)}\nmov [${S}+${off}], rax\nfld qword [${S}+${off}]`;
const pop = 'fstp qword [' + S + '+64]\nmov rax, [' + S + '+64]';

// Distance in ULPs between two doubles given as raw bit patterns. Ordered as
// sign-magnitude, which is what makes adjacent doubles adjacent integers.
const ord = (b) => (b & (1n << 63n)) ? (1n << 64n) - b : b | (1n << 63n);
const ulps = (a, b) => { const x = ord(a), y = ord(b); return x > y ? x - y : y - x; };

const cases = [];
const add = (op, v, asm) => cases.push([op, v, asm]);

// f2xm1 is defined on [-1, 1]; fyl2x wants a positive argument
for (const v of [0, 0.5, -0.5, 1, -1, 0.25, 0.1, -0.9, 0.7071067811865476])
  add('f2xm1', v, `${push(f64(v), 0)}\nf2xm1\n${pop}`);
for (const v of [1, 2, 10, 0.5, 1e10, 1.0000001, 3, 7.5])
  add('fyl2x', v, `${push(f64(1), 0)}\n${push(f64(v), 8)}\nfyl2x\n${pop}`);
for (const v of [1, 2, 0.5, 1e-5, 3])
  add('fyl2xp1', v, `${push(f64(1), 0)}\n${push(f64(v), 8)}\nfyl2xp1\n${pop}`);
for (const v of [0, 0.5, 1, 2, 3.14159265358979, -1, 1e-8, 100])
  { add('fsin', v, `${push(f64(v), 0)}\nfsin\n${pop}`);
    add('fcos', v, `${push(f64(v), 0)}\nfcos\n${pop}`); }
for (const v of [0, 0.5, 1, -1, 1e10, 0.25])
  add('fptan', v, `${push(f64(v), 0)}\nfptan\nfstp st0\n${pop}`);   // pops the pushed 1.0 first
for (const [y, x] of [[1, 1], [1, 2], [-1, 3], [0.5, 0.25], [1e10, 1]])
  add('fpatan', `${y}/${x}`, `${push(f64(y), 0)}\n${push(f64(x), 8)}\nfpatan\n${pop}`);
// arithmetic whose exact result needs more than 53 bits, so the extra
// precision of an 80-bit register is visible in the double that comes out
for (const [a, b] of [[1, 3], [1, 49], [0.1, 0.3], [1e300, 7], [2, 3]])
  add('fdiv-then-mul', `${a}/${b}`, `${push(f64(a), 0)}\n${push(f64(b), 8)}\nfdivp st1, st0\n` +
                                    `${push(f64(b), 16)}\nfmulp st1, st0\n${pop}`);
for (const v of [2, 3, 5, 10, 0.1])
  add('fsqrt-sq', v, `${push(f64(v), 0)}\nfsqrt\nfld st0\nfmulp st1, st0\n${pop}`);

const by = new Map();
let worst = 0n, worstName = '';
for (const [op, v, asm] of cases) {
  const r = runCase(`${op}-${v}`, asm + '\nret');
  let d = 0n;
  if (!r.ok) {
    if (r.field !== 'rax') { console.log(`  UNUSABLE ${op} ${v}: ${JSON.stringify(r)}`); continue; }
    d = ulps(BigInt('0x' + r.hw), BigInt('0x' + r.interp));
  }
  const e = by.get(op) ?? { n: 0, exact: 0, max: 0n, arg: '' };
  e.n++; if (d === 0n) e.exact++;
  if (d > e.max) { e.max = d; e.arg = String(v); }
  by.set(op, e);
  if (d > worst) { worst = d; worstName = `${op}(${v})`; }
}

console.log('\nx87 interpreter against hardware, in ULPs of the stored double:\n');
console.log('  op                exact   worst ULP   at');
for (const [op, e] of [...by].sort((a, b) => (b[1].max > a[1].max ? 1 : -1)))
  console.log(`  ${op.padEnd(16)} ${String(e.exact + '/' + e.n).padStart(6)}   ${String(e.max).padStart(9)}   ${e.arg}`);
console.log(`\nworst overall ${worst} ULP at ${worstName}`);

// The recorded bounds, per operation: the measured gap rounded up to a power
// of two. Tight enough that a real change trips them, loose enough to survive
// a different CPU's last bit. Zero means the two agree exactly today and are
// expected to keep agreeing.
//
// The two large ones are both ARGUMENT REDUCTION, not arithmetic. Hardware
// reduces against an 80-bit pi and the interpreter against a double one, so
// sin near pi - where the result is the difference of two nearly equal
// quantities - and tan of 1e10 - where the reduction discards thirty bits
// before it starts - are where the two diverge most. Neither is reachable
// from libm on x86-64, which computes these in SSE software rather than on
// the x87 stack; a guest that calls fsin directly gets six digits.
const BOUNDS = { fsin: 1n << 34n, fptan: 1n << 18n, fyl2xp1: 1n << 16n, f2xm1: 4n,
                 'fsqrt-sq': 1n, 'fdiv-then-mul': 1n, fpatan: 0n, fcos: 0n, fyl2x: 0n };
let bad = 0;
for (const [op, e] of by) {
  const b = BOUNDS[op];
  if (b === undefined) { console.log(`  no bound recorded for ${op} (worst ${e.max})`); bad++; }
  else if (e.max > b) { console.log(`  REGRESSION ${op}: ${e.max} ULP, recorded bound ${b}`); bad++; }
}
if (bad) process.exit(1);
console.log('every operation within its recorded bound');
