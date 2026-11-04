// Written by the site's tools/sync-play.mjs (do not edit): this is the project
// site's copy of the game page. See web/host/deploy.js in atvrecomp.
export const DEPLOY = {
  "mode": "site",
  "host": {
    "atvrecomp": "00e0aa98f0e4360b83ab80c9188819e346bb3ffd"
  },
  "builds": [
    {
      "builder": "0.4.0",
      "atvrecomp": "0923f0fe51d94a057e8ee28590b022262cfb4609",
      "xboxrecomp": "975ef5ff918399e6d07c95dc4358a5f416481be5",
      "wasiSdk": "34.0",
      "wasm": {
        "size": 22125567,
        "sha256": "89698d4dd38158e43efbd900e10e21400de75045b6584b32161d52306c52508e"
      }
    }
  ],
  "links": {
    "setup": "../../setup.html#builder",
    "site": "../../index.html"
  }
};
export const SITE = DEPLOY.mode === 'site';
