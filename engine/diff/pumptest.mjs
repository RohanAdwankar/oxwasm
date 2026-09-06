// Deferred assembly: a unit whose bytes come back while the guest is in a
// long interpreted stretch must register from INSIDE that stretch. pumpAsm()
// used to run only at run() entry and at the next tier-up, so once every hot
// root was submitted nothing pumped again: perl's op dispatcher, entered
// before its unit returned, ran its whole loop interpreted (38 s against
// 11 s with a synchronous assembler; the unit came back at t=9 s and
// registered at t=38 s, the end of the run). Here the assembler holds every
// unit until pumped, the whole program runs in ONE run() slice, and the
// interpreted-step count says whether the loop went compiled.
import { LinuxEngine } from '../linux.mjs';
import { makeAssembler } from '../../tools/assemble.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'pump-'));
const N = 3000000;
const C = `
__attribute__((noinline)) long f(long i) { return (i * 7) % 13; }
void _start(void) {
  long s = 0;
  for (long i = 0; i < ${N}; i++) s += f(i);
  register long rdi __asm__("rdi") = s & 255;
  __asm__ volatile ("mov $60, %%eax\\n\\tsyscall" : : "r"(rdi) : "rax", "rcx", "r11", "memory");
  for (;;) {}
}`;
writeFileSync(join(dir, 'pump.c'), C);
execFileSync('gcc', ['-O2', '-static', '-nostdlib', '-fno-pie', '-no-pie', '-o', join(dir, 'pump'), join(dir, 'pump.c')]);
let expect = 0; for (let i = 0; i < N; i++) expect += (i * 7) % 13;
expect &= 255;

const asm = makeAssembler({ tag: 'pmp' });
const eng = new LinuxEngine(new Uint8Array(readFileSync(join(dir, 'pump'))), { argv: ['pump'], env: [], files: {}, mtimes: {}, memMB: 256, assembleWat: asm });
eng.onAotFail = (a, m) => console.log('aotfail', a.toString(16), String(m).slice(0, 200));
const held = []; let delivered = 0, pumps = 0;
eng.assembleWatDeferred = (wat, cb) => { held.push([wat, cb]); };
eng.pumpAsm = () => { pumps++; while (held.length) { delivered++; const [wat, cb] = held.shift(); let b = null, e = null; try { b = asm(wat); } catch (x) { e = x; } cb(b, e); } };
// one slice: the pump at run() entry sees nothing in flight yet, so every
// registration has to come from inside the interpreter loop
let guard = 0;
while (eng.exitCode === null && guard++ < 100) eng.run(5e9);
const interp = eng.stats.interpreted;
const okExit = eng.exitCode === expect, okComp = interp < 4 * N;
console.log(`pump: exit=${eng.exitCode} (expect ${expect}) interpreted=${interp} units delivered=${delivered} pumps=${pumps} aotRuns=${eng.stats.aotRuns | 0}: ${okExit && okComp ? 'ok' : 'FAIL'}`);
if (!okExit) console.log('  wrong exit code');
if (!okComp) console.log(`  the loop stayed interpreted (${interp} steps for ${N} iterations): pending units did not register mid-stretch`);
process.exit(okExit && okComp ? 0 : 1);
