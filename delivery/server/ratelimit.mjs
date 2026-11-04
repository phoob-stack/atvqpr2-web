// ratelimit.mjs - a token bucket per client: `rate` requests per second on
// average, bursts up to `burst`. take(key) -> 0 (go) or ms until the next token.
export class RateLimiter {
  constructor({ rate = 50, burst = 200, now = () => performance.now() } = {}) {
    this.rate = rate; this.burst = burst; this.now = now;
    this.buckets = new Map();
    // Forget idle clients (a full bucket is the same as no bucket).
    this.timer = rate > 0 ? setInterval(() => this.sweep(), 30000) : null;
    this.timer?.unref?.();
  }
  take(key) {
    if (!(this.rate > 0)) return 0;
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) { b = { tokens: this.burst, at: t }; this.buckets.set(key, b); }
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.at) / 1000) * this.rate);
    b.at = t;
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil(((1 - b.tokens) / this.rate) * 1000);
  }
  sweep() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (b.tokens + ((t - b.at) / 1000) * this.rate >= this.burst) this.buckets.delete(k);
  }
  stop() { if (this.timer) clearInterval(this.timer); }
}
