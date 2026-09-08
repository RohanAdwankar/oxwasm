// What does the translator still refuse, across far more code than anything
// runs?
//
// The sweep's hot-refusal list is the only refusal signal this project has had,
// and it only reports functions that 170 programs actually EXECUTED often
// enough to tier. An instruction no sweep case happens to reach is invisible to
// it, however common it is in code at large.
//
// This asks a different question: take every function symbol in a corpus of
// real binaries, hand each one to the translator, and tally why it says no. It
// is a static census, so it over-counts - a function that never runs still
// counts here - and that is the point. It ranks what to teach the emitter next
// by how much CODE it appears in rather than by what one workload touched.
//
//   node tools/refusals.mjs [--bins N] [--fns N] [pattern...]
import { LinuxEngine } from '../engine/linux.mjs';
import { Memory } from '../engine/interp.mjs';
import { compileFunctionWat } from '../engine/aot_wat.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? Number(argv[i + 1]) : d; };
const MAXBINS = opt('bins', 40), MAXFNS = opt('fns', 400);
const pats = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));

const isElf64 = (p) => {
  try { const fd = readFileSync(p);
        return fd.length > 20 && fd[0] === 0x7f && fd[1] === 0x45 && fd[2] === 0x4c && fd[3] === 0x46 &&
               fd[4] === 2 && new DataView(fd.buffer, fd.byteOffset).getUint16(18, true) === 0x3e; }
  catch { return false; }
};

// Shared libraries as well as executables. A census over main-binary .text
// alone reported 1147/1147 translating, which is true and not the whole
// picture: the x87 and the exotic string work that the sweep trips over lives
// in libc, libm and libcrypto, not in cp or pkill.
const libs = [];
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu']) {
  if (!existsSync(d)) continue;
  for (const n of readdirSync(d)) {
    if (!/\.so(\.\d+)*$/.test(n)) continue;
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (!st.isFile() || st.size < 8192) continue;
    if (pats.length && !pats.some((x) => p.includes(x))) continue;
    if (isElf64(p)) libs.push(p);
  }
}
libs.sort();

const bins = [];
for (const d of ['/usr/bin', '/bin', '/usr/sbin']) {
  if (!existsSync(d)) continue;
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    let st; try { st = statSync(p); } catch { continue; }
    if (!st.isFile() || !(st.mode & 0o111) || st.size < 8192) continue;
    if (pats.length && !pats.some((x) => p.includes(x))) continue;
    if (isElf64(p)) bins.push(p);
  }
}
bins.sort();
const chosen = [];
for (let i = 0; i < bins.length && chosen.length < MAXBINS; i += Math.max(1, Math.floor(bins.length / MAXBINS)))
  chosen.push(bins[i]);

// The reason strings carry addresses and operand detail, which would make
// every refusal its own bucket. Strip those so the census groups by CAUSE.
// Bare hex too, not just 0x-prefixed: "cross-block flags for jcc @ 1000b105"
// and "... @ 1003e7b0" are ONE cause, and leaving the address in split them
// into a row each and buried them under things that happened to share a
// spelling.
const bucket = (msg) => msg
  .replace(/@\s*[0-9a-f]+/gi, '').replace(/0x[0-9a-f]+/gi, 'ADDR')
  .replace(/\b[0-9a-f]{5,}\b/gi, 'ADDR').replace(/\b\d+\b/g, 'N')
  .replace(/\s+/g, ' ').trim().slice(0, 80);

const reasons = new Map(), byBin = new Map();
let tried = 0, ok = 0, refused = 0, skippedBins = 0;

// Function starts WITHOUT symbols. Nearly every system binary here is stripped
// and dynamically linked, so `nm` returns nothing usable and a symbol-driven
// census reports zero functions - which is what the first version of this did.
//
// endbr64 (f3 0f 1e fa) is the marker instead: the distro builds with CET, so
// every indirect-call target - which is every function that is called through a
// pointer or a PLT - opens with one. It misses purely local functions and it
// catches the occasional jump table landing pad, so the count is approximate.
// It is a census, not an inventory.
const ENDBR = [0xf3, 0x0f, 0x1e, 0xfa];

// ...but only inside .text. endbr64 opens every PLT stub too, and a PLT stub
// IS a trampoline, so a scan over the whole executable segment samples mostly
// PLT: the first version of this reported 556 refusals of which 556 were
// "trampoline -> callout", which is the emitter answering correctly about code
// that is not a function. Section headers say where .text is; nothing else
// here needs them.
const textRanges = (buf, base) => {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const shoff = Number(d.getBigUint64(0x28, true));
  const shent = d.getUint16(0x3a, true), shnum = d.getUint16(0x3c, true), shstr = d.getUint16(0x3e, true);
  if (!shoff || !shnum) return [];
  const strOff = Number(d.getBigUint64(shoff + shstr * shent + 0x18, true));
  const name = (o) => { let e = strOff + o; while (buf[e]) e++; return new TextDecoder().decode(buf.subarray(strOff + o, e)); };
  const out = [];
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shent;
    const nm = name(d.getUint32(o, true));
    const addr = d.getBigUint64(o + 0x10, true), size = d.getBigUint64(o + 0x20, true);
    if (!addr || !size) continue;
    if (nm === '.text' || nm.startsWith('.text.')) out.push([addr + base, addr + base + size]);
  }
  return out;
};
const entriesOf = (eng, buf) => {
  const out = [];
  // ET_DYN (3) section addresses are file-relative and need the load base;
  // ET_EXEC ones are already absolute. linux.mjs makes the same distinction
  // (mainBias), and getting it backwards silently produced an empty census.
  const etype = new DataView(buf.buffer, buf.byteOffset).getUint16(0x10, true);
  const bias = etype === 3 ? eng.base : 0n;
  for (const [lo, hi] of textRanges(buf, bias)) {
    const n = Number(hi - lo);
    if (n <= 0 || n > (64 << 20)) continue;
    const off = eng.RAMOFF + Number(lo - eng.base);
    if (off < 0 || off + n > eng.wmem.buffer.byteLength) continue;
    const u8 = new Uint8Array(eng.wmem.buffer, off, n);
    for (let i = 0; i + 4 <= n; i++)
      if (u8[i] === ENDBR[0] && u8[i+1] === ENDBR[1] && u8[i+2] === ENDBR[2] && u8[i+3] === ENDBR[3])
        out.push(lo + BigInt(i));
  }
  return out;
};

// A shared object has no process to build, so map its PT_LOAD segments into a
// bare Memory at a synthetic base - which is all compileFunctionWat needs, and
// is how every bare-unit differential in the suite already works.
const SO_BASE = 0x10000000n;
const loadSo = (buf) => {
  const d = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const phoff = Number(d.getBigUint64(0x20, true));
  const phent = d.getUint16(0x36, true), phnum = d.getUint16(0x38, true);
  let hi = 0n;
  const segs = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phent;
    if (d.getUint32(o, true) !== 1) continue;                    // PT_LOAD
    const off = Number(d.getBigUint64(o + 0x08, true)), va = d.getBigUint64(o + 0x10, true);
    const filesz = Number(d.getBigUint64(o + 0x20, true)), memsz = d.getBigUint64(o + 0x28, true);
    segs.push([va, off, filesz]);
    if (va + memsz > hi) hi = va + memsz;
  }
  if (!segs.length) return null;
  const img = new Uint8Array(Number(hi));
  for (const [va, off, filesz] of segs) img.set(buf.subarray(off, off + filesz), Number(va));
  return new Memory([{ base: SO_BASE, bytes: img }]);
};

// the dynamic linker, so a dynamic executable can be constructed at all
const LDSO = '/lib64/ld-linux-x86-64.so.2';
const ldFiles = existsSync(LDSO) ? { [LDSO]: new Uint8Array(readFileSync(LDSO)) } : {};

for (const bin of chosen) {
  let eng; const buf = new Uint8Array(readFileSync(bin));
  try { eng = new LinuxEngine(buf, { argv: [bin], files: ldFiles, memMB: 256 }); }
  catch { skippedBins++; continue; }
  const syms = entriesOf(eng, buf);
  if (!syms.length) { skippedBins++; continue; }

  let n = 0, binRef = 0;
  const step = Math.max(1, Math.floor(syms.length / MAXFNS));
  for (let i = 0; i < syms.length && n < MAXFNS; i += step) {
    n++; tried++;
    try { compileFunctionWat(eng.mem, syms[i], { guestBase: eng.base, ramBase: eng.RAMOFF }); ok++; }
    catch (e) {
      refused++; binRef++;
      const k = bucket(e.message);
      reasons.set(k, (reasons.get(k) || 0) + 1);
    }
  }
  if (n) byBin.set(bin, { n, binRef });
}

for (const lib of libs.filter((_, i) => i % Math.max(1, Math.floor(libs.length / MAXBINS)) === 0).slice(0, MAXBINS)) {
  const buf = new Uint8Array(readFileSync(lib));
  const mem = loadSo(buf);
  if (!mem) { skippedBins++; continue; }
  const syms = [];
  for (const [lo, hi] of textRanges(buf, SO_BASE)) {
    const n = Number(hi - lo);
    if (n <= 0 || n > (64 << 20)) continue;
    for (let i = 0; i + 4 <= n; i++) {
      let m = true;
      for (let k = 0; k < 4; k++) if (Number(mem.read(lo + BigInt(i + k), 1n)) !== ENDBR[k]) { m = false; break; }
      if (m) syms.push(lo + BigInt(i));
    }
  }
  if (!syms.length) { skippedBins++; continue; }
  let n = 0, binRef = 0;
  const step = Math.max(1, Math.floor(syms.length / MAXFNS));
  for (let i = 0; i < syms.length && n < MAXFNS; i += step) {
    n++; tried++;
    try { compileFunctionWat(mem, syms[i], { guestBase: SO_BASE, ramBase: 0 }); ok++; }
    catch (e) { refused++; binRef++; const k = bucket(e.message); reasons.set(k, (reasons.get(k) || 0) + 1); }
  }
  if (n) byBin.set(lib, { n, binRef });
}

console.log(`${chosen.length - skippedBins} binaries, ${tried} functions: ${ok} translate, ${refused} refused ` +
            `(${(100 * refused / Math.max(1, tried)).toFixed(1)}%)`);
console.log(`(${skippedBins} binaries skipped: no usable symbols, or a dynamic interpreter this census does not supply)\n`);
console.log('refusal causes, by how many functions they refuse:');
for (const [k, v] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${String(v).padStart(5)}  ${k}`);

const worst = [...byBin].sort((a, b) => b[1].binRef / b[1].n - a[1].binRef / a[1].n).slice(0, 8);
console.log('\nbinaries refusing the largest share of their functions:');
for (const [b, r] of worst) console.log(`  ${(100 * r.binRef / r.n).toFixed(0).padStart(3)}%  ${b} (${r.binRef}/${r.n})`);
