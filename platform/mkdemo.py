#!/usr/bin/env python3
"""Build pipe-demo.html — the M4 platform spike as one self-contained page.

Two freestanding C programs (compiled to wasm by cc.sh, no libc, no
emscripten) run as processes in workers, connected by kernel pipes:

    producer | upper  ->  console

Requires cross-origin isolation (COOP/COEP headers) for SharedArrayBuffer;
serve.py provides that locally.
"""
import base64, os

here = os.path.dirname(os.path.abspath(__file__))
read = lambda n: open(os.path.join(here, n)).read()
b64 = lambda n: base64.b64encode(open(os.path.join(here, n), 'rb').read()).decode()

worker_src = read('ring.js') + '\n' + read('proc-worker.js')

html = read('demo-template.html') \
    .replace('__RING_JS__', read('ring.js')) \
    .replace('__WORKER_B64__', base64.b64encode(worker_src.encode()).decode()) \
    .replace('__PRODUCER_B64__', b64('producer.wasm')) \
    .replace('__UPPER_B64__', b64('upper.wasm'))

out = os.path.join(here, 'pipe-demo.html')
open(out, 'w').write(html)
print(f"wrote {out} ({os.path.getsize(out)} bytes)")
