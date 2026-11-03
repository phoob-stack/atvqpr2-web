// Where this copy of the page runs.
//
//   mode 'local'  web/host/serve.mjs on 127.0.0.1 (play-browser.cmd, the
//                 builder): the game module comes from the server
//                 (/wasm/atv2.wasm = build-wasm/), and with --game the game
//                 files too (/data/). This file, as it is in the repository.
//   mode 'site'   the project site's copy of the page (/play/host/). The site
//                 serves only this page's own code: the player picks the
//                 folder their builder made (their game files plus the
//                 atv2.wasm built from them), and build.js checks that module
//                 against `builds` and keeps it in this browser's storage.
//                 The site's tools/sync-play.mjs writes the site's version of
//                 this file: { mode: 'site', host: {...}, builds: [...], links }.
//
// builds: the game modules this copy of the page works with (the same host
// ABI): [{ builder, atvrecomp, xboxrecomp, wasm: { size, sha256 } }]. Only
// hashes are listed: the module itself is never served by the site.
export const DEPLOY = { mode: 'local', builds: [] };
export const SITE = DEPLOY.mode === 'site';
