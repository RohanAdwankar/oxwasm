const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));
  await page.goto('file://' + process.argv[2]);
  const deadline = Date.now() + 240000;
  let last = '';
  while (Date.now() < deadline) {
    const t = await page.evaluate(() =>
      document.getElementById('screen_container').firstElementChild.textContent);
    if (t.trim() !== last.trim()) {
      last = t;
      const lines = t.split('\n').map(s => s.trimEnd()).filter(Boolean);
      console.log('--- screen @', Math.round((Date.now())/1000)%10000, 's ---');
      console.log(lines.slice(-6).join('\n'));
      if (/[/~] #/.test(t)) { console.log('*** SHELL PROMPT REACHED ***'); break; }
    }
    await page.waitForTimeout(3000);
  }
  const serial = await page.evaluate(() => window.__serial.slice(-800));
  console.log('=== serial tail ===\n' + serial);
  await page.screenshot({ path: 'boot.png' });
  await browser.close();
})();
