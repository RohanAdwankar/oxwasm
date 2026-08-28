// Load-time measurement for a sidecar page under network throttling.
//   node cdp_load.mjs URL OUTPREFIX MBPS RTT_MS
// Prints the page's __oxPerf milestones (ms since navigation) for a cold
// visit, clicks the File menu and screenshots as interactivity proof, then
// navigates again in the same profile for the repeat (warm-cache) visit.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const [url, outPfx, mbpsS = '100', rttS = '20'] = process.argv.slice(2);
const mbps = +mbpsS, rtt = +rttS;
const PORT = 9345;
const profile = `/tmp/oxprof_${process.pid}`;
const chrome = spawn('/opt/pw-browsers/chromium', ['--headless','--disable-gpu','--no-sandbox',
  `--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--disk-cache-size=1073741824',
  '--window-size=1100,900','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const waiting=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m.result);waiting.delete(m.id);}};
const cmd=(m2,p={})=>new Promise(res=>{const i=++id;waiting.set(i,res);ws.send(JSON.stringify({id:i,method:m2,params:p}))});
await cmd('Page.enable'); await cmd('Runtime.enable'); await cmd('Network.enable');
await cmd('Network.emulateNetworkConditions',{offline:false,latency:rtt,
  downloadThroughput:mbps*125000,uploadThroughput:mbps*125000});
const q=async(e)=>(await cmd('Runtime.evaluate',{expression:e,returnByValue:true})).result.value;

const visit = async (label) => {
  await cmd('Page.navigate',{url});
  for (let i=0;i<600;i++){ await new Promise(r=>setTimeout(r,200));
    if (await q('window.__oxReady===true')) break; }
  // give the deferred units fetch a moment to land, then read all milestones
  for (let i=0;i<150;i++){ await new Promise(r=>setTimeout(r,200));
    if (await q('window.__oxPerf&&window.__oxPerf.unitsApplied!==undefined')) break; }
  const perf = await q('JSON.stringify(window.__oxPerf)');
  console.log(`${label} @ ${mbps}Mbps/${rtt}ms:`, perf);
  console.log(' resources:', await q(`JSON.stringify(performance.getEntriesByType('resource')
    .filter(r=>r.name.includes('app.'))
    .map(r=>({n:r.name.split('/').pop(),start:r.startTime|0,end:r.responseEnd|0,xfer:r.transferSize})))`));
  return JSON.parse(perf);
};

await visit('cold');
// interactivity proof: open the File menu with a native click, screenshot
{
  const r = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
  const sx = r.width/1024, x = r.x+424*sx, y = r.y+383*sx;
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
  await new Promise(r2=>setTimeout(r2,10000));
  const s=await cmd('Page.captureScreenshot',{format:'png'});
  writeFileSync(outPfx+'_menu.png', Buffer.from(s.data,'base64'));
  console.log('menu:', await q('document.getElementById("stat").textContent'));
}
await visit('repeat');
chrome.kill(); process.exit(0);
