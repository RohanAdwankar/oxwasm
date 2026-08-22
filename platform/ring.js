// oxwasm platform — SharedArrayBuffer byte ring ("a pipe").
// Layout: Int32 header [head, tail, eof] at 0; data bytes from BYTE_OFF.
// Writers block when full, readers block when empty — real Unix pipe
// semantics, enforced with Atomics on the shared header.
const HDR_INTS = 4, BYTE_OFF = HDR_INTS * 4;

function makePipe(capacity = 4096) {
  return { sab: new SharedArrayBuffer(BYTE_OFF + capacity), capacity };
}

function pipeViews(pipe) {
  return {
    hdr: new Int32Array(pipe.sab, 0, HDR_INTS),
    data: new Uint8Array(pipe.sab, BYTE_OFF),
    cap: pipe.capacity
  };
}

// Blocking ops — call these only off the main thread (workers may wait).
function pipeWrite(v, bytes) {
  let written = 0;
  while (written < bytes.length) {
    let head = Atomics.load(v.hdr, 0), tail = Atomics.load(v.hdr, 1);
    let free = v.cap - (tail - head);
    if (free === 0) { Atomics.wait(v.hdr, 0, head); continue; }
    const n = Math.min(free, bytes.length - written);
    for (let i = 0; i < n; i++) v.data[(tail + i) % v.cap] = bytes[written + i];
    Atomics.add(v.hdr, 1, n); Atomics.notify(v.hdr, 1);
    written += n;
  }
  return written;
}

function pipeRead(v, out, max) {
  for (;;) {
    let head = Atomics.load(v.hdr, 0), tail = Atomics.load(v.hdr, 1);
    let avail = tail - head;
    if (avail === 0) {
      if (Atomics.load(v.hdr, 2)) return 0;          // EOF and drained
      Atomics.wait(v.hdr, 1, tail); continue;
    }
    const n = Math.min(avail, max);
    for (let i = 0; i < n; i++) out[i] = v.data[(head + i) % v.cap];
    Atomics.add(v.hdr, 0, n); Atomics.notify(v.hdr, 0);
    return n;
  }
}

function pipeCloseWrite(v) { Atomics.store(v.hdr, 2, 1); Atomics.notify(v.hdr, 1); }

if (typeof module !== "undefined") module.exports = { makePipe, pipeViews, pipeWrite, pipeRead, pipeCloseWrite };
