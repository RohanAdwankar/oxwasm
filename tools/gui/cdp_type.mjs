// Type text into the packed leafpad page with native CDP key events.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const page = process.argv[2], out = process.argv[3];
const chrome = spawn('/opt/pw-browsers/chromium', ['--headless','--disable-gpu','--no-sandbox','--remote-debugging-port=9336','--window-size=800,700','about:blank'],{stdio:'ignore'});
await new Promise(r=>setTimeout(r,2500));
const list = await (await fetch('http://127.0.0.1:9336/json')).json();
const ws = new WebSocket(list[0].webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0; const waiting=new Map();
ws.onmessage=(ev)=>{const m=JSON.parse(ev.data); if(m.id&&waiting.has(m.id)){waiting.get(m.id)(m.result);waiting.delete(m.id);}};
const cmd=(m2,p={})=>new Promise(res=>{const i=++id;waiting.set(i,res);ws.send(JSON.stringify({id:i,method:m2,params:p}))});
await cmd('Page.enable'); await cmd('Runtime.enable');
await cmd('Page.navigate',{url:'file://'+page});
for (let i=0;i<60;i++){ await new Promise(r=>setTimeout(r,1000));
  if ((await cmd('Runtime.evaluate',{expression:'window.__oxReady===true'})).result.value) break; }
await new Promise(r=>setTimeout(r,3000));
// click into the text area (canvas center)
const box=JSON.parse((await cmd('Runtime.evaluate',{expression:'JSON.stringify(document.getElementById("screen").getBoundingClientRect())'})).result.value);
const cx=box.x+box.width/2, cy=box.y+box.height/2;
await cmd('Input.dispatchMouseEvent',{type:'mousePressed',x:cx,y:cy,button:'left',buttons:1,clickCount:1});
await cmd('Input.dispatchMouseEvent',{type:'mouseReleased',x:cx,y:cy,button:'left',buttons:0,clickCount:1});
await new Promise(r=>setTimeout(r,3000));
for (const code of ['KeyH','KeyE','KeyL','KeyL','KeyO','Space','KeyO','KeyX','KeyW','KeyA','KeyS','KeyM']) {
  await cmd('Input.dispatchKeyEvent',{type:'keyDown',code, key:'x', windowsVirtualKeyCode:88});
  await cmd('Input.dispatchKeyEvent',{type:'keyUp',code, key:'x', windowsVirtualKeyCode:88});
  await new Promise(r=>setTimeout(r,700));
}
await new Promise(r=>setTimeout(r,8000));
console.log('stat:', (await cmd('Runtime.evaluate',{expression:'document.getElementById("stat").textContent'})).result.value);
const shot = await cmd('Page.captureScreenshot',{format:'png'});
writeFileSync(out, Buffer.from(shot.data,'base64'));
console.log('saved', out);
chrome.kill(); process.exit(0);
