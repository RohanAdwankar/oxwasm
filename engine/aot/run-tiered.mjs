// Runtime-tiered execution of an unmodified x86-64 ELF: the engine
// interprets, profiles call targets and loop heads, and AOT-compiles hot
// call-graph closures to wasm mid-run. No symbols, no hints — the binary is
// discovered hot function by hot function.
import { LinuxEngine } from '../linux.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const binPath = process.argv[2] || '/tmp/unitprog';
const args = process.argv.slice(3);

let asmN = 0;
const assembleWat = (wat) => {
  const w = `/tmp/tier_${process.pid}_${asmN++}`;
  writeFileSync(w + '.wat', wat);
  execFileSync('wat2wasm', [w + '.wat', '-o', w + '.wasm']);
  return new Uint8Array(readFileSync(w + '.wasm'));
};

const files = {};
for (const a of args) { try { files[a] = new Uint8Array(readFileSync(a)); } catch {} }
const elf = new Uint8Array(readFileSync(binPath));
const eng = new LinuxEngine(elf, { argv: [binPath, ...args], files, memMB: 1024, assembleWat });

const t = process.hrtime.bigint();
const res = eng.run(2e9);
const ms = Number(process.hrtime.bigint() - t) / 1e6;
process.stdout.write('stdout: ' + res.stdout);
console.log('exit:', res.exitCode, ` wall: ${ms.toFixed(1)} ms`);
console.log('stats:', JSON.stringify({ interpreted: res.stats.interpreted, aotRuns: res.stats.aotRuns,
  compiledRuns: res.stats.compiledRuns, tiers: res.stats.tiers }));
