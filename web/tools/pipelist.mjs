// The render pipelines a run created (encoder.js exportPipelines), merged
// into a list the page creates ahead of time at the next boot
// (preloadPipelines): build-wasm/pipelines.json by default, served as
// /wasm/pipelines.json beside the module. It holds the run's WGSL (generated
// from the game's shaders), so like the module it stays out of git.
//
//   await savePipelines(b, file)   // b: cdp.mjs browser on the page
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const keyOf = (sp) => [sp.vs, sp.ps, sp.kind, sp.cube, sp.stride, sp.inputs, sp.writeMask,
  sp.blend ? sp.blend.join(',') : '-', sp.ds ? sp.ds.join(',') : '-', sp.sten ? sp.sten.join(',') : '-'].join('|');

export async function savePipelines(b, file) {
  const run = await b.eval('atv.presenter?.enc?.exportPipelines?.() ?? null');
  if (!run) return 'no pipeline list (old encoder?)';
  let list = null;
  if (existsSync(file)) {
    try { list = JSON.parse(readFileSync(file, 'utf8')); } catch { list = null; }
  }
  if (!list || list.version !== run.version || list.msaa !== run.msaa || list.dsFormat !== run.dsFormat)
    list = { version: run.version, msaa: run.msaa, dsFormat: run.dsFormat, shaders: {}, pipes: [] };
  const have = new Set(list.pipes.map(keyOf));
  let added = 0;
  for (const sp of run.pipes) {
    if (have.has(keyOf(sp))) continue;
    have.add(keyOf(sp));
    list.pipes.push(sp);
    for (const h of [sp.vs, sp.ps]) if (run.shaders[h]) list.shaders[h] = run.shaders[h];
    added++;
  }
  writeFileSync(file, JSON.stringify(list));
  return `${run.pipes.length} pipelines this run, ${added} new; ${list.pipes.length} in ${file}`;
}
