// Breadth probe: X11 clients outside the GTK/GIMP path. Loads only the libs
// the binary needs (guishot walks a whole sysroot, which OOMs on "/").
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
const files = {}, mtimes = {};
const add = (g,h)=>{ try { files[g]=new Uint8Array(readFileSync(h)); mtimes[g]=0; } catch{} };
for (const d of ['/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu','/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r=realpathSync(join(d,f)); if (lstatSync(r).isFile()) add(join(d,f),r); } catch{} } }
add('/etc/ld.so.cache','/etc/ld.so.cache');
for (const d of ['/usr/share/X11/XErrorDB','/etc/X11/Xresources']) add(d,d);
const bin = process.argv[2], args = process.argv.slice(3);
add(bin, bin);
if (!files[bin]) { console.log('absent:', bin); process.exit(0); }
const xs = new XServer({ width: 1024, height: 768 });
const eng = new LinuxEngine(files[bin], {
  argv: [bin, ...args], env: ['DISPLAY=:0','PATH=/bin:/usr/bin','HOME=/root','LANG=C'],
  files, mtimes, memMB: 512, xserver: xs });
const unimpl = new Map();
const old = eng.syscall.bind(eng);
eng.syscall = (cpu) => {
  const nr = Number(cpu.regs[0] & 0xffffffffn);
  const r = old(cpu);
  const rv = BigInt.asIntN(64, cpu.regs[0]);
  if (rv < 0n && rv > -4096n) { const k = nr+' => '+rv;
    unimpl.set(k, (unimpl.get(k)||0)+1); }
  return r;
};
const t0 = Date.now();
try { while (eng.exitCode === null && Date.now()-t0 < 600000) { eng.run(5e7); if (eng.blocked) eng.wake(); } }
catch (e) { console.log('THREW:', e.message); }
console.log(`${bin}: exit=${eng.exitCode} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log('stdout:', JSON.stringify(eng.stdout.join('').slice(0, 1500)));
console.log('stderr:', JSON.stringify((eng.stderr||[]).join('').slice(0, 600)));
const top = [...unimpl.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12);
console.log('failing syscalls (nr => errno) x count:', top.map(([k,v])=>k+' x'+v).join(', ') || '(none)');
