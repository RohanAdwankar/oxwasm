// Memory and throughput with many sandboxes alive at once.
//   node bench/sdk/concurrency.mjs [N ...]
import { Sandbox } from '../../sdk/index.mjs';
const rss = () => Math.round(process.memoryUsage().rss / 1048576);
const sizes = process.argv.slice(2).map(Number); if (!sizes.length) sizes.push(1, 4, 8, 16);
const base = rss();
console.log(`baseline rss ${base} MB`);
for (const n of sizes) {
  const t0 = performance.now();
  const boxes = await Promise.all(Array.from({ length: n }, () => Sandbox.create()));
  const tCreate = Math.round(performance.now() - t0);
  const t1 = performance.now();
  const r = await Promise.all(boxes.map((s, i) => s.run(`sum(range(${20000 + i}))`)));
  const tRun = Math.round(performance.now() - t1);
  const mem = rss();
  console.log(`n=${n}: create ${tCreate} ms, one cell each ${tRun} ms, rss ${mem} MB (${Math.round((mem - base) / n)} MB per sandbox)`);
  await Promise.all(boxes.map((s) => s.close()));
  await new Promise((r) => setTimeout(r, 500));
  console.log(`   after close rss ${rss()} MB`);
}
process.exit(0);
