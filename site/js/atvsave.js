// Reads ATV 2 save files in the browser. Nothing is uploaded; nothing here
// touches the network. The format is described in docs/SAVE-FORMAT.md.
//
//   parseSave(u8)        -> { header, root, trailer }  (a tree of objects and fields)
//   readSaveMeta(u8)     -> { Name: '...', ... }        (SaveMeta.xbx: UTF-16 "key=value" lines)
//   profileStats(root)   -> what Stats shows for a profile ("Rider Data")
//   recordStats(root)    -> what Stats shows for the title's records file ("Records")
//   writeSave(root)      -> bytes (used only to build the synthetic example)
//
// A file is a 4-byte header, one tagged tree, and a 20-byte trailer. In the
// tree, BEGIN (f0 0d ab cd) + a 4-byte key opens an object and END
// (de ad dc ba) closes it; anything else is a field: a 4-byte key and a value.
// The value's size is not written down. It is 4 bytes for most fields, a
// u16 length plus text for strings, and 1 byte for a few. The parser tries
// those in turn and backtracks when the rest of the file stops making sense
// (the whole file must end exactly on the root's END plus the trailer), so it
// needs no list of field types; save-keys.js only gives names to keys.
import { K, A } from './save-keys.js';

export const BEGIN = 0xcdab0df0;
export const END = 0xbadcadde;
const TRAILER = 20;
const MAX_STEPS = 4_000_000;

const KNOWN = new Set([...Object.values(K), ...Object.values(A).flat(2)]);

const printable = (u8, a, b) => {
  for (let i = a; i < b; i++) { const c = u8[i]; if (c < 0x20 || (c > 0x7e && c < 0xa0)) return false; }
  return true;
};

/** Parse one tagged save file. Throws an Error with a message for people. */
export function parseSave(u8) {
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  const n = u8.length;
  const dv = new DataView(u8.buffer, u8.byteOffset, n);
  const u32 = (p) => (p + 4 <= n ? dv.getUint32(p, true) : -1);
  if (n < 4 + 8 + 4 + TRAILER || u32(4) !== BEGIN) throw new Error('This is not an ATV 2 tagged save file (no tree at the start).');

  // Depth-first search over the value-size choices. A state (p, depth) fully
  // decides what follows, so a state that failed once is never tried again.
  const failed = new Set();
  const key = (p, d) => p * 64 + Math.min(d, 63);
  const path = [];             // { p, d, tok, alts?, ai? }  tok: what was read at p
  let p = 4, d = 0, steps = 0;

  const options = (q) => {
    // Field at q: key, then the possible values (most likely first).
    const out = [];
    const v = q + 4;
    const next = (sz) => { const w = u32(v + sz); return w === BEGIN || w === END || KNOWN.has(w); };
    if (v + 2 <= n) {
      const len = dv.getUint16(v, true);
      if (len > 0 && len < 512 && v + 2 + len <= n && printable(u8, v + 2, v + 2 + len)) out.push({ t: 'str', sz: 2 + len, hint: next(2 + len) });
    }
    for (const [t, sz] of [['u32', 4], ['u8', 1], ['u16', 2]]) if (v + sz <= n) out.push({ t, sz, hint: next(sz) });
    if (v + 2 <= n && dv.getUint16(v, true) === 0) out.push({ t: 'str', sz: 2, hint: next(2) });
    // Known keys after the value first; the order above breaks ties.
    return out.sort((a, b) => Number(b.hint) - Number(a.hint));
  };

  for (;;) {
    if (++steps > MAX_STEPS) throw new Error('This file could not be read (it does not look like an ATV 2 save).');
    let ok = !failed.has(key(p, d)) && p + 4 <= n;
    if (ok) {
      const w = u32(p);
      if (w === BEGIN) {
        if (p + 8 > n) ok = false;
        else { path.push({ p, d, tok: { k: 'obj', key: u32(p + 4) } }); p += 8; d++; continue; }
      } else if (w === END) {
        if (d === 0) ok = false;
        else {
          path.push({ p, d, tok: { k: 'end' } }); p += 4; d--;
          if (d === 0) { if (n - p === TRAILER) break; path.pop(); p -= 4; d++; ok = false; }
          else continue;
        }
      } else if (d === 0) ok = false;
      else {
        const alts = options(p);
        if (alts.length) { path.push({ p, d, tok: { k: 'field', key: w }, alts, ai: 0 }); p += 4 + alts[0].sz; continue; }
        ok = false;
      }
    }
    // Dead end: back up to the last field with another size to try.
    failed.add(key(p, d));
    for (;;) {
      const top = path.pop();
      if (!top) throw new Error('This file could not be read (it does not look like an ATV 2 save).');
      if (top.alts && top.ai + 1 < top.alts.length) {
        top.ai++; path.push(top); p = top.p + 4 + top.alts[top.ai].sz; d = top.d;
        break;
      }
      failed.add(key(top.p, top.d));
    }
  }

  // Build the tree from the chosen path.
  const root = { kind: 'obj', key: 0, off: 0, children: [] };
  const stack = [root];
  for (const s of path) {
    const parent = stack.at(-1);
    if (s.tok.k === 'obj') { const o = { kind: 'obj', key: s.tok.key, off: s.p, children: [] }; parent.children.push(o); stack.push(o); }
    else if (s.tok.k === 'end') stack.pop();
    else {
      const alt = s.alts[s.ai], v = s.p + 4;
      let value;
      if (alt.t === 'str') value = latin1(u8.subarray(v + 2, v + alt.sz));
      else if (alt.t === 'u32') value = dv.getUint32(v, true);
      else if (alt.t === 'u16') value = dv.getUint16(v, true);
      else value = u8[v];
      parent.children.push({ kind: 'field', key: s.tok.key, type: alt.t, value, off: s.p });
    }
  }
  return { header: dv.getUint32(0, true), root: root.children[0], trailer: u8.slice(n - TRAILER) };
}

const latin1 = (u8) => { let s = ''; for (const c of u8) s += String.fromCharCode(c); return s; };

// ---- reading the tree -------------------------------------------------------

const f32 = (u) => { const b = new DataView(new ArrayBuffer(4)); b.setUint32(0, u >>> 0, true); return b.getFloat32(0, true); };
const i32 = (u) => u | 0;
export const asFloat = f32;
export const asInt = i32;

/** The first child object / field with this key. */
export const obj = (o, k) => o?.children?.find((c) => c.kind === 'obj' && c.key === k) ?? null;
export const fld = (o, k) => o?.children?.find((c) => c.kind === 'field' && c.key === k) ?? null;
const int = (o, k) => { const f = fld(o, k); return f && f.type === 'u32' ? i32(f.value) : f ? f.value : null; };
const flt = (o, k) => { const f = fld(o, k); return f && f.type === 'u32' ? f32(f.value) : null; };
const str = (o, k) => { const f = fld(o, k); return f && f.type === 'str' ? f.value : null; };
const bits = (v) => { let c = 0; for (let x = v >>> 0; x; x >>>= 1) c += x & 1; return c; };
const bitList = (v, count) => [...Array(count).keys()].filter((i) => (v >>> i) & 1);

/** SaveMeta.xbx / TitleMeta.xbx: UTF-16LE (or UTF-8) "key=value" lines. */
export function readSaveMeta(u8) {
  if (!u8?.length) return {};
  const utf16 = (u8[0] === 0xff && u8[1] === 0xfe) || (u8.length > 2 && u8[1] === 0);
  const text = new TextDecoder(utf16 ? 'utf-16le' : 'utf-8').decode(u8);
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).replace(/^﻿/, '').trim()] = line.slice(i + 1).replace(/\0+$/, '').trim();
  }
  return out;
}

// Our own short labels for the game's track numbers (environment and number).
export const TRACKS = ['Dunes 1', 'Forest 1', 'Swamp 1', 'Industrial 1', 'Glacier 1', 'Dunes 2', 'Forest 2', 'Swamp 2',
  'Industrial 2', 'Glacier 2', 'Dunes 3', 'Forest 3', 'Swamp 3', 'Industrial 3', 'Glacier 3',
  'Stadium 1', 'Stadium 2', 'Stadium 3', 'Stadium 4'];
export const TRACK_COUNT = 19, RIDER_BITS = 24, ATV_BITS = 11;
const NONE_MARK = 'None';                   // the game writes this text for an empty slot

/** A profile ("Rider Data"). Every value says how sure we are. */
export function profileStats(root) {
  const player = obj(root, K.player);
  const rider = obj(root, K.customRider);
  const unl = obj(obj(root, K.unlockables), K.unlockables) ?? obj(root, K.unlockables);
  const career = obj(obj(root, K.careerData), K.careerData) ?? obj(root, K.careerData);
  const info = obj(career, K.careerInfo);
  const fs = obj(root, K.fsChallengeData);
  const settings = obj(root, K.settings);
  const arcade = obj(obj(root, K.arcadeData), K.arcadeData);
  const cheat = obj(root, K.cheat);
  const attr = (k) => { const a = obj(rider, k); return a ? { value: int(a, K.attrValue), fraction: flt(a, K.attrFraction) } : null; };
  const tracksMask = int(unl, K.tracksUnlocked);
  const ridersMask = int(unl, K.ridersUnlocked);
  const atvMask = int(unl, K.vehiclesUnlocked);
  const careerSlots = A.track.map((k, i) => ({
    slot: i, track: int(career, k), laps: int(career, A.trackLaps[i]),
    position: int(info, A.trackPosition[i]), time: flt(info, A.trackTimes[i]), points: int(info, A.trackPoints[i]),
  })).filter((s) => s.track !== null && s.track >= 0);
  const standings = A.champInfo.map((k, i) => {
    const o = obj(career, k);
    if (!o) return null;
    return { slot: i, rider: str(o, K.riderType), atv: str(o, K.vehicleType), points: int(o, K.champPoints), rank: int(o, K.rank), lastPos: int(o, K.lastRacePos) };
  }).filter((s) => s && (s.rider !== NONE_MARK || s.atv !== NONE_MARK || s.points));
  let cheatText = null;
  for (const c of cheat?.children ?? []) if (c.kind === 'field' && c.type === 'str') cheatText = c.value;
  return {
    fileVersion: flt(root, K.fileVersion), dataVersion: flt(root, K.version),
    name: str(player, K.name),
    riderId: str(rider, K.riderId),
    skillLevel: int(rider, K.skillLevel), skillPoints: int(rider, K.skillPoints),
    attributes: { ability: attr(K.attrAbility), technique: attr(K.attrTechnique), aggression: attr(K.attrAggression), strength: attr(K.attrStrength) },
    lastAtv: str(rider, K.lastAtv),
    unlocks: unl ? {
      tracks: tracksMask, tracksCount: tracksMask === null ? null : bits(tracksMask) , tracksList: tracksMask === null ? [] : bitList(tracksMask, TRACK_COUNT),
      riders: ridersMask, ridersCount: ridersMask === null ? null : bits(ridersMask),
      atvs: atvMask, atvsCount: atvMask === null ? null : bits(atvMask),
      tierQualifying: int(unl, K.qualifyingUnlocked), tierProfessional: int(unl, K.professionalUnlocked), tierCustom: int(unl, K.customUnlocked),
      musicLockedOut: int(unl, K.musicLockedOut),
    } : null,
    career: career ? { tier: str(career, K.champType), round: int(career, K.round), trackCount: int(career, K.trackCount), slots: careerSlots, standings,
      medals: A.champMedal.map((k) => int(info, k) ?? int(career, k)) } : null,
    freestyleMedals: fs ? A.fsMedal.map((k) => int(fs, k)) : [],
    arcadeRound: int(arcade, K.round),
    volumes: A.volume.map((k) => flt(obj(settings, k), K.setting)),
    pads: [0, 1, 2, 3].map((i) => { const o = obj(settings, A.slot[i]); return o ? { shocks: int(o, K.shocks), layout: int(o, K.btnLayout) } : null; }).filter(Boolean),
    cheatSet: cheatText !== null && cheatText !== '' && cheatText !== '0',
  };
}

/** The title's records file ("Records"). */
export function recordStats(root) {
  const fsO = obj(root, K.freestyle), tt = obj(root, K.timeTrial), tr = obj(root, K.trackRecords);
  const entry = (o) => o && { value: flt(o, K.record), name: str(o, K.name), rider: int(o, K.riderType), atv: int(o, K.vehicleType) };
  const empty = (e) => !e || e.rider === 255 || e.atv === 255;
  return {
    freestyle: A.fsRecord.map((ranks, m) => ({ option: m, entries: ranks.map((k) => entry(obj(fsO, k))).filter(Boolean) })),
    timeTrial: A.timeTrial.map((ranks, t) => ({ track: t, entries: ranks.map((k) => entry(obj(tt, k))).filter((e) => e && !empty(e)) })),
    trackRecords: A.trackName.map((k, t) => {
      const o = obj(tr, k);
      return { track: t, present: !!o, categories: A.trackRecord.map((rk) => entry(obj(o, rk))) };
    }).filter((x) => x.present),
    lastProfile: int(obj(root, K.settings), K.lastProfile),
  };
}

/** Which kind of file a tree is. */
export function kindOf(root) {
  if (obj(root, K.customRider) || obj(root, K.player)) return 'profile';
  if (obj(root, K.trackRecords) || obj(root, K.timeTrial) || obj(root, K.freestyle)) return 'records';
  return 'other';
}

// ---- writing (only for the synthetic example) -----------------------------------

/** Tree -> bytes: header 0x00020040, the tree, a zero trailer (no signature). */
export function writeSave(root) {
  const parts = [];
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); parts.push(b); };
  const walk = (o) => {
    u32(BEGIN); u32(o.key);
    for (const c of o.children) {
      if (c.kind === 'obj') { walk(c); continue; }
      u32(c.key);
      if (c.type === 'str') {
        const s = Uint8Array.from(String(c.value), (ch) => ch.charCodeAt(0) & 0xff);
        const l = new Uint8Array(2); new DataView(l.buffer).setUint16(0, s.length, true); parts.push(l, s);
      } else if (c.type === 'f32') { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, c.value, true); parts.push(b); }
      else if (c.type === 'u8') parts.push(Uint8Array.of(c.value & 0xff));
      else u32(c.value);
    }
    u32(END);
  };
  u32(0x00020040);
  walk(root);
  parts.push(new Uint8Array(TRAILER));
  const out = new Uint8Array(parts.reduce((a, b) => a + b.length, 0));
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}
