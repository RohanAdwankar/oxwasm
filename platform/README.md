# oxwasm platform — the M4 lane, running

The abstraction-layer thesis, reduced to its smallest working form:

```
$ ./cc.sh producer.c upper.c     # plain clang, no libc, no emscripten
built producer.wasm              # 393 bytes
built upper.wasm                 # 555 bytes
$ python3 mkdemo.py && python3 serve.py 8137
# open http://127.0.0.1:8137/pipe-demo.html
```

Two C programs written against a 3-call syscall ABI (`syscall.h`: read,
write, exit — imported from wasm module `"ox"`). The kernel (in the page)
spawns each as a **process = one Web Worker + one wasm instance**, wires
them with a **pipe = SharedArrayBuffer ring buffer**, and `producer |
upper` runs with *real blocking reads* — the reader parks on
`Atomics.wait` exactly like a process parks in `pipe_read` on any Unix.

The page shows a live process table (running / blocked(read) / exited) and
the pipeline's output. Verified in headless Chromium: both processes exit
0, output arrives uppercased.

SharedArrayBuffer requires cross-origin isolation; `serve.py` sends the
COOP/COEP headers. On static hosts, Netlify/Cloudflare `_headers` work;
GitHub Pages needs the coi-serviceworker shim.

## Why it matters

This is the seed of M4: the syscall surface grows (spawn, open/close over
OPFS, poll, a display protocol), the "programs" become real software
recompiled against the ABI, and the flagship apps get native-speed WASM
instead of emulation. Same kernel surface the M3 JIT will target from the
other side — run everything (M3), make it fast (M4).
