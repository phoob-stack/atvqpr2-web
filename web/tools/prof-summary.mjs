// Summarize a V8 .cpuprofile (race.mjs --keep-profiles): self and inclusive
// time per function, and optionally the callers of one function.
//
//   node web/tools/prof-summary.mjs <file.cpuprofile> [top=25] [--callers NAME] [--callees NAME]
import { readFileSync } from 'node:fs';

const [file, topArg] = process.argv.slice(2);
const opt = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
const top = Number(/^\d+$/.test(topArg ?? '') ? topArg : 25);
const p = JSON.parse(readFileSync(file, 'utf8'));
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (id) => byId.get(id).callFrame.functionName || '(anon)';
const self = new Map(), incl = new Map(), callers = new Map(), callees = new Map();
const wantCallers = opt('--callers'), wantCallees = opt('--callees');
let total = 0;
p.samples.forEach((id, k) => {
  const dt = (p.timeDeltas[k + 1] ?? 0) / 1000;
  total += dt;
  self.set(name(id), (self.get(name(id)) ?? 0) + dt);
  const seen = new Set();
  let child = null;
  for (let x = id; x !== undefined; child = x, x = parent.get(x)) {
    const nm = name(x);
    if (nm === wantCallers && parent.get(x) !== undefined) {
      const c = name(parent.get(x));
      callers.set(c, (callers.get(c) ?? 0) + dt);
    }
    if (nm === wantCallees && child !== null) {
      const c = name(child);
      callees.set(c, (callees.get(c) ?? 0) + dt);
    }
    if (seen.has(nm)) continue;
    seen.add(nm);
    incl.set(nm, (incl.get(nm) ?? 0) + dt);
  }
});
const list = (m, k) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k)
  .map(([f, t]) => `  ${(100 * t / total).toFixed(1).padStart(5)}%  ${t.toFixed(0).padStart(6)} ms  ${f}`).join('\n');
console.log(`${file}: ${total.toFixed(0)} ms`);
console.log(`self:\n${list(self, top)}\ninclusive:\n${list(incl, top)}`);
if (wantCallers) console.log(`callers of ${wantCallers}:\n${list(callers, top)}`);
if (wantCallees) console.log(`callees of ${wantCallees} (self time included as itself is not listed):\n${list(callees, top)}`);
