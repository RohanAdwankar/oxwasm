// Shared driver helpers for the M2 GIMP guest.
async function bootToGimp(page, url, log = console.log) {
  await page.goto('file://' + url, { timeout: 300000, waitUntil: 'domcontentloaded' });
  const t0 = Date.now();
  // Serial tells us when X is up; then give GIMP time to finish loading.
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(3000);
    const ser = await page.evaluate(() => window.__serial || '');
    if (/oxinit: X up/.test(ser)) break;
    if (/XORG FAILED|panic/.test(ser)) { log('BOOT FAILED'); log(ser.slice(-1500)); return false; }
  }
  log(`X up at ${Math.round((Date.now()-t0)/1000)}s; waiting for GIMP`);
  await page.waitForTimeout(150000);
  log(`GIMP assumed up at ${Math.round((Date.now()-t0)/1000)}s`);
  return true;
}
// vmmouse absolute positioning via the v86 bus: exact pixels, no accel.
async function mouse(page) {
  await page.evaluate(() => {
    window.__mouse = {
      abs: (x, y) => window.emulator.bus.send('mouse-absolute', [x, y, 1024, 768]),
      btn: (down) => window.emulator.bus.send('mouse-click', [down, false, false])
    };
  });
  const cur = { x: 512, y: 384 };
  return {
    cur,
    // glide in small steps so GIMP draws a continuous stroke
    goTo: async (x, y, delay = 20) => {
      const n = Math.max(2, Math.round(Math.hypot(x - cur.x, y - cur.y) / 8));
      for (let i = 1; i <= n; i++) {
        const px = Math.round(cur.x + (x - cur.x) * i / n);
        const py = Math.round(cur.y + (y - cur.y) * i / n);
        await page.evaluate(([a, b]) => window.__mouse.abs(a, b), [px, py]);
        await page.waitForTimeout(delay);
      }
      cur.x = x; cur.y = y;
    },
    down: async () => { await page.evaluate(() => window.__mouse.btn(true)); await page.waitForTimeout(200); },
    up: async () => { await page.evaluate(() => window.__mouse.btn(false)); await page.waitForTimeout(200); }
  };
}
module.exports = { bootToGimp, mouse };
