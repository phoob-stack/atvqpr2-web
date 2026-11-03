// Mirror of src/web/web_host.h (WebHost, WebAudioRing) and of GpFrame
// (src/gpu/gpu_proto.h) as wasm32 lays it out. Offsets are computed from the
// field lists, as web/gpu/proto.js does; web_host.h asserts the same sizes.

export const WEB_HOST_MAGIC = 0x57565441, WEB_HOST_VERSION = 1;
export const WEB_AUDIO_MAGIC = 0x41565441;

function words(fields) {
  const at = {};
  let i = 0;
  for (const [name, n = 1] of fields) { at[name] = i; i += n; }
  return { at, words: i, size: i * 4 };
}

// WebHost: u32 index of every field (Int32Array over the block).
export const Host = words([
  ['magic'], ['version'], ['size'], ['boot_stage'],
  ['page_attached'], ['gp_seq'], ['gp_claimed'], ['gp_dropped'], ['gp_frame'],
  ['disp_seq'], ['disp_va'], ['disp_pitch'], ['disp_aa'], ['disp_w'], ['disp_h'], ['disp_cpu'],
  ['cpu_fb'], ['flips'], ['last_draws'], ['mem_offset'],
  ['pad_seq'], ['pad_connected'], ['pad_buttons'], ['pad_analog', 2], ['pad_thumb', 4],
  ['audio_ring'], ['pad_rumble'], ['reserved', 7],
]);
export const HOST_KEYS_OFFSET = Host.size;          // uint8_t keys[256]
export const HOST_SIZE = Host.size + 256;

export const AudioRing = words([
  ['magic'], ['rate'], ['channels'], ['cap'], ['write'], ['read'], ['heartbeat'], ['underruns'],
]);
export const AUDIO_DATA_OFFSET = 32;                // float data[cap * channels]

// GpFrame on wasm32: pointers are u32 wasm addresses.
export const GpFrame = words([
  ['queue'], ['queue_bytes'], ['draws'], ['draw_count'], ['vtx'], ['vtx_bytes'],
  ['idx'], ['idx_count'], ['consts'], ['const_bytes'], ['frame'],
]);

export const STAGES = ['', 'start', 'xbe loaded', 'memory layout', 'APU', 'OHCI', 'kernel',
  'paths', 'kernel bridge', 'dispatch', 'GPU recorder', 'game entry point', 'game returned'];

export function stageName(s) {
  if (s & 0x100) return `FAILED at ${STAGES[s & 0xff] ?? s & 0xff}`;
  return STAGES[s] ?? String(s);
}

/** Check a WebHost block; returns an Int32Array over it. */
export function hostView(memory, ptr) {
  const i32 = new Int32Array(memory.buffer, ptr, Host.words);
  if (i32[Host.at.magic] >>> 0 !== WEB_HOST_MAGIC || i32[Host.at.version] !== WEB_HOST_VERSION ||
      i32[Host.at.size] !== HOST_SIZE)
    throw new Error(`host block mismatch: magic ${(i32[0] >>> 0).toString(16)} v${i32[1]} size ${i32[2]}, ` +
      `page expects v${WEB_HOST_VERSION} size ${HOST_SIZE}`);
  return i32;
}
