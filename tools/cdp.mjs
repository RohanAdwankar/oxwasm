// Drive a headless Chromium over the DevTools protocol: launch it, attach,
// evaluate expressions in a page. Shared by the CI gate (pagerun.mjs) and the
// browser benchmark (bench/vspage.mjs) so there is one place that knows how to
// find a browser and how to wait for it, rather than two that drift.
import { spawn } from 'node:child_process';
import { chromePath } from './chrome.mjs';

// Launch a browser and attach to its first target. Rejects with a message
// that names the binary and says whether it exited, because "no browser
// (fetch failed)" says nothing about why.
export async function openBrowser() {
  const port = 9600 + Math.floor(Math.random() * 400);
  // --disable-dev-shm-usage: a CI runner's /dev/shm is small and Chrome dies
  // on it. stderr is kept, not discarded, so a launch failure can be read.
  let cerr = '';
  const chrome = spawn(chromePath(), ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
    `--remote-debugging-port=${port}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  chrome.stderr.on('data', d => { cerr += d; });
  let cexit = null; chrome.on('exit', (c) => { cexit = c; });
  const kill = () => { try { chrome.kill('SIGKILL'); } catch {} };

  // The debugger port is up when /json answers. One fixed sleep was enough on
  // a developer's machine and not on a cold runner, so poll for it.
  let list = null;
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (cexit !== null) break;
    try { const r = await fetch(`http://127.0.0.1:${port}/json`); if (r.ok) { list = await r.json(); if (list.length) break; } } catch {}
  }
  if (!list || !list.length) {
    kill();
    throw new Error(`no browser at ${chromePath()} (${cexit !== null ? `exited ${cexit}` : 'debugger port never answered'})` +
                    (cerr.trim() ? `\n  ${cerr.trim().split('\n').slice(-4).join('\n  ')}` : ''));
  }
  let ws;
  try {
    ws = new WebSocket(list[0].webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  } catch (e) { kill(); throw new Error(`browser found but would not attach (${e.message})`); }

  let id = 0; const waiting = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); } };
  const cmd = (method, params = {}) => new Promise(res => { const i = ++id; waiting.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  await cmd('Page.enable'); await cmd('Runtime.enable');
  return {
    // evaluate an expression in the page and return its value
    q: async (e) => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true })).result.value,
    navigate: (url) => cmd('Page.navigate', { url }),
    close: () => { try { ws.close(); } catch {} kill(); },
  };
}

// Poll a page for `window.__oxExit`, the signal m3pack's page sets when the
// guest exits. Returns null on timeout rather than throwing, so the caller can
// read the status line to explain it. Polling beats a fixed sleep either way:
// a fixed sleep flakes on a slow tier-up and wastes a minute on a fast one.
export async function waitForExit(q, timeoutS) {
  for (let i = 0; i < timeoutS * 2; i++) {
    await new Promise(r => setTimeout(r, 500));
    const v = await q('typeof window.__oxExit === "number" ? window.__oxExit : null');
    if (typeof v === 'number') return v;
  }
  return null;
}
