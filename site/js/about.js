// About: the changelog and milestones from data/changelog.json.
import { $, h, initChrome } from './common.js';

initChrome();
(async () => {
  const cl = $('changelog'), ms = $('milestones');
  try {
    const r = await fetch('data/changelog.json', { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    for (const e of data.changelog) {
      cl.append(h('li', {}, h('time', { datetime: e.date }, e.date), h('strong', {}, e.title), h('ul', {}, e.items.map((i) => h('li', {}, i)))));
    }
    for (const m of data.milestones) ms.append(h('li', {}, h('strong', {}, m.title), h('p', { class: 'small', style: 'margin:4px 0 0' }, m.text)));
    cl.dataset.count = String(data.changelog.length);
  } catch (e) {
    cl.append(h('li', { class: 'small muted' }, `The changelog could not be loaded (${e.message}).`));
  }
})();
