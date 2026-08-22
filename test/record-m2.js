// The M2 money shot: open gimp.html, watch it boot, then DRAW in GIMP.
// All coordinates are GUEST pixels (1024x768).
const { chromium } = require('playwright');
const { bootToGimp, mouse } = require('./m2drive');
(async () => {
  const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
  const ctx = await browser.newContext({
    viewport: { width: 1100, height: 850 },
    recordVideo: { dir: 'video-m2', size: { width: 1100, height: 850 } }
  });
  const page = await ctx.newPage();
  if (!await bootToGimp(page, process.argv[2])) process.exit(1);
  const m = await mouse(page);
  const click = async (x, y) => { await m.goTo(x, y); await m.down(); await m.up(); };

  await page.click('#screen_container');
  await click(22, 27);                      // File menu — a real GTK menu, on video
  await page.waitForTimeout(4000);
  await page.screenshot({ path: 'r1-menu.png' });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);

  await page.keyboard.press('Control+n');   // File > New
  await page.waitForTimeout(9000);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(16000);
  await page.keyboard.press('p');           // paintbrush
  await page.waitForTimeout(2500);
  await page.screenshot({ path: 'r2-canvas.png' });

  // dwell at each waypoint: the guest is slow, and X compresses motion
  // events for slow clients — sampling beats streaming here.
  // GIMP under emulation reliably paints press->release interpolation,
  // so curves are chained short segments — like sketching.
  const seg = async (a, b) => {
    await m.goTo(a[0], a[1], 25); await page.waitForTimeout(250);
    await m.down(); await page.waitForTimeout(250);
    await m.goTo(b[0], b[1], 25); await page.waitForTimeout(350);
    await m.up(); await page.waitForTimeout(350);
  };
  await seg([450,300],[452,318]);           // left eye
  await seg([570,300],[572,318]);           // right eye
  const arc = [];
  for (let t = 0; t <= 8; t++) {
    const a = Math.PI * (0.12 + 0.76 * t / 8);
    arc.push([Math.round(510 - 115 * Math.cos(a)), Math.round(330 + 100 * Math.sin(a))]);
  }
  for (let t = 0; t < 8; t++) await seg(arc[t], arc[t+1]);   // the smile
  await page.waitForTimeout(3000);
  await page.screenshot({ path: 'r3-drawn.png' });
  await page.waitForTimeout(2000);
  await ctx.close();
  console.log('VIDEO:', await page.video().path());
  await browser.close();
})();
