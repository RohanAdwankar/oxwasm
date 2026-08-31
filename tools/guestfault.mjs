// Name a guest fault: which image and symbol the rip is in, what the frame
// chain above it looks like, and the instruction bytes around it.
//
// gueststack.mjs did this for CPython and said the walk was "worth lifting
// out when a second guest needs them". xz is that second guest. Same idea,
// any binary: symbol resolution over eng.maps plus the main image, an rbp
// walk, and a disassembly window so a misdecoded instruction is visible
// rather than inferred.
//
//   node tools/guestfault.mjs /usr/bin/xz -9 -c /tmp/breadth_in.txt
//   TREE=/usr/lib/python3.11 node tools/guestfault.mjs /usr/bin/python3 -S -c pass
//   AOT=1 ...   # run with the AOT tier live instead of pure interpreter
import { LinuxEngine } from '../engine/linux.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, statSync,
         writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const files = {}, mtimes = {};
const add = (g, h) => { try { files[g] = new Uint8Array(readFileSync(h));
                              mtimes[g] = Math.floor(statSync(h).mtimeMs / 1000); } catch {} };
const walk = (d) => { let e; try { e = readdirSync(d); } catch { return; }
  for (const f of e) { const hp = join(d, f); let st; try { st = lstatSync(hp); } catch { continue; }
    if (st.isDirectory()) walk(hp); else { try { add(hp, realpathSync(hp)); } catch {} } } };
for (const d of ['/lib/x86_64-linux-gnu', '/usr/lib/x86_64-linux-gnu', '/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r = realpathSync(join(d, f)); if (lstatSync(r).isFile()) add(join(d, f), r); } catch {} } }
add('/etc/ld.so.cache', '/etc/ld.so.cache');
for (const d of (process.env.TREE || '').split(':').filter(Boolean)) walk(d);

const bin = process.argv[2], args = process.argv.slice(3);
if (!bin) { console.log('usage: guestfault.mjs <binary> [args...]'); process.exit(2); }
add(bin, bin);
for (const p of args) if (existsSync(p)) add(p, p);

const symCache = new Map();
const syms = (path) => {
  if (symCache.has(path)) return symCache.get(path);
  let out = '';
  for (const flag of ['-n', '--dynamic -n']) {
    try { out = execFileSync('bash', ['-c', `nm ${flag} --defined-only ${path} 2>/dev/null`],
                             { encoding: 'utf8', maxBuffer: 64e6 }); } catch {}
    if (out.trim()) break;
  }
  const list = [];
  for (const l of out.split('\n')) { const m = /^([0-9a-f]+)\s+\S\s+(.+)$/.exec(l); if (m) list.push([BigInt('0x'+m[1]), m[2]]); }
  list.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  symCache.set(path, list); return list;
};
const nearest = (list, off) => { let lo=0, hi=list.length-1, best=null;
  while (lo <= hi) { const mid = (lo+hi)>>1; if (list[mid][0] <= off) { best = list[mid]; lo = mid+1; } else hi = mid-1; }
  return best; };
// which image an address is in, and where inside it. An address in NO map is
// reported as such rather than attributed to the main binary - assuming it was
// the main image once produced a symbol name past the end of a 6MB file.
const locate = (eng, addr) => {
  for (const m of (eng.maps || [])) if (addr >= m.at && addr < m.at + BigInt(m.len)) {
    const off = addr - m.at + BigInt(m.fileOff ?? 0);
    const b = nearest(syms(m.path), off);
    return { path: m.path, off, label: `${m.path.split('/').pop()}+0x${off.toString(16)}` +
             (b ? ` (${b[1]}+0x${(off - b[0]).toString(16)})` : '') };
  }
  if (addr >= eng.base && addr < eng.base + 0x2000000n) {
    const off = addr - eng.base;
    const b = nearest(syms(bin), off);
    return { path: bin, off, label: `${bin.split('/').pop()}+0x${off.toString(16)}` +
             (b ? ` (${b[1]}+0x${(off - b[0]).toString(16)})` : '') };
  }
  return { path: null, off: null, label: `0x${addr.toString(16)} in no mapped image` };
};

let assembleWat = null;
if (process.env.AOT) {
  const CACHE = new URL('../bench/kernels/watcache/', import.meta.url).pathname;
  mkdirSync(CACHE, { recursive: true }); let an = 0;
  assembleWat = (wat) => {
    const h = createHash('sha1').update(wat).digest('hex'), cp = CACHE + h + '.wasm';
    if (existsSync(cp)) return new Uint8Array(readFileSync(cp));
    const w = `/tmp/gf_${process.pid}_${an++}`;
    writeFileSync(w + '.wat', wat);
    execFileSync('wat2wasm', ['--enable-tail-call', w + '.wat', '-o', w + '.wasm']);
    const b = new Uint8Array(readFileSync(w + '.wasm'));
    try { unlinkSync(w + '.wat'); unlinkSync(w + '.wasm'); } catch {}
    try { writeFileSync(cp, b); } catch {}
    return b;
  };
}

const eng = new LinuxEngine(new Uint8Array(readFileSync(bin)),
  { argv: [bin, ...args], env: ['PATH=/usr/bin:/bin', 'LANG=C', 'HOME=/root'],
    files, mtimes, memMB: Number(process.env.MEMMB || 512),
    ...(assembleWat ? { assembleWat } : {}) });
let err = null;
try { let g = 0; while (eng.exitCode === null) { eng.run(5e6); if (eng.blocked) eng.wake();
        if (++g > 40000) { err = 'no exit'; break; } } }
catch (e) { err = e.message; }

console.log(`fault: ${err} @rip 0x${eng.cpu.rip.toString(16)} after ${eng.stats.interpreted} interpreted insns`);
console.log(`  exit=${eng.exitCode} stdout=${(eng.stdoutBytes||[]).reduce((a,b)=>a+b.length,0)}B` +
            (assembleWat ? ` aotFns=${eng.aotFns.size}` : ' (pure interpreter)'));
const at = locate(eng, eng.cpu.rip);
console.log(`  rip -> ${at.label}`);
console.log('  regs: ' + ['rax','rcx','rdx','rbx','rsp','rbp','rsi','rdi'].map(
  (n,i)=>`${n}=${eng.cpu.regs[i].toString(16)}`).join(' '));

// Disassemble a window around the faulting rip straight out of guest memory,
// so a wrong instruction is read rather than guessed at.
if (at.path) {
  const lo = eng.cpu.rip - 32n, buf = Buffer.alloc(80);
  try {
    for (let i = 0; i < 80; i++) buf[i] = Number(eng.mem.read(lo + BigInt(i), 1n));
    const f = `/tmp/gf_dis_${process.pid}.bin`; writeFileSync(f, buf);
    const dis = execFileSync('bash', ['-c',
      `objdump -D -b binary -m i386:x86-64 --adjust-vma=0x${lo.toString(16)} ${f} 2>/dev/null | tail -n +8`],
      { encoding: 'utf8' });
    console.log('\n  around the fault (objdump, from guest memory):');
    for (const l of dis.split('\n')) {
      if (!l.trim()) continue;
      const isRip = l.includes(eng.cpu.rip.toString(16) + ':');
      console.log(`   ${isRip ? '>>' : '  '} ${l.trim()}`);
    }
    unlinkSync(f);
  } catch (e) { console.log('  (disassembly unavailable:', e.message + ')'); }
}

console.log('\n  frame chain (rbp walk):');
let rbp = eng.cpu.regs[5];
for (let i = 0; i < 20; i++) {
  let ret, next;
  try { next = eng.mem.read(rbp, 8n); ret = eng.mem.read(rbp + 8n, 8n); } catch { break; }
  if (!ret || ret > 0x800000000n) break;
  console.log(`   #${i} ret 0x${ret.toString(16)} -> ${locate(eng, ret).label}`);
  if (next <= rbp || next === 0n) break;
  rbp = next;
}
