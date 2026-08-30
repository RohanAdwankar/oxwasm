// Drag/stroke latency on the packed page: press on the canvas, move in
// steps, release — the paint path, which is motion-coalesced and so exercises
// different scheduling than a menu click. Reports per-move input->paint
// latency from the page's own __oxLat, plus whether pixels actually changed
// (a stroke that leaves no marks is a correctness failure, not a fast one).
//   node cdp_draw.mjs URL [strokes=5] [steps=24]
import { spawn } from 'node:child_process';

const [url, strokesS = '5', stepsS = '24'] = process.argv.slice(2);
const STROKES = +strokesS, STEPS = +stepsS;
const PORT = 9365;
const chrome = spawn('/opt/pw-browsers/chromium', ['--headless','--disable-gpu','--no-sandbox',
  `--remote-debugging-port=${PORT}`,'--window-size=1100,900','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const waiting=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m.result);waiting.delete(m.id);}};
const cmd=(m2,p={})=>new Promise(res=>{const i=++id;waiting.set(i,res);ws.send(JSON.stringify({id:i,method:m2,params:p}))});
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate',{url});
for (let i=0;i<600;i++){ await new Promise(r=>setTimeout(r,200));
  if ((await cmd('Runtime.evaluate',{expression:'window.__oxReady===true'})).result.value) break; }
for (let i=0;i<150;i++){ await new Promise(r=>setTimeout(r,200));
  if ((await cmd('Runtime.evaluate',{expression:'window.__oxPerf&&window.__oxPerf.unitsApplied!==undefined'})).result.value) break; }
await new Promise(r=>setTimeout(r,3000));
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
// the canvas rect is fetched ONCE: doing a CDP round trip per move added
// ~15ms of probe overhead to every step and swamped the engine's own cost
const _rect = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
const _sx = _rect.width / 1024;
const guest = async (gx, gy) => [_rect.x + gx * _sx, _rect.y + gy * _sx];
// count non-background pixels in the canvas area the strokes cross
const inkCount = `(() => { const c=document.getElementById('screen').getContext('2d');
  const d=c.getImageData(470,450,240,80).data; let n=0;
  for (let i=0;i<d.length;i+=4) if (d[i]<200||d[i+1]<200||d[i+2]<200) n++;
  return n; })()`;
const resetLat = `(() => { const L=window.__oxLat; L.samples=0; L.sumMs=0; L.maxMs=0; L.sumWait=0; L.sumWork=0; L.hist=new Array(12).fill(0); return 1; })()`;

// A fresh page has NO image open — just GIMP's empty "(untitled)" window,
// where a stroke correctly draws nothing. Create one first (File > New >
// OK), or this measures the latency of doing nothing.
const click=async(gx,gy)=>{ const [x,y]=await guest(gx,gy);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); };
await click(424,383); await new Promise(r=>setTimeout(r,1200));   // File
await click(452,422); await new Promise(r=>setTimeout(r,2500));   // New...
await click(587,526); await new Promise(r=>setTimeout(r,4000));   // OK
console.log('after File>New>OK:', await q('document.getElementById("stat").textContent'));

const before = await q(inkCount);
// Optional CPU profile of the stroke path, taken in the BROWSER so the pump
// and the X server's blitting are in frame — a node-harness profile has
// neither. PROF=<path> profiles every stroke after the first.
const PROF = process.env.PROF;
if (PROF) await cmd('Profiler.enable');
const rows = [];
for (let s = 0; s < STROKES; s++) {
  if (PROF && s === 1) await cmd('Profiler.start');
  await q(resetLat);
  const y = 450 + s * 8;
  const [x0,y0] = await guest(480, y);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:x0,y:y0});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:x0,y:y0,button:'left',buttons:1,clickCount:1});
  const t0 = Date.now();
  for (let i=1;i<=STEPS;i++){
    const [x,yy] = await guest(480 + i*8, y);
    await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:yy,button:'left',buttons:1});
    await new Promise(r=>setTimeout(r,16));           // ~60Hz, like a real drag
  }
  const [x1,y1] = await guest(480 + STEPS*8, y);
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:x1,y:y1,button:'left',buttons:0,clickCount:1});
  const wall = Date.now() - t0;
  await new Promise(r=>setTimeout(r,600));
  const lat = JSON.parse(await q('JSON.stringify(window.__oxLat)'));
  const mean = lat.samples ? lat.sumMs / lat.samples : -1;
  const wait = lat.samples ? lat.sumWait / lat.samples : -1;
  const work = lat.samples ? lat.sumWork / lat.samples : -1;
  rows.push({ wall, mean, max: lat.maxMs, samples: lat.samples, pumpMax: lat.pumpMaxMs, wait, work });
  console.log(`stroke ${s+1}: ${STEPS} moves in ${wall}ms · input->paint ${mean.toFixed(1)}ms = wait ${wait.toFixed(1)} + work ${work.toFixed(1)} · max ${lat.maxMs.toFixed(0)}ms (${lat.samples} paints) · worst pump ${lat.pumpMaxMs.toFixed(0)}ms`);
}
if (PROF) {
  const { profile } = await cmd('Profiler.stop');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(PROF, JSON.stringify(profile));
  console.log('stroke profile -> ' + PROF);
}
const after = await q(inkCount);
const med = (a) => [...a].sort((x,y)=>x-y)[a.length>>1];
const warm = rows.slice(1);
console.log(`SUMMARY warm stroke: input->paint med ${med(warm.map(r=>r.mean)).toFixed(1)}ms = wait ${med(warm.map(r=>r.wait)).toFixed(1)} + work ${med(warm.map(r=>r.work)).toFixed(1)} · max med ${med(warm.map(r=>r.max)).toFixed(0)}ms`);
console.log(`ink pixels ${before} -> ${after} (${after>before?'STROKES DREW':'NO MARKS - correctness failure'})`);
console.log('stat:', await q('document.getElementById("stat").textContent'));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
