# ATV 2 save files: what we know

Notes on the save files of ATV Quad Power Racing 2 (Xbox, USA, title id `4143000a`) as written by the
recompiled game, worked out from our own test saves. The Stats page (`js/atvsave.js`) reads them this way.
Everything below is our own description. Where we are not sure, it says so.

Status words used here:

- **confirmed**: checked against several files and consistent with what the game showed when they were made.
- **likely**: the value fits, but we have not checked it against the game's screens.
- **unknown**: we can read it but do not know what it means.

## Where the files are

| Where | Layout |
|---|---|
| Browser build, "Download backup" | a zip: `atv2-saves.json` (a manifest the local page writes), `UDATA/4143000a/<save>/...`, `TDATA/4143000a/...` |
| Windows build | the save folder (default `%LOCALAPPDATA%\xboxrecomp`, or `RECOMP_SAVE_DIR`): the same `UDATA\4143000a\<save>\...`, next to large disk-image and cache files that are not saves |

Inside `UDATA/4143000a/`:

| File | What it is | Status |
|---|---|---|
| `<save>/SaveMeta.xbx` | the save's display name for the console's memory manager: UTF-16LE with a BOM, `Name=<text>` lines | confirmed |
| `<save>/Rider Data` | one player profile (one save folder per profile) | confirmed |
| `<save>/Records` | the records shared by every profile (one save folder) | confirmed |
| `TitleMeta.xbx` | the title's name for the memory manager (UTF-16LE `TitleName=`) | confirmed |
| `SaveImage.xbx`, `TitleImage.xbx` | icons for the memory manager (images) | not read |

`<save>` is a 12-hex-digit folder name chosen by the game.

## The container

Both `Rider Data` and `Records` use the same tagged format. All numbers are little-endian.

```
offset 0      u32 header        0x00020040 in every file we have        (unknown)
offset 4      the tree          one object, the root
end - 20      20 bytes          trailer; changes when the content changes (likely a signature)
```

The tree is a stream of 32-bit words:

- `BEGIN` = `0xCDAB0DF0` (bytes `f0 0d ab cd`), then a 4-byte **key**: opens an object.
- `END` = `0xBADCADDE` (bytes `de ad dc ba`): closes the latest object.
- anything else is a **field**: a 4-byte key followed by its value.

Objects nest. The value's type and size are **not stored**; they depend on the field:

| Kind | Bytes | Seen for |
|---|---|---|
| 32-bit | 4 | integers, flags, bit masks, and 32-bit floats (most fields) |
| string | u16 length, then that many bytes (Latin-1, no terminator) | names, character and vehicle ids |
| byte | 1 | rider and ATV numbers inside record entries |

Because sizes are implicit, our reader tries the possible sizes and backtracks: the only arrangement
that ends exactly on the root's `END` followed by the 20-byte trailer is the right one. On our test files
this takes a few milliseconds and re-encoding the parsed tree reproduces every byte before the trailer.

### Keys

A key is the CRC-32 of the field's name in the game's code: the common reflected CRC-32 (polynomial
`0xEDB88320`, initial value `0xFFFFFFFF`) **without** the final XOR. Lists use the name with an index
appended (`...0`, `...1`, ...), so each element has its own key. We publish only the numbers, with our own
ids (`js/save-keys.js`); the ids below are ours.

## Profile (`Rider Data`)

Root (`0x4939A99A`) holds:

| Our id | Key | Value | Status |
|---|---|---|---|
| fileVersion | `0x48E65B4B` | float, 1.0 | confirmed (constant) |
| version | `0x8F5E15A0` | float, 3.4 | confirmed (constant) |
| player → name | `0x604A80AC` → `0x01EE2EC7` | string: the profile name as typed in the game | confirmed |
| settings | `0xE3CC3D6C` | object, see below | |
| unlockables → unlockables | `0x9C788EA5` (twice, nested) | object, see below | |
| customRider | `0x0EB0F7FF` | object: the profile's rider, see below | |
| careerData → careerData | `0xE2B5E565` (twice) | object: the championship in progress | |
| arcadeData → arcadeData | `0x2ECFC67D` (twice) | object: arcade progress | partly unknown |
| fsChallengeData | `0x7EAC580D` | object: 12 freestyle-challenge medals | |
| cheat | `0xBD8E139F` | object with one string field (key unknown): `"0"` normally, a code word when the profile was named with one | likely |
| (unknown) | `0xB34D06CB` | 32-bit, 1 in all files | unknown |

### Rider (`customRider`)

| Our id | Key | Value | Status |
|---|---|---|---|
| riderId | `0x0216A892` | string: the chosen rider character's id | confirmed |
| attrAbility, attrTechnique, attrAggression, attrStrength | `0xF575EFD9`, `0x6C067951`, `0x20BCA129`, `0xEF75826B` | objects, each: `attrValue` `0xE0C3C2F5` (int, 0-5 seen) and `attrFraction` `0xD6D1AAFB` (float) | confirmed (names), likely (range 0-5) |
| skillPoints | `0x50CA9EF2` | int | confirmed |
| skillLevel | `0xE2A0F134` | int, 1 for a new profile, 7 seen at most | confirmed |
| lastAtv | `0xAB076393` | string: the id of the ATV used last | confirmed |

### Unlocks

| Our id | Key | Value | Status |
|---|---|---|---|
| tracksUnlocked | `0x75A4355F` | bit mask, 19 tracks (new profile: 3 bits; everything unlocked: `0x7FFFF`) | confirmed (count); bit N = track number N is likely |
| ridersUnlocked | `0x750570E1` | bit mask, 24 riders (new profile `0x3FFC00`, all `0xFFFFFF`) | confirmed (count) |
| vehiclesUnlocked | `0xED65C814` | bit mask, 11 ATVs (new profile 3 bits, all `0x7FF`) | confirmed (count) |
| qualifyingUnlocked, professionalUnlocked, customUnlocked | `0x76406950`, `0x633AAA39`, `0x01AF3E19` | 0 or 1: championship tiers open | confirmed |
| musicLockedOut | `0x0E6C102F` | int, 0 in all files | unknown |

### Medals

| Our id | Where | Value | Status |
|---|---|---|---|
| fsMedal[0..11] | in fsChallengeData | -1 = none; 0, 1, 2 = a medal. A profile with everything unlocked has 2 in all twelve, so 2 is probably the best (gold) | likely |
| champMedal[0..2] | in careerData → careerInfo | -1 = none; otherwise as above | likely |

### Career (championship in progress)

| Our id | Value | Status |
|---|---|---|
| champType | string: the championship tier's id | confirmed |
| round, trackCount | ints | confirmed (names), meaning likely |
| track[0..18] | track number of each round, -1 = unused | likely |
| trackLaps[0..18] | laps per round (3 in every file) | likely |
| careerInfo → trackPosition[0..18] | finishing place per round, -1 = not raced (0-based) | likely |
| careerInfo → trackTimes[0..18] | float, seconds | likely |
| careerInfo → trackPoints[0..18] | int | likely |
| champInfo[0..7] | 8 objects, one per racer: riderType, vehicleType (strings, the text `None` when empty), championship points, rank, last race place, and 19 more string fields | names confirmed; the 19 strings unknown |

### Settings (per profile)

| Our id | Value | Status |
|---|---|---|
| volume[0..3] | objects with `setting` (float, 1.0 = full) | four volume sliders; which is which: unknown |
| track[0..7], playlistOption[0..3] (inside settings) | `setting` ints 0-7 / 0-1 | likely music playlist; unknown |
| camera[0..14] | objects with `enable` 0/1 | unknown |
| trackInc, numCameras, startCamera | ints (-1, 4, 4) | unknown |
| slot[0..3] | objects with `shocks` 0/1 and `btnLayout` int, one per controller port | shocks = vibration is likely; layout index unknown |

### Arcade

`arcadeData` holds a round counter, 8 player objects (a type string, rounds survived, grid position),
24 drop-out ints and 15 ATV-used strings. Stats shows only the round; the rest is unknown.

## Records (`Records`)

Root holds four objects:

| Our id | Content | Status |
|---|---|---|
| freestyle | `fsRecord[m][r]`: 5 time options × 3 places. Each entry: `record` (float score), `name` (string), `riderType` (byte), `vehicleType` (byte) | confirmed layout; the 5 options being the 1/3/5/10-minute and unlimited sessions is likely |
| timeTrial | `timeTrial[t][r]`: 19 tracks × 5 places, entries as above with a time in seconds. An empty place has rider and ATV 255 and a placeholder time | confirmed layout; lap time or run time unknown |
| trackRecords | one object per track, keyed by the track's own key (`trackName[0..18]`), each with `trackRecord[0..4]` entries | confirmed layout; record 0 is a time in seconds (likely); records 1-4 unknown (their values look like a speed, a distance and two durations) |
| settings → lastProfile | int: the profile used last | likely |

A new `Records` file comes with the game's default entries in every table. Stats shows them as they are;
results set by the player replace them.

## Track numbers

The game numbers its 19 tracks 0-18: five environments with three tracks each (0-14, in the order
dunes, forest, swamp, industrial, glacier; tracks 0-4 are the first of each, 5-9 the second, 10-14 the
third), then four stadiums (15-18). Stats labels them with our own short labels such as "Dunes 1" or
"Stadium 2", not the in-game track titles.

## Not read

The trailer is not checked. `SaveImage.xbx` and `TitleImage.xbx` are never shown. The Stats page never
writes files.
