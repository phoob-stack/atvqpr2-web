// Drains the game's float32 stereo ring (WebAudioRing, src/web/web_host.h)
// in wasm memory. processorOptions: { buffer: the memory's SharedArrayBuffer,
// ring: its wasm address }. Counts each quantum in `heartbeat`, so the game
// side knows the worklet is alive and stops draining by wall clock.
//
// Once a second it posts { type: 'stats' } on its port: frames played, quanta
// that ran short of data (underruns, counted only once data has flowed), the
// ring fill seen at each quantum (min/avg/max frames: the queueing latency),
// and the RMS and peak of what it output. { type: 'capture', frames } on the
// port records the next `frames` output frames and posts them back as
// { type: 'capture', data: Float32Array (interleaved L R) } (the page's audio
// check; nothing leaves the page).
const W = { magic: 0, rate: 1, channels: 2, cap: 3, write: 4, read: 5, heartbeat: 6, underruns: 7 };

class RingPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const { buffer, ring } = opts.processorOptions;
    this.h = new Int32Array(buffer, ring, 8);
    this.cap = this.h[W.cap];
    this.data = new Float32Array(buffer, ring + 32, this.cap * 2);
    this.flowing = false;          // data has arrived at least once
    this.total = { frames: 0, quanta: 0, underruns: 0, short: 0 };
    this.resetSecond();
    this.cap_buf = null; this.cap_at = 0;
    this.port.onmessage = ({ data: m }) => {
      if (m.type === 'capture') { this.cap_buf = new Float32Array(m.frames * 2); this.cap_at = 0; }
    };
  }

  resetSecond() {
    this.sec = { quanta: 0, frames: 0, underruns: 0, fillMin: Infinity, fillMax: 0, fillSum: 0, sq: 0, peak: 0 };
  }

  process(inputs, outputs) {
    const out = outputs[0], L = out[0], R = out[1] ?? out[0], n = L.length, h = this.h;
    const r = Atomics.load(h, W.read), w = Atomics.load(h, W.write);
    const avail = (w - r) >>> 0, take = Math.min(n, avail);
    const s = this.sec;
    let sq = 0, peak = 0;
    for (let i = 0; i < take; i++) {
      const at = ((r + i) >>> 0) % this.cap * 2;
      const l = this.data[at], rr = this.data[at + 1];
      L[i] = l; R[i] = rr;
      sq += l * l + rr * rr;
      const a = Math.max(Math.abs(l), Math.abs(rr));
      if (a > peak) peak = a;
    }
    for (let i = take; i < n; i++) { L[i] = 0; R[i] = 0; }
    if (take) {
      this.flowing = true;
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
    if (take < n && this.flowing) {
      Atomics.add(h, W.underruns, 1);
      s.underruns++; this.total.underruns++;
      if (take) this.total.short++;
    }
    Atomics.add(h, W.heartbeat, 1);

    if (this.cap_buf) {
      const m = Math.min(n, (this.cap_buf.length >> 1) - this.cap_at);
      for (let i = 0; i < m; i++) { this.cap_buf[(this.cap_at + i) * 2] = L[i]; this.cap_buf[(this.cap_at + i) * 2 + 1] = R[i]; }
      this.cap_at += m;
      if (this.cap_at * 2 >= this.cap_buf.length) {
        this.port.postMessage({ type: 'capture', data: this.cap_buf }, [this.cap_buf.buffer]);
        this.cap_buf = null;
      }
    }

    s.quanta++; s.frames += take; s.sq += sq; if (peak > s.peak) s.peak = peak;
    s.fillSum += avail; if (avail < s.fillMin) s.fillMin = avail; if (avail > s.fillMax) s.fillMax = avail;
    this.total.quanta++; this.total.frames += take;
    if (s.quanta * n >= sampleRate) {
      this.port.postMessage({
        type: 'stats', t: currentTime, quanta: s.quanta, frames: s.frames, underruns: s.underruns,
        fill: { min: s.fillMin, avg: s.fillSum / s.quanta, max: s.fillMax },
        rms: Math.sqrt(s.sq / Math.max(1, 2 * s.frames)), peak: s.peak, total: { ...this.total },
      });
      this.resetSecond();
    }
    return true;
  }
}

registerProcessor('atv2-ring', RingPlayer);
