// Where the time in a runtime tier-up actually goes, measured in the browser.
//
// The page compiles units at runtime: compileUnitWat emits WAT text,
// eng.assembleWat runs wabt.js on it, and (asyncCompile) WebAssembly
// instantiates off-thread. Only the first two are on the critical path, and
// eng.tierMsMax is supposed to bound them - but it is a PRE-check
// (`if (tierMs >= tierMsMax) return`), so a single expensive unit overshoots
// the budget by however long it takes and janks the frame it lands in. The
// budget can only stop the NEXT unit.
//
// This wraps tierUpAot and assembleWat in the page and reports the per-unit
// distribution, so "tier-up is slow" can be replaced by a number and a split.
//   node cdp_tier.mjs URL
import { spawn } from 'node:child_process';
import { chromePath } from './../chrome.mjs';

const url = process.argv[2];
const PORT = 9375;
const chrome = spawn(chromePath(), ['--headless','--disable-gpu','--no-sandbox',
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
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;
// wabt is fetched after the page is interactive; without it cacheOnly stays
// true and nothing tiers up, so measuring before it lands measures nothing
for (let i=0;i<150;i++){ await new Promise(r=>setTimeout(r,200));
  if (await q('window.__ox && window.__ox.eng && window.__ox.eng.cacheOnly === false')) break; }
const asyncAsm = await q('!!(window.__ox.eng.assembleWatAsync)');
console.log('wabt ready, cacheOnly =', await q('window.__ox.eng.cacheOnly'),
            '| assembler:', asyncAsm ? 'WORKER (off main thread)' : 'main thread');

// Wrap in the page. assembleWat is a plain property; tierUpAot is a method,
// so an own-property wrapper shadows the prototype's without patching it.
await q(`(() => {
  const eng = window.__ox.eng;
  window.__tier = [];
  let asmMs = 0, watLen = 0;
  const origAsm = eng.assembleWat;
  eng.assembleWat = function (wat) {
    watLen = wat.length; const t = performance.now();
    try { return origAsm.call(this, wat); } finally { asmMs = performance.now() - t; }
  };
  // With a worker the handoff is what the main thread pays; the parse itself
  // is off-thread and correctly does NOT belong in the on-thread total.
  const origAsync = eng.assembleWatAsync;
  if (origAsync) eng.assembleWatAsync = function (wat) {
    watLen = wat.length; const t = performance.now();
    try { return origAsync.call(this, wat); } finally { asmMs = performance.now() - t; }
  };
  const origTier = eng.tierUpAot;
  eng.tierUpAot = function (entry) {
    asmMs = 0; watLen = 0;
    const t = performance.now();
    try { return origTier.call(this, entry); }
    finally { const tot = performance.now() - t;
      window.__tier.push({ tot, asm: asmMs, wat: watLen, budget: eng.tierMsMax }); }
  };
  return 'wrapped';
})()`);
console.log('instrumented');

const _rect = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
const _sx = _rect.width / 1024;
const guest = (gx, gy) => [_rect.x + gx * _sx, _rect.y + gy * _sx];
const click = async (gx, gy) => { const [x,y] = guest(gx,gy);
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1}); };

const report = async (label) => {
  const rows = await q('JSON.stringify(window.__tier)');
  const t = JSON.parse(rows); await q('window.__tier = []');
  if (!t.length) { console.log(`\n${label}: no tier-ups`); return; }
  const tot = t.map(r=>r.tot).sort((a,b)=>a-b);
  const sum = (a) => a.reduce((x,y)=>x+y,0);
  const p = (a,f) => a[Math.min(a.length-1, Math.floor(a.length*f))];
  const sumTot = sum(t.map(r=>r.tot)), sumAsm = sum(t.map(r=>r.asm));
  console.log(`\n${label}: ${t.length} units, ${sumTot.toFixed(0)}ms total sync tier work`);
  const asmLabel = asyncAsm ? 'handoff to worker' : 'assemble (wabt.js)';
  console.log(`  emit (compileUnitWat) ${(sumTot-sumAsm).toFixed(0)}ms (${(100*(sumTot-sumAsm)/sumTot).toFixed(0)}%)` +
              ` | ${asmLabel} ${sumAsm.toFixed(0)}ms (${(100*sumAsm/sumTot).toFixed(0)}%)`);
  console.log(`  per unit ms: median ${p(tot,0.5).toFixed(1)}  p90 ${p(tot,0.9).toFixed(1)}  max ${tot[tot.length-1].toFixed(1)}`);
  console.log(`  WAT emitted: ${(sum(t.map(r=>r.wat))/1e6).toFixed(1)} MB, largest ${(Math.max(...t.map(r=>r.wat))/1e6).toFixed(2)} MB`);
  const over = t.filter(r => r.tot > r.budget);
  console.log(`  units that overshot tierMsMax: ${over.length}/${t.length}` +
              (over.length ? `, worst ${Math.max(...over.map(r=>r.tot)).toFixed(0)}ms against a ${over[0].budget}ms budget` : ''));
};

await click(424,383); await new Promise(r=>setTimeout(r,1200));   // File
await click(452,422); await new Promise(r=>setTimeout(r,2500));   // New...
await click(587,526); await new Promise(r=>setTimeout(r,4000));   // OK
await report('File>New>OK');

// a drag: tierMsMax drops to 2ms while the pointer is down
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
  await new Promise(r=>setTimeout(r,1500));
}
await report('two paint strokes');

console.log('\nstat:', await q('document.getElementById("stat").textContent'));
chrome.kill(); process.exit(0);
