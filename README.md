# oxwasm

> [!NOTE]
> This project is a bit of an experiment. Currently the latency is not in close parity with other sandboxes and the scope of linux programs which can be run is limited. The eventual goal is to reach within a stone's throw of performance while carrying over the ease of use.

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

## Linux programs as one HTML file

```
$ ./fetch-runtime.sh
$ ./pack-app.sh examples/gimp.app  -o gimp.html
$ open gimp.html
```
