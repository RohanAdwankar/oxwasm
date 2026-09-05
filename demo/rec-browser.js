// Record the browser side: white marker page -> navigate to gimp.html ->
// GIMP visible. The white->dark transition marks the launch instant.
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({executablePath:'/opt/pw-browsers/chromium'});
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 },
    recordVideo: { dir: 'video-demo', size: { width: 1100, height: 850 } } });
  const page = await ctx.newPage();
  await page.setContent('<body style="background:#fff"></body>');   // white marker
  await page.waitForTimeout(1500);
  const t0 = Date.now();
  await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
  let up = null;
  for (let i = 0; i < 200 && !up; i++) {
    await page.waitForTimeout(100);
    const lum = await page.evaluate(() => { const c = document.querySelector('#screen_container canvas');
      if (!c || !c.width) return -1; const g = c.getContext('2d'); if (!g) return -1;
      const d = g.getImageData(0,0,c.width,c.height).data; let s=0,n=0;
      for (let x=0;x<d.length;x+=4*97){s+=d[x];n++;} return s/n; });
    if (lum > 120) up = ((Date.now()-t0)/1000).toFixed(2);
  }
  console.log('VISIBLE_SECONDS=' + up);
  await page.waitForTimeout(3500);
  await ctx.close();
  console.log('VIDEO=' + await page.video().path());
  await browser.close();
})();
