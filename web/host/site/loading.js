// The loading card over the game: what is happening (game files, compile,
// boot stage), how long it has taken, and Retry / Reload / Download log. It
// goes away once the game shows its first frame, and comes back if the game
// stops with an error (trap, boot failure, exit).
import { downloadLog } from './logs.js';

const $ = (id) => document.getElementById(id);
const BUSY = 'atv2.busyRetries';

function phaseText(atv) {
  const L = atv?.loader?.phase;
  if (atv?.state?.error) return null;
  if (L === 'waiting') return 'Choose your game folder to continue';
  if (L === 'validating') return 'Checking your game folder…';
  if (L === 'importing') {
    const p = atv.loader.progress;
    return p ? `Copying the game files into this browser… ${Math.round((100 * p.done) / Math.max(1, p.total))}%` : 'Copying the game files…';
  }
  const log = atv?.log ?? [];
  const stage = atv?.stage?.() ?? '';
  if (!log.some((l) => l.includes('compiled in'))) return 'Loading and compiling the game…';
  if (!atv.presenter) return `Starting the game… (${stage || 'starting'})`;
  return 'Starting the game… (the first frame is on its way)';
}

export function watch({ kind }) {
  const card = $('loading');
  const title = $('loading-title'), msg = $('loading-msg'), time = $('loading-time');
  title.textContent = kind === 'freeride' ? 'Free Ride' : kind === 'freeride-pick' ? 'Free Ride: choose your rider' : 'ATV Quad Power Racing 2';
  card.hidden = false;
  $('ld-retry').onclick = () => location.reload();
  $('ld-reload').onclick = () => { location.href = location.pathname; };
  $('ld-log').onclick = () => { const n = downloadLog(); $('loading-note').textContent = `Saved ${n} to your downloads.`; };
  const t0 = performance.now();
  let shown = false;
  const tick = () => {
    const atv = window.atv;
    const st = atv?.state;
    const failed = st?.error || st?.trap || (st?.exit !== null && st?.exit !== undefined);
    // The game files are still open in a page that is going away (Quit, then Play again at once): the
    // browser frees them a moment later, so start again by itself a few times before calling it a failure.
    if (st?.error && /in use by another tab/.test(String(st.error))) {
      let n = 0;
      try { n = Number(sessionStorage.getItem(BUSY) ?? 0); } catch { /* */ }
      if (n < 8) {
        try { sessionStorage.setItem(BUSY, String(n + 1)); } catch { /* */ }
        msg.textContent = 'Waiting for the previous game to close…';
        setTimeout(() => location.reload(), 1000);
        return;
      }
    }
    if (failed) {
      card.hidden = false; card.classList.add('failed');
      title.textContent = 'The game stopped';
      msg.textContent = st.error ? `Start failed: ${String(st.error).split('\n')[0]}` :
        st.trap ? `The game hit an error: ${String(st.trap.message).slice(0, 200)}` : `The game ended (code ${st.exit}).`;
      time.textContent = 'Retry starts it again. The log helps with a bug report.';
      setTimeout(tick, 1000);
      return;
    }
    const s = atv?.presenter?.stats;
    if (!shown && s && (s.frames > 0 || s.cpuFrames > 0)) {
      shown = true; card.hidden = true;
      try { sessionStorage.removeItem(BUSY); } catch { /* */ }
      document.body.classList.add('playing');
    }
    if (!shown) {
      const text = phaseText(atv);
      if (text) msg.textContent = text;
      // The import panel covers the card while it is up.
      card.classList.toggle('behind', atv?.loader?.phase === 'waiting' || atv?.loader?.phase === 'validating' || atv?.loader?.phase === 'importing');
      time.textContent = `${((performance.now() - t0) / 1000).toFixed(0)} s`;
    }
    setTimeout(tick, shown ? 1000 : 250);
  };
  tick();
}
