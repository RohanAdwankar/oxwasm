// Run an X client until its window is painted, then dump the screen as text
// (which glyphs actually landed) — a GUI app never exits, so exit code is
// the wrong signal.
import { LinuxEngine } from '../../engine/linux.mjs';
import { XServer } from '../../engine/xserver.mjs';
import { readFileSync, readdirSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const files = {}, mtimes = {};
const add = (g,h)=>{ try { files[g]=new Uint8Array(readFileSync(h)); mtimes[g]=0; } catch{} };
for (const d of ['/lib/x86_64-linux-gnu','/usr/lib/x86_64-linux-gnu','/lib64']) {
  let e; try { e = readdirSync(d); } catch { continue; }
  for (const f of e) { try { const r=realpathSync(join(d,f)); if (lstatSync(r).isFile()) add(join(d,f),r); } catch{} } }
add('/etc/ld.so.cache','/etc/ld.so.cache');
const bin = process.argv[2], args = process.argv.slice(3);
add(bin, bin);
if (!files[bin]) { console.log('absent:', bin); process.exit(0); }
const xs = new XServer({ width: 480, height: 200 });
const eng = new LinuxEngine(files[bin], { argv:[bin, ...args],
  env:['DISPLAY=:0','PATH=/bin:/usr/bin','HOME=/root','LANG=C'], files, mtimes, memMB: 512, xserver: xs });
const t0 = Date.now(); let painted = 0;
// A cold Xt app can take many minutes to reach first paint, and a run that
// only prints at the end loses everything if it is killed or the container
// restarts. Checkpoint progress to XSHOT_PROGRESS (default /tmp/xshot.progress)
// as it goes, so a partial run is still worth something.
const PROG = process.env.XSHOT_PROGRESS || '/tmp/xshot.progress';
let lastProg = 0;
const note = () => {
  const nz = xs.fb.reduce((a, v) => a + (v !== 0 ? 1 : 0), 0);
  try { writeFileSync(PROG, `t=${((Date.now()-t0)/1000).toFixed(0)}s nonzero=${nz}px exit=${eng.exitCode}\n`
    + 'stderr: ' + JSON.stringify((eng.stderr || []).join('').slice(0, 600)) + '\n'); } catch {}
  return nz;
};
try { while (eng.exitCode === null && Date.now()-t0 < (Number(process.env.XSHOT_MS) || 120000)) {
  eng.run(2e7); if (eng.blocked) eng.wake();
  const nz = xs.fb.reduce((a,v)=>a+(v!==0?1:0),0);
  if (Date.now() - lastProg > 5000) { lastProg = Date.now(); note(); }
  if (nz > 200) { painted = nz; break; }
} } catch(e) { console.log('THREW:', e.message); }
note();
console.log(`${bin}: exit=${eng.exitCode} painted=${painted}px in ${((Date.now()-t0)/1000).toFixed(1)}s`);
console.log('stderr:', JSON.stringify((eng.stderr||[]).join('').slice(0,300)));
// render the framebuffer as coarse text so glyphs are checkable without a viewer
if (painted) {
  const bg = xs.fb[0];
  let out = '';
  for (let y = 0; y < xs.H; y += 2) { let line = '';
    for (let x = 0; x < xs.W; x += 1) line += xs.fb[y*xs.W+x] === bg ? ' ' : '#';
    if (line.trim()) out += line.replace(/\s+$/,'') + '\n'; }
  writeFileSync('/tmp/xshot.txt', out);
  console.log(out.split('\n').slice(0, 40).join('\n'));
}
