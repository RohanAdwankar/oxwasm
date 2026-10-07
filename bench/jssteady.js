// Steady-state JavaScript mix used to compare opencode (bun) under oxwasm with the same binary natively.
// Run: BUN_BE_BUN=1 opencode jssteady.js [rounds]   (natively, or inside a sandbox with the binary as bun)
// steady-state JS mix: recursion, typed-array math, object/property access, string building,
// array sort, Map/Set, JSON round-trip. Each round is timed; the best of the later rounds is the
// steady state (the first rounds include tier-up).
function fib(n) { return n < 2 ? n : fib(n - 1) + fib(n - 2); }
function mathLoop(n) { const a = new Float64Array(1024); let s = 0; for (let i = 0; i < n; i++) { const j = i & 1023; a[j] = a[j] * 0.5 + i; s += a[j]; } return s; }
function objects(n) { const o = []; for (let i = 0; i < n; i++) o.push({ a: i, b: i * 2, c: 'x' + (i & 15) }); let s = 0; for (const e of o) s += e.a + e.b + e.c.length; return s; }
function strings(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(97 + (i % 26)); let c = 0; for (let i = 0; i < s.length; i++) c += s.charCodeAt(i); return c + s.split('a').length; }
function sorting(n) { const a = []; let x = 12345; for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) & 0x7fffffff; a.push(x); } a.sort((p, q) => p - q); return a[n >> 1]; }
function maps(n) { const m = new Map(), st = new Set(); for (let i = 0; i < n; i++) { m.set('k' + (i & 4095), i); st.add(i & 8191); } let s = 0; for (const [k, v] of m) s += v; return s + st.size; }
function json(n) { let s = 0; for (let i = 0; i < n; i++) { const t = JSON.parse(JSON.stringify({ i, a: [1, 2, 3], s: 'abc' + i })); s += t.i + t.a.length; } return s; }
const phases = { fib: () => fib(31), math: () => mathLoop(20000000), objects: () => objects(500000), strings: () => strings(1500000), sorting: () => sorting(400000), maps: () => maps(1500000), json: () => json(80000) };
const rounds = +(process.argv[2] || 8);
const best = {}; let total = [];
for (let r = 0; r < rounds; r++) {
  const t0 = performance.now(); let tr = 0;
  for (const [name, f] of Object.entries(phases)) { const a = performance.now(); f(); const d = performance.now() - a; tr += d; best[name] = Math.min(best[name] ?? 1e9, d); }
  total.push(tr);
  console.log(`round ${r}: ${tr.toFixed(0)} ms`);
}
const steady = Math.min(...total.slice(Math.floor(rounds / 2)));
console.log(`STEADY ${steady.toFixed(0)} ms (best of rounds ${Math.floor(rounds / 2)}..${rounds - 1})`);
console.log('PHASES ' + Object.entries(best).map(([k, v]) => `${k}=${v.toFixed(0)}`).join(' '));
