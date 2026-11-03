// The loading card over the game: what is happening (game files, compile,
// boot stage), how long it has taken, and Retry / Reload / Download log. It
// goes away once the game shows its first frame, and comes back if the game
// stops with an error (trap, boot failure, exit).
import { downloadLog } from './logs.js';

const $ = (id) => document.getElementById(id);

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
  title.textContent = kind === 'freeride' ? 'Free Ride' : 'ATV Quad Power Racing 2';
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
