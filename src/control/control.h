/*
 * control.h -- a local test channel into the running title (RECOMP_CONTROL).
 *
 * RECOMP_CONTROL=<port> opens a TCP listener on 127.0.0.1:<port> (loopback
 * only; anything else is refused). One connection at a time, one text command
 * per line, one JSON line back per command. See CONTROL.md for the commands.
 */
#ifndef ATV2_CONTROL_H
#define ATV2_CONTROL_H

/* Start the listener if RECOMP_CONTROL is set. Call once after the guest
 * memory is mapped. */
void atv2_control_init(void);

/* Once per flip, from the GPU recorder's flip (after the frame is consumed).
 * Counts frames, measures fps, advances the pad's frame clock, and holds the
 * flip while the channel has the title paused. `draws` is the frame's draw
 * count. Cheap and inert when the channel is off. */
void atv2_control_frame(unsigned draws);

#endif
