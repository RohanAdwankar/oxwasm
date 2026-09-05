#!/usr/bin/env python3
"""Build imgops-demo.html: the wasm resampler doing a big bicubic resample
(2048x2048 -> 8192x8192) live in the page, with timer and checksum."""
import base64, os
here = os.path.dirname(os.path.abspath(__file__))
wasm = base64.b64encode(open(os.path.join(here, 'resample-relaxed.wasm'), 'rb').read()).decode()
html = open(os.path.join(here, 'demo-template.html')).read().replace('__WASM_B64__', wasm)
open(os.path.join(here, 'imgops-demo.html'), 'w').write(html)
print('wrote imgops-demo.html (%d bytes)' % os.path.getsize(os.path.join(here, 'imgops-demo.html')))
