// A made-up save set for the Stats page's "Show a made-up example": written
// by our own code in the file layout described in docs/SAVE-FORMAT.md. Every
// name and number here is invented; none of it comes from the game.
import { K, A } from './save-keys.js';
import { writeSave } from './atvsave.js';

const o = (key, ...children) => ({ kind: 'obj', key, children });
const u = (key, value) => ({ kind: 'field', key, type: 'u32', value: value >>> 0 });
const f = (key, value) => ({ kind: 'field', key, type: 'f32', value });
const s = (key, value) => ({ kind: 'field', key, type: 'str', value });
const b = (key, value) => ({ kind: 'field', key, type: 'u8', value });

function profile() {
  const career = o(K.careerData, s(K.champType, 'EXAMPLE TIER'), u(K.round, 2), u(K.trackCount, 3),
    ...A.track.flatMap((k, i) => [u(k, i < 3 ? [0, 5, 1][i] : -1), u(A.trackLaps[i], 3)]),
    o(K.careerInfo,
      ...A.trackPosition.flatMap((k, i) => [u(k, i < 2 ? [2, 1][i] : -1), f(A.trackTimes[i], i < 2 ? [212.4, 198.75][i] : 0), u(A.trackPoints[i], i < 2 ? [8, 10][i] : 0)]),
      ...A.champMedal.map((k, i) => u(k, i === 0 ? 1 : -1))));
  const root = o(K.root, f(K.fileVersion, 1), f(K.version, 3.4),
    o(K.player, s(K.name, 'Example Rider')),
    o(K.settings, ...A.volume.map((k, i) => o(k, f(K.setting, [0.8, 1, 0.6, 1][i]))),
      ...[0, 1, 2, 3].map((i) => o(A.slot[i], u(K.shocks, 1), u(K.btnLayout, 0)))),
    o(K.unlockables, o(K.unlockables, u(K.qualifyingUnlocked, 1), u(K.professionalUnlocked, 0), u(K.customUnlocked, 0),
      u(K.tracksUnlocked, 0b11111111), u(K.ridersUnlocked, 0x3ffc00), u(K.vehiclesUnlocked, 0b11111), u(K.musicLockedOut, 0))),
    o(K.customRider, s(K.riderId, 'Example_Character'),
      o(K.attrAbility, u(K.attrValue, 3), f(K.attrFraction, 0.5)), o(K.attrTechnique, u(K.attrValue, 2), f(K.attrFraction, 0)),
      o(K.attrAggression, u(K.attrValue, 4), f(K.attrFraction, 0.25)), o(K.attrStrength, u(K.attrValue, 1), f(K.attrFraction, 0)),
      u(K.skillPoints, 125000), u(K.skillLevel, 3), s(K.lastAtv, 'Example ATV')),
    o(K.careerData, career),
    o(K.fsChallengeData, ...A.fsMedal.map((k, i) => u(k, i < 5 ? [2, 1, 0, 2, 1][i] : -1))),
    o(K.cheat, s(0x12345678, '0')));
  return writeSave(root);
}

function records() {
  const e = (key, value, name, rider, atv) => o(key, f(K.record, value), s(K.name, name), b(K.riderType, rider), b(K.vehicleType, atv));
  const none = (key) => e(key, 999.99, '-', 255, 255);
  const root = o(K.root, f(K.fileVersion, 1),
    o(K.freestyle, ...A.fsRecord.flatMap((ranks, m) => ranks.map((k, r) => e(k, (m + 1) * 100000 - r * 25000, ['Example Rider', 'Sample Sam', 'Demo Dee'][r], r, 0)))),
    o(K.timeTrial, ...A.timeTrial.flatMap((ranks, t) => ranks.map((k, r) => (t === 0 && r < 2 ? e(k, 61.5 + r * 2.25, r ? 'Sample Sam' : 'Example Rider', r, 1) : none(k))))),
    o(K.trackRecords, ...A.trackName.slice(0, 3).map((k, t) => o(k, ...A.trackRecord.map((rk, c) => e(rk, [95.5, 70, 20, 4.5, 3][c] + t, 'Example Rider', 0, 0))))),
    o(K.settings, u(K.lastProfile, 0)));
  return writeSave(root);
}

const utf16 = (text) => { const out = new Uint8Array(2 + text.length * 2); out[0] = 0xff; out[1] = 0xfe; for (let i = 0; i < text.length; i++) out[2 + 2 * i] = text.charCodeAt(i); return out; };

/** [{ path, data }] in the export zip's layout. */
export function exampleFiles() {
  const base = 'UDATA/4143000a';
  return [
    { path: `${base}/EXAMPLE00001/SaveMeta.xbx`, data: utf16('Name=Example profile\r\n') },
    { path: `${base}/EXAMPLE00001/Rider Data`, data: profile() },
    { path: `${base}/EXAMPLE0000R/SaveMeta.xbx`, data: utf16('Name=Example records\r\n') },
    { path: `${base}/EXAMPLE0000R/Records`, data: records() },
  ];
}
