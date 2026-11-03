// Compile every .wgsl file in a folder with the local Edge/Chrome's WebGPU
// and build a pipeline for each against the shared layout.
//
//   node web/tools/validate-wgsl.mjs <dir with *.wgsl> [--show-browser]
//
// Exit 0 when every module compiles and pipelines; prints failures with the
// compiler's messages. Nothing is downloaded: the WebGPU implementation is
// the browser's own.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve, launch } from './cdp.mjs';

const dir = process.argv[2];
if (!dir) { console.error('usage: validate-wgsl.mjs <dir>'); process.exit(2); }
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const mods = readdirSync(dir).filter((f) => f.endsWith('.wgsl')).sort()
  .map((name) => ({ name, code: readFileSync(join(dir, name), 'utf8') }));

const srv = await serve({ '/': web });
const b = await launch(`${srv.url}/validate.html`, { headless: !process.argv.includes('--show-browser') });
let res;
try {
  res = await b.eval(`validate(${JSON.stringify(mods)})`);
} finally {
  await b.close(); srv.close();
}
const failed = res.results.filter((r) => r.ok === false || (r.ok && r.pipeline !== 'ok'));
const skipped = res.results.filter((r) => r.ok === null);
const warned = res.results.filter((r) => r.ok && r.messages.length);
console.log(`adapter: ${res.adapterName}; features: ${res.features.join(', ') || 'none'}`);
for (const r of failed) console.log(`FAIL ${r.name}\n  ${r.messages.join('\n  ')}\n  pipeline: ${r.pipeline}`);
for (const r of warned.slice(0, 5)) console.log(`warn ${r.name}: ${r.messages[0]}`);
const kinds = (pre) => res.results.filter((r) => r.name.startsWith(pre) && r.ok).length;
console.log(`${res.results.length} modules: ${res.results.length - failed.length - skipped.length} ok ` +
  `(vs ${kinds('vs_')}, ps ${kinds('ps_')}), ${failed.length} failed, ${skipped.length} skipped, ` +
  `${warned.length} with warnings`);
process.exit(failed.length ? 1 : 0);
