// Drives site/index.html in headless Chromium: types commands, reads the terminal.
// Needs playwright-core (npm i -D playwright-core) and a Chromium (OXWASM_CHROME or /opt/pw-browsers/chromium).
//   node tools/shellpage-test.mjs $PWD/site/index.html
import { chromium } from 'playwright-core';
const page_path = process.argv[2];
const browser = await chromium.launch({ executablePath: process.env.OXWASM_CHROME || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
const errs = []; page.on('pageerror', (e) => errs.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('file://' + page_path);
const screen = () => page.evaluate(() => { const t = document.querySelector('.xterm-rows'); return t ? t.innerText : ''; });
const until = async (re, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const s = await screen(); if (re.test(s)) return s; await page.waitForTimeout(150); } return await screen(); };
let s = await until(/oxwasm:~# /);
console.log('--- banner/prompt ---\n' + s.trim().split('\n').slice(0, 12).join('\n'));
const promptCount = (t) => (t.match(/oxwasm:~# /g) || []).length;
const run = async (cmd, wait) => {
  const before = promptCount(await screen());
  await page.keyboard.type(cmd); await page.keyboard.press('Enter');
  const t = Date.now(); let cur = await screen();
  while (Date.now() - t < 60000 && !(promptCount(cur) > before && /oxwasm:~# \s*$/.test(cur.trimEnd() + ' '))) { await page.waitForTimeout(150); cur = await screen(); }
  return cur;
};
const results = [];
for (const [cmd, want] of [['echo hi $((6*7))', /hi 42/], ['ls /bin | wc -l', /272/], ['cat hello.txt', /hello from a file inside/], ['sh primes.sh', /2 3 5 7 11 13 17 19 23 29 31 37/], ["seq 1 100 | awk '{s+=$1} END {print s}'", /5050/], ['tty; stty size', /\/dev\/pts|not a tty/], ['echo fruit > f.txt; echo apple >> f.txt; sort f.txt | head -1', /apple/], ['mkdir -p d/e && cd d/e && pwd && cd', /\/root\/d\/e/]]) {
  const s = await run(cmd);
  const ok = want.test(s); results.push(ok);
  console.log((ok ? 'ok   ' : 'FAIL ') + cmd);
  if (!ok) console.log(s.trim().split('\n').slice(-8).join('\n'));
}
console.log('page errors:', errs.length ? errs.join(' | ') : 'none');
await page.screenshot({ path: '/tmp/oxwasm-shell.png' });
await browser.close();
process.exit(results.every(Boolean) && !errs.length ? 0 : 1);
