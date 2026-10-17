Prices the guest indirect-jump protocol in isolation (no engine, no cache). A chain of 64 tiny handlers dispatches 100M times
on a repeating 24-entry pattern (a random stream is misprediction-bound and hides the differences).
  node gen.mjs && node gen2.mjs
  for v in full min params sw; do wat2wasm --enable-tail-call $v.wat -o $v.wasm; done   # sw needs no flag
  node run.mjs
full   = current emitted protocol: spill 5 regs, depth counter, fuel, hash probe, guard, return_call_indirect
min    = spill 5 regs + return_call_indirect
params = registers passed as wasm params on the tail call
sw     = one function, loop + br_table, registers in locals (the mega-unit shape)
gen3.mjs/runbig.mjs: one br_table dispatcher with N cases (node gen3.mjs <cases> <locals> <body ops>; wat2wasm big.wat -o big.wasm; node runbig.mjs)
