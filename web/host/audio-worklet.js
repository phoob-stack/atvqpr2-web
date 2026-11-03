// Drains the game's float32 stereo ring (WebAudioRing, src/web/web_host.h)
// in wasm memory. processorOptions: { buffer: the memory's SharedArrayBuffer,
// ring: its wasm address }. Counts each quantum in `heartbeat`, so the game
// side knows the worklet is alive and stops draining by wall clock.
const W = { magic: 0, rate: 1, channels: 2, cap: 3, write: 4, read: 5, heartbeat: 6, underruns: 7 };

class RingPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const { buffer, ring } = opts.processorOptions;
    this.h = new Int32Array(buffer, ring, 8);
    this.cap = this.h[W.cap];
    this.data = new Float32Array(buffer, ring + 32, this.cap * 2);
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0], n = L.length, h = this.h;
    const r = Atomics.load(h, W.read), w = Atomics.load(h, W.write);
    const avail = (w - r) >>> 0, take = Math.min(n, avail);
    for (let i = 0; i < take; i++) {
      const at = ((r + i) >>> 0) % this.cap * 2;
      L[i] = this.data[at]; R[i] = this.data[at + 1];
    }
    for (let i = take; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (take) {
      // The game side may have moved `read` by wall clock meanwhile: only
      // ever move it forward.
      let cur = r;
      for (;;) {
        const want = (r + take) | 0;
        if (((want - cur) | 0) <= 0) break;
        const prev = Atomics.compareExchange(h, W.read, cur, want);
        if (prev === cur) break;
        cur = prev;
      }
    }
    if (take < n && avail === 0) Atomics.add(h, W.underruns, 1);
    Atomics.add(h, W.heartbeat, 1);
    return true;
  }
}

registerProcessor('atv2-ring', RingPlayer);
