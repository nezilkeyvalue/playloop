// lib/runtime/music.ts
//
// Per-template background music, synthesised the same way the one-shot cues
// in audio.ts are: a step sequencer over oscillators, no audio files. Same
// payoff — nothing to host, nothing that can 404 or arrive late mid-game,
// works offline and in CI — and here it buys one more thing a loop of
// recorded audio can't: the bed is DATA, so giving a new template its own
// music is a table entry, not an asset pipeline.
//
// `audio.ts` owns the AudioContext and the mute state; this file only knows
// how to turn a `MusicBed` into scheduled notes on a gain node it's handed.
//
// Two things to understand before editing:
//
// 1. **Music is scheduled ahead, not played per frame.** Web Audio has its
//    own high-resolution clock and `requestAnimationFrame` is nowhere near
//    steady enough to place notes on — jitter that is invisible in a sprite
//    position is plainly audible as a stumbling beat. So a coarse timer
//    wakes up every SCHEDULER_TICK_MS and schedules every note that falls
//    inside the next LOOKAHEAD_SEC, and the notes themselves are timed by
//    the audio clock. This is the standard Web Audio scheduling pattern and
//    the reason the beat stays solid while the game is dropping frames.
// 2. **It must sit UNDER the cues.** A background bed that masks the
//    success/fail feedback is worse than no music: those cues are game
//    state, the bed is atmosphere. Hence a separate gain bus at
//    MUSIC_VOLUME, well below the cue bus, plus the duck on every cue (see
//    `duck()`).

import type { TemplateId } from "@/lib/engine/types";

/** How often the scheduler wakes. Coarse on purpose — it only decides WHAT
 * to schedule; the audio clock decides when each note actually sounds. */
const SCHEDULER_TICK_MS = 60;

/** How far ahead notes are scheduled. Must comfortably exceed
 * SCHEDULER_TICK_MS so a late timer callback can't leave a gap. */
const LOOKAHEAD_SEC = 0.35;

/** Background level, relative to the music bus's own parent. Deliberately
 * low: see note 2 above. */
const MUSIC_VOLUME = 0.5;

/** If the scheduler wakes to find itself this far behind — a backgrounded
 * tab, where timers are throttled to ~1/sec — it resyncs to the present
 * instead of scheduling the whole backlog. Without this, returning to a tab
 * left open for a minute dumps hundreds of simultaneous notes. */
const RESYNC_THRESHOLD_SEC = 1.0;

/** Semitone offsets from the bed's root. */
type Scale = readonly number[];

const MINOR: Scale = [0, 2, 3, 5, 7, 8, 10];
const MAJOR: Scale = [0, 2, 4, 5, 7, 9, 11];
const DORIAN: Scale = [0, 2, 3, 5, 7, 9, 10];
const PENTATONIC: Scale = [0, 3, 5, 7, 10];

interface Voice {
  wave: OscillatorType;
  /** Peak gain within the music bus, 0..1. */
  gain: number;
  /** One entry per step. `null` is a rest. Numbers are scale degrees,
   * relative to the current bar's chord root; they may exceed the scale
   * length and wrap into higher octaves. */
  pattern: readonly (number | null)[];
  /** Note length as a multiple of one step. <1 staccato, >1 overlapping. */
  hold: number;
  /** Octave offset applied on top of the scale degree. */
  octave: number;
}

export interface MusicBed {
  bpm: number;
  /** Root frequency in Hz — the tonic of the whole bed. */
  root: number;
  scale: Scale;
  /** Chord root per bar, as a scale degree. Length = bars before it loops. */
  progression: readonly number[];
  /** Steps per bar. 8 = eighths, 16 = sixteenths. */
  stepsPerBar: number;
  voices: readonly Voice[];
}

function hz(root: number, scale: Scale, degree: number, octave: number): number {
  // Degrees wrap into octaves rather than clamping, so a pattern can walk
  // upward past the top of the scale and keep making musical sense.
  const len = scale.length;
  const wrapped = ((degree % len) + len) % len;
  const octaveShift = Math.floor(degree / len) + octave;
  const semis = (scale[wrapped] ?? 0) + octaveShift * 12;
  const f = root * Math.pow(2, semis / 12);
  return Number.isFinite(f) ? Math.max(20, Math.min(12000, f)) : root;
}

// ---------------------------------------------------------------------------
// The beds. One per template, and a COMPLETE Record<TemplateId, …> on
// purpose: a new TemplateId without a bed is then a compile error rather
// than silence nobody notices. That is the same trap that let every
// template after `shooter` quietly fall through the switch in
// lib/engine/scoreCeiling.ts, so it is worth the two lines here.
//
// Each bed wants a recognisable identity, because the same eleven games get
// embedded on eleven different storefronts: tempo, mode and timbre do most
// of that work. Keep them sparse — this plays under gameplay for 40 seconds
// and anything busy becomes irritating on the third replay.
// ---------------------------------------------------------------------------

export const MUSIC_BEDS: Record<TemplateId, MusicBed> = {
  // Bright and bouncy — things are falling and it's cheerful about it.
  catch: {
    bpm: 112,
    root: 196, // G3
    scale: MAJOR,
    progression: [0, 5, 3, 4],
    stepsPerBar: 8,
    voices: [
      { wave: "triangle", gain: 0.5, octave: -1, hold: 0.9, pattern: [0, null, 4, null, 2, null, 4, null] },
      { wave: "sine", gain: 0.24, octave: 1, hold: 1.4, pattern: [7, null, null, 5, null, 4, null, null] },
    ],
  },
  // Sparse, suspended, quiz-show hesitation. Almost no rhythm on purpose:
  // the player is reading a price and thinking.
  guess_price: {
    bpm: 84,
    root: 175, // F3
    scale: MAJOR,
    progression: [0, 4, 5, 4],
    stepsPerBar: 8,
    voices: [
      { wave: "sine", gain: 0.42, octave: -1, hold: 3.2, pattern: [0, null, null, null, null, null, null, null] },
      { wave: "triangle", gain: 0.18, octave: 1, hold: 1.1, pattern: [null, null, 4, null, null, null, 2, null] },
    ],
  },
  // Rolling sixteenths — puzzle momentum without urgency.
  chain_pop: {
    bpm: 100,
    root: 220, // A3
    scale: DORIAN,
    progression: [0, 3, 5, 2],
    stepsPerBar: 16,
    voices: [
      { wave: "triangle", gain: 0.44, octave: -1, hold: 0.8, pattern: [0, null, null, 0, null, null, 4, null, 0, null, null, 0, null, 4, null, null] },
      { wave: "sine", gain: 0.2, octave: 1, hold: 0.7, pattern: [null, 2, null, 4, null, 6, null, 4, null, 2, null, 4, null, null, 6, null] },
    ],
  },
  // Chase-y and mechanical, a nod to what a pellet-eating game sounds like.
  chomp: {
    bpm: 132,
    root: 165, // E3
    scale: MINOR,
    progression: [0, 0, 5, 5],
    stepsPerBar: 16,
    voices: [
      { wave: "square", gain: 0.26, octave: -1, hold: 0.55, pattern: [0, null, 3, null, 4, null, 3, null, 0, null, 3, null, 4, null, 6, null] },
      { wave: "triangle", gain: 0.18, octave: 1, hold: 0.6, pattern: [null, null, null, 7, null, null, null, 5, null, null, null, 7, null, null, null, 9] },
    ],
  },
  // Oom-pah fairground. Whack-a-mole is a carnival game.
  whack: {
    bpm: 124,
    root: 147, // D3
    scale: MAJOR,
    progression: [0, 0, 4, 4],
    stepsPerBar: 8,
    voices: [
      { wave: "triangle", gain: 0.5, octave: -1, hold: 0.7, pattern: [0, null, 4, null, 0, null, 4, null] },
      { wave: "square", gain: 0.14, octave: 1, hold: 0.5, pattern: [null, 7, null, 7, null, 9, null, 7] },
    ],
  },
  // Near-silent pad. simon pitches its pads as the actual mechanic (see
  // simon.ts), so anything more here would fight the thing being memorised.
  simon: {
    bpm: 72,
    root: 131, // C3
    scale: MAJOR,
    progression: [0, 0, 3, 3],
    stepsPerBar: 4,
    voices: [
      { wave: "sine", gain: 0.34, octave: -1, hold: 4.0, pattern: [0, null, null, null] },
    ],
  },
  // Taut and percussive — quick reflexes, blades.
  slice: {
    bpm: 128,
    root: 233, // Bb3
    scale: PENTATONIC,
    progression: [0, 2, 3, 1],
    stepsPerBar: 16,
    voices: [
      { wave: "triangle", gain: 0.42, octave: -1, hold: 0.5, pattern: [0, null, null, 2, null, null, 0, null, null, 3, null, null, 2, null, null, null] },
      { wave: "sine", gain: 0.16, octave: 1, hold: 0.8, pattern: [4, null, null, null, null, null, 3, null, null, null, null, null, 4, null, null, null] },
    ],
  },
  // Low drone + slow high line: space, not action-movie.
  shooter: {
    bpm: 96,
    root: 110, // A2
    scale: MINOR,
    progression: [0, 0, 5, 4],
    stepsPerBar: 8,
    voices: [
      { wave: "sawtooth", gain: 0.14, octave: 0, hold: 4.0, pattern: [0, null, null, null, null, null, null, null] },
      { wave: "sine", gain: 0.24, octave: 2, hold: 1.6, pattern: [null, null, 4, null, null, 6, null, null] },
    ],
  },
  // Tick-tock precision. The game is about timing, so the bed is a metronome
  // with a tune attached.
  sweet_spot: {
    bpm: 108,
    root: 208, // G#3
    scale: MAJOR,
    progression: [0, 4, 5, 3],
    stepsPerBar: 8,
    voices: [
      { wave: "triangle", gain: 0.4, octave: -1, hold: 0.6, pattern: [0, null, null, null, 4, null, null, null] },
      { wave: "sine", gain: 0.2, octave: 1, hold: 0.9, pattern: [null, null, 2, null, null, null, 6, null] },
    ],
  },
  // Driving and forward-leaning — the one game with constant motion.
  runner: {
    bpm: 144,
    root: 185, // F#3
    scale: MINOR,
    progression: [0, 0, 3, 5],
    stepsPerBar: 16,
    voices: [
      { wave: "square", gain: 0.2, octave: -1, hold: 0.5, pattern: [0, null, 0, null, 4, null, 0, null, 0, null, 0, null, 5, null, 4, null] },
      { wave: "triangle", gain: 0.22, octave: 1, hold: 0.7, pattern: [null, 4, null, null, null, 6, null, null, null, 4, null, null, null, 7, null, null] },
    ],
  },
  // Warm, unhurried lounge. Pouring a drink is not a race.
  pour: {
    bpm: 88,
    root: 156, // Eb3
    scale: DORIAN,
    progression: [0, 3, 4, 3],
    stepsPerBar: 8,
    voices: [
      { wave: "sine", gain: 0.46, octave: -1, hold: 2.0, pattern: [0, null, null, null, 4, null, null, null] },
      { wave: "triangle", gain: 0.16, octave: 1, hold: 1.2, pattern: [null, null, 6, null, null, 4, null, 2] },
    ],
  },
  // Reserved TemplateIds. No runtime module exists for these yet, so these
  // entries are never reached — they exist so the Record stays complete and
  // adding a real module for either doesn't need a music change too.
  match: {
    bpm: 96,
    root: 175,
    scale: MAJOR,
    progression: [0, 3, 4, 0],
    stepsPerBar: 8,
    voices: [{ wave: "sine", gain: 0.4, octave: -1, hold: 2.0, pattern: [0, null, 4, null, 2, null, 4, null] }],
  },
  stack: {
    bpm: 104,
    root: 165,
    scale: MINOR,
    progression: [0, 4, 3, 4],
    stepsPerBar: 8,
    voices: [{ wave: "triangle", gain: 0.4, octave: -1, hold: 1.2, pattern: [0, null, null, 4, null, null, 2, null] }],
  },
};

export interface MusicController {
  /** Idempotent: starting an already-playing bed is a no-op, so a replay
   * can call it without stacking a second sequencer. */
  start(bed: MusicBed): void;
  stop(): void;
  /** Briefly dip the bed so a cue cuts through. Called by audio.ts on every
   * cue; safe when nothing is playing. */
  duck(): void;
  isPlaying(): boolean;
  destroy(): void;
}

export function createMusic(ctx: AudioContext, destination: AudioNode): MusicController {
  const bus = ctx.createGain();
  bus.gain.value = MUSIC_VOLUME;
  bus.connect(destination);

  let timer: ReturnType<typeof setInterval> | null = null;
  let bed: MusicBed | null = null;
  let step = 0;
  let nextStepTime = 0;
  // Every oscillator scheduled but not yet finished, so stop() can silence
  // the notes already sitting in the lookahead window instead of letting up
  // to LOOKAHEAD_SEC of music play on over the reward screen.
  const live = new Set<OscillatorNode>();

  function scheduleStep(atTime: number): void {
    const b = bed;
    if (!b) return;
    const bar = Math.floor(step / b.stepsPerBar) % b.progression.length;
    const chordRoot = b.progression[bar] ?? 0;
    const stepInBar = step % b.stepsPerBar;
    const stepDur = (60 / b.bpm) * (4 / b.stepsPerBar);

    for (const voice of b.voices) {
      const degree = voice.pattern[stepInBar % voice.pattern.length];
      if (degree === null || degree === undefined) continue;
      try {
        const osc = ctx.createOscillator();
        const env = ctx.createGain();
        osc.type = voice.wave;
        osc.frequency.value = hz(b.root, b.scale, chordRoot + degree, voice.octave);

        const dur = Math.max(0.05, stepDur * voice.hold);
        const attack = Math.min(0.03, dur * 0.25);
        // Exponential ramps, never a direct assignment: a stepped gain
        // clicks at both ends of every note, which at 144bpm is a rattle.
        env.gain.setValueAtTime(0.0001, atTime);
        env.gain.exponentialRampToValueAtTime(voice.gain, atTime + attack);
        env.gain.exponentialRampToValueAtTime(0.0001, atTime + dur);

        osc.connect(env);
        env.connect(bus);
        live.add(osc);
        osc.onended = () => {
          live.delete(osc);
          try {
            env.disconnect();
            osc.disconnect();
          } catch {
            // Context already closed; nothing left to release.
          }
        };
        osc.start(atTime);
        osc.stop(atTime + dur + 0.02);
      } catch {
        // One bad note must never stop the sequencer.
      }
    }
  }

  function tick(): void {
    const b = bed;
    if (!b || ctx.state !== "running") return;
    const stepDur = (60 / b.bpm) * (4 / b.stepsPerBar);

    // Throttled-timer guard, see RESYNC_THRESHOLD_SEC.
    if (nextStepTime < ctx.currentTime - RESYNC_THRESHOLD_SEC) {
      nextStepTime = ctx.currentTime + 0.05;
    }

    while (nextStepTime < ctx.currentTime + LOOKAHEAD_SEC) {
      scheduleStep(nextStepTime);
      nextStepTime += stepDur;
      step += 1;
    }
  }

  function start(next: MusicBed): void {
    if (bed === next && timer !== null) return; // already running this bed
    stop();
    bed = next;
    step = 0;
    nextStepTime = ctx.currentTime + 0.08;
    try {
      bus.gain.cancelScheduledValues(ctx.currentTime);
      bus.gain.setValueAtTime(MUSIC_VOLUME, ctx.currentTime);
    } catch {
      bus.gain.value = MUSIC_VOLUME;
    }
    tick(); // fill the first window now rather than waiting a tick
    timer = setInterval(tick, SCHEDULER_TICK_MS);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    bed = null;
    for (const osc of [...live]) {
      try {
        osc.stop();
      } catch {
        // Never started, or the context is gone.
      }
    }
    live.clear();
  }

  function duck(): void {
    if (!bed) return;
    try {
      const now = ctx.currentTime;
      bus.gain.cancelScheduledValues(now);
      bus.gain.setValueAtTime(bus.gain.value, now);
      bus.gain.linearRampToValueAtTime(MUSIC_VOLUME * 0.45, now + 0.03);
      bus.gain.linearRampToValueAtTime(MUSIC_VOLUME, now + 0.28);
    } catch {
      // Ducking is pure polish — if the ramp is rejected, leave the level.
    }
  }

  function destroy(): void {
    stop();
    try {
      bus.disconnect();
    } catch {
      // Already disconnected with the context.
    }
  }

  return { start, stop, duck, isPlaying: () => bed !== null, destroy };
}
