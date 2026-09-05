// oxwasm platform — a process. One worker, one wasm module, a syscall
// table imported from module "ox". The program blocks on read like any
// process on any Unix; Atomics.wait makes that real in a browser.
onmessage = async (e) => {
  const { wasmBytes, stdin, stdout, pid } = e.data;
  const IN = stdin ? pipeViews(stdin) : null;
  const OUT = stdout ? pipeViews(stdout) : null;
  let mem;
  const imports = { ox: {
    read: (fd, ptr, len) => {
      if (fd !== 0 || !IN) return -1;
      postMessage({ pid, state: "blocked(read)" });
      const n = pipeRead(IN, new Uint8Array(mem.buffer, ptr, len), len);
      postMessage({ pid, state: "running" });
      return n;
    },
    write: (fd, ptr, len) => {
      if (fd !== 1 || !OUT) return -1;
      return pipeWrite(OUT, new Uint8Array(mem.buffer, ptr, len));
    },
    exit: (code) => {
      if (OUT) pipeCloseWrite(OUT);
      postMessage({ pid, state: "exited(" + code + ")" });
      close();
    }
  }};
  const { instance } = await WebAssembly.instantiate(wasmBytes, imports);
  mem = instance.exports.memory;
  postMessage({ pid, state: "running" });
  try { instance.exports._start(); } catch (err) {
    postMessage({ pid, state: "fault: " + err.message });
  }
};
