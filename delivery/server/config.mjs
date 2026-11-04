// config.mjs - the asset server's settings, from the environment.
//
//   ASSET_HOST            bind address (127.0.0.1). Anything else needs ASSET_ALLOW_PUBLIC=1
//   ASSET_PORT            port (8853)
//   ASSET_ALLOW_PUBLIC    1: allow a non-loopback bind (inside a container, behind Caddy/cloudflared)
//   ASSET_DIR             the asset folder (manifest.json + objects/); unset = no assets
//   ASSET_PREFIX          URL prefix of the asset routes (/assets/)
//   WEB_DIR               a static web root served at / (the launcher); unset = none
//   ASSET_CDN_BASE        objects come from this base URL instead (…/ that holds objects/)
//   ASSET_CDN_MODE        redirect (302, default) | proxy (fetched and streamed through)
//   ASSET_CORP            Cross-Origin-Resource-Policy of asset responses: same-origin (default),
//                         same-site, or cross-origin (assets on another origin than the page)
//   ASSET_RATE_RPS        requests per second per client (50), ASSET_RATE_BURST (200)
//   ASSET_TRUST_PROXY     1: the client is the X-Forwarded-For entry ASSET_TRUST_PROXY_HOPS (1)
//                         from the right (only behind your own proxy)
//   ASSET_COMPRESS        0 turns gzip/brotli off (1)
//   ASSET_CSP_CONNECT     extra connect-src sources for the launcher page's CSP
//                         (e.g. ws://127.0.0.1:8854 for a hub on another port)
//   ASSET_BUCKET_DIR      R2 stand-in: serve a versioned bucket tree (out/r2: latest.json,
//                         v/<version>/...) at / the way R2 does (instead of ASSET_DIR/WEB_DIR)
//   ASSET_BUCKET_PLAN     its upload plan (Cache-Control and Content-Type per key;
//                         default <ASSET_BUCKET_DIR>/../r2-upload-plan.json)
//   ASSET_BUCKET_CORS     the bucket's CORS policy (default deploy/r2-cors.json)
//   ASSET_BUCKET_CORS_ORIGINS  extra allowed origins (local tests: the local site's origin)
//   ASSET_TEST_HOOKS      1: /__test/* (stats, cut, corrupt, throttle) - local tests only
//   ASSET_SKIP_SCAN       1: skip the start-up scan (never in production; tests of the server itself)
export const isLoopback = (h) => h === '127.0.0.1' || h === '::1' || h === 'localhost';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const flag = (v) => v === '1' || v === 'true' || v === 'yes';

export function loadConfig(env = process.env) {
  const prefix = '/' + String(env.ASSET_PREFIX ?? '/assets/').split('/').filter(Boolean).join('/') + '/';
  const cdnBase = env.ASSET_CDN_BASE ? (env.ASSET_CDN_BASE.endsWith('/') ? env.ASSET_CDN_BASE : env.ASSET_CDN_BASE + '/') : null;
  if (cdnBase && !/^https?:\/\//.test(cdnBase)) throw new Error('ASSET_CDN_BASE must be an http(s) URL');
  const cdnMode = env.ASSET_CDN_MODE ?? 'redirect';
  if (!['redirect', 'proxy'].includes(cdnMode)) throw new Error('ASSET_CDN_MODE must be redirect or proxy');
  const corp = env.ASSET_CORP ?? 'same-origin';
  if (!['same-origin', 'same-site', 'cross-origin'].includes(corp)) throw new Error('ASSET_CORP must be same-origin, same-site or cross-origin');
  const connect = String(env.ASSET_CSP_CONNECT ?? '').split(/\s+/).filter((s) => /^(wss?|https?):\/\/[\w.:[\]-]+\/?$/.test(s));
  return {
    host: env.ASSET_HOST ?? '127.0.0.1',
    port: num(env.ASSET_PORT, 8853),
    allowPublic: flag(env.ASSET_ALLOW_PUBLIC),
    assetDir: env.ASSET_DIR || null,
    assetPrefix: prefix === '//' ? '/' : prefix,
    webDir: env.WEB_DIR || null,
    cdnBase, cdnMode,
    assetCorp: corp,
    rateRps: num(env.ASSET_RATE_RPS, 50),
    rateBurst: num(env.ASSET_RATE_BURST, 200),
    trustProxy: flag(env.ASSET_TRUST_PROXY),
    trustProxyHops: Math.max(1, num(env.ASSET_TRUST_PROXY_HOPS, 1)),
    compress: env.ASSET_COMPRESS === undefined ? true : flag(env.ASSET_COMPRESS),
    compressCacheBytes: num(env.ASSET_COMPRESS_CACHE_MB, 64) * 1048576,
    bucketDir: env.ASSET_BUCKET_DIR || null,
    bucketPlan: env.ASSET_BUCKET_PLAN || null,
    bucketCors: env.ASSET_BUCKET_CORS || null,
    bucketCorsOrigins: String(env.ASSET_BUCKET_CORS_ORIGINS ?? '').split(/\s+/).filter((o) => /^https?:\/\/[\w.:[\]-]+$/.test(o)),
    testHooks: flag(env.ASSET_TEST_HOOKS),
    skipScan: flag(env.ASSET_SKIP_SCAN),
    csp: ["default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self'", "img-src 'self' blob: data:",
      `connect-src 'self' ${connect.join(' ')}`.trim(), "worker-src 'self'", "base-uri 'none'", "form-action 'none'",
      "frame-ancestors 'none'", "object-src 'none'"].join('; '),
  };
}
