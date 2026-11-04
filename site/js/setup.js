// Setup page: the Play panel and a check of what this browser offers.
import { $, h, initChrome, initPlayBox, playBoxMarkup } from './common.js';
import { loadConfig, launchUrl } from './config-model.js';

initChrome();
const box = $('playbox');
box.innerHTML = playBoxMarkup();
initPlayBox(box, { launchUrl: () => { const c = loadConfig(); return launchUrl(c.values, c.launch); } });

async function browserCheck() {
  const out = $('browser-check');
  const rows = [];
  let gpu = 'no';
  if ('gpu' in navigator) {
    try { gpu = (await navigator.gpu.requestAdapter()) ? 'yes' : 'present, but no adapter (check hardware acceleration)'; }
    catch { gpu = 'present, but it failed'; }
  }
  const ua = navigator.userAgentData?.brands?.map((b) => b.brand).filter((b) => !/Not.?A.?Brand/i.test(b)).join(', ') || navigator.userAgent.split(' ').at(-1);
  rows.push(['Browser', ua]);
  rows.push(['WebGPU', gpu]);
  rows.push(['WebAssembly threads', typeof SharedArrayBuffer === 'function' || 'Atomics' in globalThis ? 'supported' : 'no']);
  rows.push(['Folder picker', 'showDirectoryPicker' in window ? 'yes' : 'no (a file list is used instead)']);
  rows.push(['Gamepad API', 'getGamepads' in navigator ? 'yes' : 'no']);
  out.textContent = '';
  out.append(h('dl', { class: 'facts' }, rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
  out.dataset.webgpu = gpu === 'yes' ? '1' : '0';
}
browserCheck();
