# 6. Deploy, update and roll back (Box Quad and Orbit)

This covers our test titles only. There is no command, target or key layout
for ATV 2 artifacts: `upload-r2.mjs` refuses an ATV 2 title, the gate refuses
an ATV 2 prefix, and ATV 2's profile has no remote source.

Run from the `delivery` folder of the workspace (PowerShell or Git Bash). wrangler
uses its own login; no credentials are read by these scripts.

## Build and check

```
node pipeline/build.mjs                         # out/: r2 tree (games/boxquad/, games/orbit/), upload plan, gate
node --test test/*.test.mjs
node test/r2-e2e.mjs --site ../site             # the site's test titles from a local R2 stand-in
node pipeline/upload-r2.mjs --dry-run           # every command, after every check; uploads nothing
```

## Upload (a release)

```
node pipeline/upload-r2.mjs                     # all titles: per title the files, its manifest, then games/<id>/latest.json
node pipeline/upload-r2.mjs --title orbit       # one title only
node pipeline/upload-r2.mjs --check             # read every key back over HTTPS (size, Cache-Control, Content-Type, CORS)
```

Each command is `npx wrangler r2 object put atvqpr2-assets/<key> --file <file>
--cache-control <cc> --content-type <ct> --remote`; the first failure stops
the run before that title's `latest.json`, so the live version stays.

## The move of Box Quad to `games/boxquad/` (one time)

The pipeline's Box Quad is `1.1.0-c230f2d0b4ba`, byte for byte the version
now at the bucket root. Uploading it under the prefix re-publishes 1.1.0:

```
node pipeline/build.mjs
node pipeline/upload-r2.mjs --title boxquad --dry-run
node pipeline/upload-r2.mjs --title boxquad
node pipeline/upload-r2.mjs --title orbit
node pipeline/upload-r2.mjs --check
```

Then deploy the site (below). Until `games/boxquad/latest.json` exists, the
site's Box Quad reads the root's `latest.json` (`remote.fallbackPrefix: ""`);
after it exists, players already holding 1.1.0 fetch only the new manifest
URL (0 file downloads, tested). The root objects (`latest.json`,
`v/1.1.0-c230f2d0b4ba/*`) stay until the owner deletes them; after that,
`fallbackPrefix` can be dropped from `profiles/boxquad.json` in a later
release.

## Update the site

```
cd ..\site
node tools/sync-delivery.mjs --check            # test-title/ matches delivery HEAD
node tools/sync-play.mjs --check                # play/ matches atvrecomp HEAD (after the asset-source merge)
```

Then, in Git Bash (a PowerShell 5.1 pipe would alter the tar bytes):

```
cd ../work/pubsite                              # (from site/) the deploy config (wrangler.jsonc) lives outside the site repo
rm -rf deploy && mkdir deploy && git -C ../../site archive HEAD | tar -x -C deploy
npx wrangler deploy --dry-run                   # then: npx wrangler deploy
```

## Roll back (per title)

```
node pipeline/upload-r2.mjs --rollback 1.1.0-c230f2d0b4ba --title boxquad --dry-run
node pipeline/upload-r2.mjs --rollback 1.1.0-c230f2d0b4ba --title boxquad
```

It reads that version's manifest from the bucket (or `--from <out/r2>`),
checks every file of the version is still there (HEAD, sizes), writes
`out/rollback/<id>/latest.json` and puts it as `games/<id>/latest.json`
(no-cache). Clients follow on their next start (tested on the stand-in: a
second release picked up with only its one changed file downloaded, then the
rollback followed with 0 file downloads).
