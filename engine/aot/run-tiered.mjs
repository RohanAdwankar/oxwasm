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
  execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
  return new Uint8Array(readFileSync(w + '.wasm'));
};

const files = {};
for (const a of args) { try { files[a] = new Uint8Array(readFileSync(a)); } catch {} }
const elf = new Uint8Array(readFileSync(binPath));

// dynamic executable: bundle the interpreter + ldd-resolved libraries
const env = [];
{
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.length);
  const phoff = Number(dv.getBigUint64(32, true));
  const phentsize = dv.getUint16(54, true), phnum = dv.getUint16(56, true);
  let interp = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (dv.getUint32(o, true) === 3) {
      const off = Number(dv.getBigUint64(o + 8, true)), sz = Number(dv.getBigUint64(o + 32, true));
      interp = Buffer.from(elf.subarray(off, off + sz - 1)).toString();
    }
  }
  if (interp) {
    files[interp] = new Uint8Array(readFileSync(interp));
    try {
      for (const line of execFileSync('ldd', [binPath]).toString().split('\n')) {
        const m = line.match(/=>\s*(\/\S+)/);
        if (m) files[m[1]] = new Uint8Array(readFileSync(m[1]));
      }
    } catch {}
    env.push('LD_LIBRARY_PATH=/lib/x86_64-linux-gnu');
  }
}
const eng = new LinuxEngine(elf, { argv: [binPath, ...args], env, files, memMB: 1024, assembleWat });

const t = process.hrtime.bigint();
const res = eng.run(2e9);
const ms = Number(process.hrtime.bigint() - t) / 1e6;
process.stdout.write('stdout: ' + res.stdout);
console.log('exit:', res.exitCode, ` wall: ${ms.toFixed(1)} ms`);
console.log('stats:', JSON.stringify({ interpreted: res.stats.interpreted, aotRuns: res.stats.aotRuns,
  compiledRuns: res.stats.compiledRuns, tiers: res.stats.tiers }));
