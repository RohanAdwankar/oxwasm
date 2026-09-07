// Pending-page stall test: on a slow link, click the instant the page says
// it's interactive — while the rom sidecar (file-clean library pages) is
// still streaming. The engine must stall-and-retry on guarded pages, never
// corrupt, and the menu must render once the bytes land.
//   node cdp_stall.mjs URL OUTPREFIX [MBPS] [RTT_MS]
import { spawn } from 'node:child_process';
import { chromePath } from './../chrome.mjs';
import { writeFileSync } from 'node:fs';

const [url, outPfx, mbpsS = '20', rttS = '20'] = process.argv.slice(2);
const mbps = +mbpsS, rtt = +rttS;
const PORT = 9347;
const profile = `/tmp/oxstall_${process.pid}`;
const chrome = spawn(chromePath(), ['--headless','--disable-gpu','--no-sandbox',
  `--remote-debugging-port=${PORT}`,`--user-data-dir=${profile}`,'--window-size=1100,900','about:blank'],{stdio:'ignore'});
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
await cmd('Page.navigate',{url});
for (let i=0;i<600;i++){ await new Promise(r=>setTimeout(r,100));
  if (await q('window.__oxReady===true')) break; }
const readyAt = await q('window.__oxPerf.ready');
const romDone0 = await q('window.__oxPerf.romDone');
console.log(`ready at ${readyAt|0}ms, rom done: ${romDone0===undefined?'still streaming':'already '+(romDone0|0)+'ms'}`);
// click File menu immediately — during the pending window on a slow link
{
  const r = JSON.parse(await q('JSON.stringify(document.getElementById("screen").getBoundingClientRect())'));
  const sx = r.width/1024, x = r.x+424*sx, y = r.y+383*sx;
  await cmd('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});
  await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',buttons:1,clickCount:1});
  await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',buttons:0,clickCount:1});
}
console.log('clicked at ready+0; waiting…');
await new Promise(r=>setTimeout(r,20000));
const s=await cmd('Page.captureScreenshot',{format:'png'});
writeFileSync(outPfx+'_stallmenu.png', Buffer.from(s.data,'base64'));
console.log('romDone:', await q('window.__oxPerf.romDone'), 'stat:', await q('document.getElementById("stat").textContent'));
chrome.kill(); process.exit(0);
