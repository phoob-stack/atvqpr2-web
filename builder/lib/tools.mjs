// Find the programs the build needs on this machine: Python 3 with capstone
// (the lifter), bash (web/wasm/build.sh; Git Bash on Windows), a browser.
// Nothing is installed here: a missing piece is reported with what to install.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { isWin, probe } from './util.mjs';

export const MIN_PYTHON = [3, 10];
export const CAPSTONE_TESTED = '5.0.7';

// { cmd, args, version, capstone } or throws with advice.
export function findPython(override) {
  const tries = override ? [override.split(' ')] : isWin ? [['py', '-3'], ['python'], ['python3']] : [['python3'], ['python']];
  const seen = [];
  for (const [cmd, ...args] of tries) {
    // The Microsoft Store "python" stub prints an advert and exits non-zero.
    const r = probe(cmd, [...args, '-c', 'import sys; print("%d.%d.%d" % sys.version_info[:3])']);
    if (!r.ok || !/^\d+\.\d+\.\d+$/.test(r.out)) { seen.push(`${[cmd, ...args].join(' ')}: ${r.out.split('\n')[0] || 'not found'}`); continue; }
    const version = r.out;
    const [maj, min] = version.split('.').map(Number);
    if (maj !== 3 || min < MIN_PYTHON[1]) { seen.push(`${cmd}: Python ${version} (need 3.${MIN_PYTHON[1]}+)`); continue; }
    const c = probe(cmd, [...args, '-c', 'import capstone; print(capstone.__version__)']);
    if (!c.ok) throw new Error(`Python ${version} (${[cmd, ...args].join(' ')}) has no capstone module. Install it with:\n` +
      `  ${[cmd, ...args].join(' ')} -m pip install --user capstone==${CAPSTONE_TESTED}`);
    return { cmd, args, version, capstone: c.out.trim() };
  }
  throw new Error(`no Python 3.${MIN_PYTHON[1]}+ found (${seen.join('; ')}). Install Python 3.10 or newer from python.org` +
    (isWin ? ' (tick "py launcher"), ' : ', ') + `then: python -m pip install --user capstone==${CAPSTONE_TESTED}`);
}

// bash for web/wasm/build.sh. On Windows this must be Git Bash (MSYS): the
// bash.exe in System32 / WindowsApps is WSL's, which cannot run the Windows
// clang.exe/py.exe the script calls with these paths.
export function findBash(override) {
  if (override) {
    if (!existsSync(override) && !probe(override, ['--version']).ok) throw new Error(`--bash ${override}: not found`);
    return override;
  }
  if (!isWin) {
    if (probe('bash', ['--version']).ok) return 'bash';
    throw new Error('bash not found (needed for web/wasm/build.sh)');
  }
  const pf = [process.env.ProgramFiles, process.env.ProgramW6432, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]
    .filter(Boolean);
  const cands = pf.flatMap((p) => [join(p, 'Git', 'bin', 'bash.exe'), join(p, 'Git', 'usr', 'bin', 'bash.exe')]);
  // git.exe on PATH -> <Git>\cmd\git.exe or <Git>\bin\git.exe -> <Git>\bin\bash.exe
  const w = probe('where', ['git']);
  if (w.ok) for (const g of w.out.split(/\r?\n/)) {
    const root = dirname(dirname(g.trim()));
    cands.push(join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe'));
  }
  const hit = cands.find((p) => existsSync(p));
  if (hit) return hit;
  throw new Error('Git Bash not found. Install Git for Windows (https://git-scm.com/download/win), or pass --bash <path to Git\\bin\\bash.exe>. ' +
    '(The bash.exe in System32 is WSL and will not work.)');
}

export function bashVersion(bash) {
  const r = probe(bash, ['--version']);
  return r.ok ? (r.out.split('\n')[0].match(/version ([^\s]+)/)?.[1] ?? r.out.split('\n')[0]) : null;
}

const BROWSERS = isWin ? [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
] : process.platform === 'darwin' ? [
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
] : ['/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

// Edge or Chrome (WebGPU + cross-origin isolation): BROWSER=<path> overrides.
export function findBrowser() {
  return [process.env.BROWSER, ...BROWSERS].filter(Boolean).find((p) => existsSync(p)) ?? null;
}
