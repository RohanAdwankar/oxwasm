// Boot the guest, wait until the app is fully up, then snapshot the machine
// (v86 save_state) and stream it out to a file. This state is what makes
// the shipped HTML restore-to-ready instead of boot-from-scratch.
const { chromium } = require('playwright');
const fs = require('fs');
(async () => {
  const url = process.argv[2], outFile = process.argv[3];
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM || undefined});
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  const t0 = Date.now();
  await page.goto('file://' + url, { timeout: 300000, waitUntil: 'domcontentloaded' });
  let xUp = false, appUp = false;
  for (let i = 0; i < 220 && !appUp; i++) {
    await page.waitForTimeout(1500);
    const ser = await page.evaluate(() => window.__serial || '');
    if (!xUp && /oxinit: X up/.test(ser)) { xUp = true; }
    if (xUp) {
      const lum = await page.evaluate(() => {
        const c = document.querySelector('#screen_container canvas');
        if (!c || !c.width) return 0;
        const g = c.getContext('2d'); if (!g) return 0;
        const d = g.getImageData(0, 0, c.width, c.height).data;
        let s = 0, n = 0; for (let p = 0; p < d.length; p += 4*97) { s += d[p]; n++; }
        return s / n;
      });
      if (lum > 120) appUp = true;
    }
  }
  if (!appUp) { console.log('APP NEVER CAME UP'); await browser.close(); process.exit(1); }
  console.log(`app up at ${((Date.now()-t0)/1000).toFixed(1)}s; letting it settle`);
  await page.waitForTimeout(8000);   // let GIMP finish idle work before freezing

  // save_state -> stash on window, then read out in chunks
  const len = await page.evaluate(async () => {
    const buf = await window.emulator.save_state();
    window.__state = new Uint8Array(buf);
    return window.__state.length;
  });
  console.log(`state size: ${(len/1e6).toFixed(1)} MB, streaming out`);
  const fd = fs.openSync(outFile, 'w');
  const CHUNK = 4 * 1024 * 1024;
  for (let off = 0; off < len; off += CHUNK) {
    const b64 = await page.evaluate(([o, c]) => {
      let s = '', a = window.__state.subarray(o, o + c);
      for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
      return btoa(s);
    }, [off, CHUNK]);
    fs.writeSync(fd, Buffer.from(b64, 'base64'));
  }
  fs.closeSync(fd);
  console.log('wrote', outFile);
  await browser.close();
})();
