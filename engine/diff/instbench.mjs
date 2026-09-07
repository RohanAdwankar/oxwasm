// What instantiating a unit costs, and whether the shared table's size is in
// it.
//
// A CPU profile of a rustc compile inside the engine put `new
// WebAssembly.Instance` at 17.1 s of 163 - 10.5% of the run, the largest line
// after the emitter, and never named before. The run instantiates 5,511 units,
// so that is ~3 ms each, which is far too much for a module V8 compiles
// lazily. Every unit imports the one shared funcref table, and the engine
// pre-sizes that table to thousands of entries; if instantiation is O(table
// size) then unit count and table size multiply, and a big app pays twice.
//
//   node engine/diff/instbench.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';

const WAT = `(module
  (import "js" "mem" (memory 1))
  (import "js" "ftab" (table $ft 0 funcref))
  (type $uft (func (result i64)))
  (func (export "f") (result i64)
    (i64.add (i64.load (i32.const 8)) (i64.const 1))))`;

const w = `/tmp/instbench_${process.pid}`;
writeFileSync(w + '.wat', WAT);
try { execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']); }
catch (e) { console.log('instbench SKIPPED: wat2wasm not available'); process.exit(0); }
const bytes = new Uint8Array((await import('node:fs')).readFileSync(w + '.wasm'));
for (const s of ['.wat', '.wasm']) { try { unlinkSync(w + s); } catch {} }

const mod = new WebAssembly.Module(bytes);
const mem = new WebAssembly.Memory({ initial: 64 });

// `--mem SIZE`: one clean measurement of resident bytes per instance, in a
// process that has done nothing else.
const memArg = process.argv.indexOf('--mem');
if (memArg > 0) {
  const size = +process.argv[memArg + 1];
  const ftab = new WebAssembly.Table({ element: 'anyfunc', initial: size });
  const keep = [];
  const before = process.memoryUsage().rss;
  for (let i = 0; i < 3000; i++) keep.push(new WebAssembly.Instance(mod, { js: { mem, ftab } }));
  const after = process.memoryUsage().rss;
  keep[0].exports.f();
  console.log(((after - before) / 3000) | 0);
  process.exit(0);
}

// The instances are held, as the engine holds its units - which is the point,
// since what is being measured is per-instance memory as much as time. A big
// table times a big N runs the heap out, so N shrinks as the table grows.
const row = (tableSize, N) => {
  const ftab = new WebAssembly.Table({ element: 'anyfunc', initial: tableSize });
  const imports = { js: { mem, ftab } };
  const keep = new Array(N);
  const t0 = performance.now();
  for (let i = 0; i < N; i++) keep[i] = new WebAssembly.Instance(mod, imports);
  const ms = performance.now() - t0;
  keep[0].exports.f();                             // touch one, so nothing is optimised away
  return ms;
};

console.log('instantiating one small module that imports a shared funcref table:\n');
console.log('  table entries        n   per instance');
const per = {};
for (const size of [1, 1024, 8192, 65536]) {
  const N = size >= 65536 ? 200 : 2000;
  row(size, N);                                    // warm this size
  const ms = Math.min(row(size, N), row(size, N));
  per[size] = ms * 1000 / N;
  console.log(`  ${String(size).padStart(9)}  ${String(N).padStart(7)}  ${per[size].toFixed(1).padStart(9)}us`);
}
// Time is only half of it: the dispatch table V8 allocates per instance is
// resident memory that lives as long as the unit does. Each size is measured
// in a FRESH process - measuring them in one process reads 33 kB for the
// 20,000-entry case instead of the truth, because the timing rows above have
// already grown the heap and the allocations land in memory that is resident
// already.
console.log('\nresident memory per instance (fresh process each):\n');
for (const size of [1, 20000]) {                   // 20000 is the engine's FTMAP_MAX
  const out = execFileSync(process.execPath, ['--max-old-space-size=6000',
    new URL(import.meta.url).pathname, '--mem', String(size)], { encoding: 'utf8' }).trim();
  console.log(`  ${String(size).padStart(9)} entries  ${(+out).toLocaleString().padStart(11)} bytes per instance`);
}

const flat = per[65536] / per[1];
console.log(`\n65536 entries costs ${flat.toFixed(1)}x what 1 entry does per instantiation.`);
console.log(flat > 2
  ? 'Instantiation scales with the shared table: unit count and table size multiply.'
  : 'Instantiation does not scale with the shared table; the per-unit cost is elsewhere.');
