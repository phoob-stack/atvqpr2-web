/*
 * game_values.h -- named ATV 2 (retail) values for the control channel's `state`.
 *
 * Each entry is a guest address, optionally reached through pointers: start
 * at `base`, and for each of the `nptr` hops read a u32 there and add off[i].
 * The value read is then `value * scale + bias` (scale 0 = 1).
 *
 * Types: b u8, h u16, w u32, i i32, f f32, v vec3 of f32 (reported as an
 * array), m length of a vec3 of f32.
 *
 * `verified` = confirmed in play (2026-11-02, single race on Dunes: Lagoon):
 *   track_index, race_laps  scanned on TRACK SELECT (left/right, X/Y) and
 *                           matched against the screen;
 *   race_time               0 from race load, runs from the countdown, stops
 *                           in the pause menu, 0 again after RESTART;
 *   laps_completed / lap    0 -> 1 -> 2 as the player crossed the line twice
 *                           (HUD 1/3 -> 2/3 -> 3/3); writing 0 made the HUD
 *                           show 1/3;
 *   player_pos / player_vel the player's racer object: position constant while
 *                           the player idled and the AI objects moved; vel ==
 *                           d(pos)/dt measured by stepping one frame;
 *   speed_mph               |vel| * 2.237 == the speedometer (48.6 vs 48);
 *   racerN_pos              the 7 AI racer objects, positions follow the AI
 *                           round the track.
 * race_position is NOT verified: it reads 8 while the HUD says 8TH and the
 * game rewrites it every frame, but no change of place was observed.
 *
 * The racer table at 0x1D752C (8 x {object, 2500.0, 10000.0, d^2, ...},
 * stride 0x18) belongs to the engine-sound manager at 0x1D7528 (distances to
 * the camera); entry 0 is the player in a single race. The player's race
 * progress object is at *0x1D8634 (also racer object +0x478); AI racers' +0x478
 * point at something else.
 */
#ifndef ATV2_GAME_VALUES_H
#define ATV2_GAME_VALUES_H

#include <stdint.h>

typedef struct {
    const char *name;
    uint32_t    base;
    int         nptr;
    uint32_t    off[4];
    char        type;
    double      scale, bias;
    int         verified;
    const char *note;
} Atv2Value;

#define RACER(i) 0x1D752Cu + (i) * 0x18u

static const Atv2Value k_atv2_values[] = {
    { "track_index", 0x1D8654, 0, {0}, 'w', 0, 0, 1, "TRACK SELECT cursor; 0 = Dunes: Lagoon" },
    { "race_laps", 0x1D865C, 0, {0}, 'w', 0, 0, 1, "laps chosen on TRACK SELECT" },
    { "race_time", 0x1DA05C, 0, {0}, 'f', 0, 0, 1, "s; 0 from race load, runs from the countdown, stops when paused" },
    { "laps_completed", 0x1D8634, 1, {0x4C4}, 'w', 0, 0, 1, "player progress object +0x4C4" },
    { "lap", 0x1D8634, 1, {0x4C4}, 'w', 0, 1, 1, "HUD lap = laps_completed + 1" },
    { "race_position", 0x1D8634, 1, {0x4E0}, 'w', 0, 0, 0, "UNVERIFIED: 8 while HUD shows 8TH; rewritten every frame" },
    { "player_pos", RACER(0), 1, {0x70}, 'v', 0, 0, 1, "x y z (y up), metres" },
    { "player_vel", RACER(0), 1, {0x7C}, 'v', 0, 0, 1, "m/s" },
    { "speed_ms", RACER(0), 1, {0x7C}, 'm', 0, 0, 1, "|player_vel|" },
    { "speed_mph", RACER(0), 1, {0x7C}, 'm', 2.237, 0, 1, "matches the speedometer" },
    { "racer1_pos", RACER(1), 1, {0x70}, 'v', 0, 0, 1, "AI racer 1" },
    { "racer2_pos", RACER(2), 1, {0x70}, 'v', 0, 0, 1, "AI racer 2" },
    { "racer3_pos", RACER(3), 1, {0x70}, 'v', 0, 0, 1, "AI racer 3" },
    { "racer4_pos", RACER(4), 1, {0x70}, 'v', 0, 0, 1, "AI racer 4" },
    { "racer5_pos", RACER(5), 1, {0x70}, 'v', 0, 0, 1, "AI racer 5" },
    { "racer6_pos", RACER(6), 1, {0x70}, 'v', 0, 0, 1, "AI racer 6" },
    { "racer7_pos", RACER(7), 1, {0x70}, 'v', 0, 0, 1, "AI racer 7" },
    { NULL, 0, 0, {0}, 0, 0, 0, 0, NULL }
};

#undef RACER
#endif
