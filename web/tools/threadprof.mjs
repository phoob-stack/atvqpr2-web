// Per-thread V8 CPU profile of the page and every Worker (each one host
// thread: guest threads, the pushbuffer walk, timers, I/O), as race.mjs
// --profile does, for the other tools (mp.mjs --cpuprof N).
//
//   const text = await profileThreads(b, secs, { keepDir, top: 14 });
//
// Self and inclusive time per function. "Idle" = (idle)/(program)/(root) at
// the top of the stack; waits inside wasm show as the C function that waits
// (memory.atomic.wait32 is an instruction).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function profileThreads(b, secs, { keepDir = null, top = 14, interval = 500 } = {}) {
  const sessions = new Map();          // sessionId -> { title, type }
  const off = b.on((m) => {
    if (m.method === 'Target.attachedToTarget')
      sessions.set(m.params.sessionId, { title: m.params.targetInfo.title, type: m.params.targetInfo.type, url: m.params.targetInfo.url });
  });
  await b.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await sleep(500);
  const all = [[undefined, { title: 'page main thread', type: 'page' }], ...sessions];
  for (const [sid] of all) {
    await b.send('Profiler.enable', {}, sid);
    await b.send('Profiler.setSamplingInterval', { interval }, sid);
  }
  await Promise.all(all.map(([sid]) => b.send('Profiler.start', {}, sid)));
  await sleep(secs * 1000);
  const profs = await Promise.all(all.map(([sid]) => b.send('Profiler.stop', {}, sid)));
  off();
  const reports = [];
  profs.forEach((r, i) => {
    const p = r.result?.profile;
    if (!p) return;
    const [, info] = all[i];
    if (keepDir) writeFileSync(join(keepDir, `thread-${i}.cpuprofile`), JSON.stringify(p));
    reports.push(summarize(p, `${i}: ${info.type} ${info.title ?? ''}`, top));
  });
  reports.sort((x, y) => y.busy - x.busy);
  return `profiled ${all.length} threads for ${secs} s\n` + reports.map((r) => r.text).join('\n');
}

export function summarize(p, title, k = 14) {
  const byId = new Map(p.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const self = new Map(), incl = new Map();
  let total = 0, idle = 0;
  const name = (n) => n.callFrame.functionName || `(anon ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber})`;
  p.samples.forEach((id, j) => {
    const dt = (p.timeDeltas[j + 1] ?? p.timeDeltas[j] ?? 0) / 1000;
    total += dt;
    const nm = name(byId.get(id));
    if (nm === '(idle)' || nm === '(program)' || nm === '(root)') idle += dt;
    self.set(nm, (self.get(nm) ?? 0) + dt);
    const seen = new Set();
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const xn = name(byId.get(x));
      if (seen.has(xn)) continue;
      seen.add(xn);
      incl.set(xn, (incl.get(xn) ?? 0) + dt);
    }
  });
  const list = (m) => [...m].sort((a, c) => c[1] - a[1]).slice(0, k)
    .map(([f, t]) => `    ${(100 * t / total).toFixed(1).padStart(5)}%  ${f}`).join('\n');
  return { busy: total - idle, text: `== thread ${title}: ${total.toFixed(0)} ms sampled, ${(100 * (total - idle) / Math.max(1, total)).toFixed(0)}% not idle\n` +
    `  self:\n${list(self)}\n  inclusive:\n${list(incl)}` };
}
