// Home: the Play panel and the news (data/news.json).
import { $, h, initChrome, initHubStatus, initPlayBox, playBoxMarkup } from './common.js';
import { loadConfig, launchUrl } from './config-model.js';

initChrome();
const box = $('playbox');
box.innerHTML = playBoxMarkup();
initPlayBox(box, { launchUrl: () => { const c = loadConfig(); return launchUrl(c.values, c.launch); },
  roam: () => { const v = loadConfig().values; return { server: v.roam_server, name: v.roam_name }; } });
initHubStatus($('hub-status'), loadConfig().values.roam_server);

async function news() {
  const list = $('news');
  try {
    const r = await fetch('data/news.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const items = await r.json();
    list.textContent = '';
    for (const n of items) {
      list.append(h('li', {}, h('article', {},
        h('time', { datetime: n.date }, n.date),
        h('h3', {}, n.title),
        (n.body ?? []).map((p) => h('p', { class: 'small' }, p)))));
    }
    list.dataset.count = String(items.length);
  } catch (e) {
    list.textContent = '';
    list.append(h('li', { class: 'small muted' }, `The news could not be loaded (${e.message}).`));
  }
}
news();
