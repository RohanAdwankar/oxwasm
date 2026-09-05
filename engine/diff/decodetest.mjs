// Decoder differential against objdump, over whole real binaries.
//
// The instruction-level differential in this suite checks 6,037 instructions
// against hardware, which samples the decoder rather than covering it. This
// covers it: every instruction objdump finds in a real binary's .text, checked
// for the one property that matters most.
//
// LENGTH is that property. If decode() computes a different length than the
// instruction really has, the very next fetch starts mid-instruction and
// execution silently desynchronises - and it desynchronises IDENTICALLY in the
// interpreter and the AOT, because both call the same decode(). That is the
// shape of bug the two-tier differential cannot see: shadowDispatch compares
// interp against AOT, and a shared decoder error makes both sides wrong the
// same way.
//
// A decode that THROWS is a different and safe outcome: unsupported encodings
// become `udec`, which deopts to the interpreter and faults faithfully. Those
// are reported separately and are not failures.
import { decode } from '../decode.mjs';
import { execFileSync } from 'node:child_process';

const BINS = process.argv.slice(2).length ? process.argv.slice(2)
  : ['/bin/true', '/bin/gzip', '/usr/bin/sha256sum'];

let totalOk = 0, totalLen = 0, totalUnsup = 0, files = 0;
const unsupported = new Map();

for (const bin of BINS) {
  let out;
  try { out = execFileSync('objdump', ['-d', bin],
                           { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }); }
  catch (e) { console.log(`skip ${bin}: ${e.message.split('\n')[0]}`); continue; }
  files++;

  // objdump splits an instruction longer than 7 bytes across two lines, and
  // the continuation carries its OWN address with no mnemonic - it is not a
  // bare indented byte run. Reading those as separate instructions makes every
  // long instruction look 7 bytes long, which is how the first run of this
  // test reported 766 decoder bugs that were all the parser's.
  const insns = [];
  let cur = null;
  for (const line of out.split('\n')) {
    const m = /^\s*([0-9a-f]+):\t([0-9a-f ]+?)(?:\t(.*))?$/.exec(line);
    if (!m) continue;
    const bytes = m[2].trim().split(/\s+/).filter(Boolean).map(h => parseInt(h, 16));
    const text = (m[3] || '').trim();
    if (!text && cur) { for (const b of bytes) cur.bytes.push(b); continue; }
    cur = { addr: BigInt('0x' + m[1]), bytes, text };
    insns.push(cur);
  }
  if (!insns.length) { console.log(`skip ${bin}: no disassembly`); continue; }

  // flat buffer so a decode can over-read into the following instructions the
  // way a real fetch would
  const lo = insns[0].addr;
  const hi = insns[insns.length - 1].addr + BigInt(insns[insns.length - 1].bytes.length);
  const buf = new Uint8Array(Number(hi - lo) + 16);
  for (const i of insns) buf.set(i.bytes, Number(i.addr - lo));

  let ok = 0, bad = 0, unsup = 0;
  const badSamples = [];
  for (const i of insns) {
    // objdump prints "(bad)" for bytes it cannot decode either; skip those
    if (i.text.startsWith('(bad)') || !i.text) continue;
    let d;
    try { d = decode((k) => buf[Number(i.addr - lo) + k] ?? 0, i.addr); }
    catch (e) {
      unsup++;
      const key = i.text.split(/\s+/)[0];
      unsupported.set(key, (unsupported.get(key) || 0) + 1);
      continue;
    }
    if (d.len === i.bytes.length) ok++;
    else {
      bad++;
      if (badSamples.length < 8)
        badSamples.push(`    0x${i.addr.toString(16)} ours=${d.len} real=${i.bytes.length}  ${i.text}`);
    }
  }
  totalOk += ok; totalLen += bad; totalUnsup += unsup;
  console.log(`${bin}: ${ok} lengths exact, ${bad} WRONG, ${unsup} unsupported (safe: they deopt)`);
  for (const s of badSamples) console.log(s);
}

if (files) {
  const top = [...unsupported].sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([k, n]) => `${k}:${n}`).join(' ');
  console.log(`\n${totalOk} instruction lengths exact across ${files} binaries, ${totalLen} wrong`);
  if (top) console.log(`unsupported (deopt, not a failure): ${top}`);
  if (totalLen) { console.log('DECODER LENGTH MISMATCH - execution would desynchronise'); process.exit(1); }
}
