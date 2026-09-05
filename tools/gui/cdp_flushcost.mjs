// What does a paint actually cost, and how much of the screen changes?
//
// flush() clears the whole framebuffer and recomposites the entire window
// tree on every call; the page then putImageData's the full canvas. Dirty-
// rect compositing (#32) is only worth building if (a) flush+blit is a
// meaningful share of the frame and (b) the typical damage is a small part
// of the screen. This measures both in the real page: wraps xs.flush with a
// timer and a diff against the previous framebuffer (changed-pixel count and
// bounding box), wraps putImageData with a timer, drives one File>New>OK and
// two strokes, and reports per-flush numbers.
//   node cdp_flushcost.mjs URL
import { spawn } from 'node:child_process';

const url = process.argv[2];
const PORT = 9367;
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
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
for (let i=0;i<600;i++){ await new Promise(r=>setTimeout(r,200));
  if (await q('window.__oxReady===true')) break; }
await new Promise(r=>setTimeout(r,3000));

await q(`(() => {
  const xs = window.__ox.xs;
  window.__fl = { flush: [], put: [], prev: null };
  const orig = xs.flush.bind(xs);
  xs.flush = () => {
    const t0 = performance.now();
    const fb = orig();
    const ms = performance.now() - t0;
    const F = window.__fl;
    let changed = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    const W = xs.W, H = xs.H;
    if (F.prev) {
      const p = F.prev;
      for (let y = 0; y < H; y++) {
        const row = y * W;
        for (let x = 0; x < W; x++) {
          if (fb[row + x] !== p[row + x]) {
            changed++;
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (y < y0) y0 = y; if (y > y1) y1 = y;
          }
        }
      }
    }
    F.prev = fb.slice();
    const bbox = x1 >= 0 ? (x1 - x0 + 1) * (y1 - y0 + 1) : 0;
    F.flush.push({ ms: +ms.toFixed(2), changed, bboxPct: +(bbox * 100 / (W * H)).toFixed(1),
                   chPct: +(changed * 100 / (W * H)).toFixed(2) });
    return fb;
  };
  const origPut = CanvasRenderingContext2D.prototype.putImageData;
  CanvasRenderingContext2D.prototype.putImageData = function (...a) {
    const t0 = performance.now();
    const r = origPut.apply(this, a);
    window.__fl.put.push(+(performance.now() - t0).toFixed(2));
    return r;
  };
  return 'wrapped';
})()`);

const _rect = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
const _sx = _rect.width / 1024;
const guest = (gx, gy) => [_rect.x + gx * _sx, _rect.y + gy * _sx];
const click = async (gx, gy) => { const [x,y] = guest(gx,gy);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); };
await click(424,383); await new Promise(r=>setTimeout(r,1200));
await click(452,422); await new Promise(r=>setTimeout(r,2500));
await click(587,526); await new Promise(r=>setTimeout(r,4000));
const report = async (label) => {
  const F = JSON.parse(await q('JSON.stringify({flush: window.__fl.flush, put: window.__fl.put})'));
  await q('window.__fl.flush = []; window.__fl.put = []');
  const med = (a) => a.slice().sort((x,y)=>x-y)[a.length>>1];
  const fms = F.flush.map(f=>f.ms), bb = F.flush.filter(f=>f.bboxPct>0).map(f=>f.bboxPct);
  console.log(`${label}: ${F.flush.length} flushes  flush ms med=${med(fms) ?? '-'} max=${Math.max(...fms).toFixed(1)}` +
              `  putImageData ms med=${med(F.put) ?? '-'} max=${F.put.length?Math.max(...F.put).toFixed(1):'-'}`);
  if (bb.length) console.log(`   damage bbox %: med=${med(bb)} max=${Math.max(...bb)}  ` +
              `changed-px %: med=${med(F.flush.filter(f=>f.chPct>0).map(f=>f.chPct))}`);
};
await report('menu (File>New>OK)');
for (let s = 0; s < 2; s++) {
  const y = 450 + s*8;
  const [x0,y0] = guest(480, y);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x:x0,y:y0});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:x0,y:y0,button:'left',buttons:1,clickCount:1});
  for (let i=1;i<=16;i++){ const [x,yy] = guest(480+i*8, y);
    await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y:yy,button:'left',buttons:1});
    await new Promise(r=>setTimeout(r,16)); }
  const [x1,y1] = guest(480+16*8, y);
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:x1,y:y1,button:'left',buttons:0,clickCount:1});
  await new Promise(r=>setTimeout(r,1200));
}
await report('two strokes');
chrome.kill(); process.exit(0);
