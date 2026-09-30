// Same workloads on oxwasm's SDK and on Pyodide, in one node process each.
//   node bench/sdk/vs-pyodide.mjs [path-to-pyodide-package]
import { Sandbox } from '../../sdk/index.mjs';
import { createRequire } from 'node:module';
const ms = (t) => Math.round(performance.now() - t);
const CODE = {
  'first cell': '1+1',
  'loop 2M adds': 's=0\nfor i in range(2000000): s+=i\ns',
  'string+dict work': 'd={}\nfor i in range(200000): d[str(i)]=i*2\nlen(d)',
  'sort 300k floats': 'import random\nr=random.Random(1)\na=[r.random() for _ in range(300000)]\na.sort()\na[0]',
};
const out = {};
{ // oxwasm
  const t0 = performance.now();
  const s = await Sandbox.create();
  out.oxwasm = { 'create (cache warm)': ms(t0) };
  for (let i = 0; i < 12; i++) await s.run('1');       // let the compiled tier settle: measured separately below
  for (const [k, c] of Object.entries(CODE)) { const t = performance.now(); await s.run(c); out.oxwasm[k] = ms(t); }
  const t = performance.now(); for (let i = 0; i < 50; i++) await s.run('1+1'); out.oxwasm['50 trivial cells (each)'] = +((performance.now() - t) / 50).toFixed(1);
  await s.close();
}
{ // pyodide
  const require = createRequire(import.meta.url);
  const dir = process.argv[2] || '/tmp/scratch';
  const { loadPyodide } = await import(dir + '/pyodide.mjs');
  const t0 = performance.now();
  const py = await loadPyodide();
  out.pyodide = { 'create (cache warm)': ms(t0) };
  for (const [k, c] of Object.entries(CODE)) { const t = performance.now(); py.runPython(c); out.pyodide[k] = ms(t); }
  const t = performance.now(); for (let i = 0; i < 50; i++) py.runPython('1+1'); out.pyodide['50 trivial cells (each)'] = +((performance.now() - t) / 50).toFixed(1);
}
console.log(JSON.stringify(out, null, 1));
