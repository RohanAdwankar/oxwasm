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
const guest=async(gx,gy)=>{ const r=JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
  const sx=r.width/1024; return [r.x+gx*sx, r.y+gy*sx]; };
// count non-background pixels in the canvas area the strokes cross
const inkCount = `(() => { const c=document.getElementById('screen').getContext('2d');
  const d=c.getImageData(470,430,240,90).data; let n=0;
  for (let i=0;i<d.length;i+=4) if (d[i]<200||d[i+1]<200||d[i+2]<200) n++;
  return n; })()`;
const resetLat = `(() => { const L=window.__oxLat; L.samples=0; L.sumMs=0; L.maxMs=0; L.hist=new Array(12).fill(0); return 1; })()`;

const before = await q(inkCount);
const rows = [];
for (let s = 0; s < STROKES; s++) {
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
  rows.push({ wall, mean, max: lat.maxMs, samples: lat.samples, pumpMax: lat.pumpMaxMs });
  console.log(`stroke ${s+1}: ${STEPS} moves in ${wall}ms · input->paint mean ${mean.toFixed(1)}ms max ${lat.maxMs.toFixed(0)}ms (${lat.samples} paints) · worst pump ${lat.pumpMaxMs.toFixed(0)}ms`);
}
const after = await q(inkCount);
const med = (a) => [...a].sort((x,y)=>x-y)[a.length>>1];
const warm = rows.slice(1);
console.log(`SUMMARY warm stroke: input->paint mean med ${med(warm.map(r=>r.mean)).toFixed(1)}ms · max med ${med(warm.map(r=>r.max)).toFixed(0)}ms`);
console.log(`ink pixels ${before} -> ${after} (${after>before?'STROKES DREW':'NO MARKS - correctness failure'})`);
console.log('stat:', await q('document.getElementById("stat").textContent'));
ws.close(); chrome.kill('SIGKILL'); process.exit(0);
