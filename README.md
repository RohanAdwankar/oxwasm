# oxwasm

oxwasm is an in process wasm sandbox, so no VM, no container, no cloud, no per-second bill.

```js
import { Sandbox } from 'oxwasm'

const s = await Sandbox.create()          // ~2 s, from a snapshot

await s.run('x = 10')
await s.run('print(x * 5)')
await s.sh('ls /')

await s.files.write('/work/data.csv', csv)
await s.run('import csv; ...')

await s.close()
```

The guest is executing inside a WebAssembly engine, in a worker thread of your own Node process. 
In the past the issue with wasm sandboxes is that they weren't capability complete with a typical linux sanbox, oxwasm's ambitious goal is to close that gap.

To try out the shell go the static site: https://rohanadwankar.github.io/oxwasm/shell/

## Linux programs as one HTML file

```
$ ./fetch-runtime.sh
$ ./pack-app.sh examples/gimp.app  -o gimp.html
$ open gimp.html
```
To try out the resulting file go the static site: https://rohanadwankar.github.io/oxwasm/gimp/
