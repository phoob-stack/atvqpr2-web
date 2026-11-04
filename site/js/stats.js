// Stats page: open a save backup zip, save files or the Windows save folder,
// parse them here (atvsave.js) and show what we can read with confidence.
import { $, h, initChrome } from './common.js';
import { readZip } from './zip.js';
import { parseSave, readSaveMeta, profileStats, recordStats, kindOf, TRACKS, TRACK_COUNT, RIDER_BITS, ATV_BITS, asFloat } from './atvsave.js';
import { K, A } from './save-keys.js';
import { exampleFiles } from './example-save.js';

initChrome();
const TITLE_ID = '4143000a';
const WANTED = new Set(['rider data', 'records', 'savemeta.xbx', 'titlemeta.xbx', 'atv2-saves.json']);
const MAX_FILE = 4 << 20, MAX_ZIP = 256 << 20;

const say = (text, cls = '') => { const m = $('stats-msg'); m.textContent = text; m.className = `msg ${cls}`; };
const base = (p) => p.replace(/\\/g, '/').split('/').filter(Boolean);
const wanted = (p) => WANTED.has(base(p).at(-1)?.toLowerCase() ?? '');

// ---- getting the files ------------------------------------------------------------------

async function fromFileList(list) {
  const files = [];
  for (const f of list) {
    const path = f.webkitRelativePath || f.name;
    if (/\.zip$/i.test(f.name)) {
      if (f.size > MAX_ZIP) throw new Error(`${f.name} is ${Math.round(f.size / 1048576)} MB; a save backup is a few hundred KB at most.`);
      const entries = await readZip(new Uint8Array(await f.arrayBuffer()), { maxEntries: 20000, maxBytes: 64 << 20, keep: wanted });
      for (const e of entries) if (!e.dir) files.push({ path: `${f.name}/${e.path}`, data: e.data });
    } else if (wanted(path)) {
      if (f.size > MAX_FILE) continue;
      files.push({ path, data: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return files;
}

async function fromDirHandle(dir) {
  const files = [];
  const walk = async (d, prefix, depth) => {
    if (depth > 8) return;
    for await (const e of d.values()) {
      const path = `${prefix}/${e.name}`;
      if (e.kind === 'directory') await walk(e, path, depth + 1);
      else if (wanted(e.name)) {
        const f = await e.getFile();
        if (f.size <= MAX_FILE) files.push({ path, data: new Uint8Array(await f.arrayBuffer()) });
      }
    }
  };
  await walk(dir, dir.name, 0);
  return files;
}

async function fromDrop(items) {
  const files = [];
  const walk = async (entry, depth) => {
    if (depth > 8) return;
    if (entry.isFile) {
      const f = await new Promise((r, j) => entry.file(r, j));
      if (/\.zip$/i.test(f.name)) files.push(...await fromFileList([f]));
      else if (wanted(entry.fullPath) && f.size <= MAX_FILE) files.push({ path: entry.fullPath, data: new Uint8Array(await f.arrayBuffer()) });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((r, j) => reader.readEntries(r, j));
        if (!batch.length) break;
        for (const e of batch) await walk(e, depth + 1);
      }
    }
  };
  for (const it of items) { const e = it.webkitGetAsEntry?.(); if (e) await walk(e, 0); }
  return files;
}

// ---- grouping and parsing ---------------------------------------------------------------------

/** Files -> save folders: { id, meta, kind, parsed, stats, error, path } plus title-level info. */
function analyse(files) {
  const folders = new Map();
  let manifest = null, titleMeta = null;
  for (const f of files) {
    const parts = base(f.path);
    const name = parts.at(-1).toLowerCase();
    if (name === 'atv2-saves.json') { try { manifest = JSON.parse(new TextDecoder().decode(f.data)); } catch { /* ignore */ } continue; }
    const ti = parts.findIndex((p) => p.toLowerCase() === TITLE_ID);
    if (name === 'titlemeta.xbx') { titleMeta = readSaveMeta(f.data); continue; }
    // The save folder is the one holding the file (under .../<title id>/<save>/ when that is there).
    const id = ti >= 0 && parts.length - ti >= 3 ? parts[ti + 1] : parts.at(-2) ?? '(top)';
    const key = (ti >= 0 ? parts.slice(0, ti + 2) : parts.slice(0, -1)).join('/').toLowerCase();
    const g = folders.get(key) ?? { id, path: parts.slice(0, -1).join('/'), meta: {}, files: [] };
    if (name === 'savemeta.xbx') g.meta = readSaveMeta(f.data);
    else g.files.push({ name: parts.at(-1), data: f.data });
    folders.set(key, g);
  }
  const out = [];
  for (const g of folders.values()) {
    for (const file of g.files) {
      const item = { id: g.id, path: `${g.path}/${file.name}`, metaName: g.meta.Name ?? '', file: file.name, size: file.data.length };
      try {
        item.parsed = parseSave(file.data);
        item.kind = kindOf(item.parsed.root);
        item.stats = item.kind === 'profile' ? profileStats(item.parsed.root) : item.kind === 'records' ? recordStats(item.parsed.root) : null;
      } catch (e) { item.error = e.message; }
      out.push(item);
    }
  }
  out.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'profile' ? -1 : 1));
  return { items: out, manifest, titleMeta };
}

// ---- formatting -----------------------------------------------------------------------------------

const unconfirmed = (why) => h('span', { class: 'tag unconfirmed', title: why ?? 'Not confirmed against the game yet' }, 'unconfirmed');
const pretty = (s) => (s ?? '').replace(/_/g, ' ');
const n = (v) => (v === null || v === undefined ? '–' : Number(v).toLocaleString('en-US'));
const secs = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '–';
  const m = Math.floor(v / 60), s = v - m * 60;
  return m ? `${m}:${s.toFixed(2).padStart(5, '0')}` : `${v.toFixed(2)} s`;
};
const num = (v) => (v === null || v === undefined || !Number.isFinite(v) ? '–' : Number.isInteger(v) ? v.toLocaleString('en-US') : (+v.toFixed(2)).toLocaleString('en-US'));
const facts = (rows) => h('dl', { class: 'facts' }, rows.filter(Boolean).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
const table = (caption, head, rows, attrs = {}) => h('div', { class: 'table-wrap' }, h('table', { class: 'list', ...attrs },
  h('caption', {}, caption), h('thead', {}, h('tr', {}, head.map((x, i) => h('th', { scope: 'col', class: i && x.num ? 'num' : '' }, x.label ?? x)))),
  h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c, i) => (i === 0 ? h('th', { scope: 'row', style: 'font-weight:600;color:inherit' }, c) : h('td', { class: head[i]?.num ? 'num' : '' }, c))))))));
const medal = (v) => (v === null || v === undefined || v < 0 ? 'none' : `level ${v}`);

function profileCard(it) {
  const s = it.stats;
  const u = s.unlocks;
  const card = h('section', { class: 'card wide profile', 'data-save': it.id, 'aria-label': `Profile ${s.name ?? it.id}` });
  card.append(h('h3', {}, `Profile: ${it.metaName || s.name || it.id}`));
  card.append(facts([
    ['Name in the game', s.name ?? '–'],
    ['Save folder', h('code', {}, it.id)],
    ['Rider', s.riderId ? pretty(s.riderId) : '–'],
    ['Skill level', h('span', { class: 'skill-level' }, n(s.skillLevel))],
    ['Skill points', h('span', { class: 'skill-points' }, n(s.skillPoints))],
    ['Last ATV used', s.lastAtv ? pretty(s.lastAtv) : '–'],
    s.cheatSet ? ['Cheat', 'a cheat name is stored in this profile'] : null,
  ]));
  const at = s.attributes;
  card.append(table('Rider attributes', ['Attribute', { label: 'Value', num: true }, { label: 'Part-way', num: true }],
    [['Ability', at.ability], ['Technique', at.technique], ['Aggression', at.aggression], ['Strength', at.strength]]
      .map(([k, v]) => [k, n(v?.value), v?.fraction ? `${Math.round(v.fraction * 100)}%` : '–'])));

  if (u) {
    card.append(h('h3', { style: 'margin-top:14px' }, 'Unlocks'));
    card.append(facts([
      ['Tracks', h('span', { class: 'unl-tracks' }, `${u.tracksCount} of ${TRACK_COUNT}`)],
      ['Riders', h('span', { class: 'unl-riders' }, `${u.ridersCount} of ${RIDER_BITS}`)],
      ['ATVs', h('span', { class: 'unl-atvs' }, `${u.atvsCount} of ${ATV_BITS}`)],
      ['Championship tiers', h('ul', { class: 'chips' },
        [['Qualifying', u.tierQualifying], ['Professional', u.tierProfessional], ['Custom', u.tierCustom]].map(([k, v]) => h('li', { class: v ? 'on' : '' }, `${k}: ${v ? 'open' : 'locked'}`)))],
    ]));
    card.append(h('p', { class: 'small' }, 'Tracks by bit ', unconfirmed('That bit N is track N is our assumption.'), ':'),
      h('ul', { class: 'chips', 'aria-label': 'Tracks' }, TRACKS.map((t, i) => h('li', { class: u.tracksList.includes(i) ? 'on' : '' }, t))));
  }

  card.append(h('h3', { style: 'margin-top:14px' }, 'Medals'));
  const champ = s.career?.medals ?? [];
  card.append(h('p', { class: 'small' }, 'Championships: ', unconfirmed('Values seen: none (-1); a profile with everything unlocked has level 2 in the freestyle challenges, so 2 is probably gold.')),
    h('ul', { class: 'medals', 'aria-label': 'Championship medals' }, champ.map((v, i) => h('li', { class: v >= 0 ? 'has' : '' }, `Championship ${i + 1}: ${medal(v)}`))),
    h('p', { class: 'small' }, 'Freestyle challenges:'),
    h('ul', { class: 'medals fs-medals', 'aria-label': 'Freestyle challenge medals' }, s.freestyleMedals.map((v, i) => h('li', { class: v >= 0 ? 'has' : '' }, `#${i + 1}: ${medal(v)}`))));

  if (s.career) {
    card.append(h('h3', { style: 'margin-top:14px' }, 'Career'));
    card.append(facts([['Championship', s.career.tier ? pretty(s.career.tier) : '–'], ['Round', n(s.career.round)], ['Tracks in it', n(s.career.trackCount)]]));
    if (s.career.slots.length) {
      card.append(table('Championship tracks', ['Round', 'Track', { label: 'Laps', num: true }, { label: 'Finished', num: true }, { label: 'Time', num: true }, { label: 'Points', num: true }],
        s.career.slots.map((x) => [String(x.slot + 1), TRACKS[x.track] ?? `#${x.track}`, n(x.laps), x.position >= 0 ? `${x.position + 1}` : '–', x.time ? secs(x.time) : '–', n(x.points)])));
      card.append(h('p', { class: 'small muted' }, 'Finishing places are shown 1-based (the file counts from 0) ', unconfirmed(), '.'));
    } else card.append(h('p', { class: 'small muted' }, 'No championship in progress.'));
    if (s.career.standings.length) {
      card.append(table('Standings', ['Slot', 'Rider', 'ATV', { label: 'Points', num: true }, { label: 'Rank', num: true }],
        s.career.standings.map((x) => [String(x.slot + 1), pretty(x.rider), pretty(x.atv), n(x.points), n(x.rank)])));
    }
  }
  if (s.volumes.some((v) => v !== null) || s.pads.length) {
    card.append(h('details', {}, h('summary', { class: 'small' }, 'Profile options'),
      facts([
        ['Volume sliders', `${s.volumes.map((v) => (v === null ? '–' : `${Math.round(v * 100)}%`)).join(', ')}`],
        ['Pads (vibration, layout)', s.pads.map((p, i) => `pad ${i + 1}: ${p.shocks ? 'on' : 'off'}, ${p.layout}`).join('; ')],
      ]), h('p', { class: 'small muted' }, 'Which slider is which, and whether the pad flag is vibration, is ', unconfirmed(), '.')));
  }
  return card;
}

function recordsCard(it) {
  const r = it.stats;
  const card = h('section', { class: 'card wide records', 'aria-label': 'Records' });
  card.append(h('h3', {}, `Records${it.metaName ? `: ${it.metaName}` : ''}`));
  card.append(h('p', { class: 'small muted' }, 'One records file is shared by every profile on a console. A new one comes with the game\'s default entries; your own results replace them.'));
  if (r.trackRecords.length) {
    card.append(table('Track records', ['Track', { label: 'Record 1 (time)', num: true }, { label: 'Record 2', num: true }, { label: 'Record 3', num: true }, { label: 'Record 4', num: true }, { label: 'Record 5', num: true }],
      r.trackRecords.map((t) => [TRACKS[t.track], ...t.categories.map((c, i) => (c ? h('span', { title: c.name ?? '' }, `${i === 0 ? secs(c.value) : num(c.value)}`, h('br'), h('span', { class: 'small muted' }, c.name ?? '')) : '–'))]), { id: 'track-records' }));
    card.append(h('p', { class: 'small muted' }, 'Five records per track. The first is a time in seconds; records 2-5 are ', unconfirmed('Their values look like a speed, a distance and two durations; which is which is not confirmed.'), ' categories.'));
  }
  const tt = r.timeTrial.filter((t) => t.entries.length);
  if (tt.length) {
    card.append(table('Time trial (best five per track)', ['Track', 'Rank', { label: 'Time', num: true }, 'Name'],
      tt.flatMap((t) => t.entries.map((e, i) => [i ? '' : TRACKS[t.track], String(i + 1), secs(e.value), e.name ?? ''])), { id: 'time-trial' }));
    card.append(h('p', { class: 'small muted' }, 'Whether this is a lap or a whole run is ', unconfirmed(), '.'));
  } else card.append(h('p', { class: 'small', id: 'time-trial-empty' }, 'Time trial: no times set yet.'));
  card.append(table('Freestyle high scores', ['Time option', 'Rank', { label: 'Score', num: true }, 'Name'],
    r.freestyle.flatMap((m) => m.entries.map((e, i) => [i ? '' : `Option ${m.option + 1}`, String(i + 1), num(e.value), e.name ?? '']))));
  card.append(h('p', { class: 'small muted' }, 'Five time options with three scores each; they are probably the 1, 3, 5 and 10 minute and unlimited sessions ', unconfirmed(), '.'));
  return card;
}

// A readable dump of a file's tree, with our names where we have them.
const NAMES = new Map();
for (const [id, v] of Object.entries(K)) NAMES.set(v, id);
for (const [id, arr] of Object.entries(A)) arr.forEach((v, i) => (Array.isArray(v) ? v.forEach((w, j) => NAMES.set(w, `${id}[${i}][${j}]`)) : NAMES.set(v, `${id}[${i}]`)));
function dumpTree(root) {
  const lines = [];
  const name = (k) => NAMES.get(k) ?? `unknown 0x${k.toString(16).padStart(8, '0')}`;
  const walk = (o, d) => {
    lines.push(`${'  '.repeat(d)}${name(o.key)} {`);
    for (const c of o.children) {
      if (c.kind === 'obj') { walk(c, d + 1); continue; }
      const v = c.type === 'str' ? JSON.stringify(c.value) : c.type === 'u32' ? `${c.value | 0} (as float ${+asFloat(c.value).toPrecision(6)})` : String(c.value);
      lines.push(`${'  '.repeat(d + 1)}${name(c.key)}: ${c.type} ${v}`);
    }
    lines.push(`${'  '.repeat(d)}}`);
  };
  walk(root, 0);
  return lines.join('\n');
}

function render({ items, manifest, titleMeta }, source) {
  const out = $('stats-out');
  out.textContent = '';
  const profiles = items.filter((x) => x.kind === 'profile'), records = items.filter((x) => x.kind === 'records');
  const bad = items.filter((x) => x.error);
  out.append(h('div', { class: 'notice ok', id: 'stats-summary' },
    `${source}: ${profiles.length} profile${profiles.length === 1 ? '' : 's'}, ${records.length ? 'records' : 'no records file'}` +
    `${bad.length ? `, ${bad.length} file${bad.length > 1 ? 's' : ''} not readable` : ''}.` +
    `${manifest?.exportedAt ? ` Backup made ${new Date(manifest.exportedAt).toLocaleString()}.` : ''}` +
    `${titleMeta?.TitleName ? '' : ''}`));
  for (const it of profiles) out.append(profileCard(it));
  for (const it of records) out.append(recordsCard(it));
  for (const it of bad) out.append(h('p', { class: 'notice warn' }, `${it.path}: ${it.error}`));
  const details = h('details', { class: 'card wide', style: 'margin-top:14px' }, h('summary', {}, 'Every field, as read (for the curious)'),
    h('p', { class: 'small muted' }, 'Keys are numbers in the file. Names are ours; "unknown" ones we have not identified. Values are shown as stored.'));
  for (const it of items.filter((x) => x.parsed)) {
    details.append(h('h3', { style: 'margin-top:10px' }, `${it.path} (${it.size} bytes)`), h('pre', { class: 'tree' }, dumpTree(it.parsed.root)));
  }
  out.append(details);
  out.querySelectorAll('section.card, details.card').forEach((c) => { c.style.marginTop = '14px'; });
}

async function run(source, get) {
  say(`Reading ${source}…`);
  try {
    const files = await get();
    if (!files.length) throw new Error('No ATV 2 save files were found there (looked for "Rider Data", "Records" and SaveMeta.xbx).');
    const res = analyse(files);
    if (!res.items.length) throw new Error('Only save descriptions were found, no profile or records files.');
    render(res, source);
    say(`Read ${files.length} file${files.length === 1 ? '' : 's'} from ${source}. Nothing was uploaded.`, 'ok');
  } catch (e) {
    say(e.message, 'err');
  }
}

$('stats-file').addEventListener('change', (e) => {
  const list = [...e.target.files];
  e.target.value = '';
  if (list.length) run(list.length === 1 ? list[0].name : `${list.length} files`, () => fromFileList(list));
});
$('stats-dir').addEventListener('change', (e) => {
  const list = [...e.target.files];
  e.target.value = '';
  if (list.length) run('the folder', () => fromFileList(list.filter((f) => wanted(f.webkitRelativePath || f.name))));
});
$('stats-folder').addEventListener('click', async () => {
  if (!window.showDirectoryPicker) { $('stats-dir').click(); return; }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: 'atv2-saves', mode: 'read' }); } catch (e) {
    if (e.name !== 'AbortError') $('stats-dir').click();
    return;
  }
  run(`the folder ${dir.name}`, () => fromDirHandle(dir));
});
$('stats-example').addEventListener('click', () => run('the made-up example', async () => exampleFiles()));
const drop = $('drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const items = [...(e.dataTransfer?.items ?? [])];
  run('the dropped files', () => fromDrop(items));
});
