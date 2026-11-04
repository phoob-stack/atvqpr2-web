// [pubsite] Import a config file made on the project site (Configs -> Export config file):
// JSON { format: 'atv2-settings', version: 1, values: { key: value }, launch?: {...} }.
// "values" uses this page's own setting keys, so it goes through the same checks as the
// stored settings (settings.js parseValue); refused values keep their defaults and are
// listed. "launch" (saves mode, start mode) belongs to the site's launch link and is ignored.
import { SETTINGS, BY_KEY, parseValue, defaults, saveSettings } from './settings.js';

/** Check a config file's text: { values, notes: [text] }; throws for a file that is not one. */
export function readConfigText(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`Not a config file (not JSON: ${e.message}).`); }
  if (!data || typeof data !== 'object' || (data.format !== undefined && data.format !== 'atv2-settings'))
    throw new Error('Not an ATV 2 settings file.');
  if (data.version !== undefined && data.version !== 1) throw new Error(`Settings file version ${data.version} is newer than this page.`);
  const values = defaults(), notes = [];
  for (const [k, v] of Object.entries(data.values ?? {})) {
    const s = BY_KEY[k];
    if (!s) { notes.push(`unknown setting "${k}" (ignored)`); continue; }
    const r = parseValue(s, s.type === 'bool' ? (v ? 'on' : 'off') : String(v));
    if (r.error) { notes.push(`${k}: ${JSON.stringify(v)} refused, expected ${r.error}; keeps the default`); continue; }
    values[k] = r.value;
  }
  return { values, notes };
}

/** A file picker; applies the file. say(text, cls) reports, done() redraws. */
export function importConfigFile({ say = () => {}, done = () => {} } = {}) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: '.json,application/json' });
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    try {
      if (f.size > 256 * 1024) throw new Error(`${f.name} is too large for a settings file.`);
      const r = readConfigText(await f.text());
      saveSettings(r.values);
      done();
      say(`Imported ${f.name}${r.notes.length ? `, with ${r.notes.length} value${r.notes.length > 1 ? 's' : ''} refused: ${r.notes.join('; ')}` : ''}.`, r.notes.length ? 'warn' : 'ok');
    } catch (e) { say(e.message, 'warn'); }
  };
  input.click();
}
export { SETTINGS };
