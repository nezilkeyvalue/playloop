// lib/runtime/audio.ts
//
// The runtime's sound service. One more shared service alongside stage.ts /
// loop.ts / input.ts: `mount.ts` owns the instance and hands game modules
// `ctx.sound`, so a template never touches `AudioContext` itself — the same
// reason they never touch the DOM or call `new Image()` (see
// docs/ADDING_A_TEMPLATE.md).
//
// Sounds are SYNTHESISED, not loaded. Every cue is a few oscillators with a
// gain envelope, which buys three things an audio-file pipeline would cost
// real work to get back: no network request (so a cue can never arrive late
// or 404 mid-game), nothing to host or cache-bust, and it works offline, in
// CI, and in the `/play/<fixture>` fixtures with no asset dependency at all.
//
// Two rules that shaped this file:
//
// 1. **Nothing may make a sound before a real user gesture.** Browsers
//    autoplay-block an AudioContext created outside one, and — more to the
//    point — this runtime is embedded in third-party storefronts, where
//    unsolicited noise is hostile. The context is created lazily by
//    `unlock()`, which mount.ts calls from the "Start playing" click and
//    nowhere else. Before that, `play()` is a no-op.
// 2. **Audio is never load-bearing.** Every entry point is wrapped and
//    total: no AudioContext (SSR, ancient browser, blocked by policy), a
//    throwing constructor, or a suspended context that never resumes all
//    degrade to silence. A game must play identically with sound broken,
//    so this file never throws and never reports failure upward.

import { createMusic, MUSIC_BEDS, type MusicController } from "@/lib/runtime/music";
import type { TemplateId } from "@/lib/engine/types";

/** The vocabulary a game module gets. Deliberately SEMANTIC ("success", not
 * "beep880"): the same cue should mean the same thing to a player across all
 * eleven templates, and the actual waveform stays tunable here without
 * touching a single game module. */
export type SoundCue =
  | "start" // a round begins
  | "success" // the player scored — a catch, a hit, a pop, a correct guess
  | "fail" // a miss, a hazard, a wrong answer, a life lost
  | "tick" // a neutral beat — a sequence step, a countdown, a spawn
  | "milestone" // progression — a streak, a level, a chain bonus
  | "jump" // the player left the ground
  | "land" // …and came back down
  | "gameOver" // the run ended
  | "reward"; // the reward reveal

export interface PlayOptions {
  /** Semitones to transpose the cue, for rising-combo feel. Clamped to
   * +/-24 so a runaway streak counter can't synthesise a 20kHz shriek. */
  semitones?: number;
}

export interface GameAudio {
  play(cue: SoundCue, options?: PlayOptions): void;
  /** Starts this template's background bed (lib/runtime/music.ts). Safe to
   * call repeatedly — starting the bed that is already playing is a no-op,
   * so a replay doesn't stack a second sequencer. No-op before unlock(). */
  startMusic(template: TemplateId): void;
  stopMusic(): void;
  /** 0..1, how intense the game is right now. Drives the bed's tempo for
   * templates that declare `intensityTempoScale` (lib/runtime/music.ts);
   * a no-op for the rest, so it's always safe to call. Cheap enough to
   * call every frame. */
  setMusicIntensity(value: number): void;
  setMuted(muted: boolean): void;
  isMuted(): boolean;
  /** Creates/resumes the AudioContext. MUST be called synchronously from a
   * real user gesture (a click/tap handler) or the browser will refuse. */
  unlock(): void;
  destroy(): void;
}

type Wave = OscillatorType;

interface Note {
  /** Frequency in Hz at the cue's base pitch. */
  hz: number;
  /** Optional glide target. With this set the note sweeps hz -> toHz across
   * its duration instead of holding a fixed pitch, which is what makes a
   * jump read as a jump — a whoosh is pitch MOVEMENT, and two static notes
   * played in sequence don't sound like one. */
  toHz?: number;
  /** Seconds after the cue starts. */
  at: number;
  /** Seconds. */
  dur: number;
  wave: Wave;
  /** Peak gain, 0..1, before the master volume. */
  peak: number;
}

// Master ceiling. Well below 1 on purpose: several cues can overlap (a
// success and a milestone land on the same frame in chain_pop), and
// summing oscillators at full scale clips audibly.
const MASTER_VOLUME = 0.22;

// A cue is cheap, but a game spamming one per frame is not. Cues are dropped
// while more than this many voices are already sounding — inaudible as a
// dropout, and it keeps a bad call site from turning into a buzzsaw.
const MAX_CONCURRENT_VOICES = 12;

const CUES: Record<SoundCue, Note[]> = {
  // Rising perfect fifth — "we're off".
  start: [
    { hz: 440, at: 0, dur: 0.1, wave: "triangle", peak: 0.5 },
    { hz: 660, at: 0.08, dur: 0.14, wave: "triangle", peak: 0.55 },
  ],
  // Short bright two-note ping. The workhorse; kept brief because it fires
  // most often and anything with a tail becomes mush at speed.
  success: [
    { hz: 784, at: 0, dur: 0.07, wave: "triangle", peak: 0.5 },
    { hz: 1047, at: 0.05, dur: 0.1, wave: "sine", peak: 0.42 },
  ],
  // Descending minor third on a softened square — reads as "no" without
  // the harshness of a raw buzz.
  fail: [
    { hz: 233, at: 0, dur: 0.11, wave: "square", peak: 0.2 },
    { hz: 175, at: 0.09, dur: 0.16, wave: "triangle", peak: 0.3 },
  ],
  // Barely-there click for neutral beats.
  tick: [{ hz: 900, at: 0, dur: 0.035, wave: "sine", peak: 0.22 }],
  // Upward sweep — short, so it's out of the way before the player lands.
  jump: [{ hz: 320, toHz: 760, at: 0, dur: 0.16, wave: "triangle", peak: 0.34 }],
  // Downward thud, low and quiet: landing happens constantly in a runner,
  // so this has to be felt more than heard or it becomes a rattle.
  land: [{ hz: 190, toHz: 110, at: 0, dur: 0.09, wave: "sine", peak: 0.26 }],
  // Major arpeggio — clearly better than `success` without being a fanfare.
  milestone: [
    { hz: 659, at: 0, dur: 0.08, wave: "triangle", peak: 0.42 },
    { hz: 831, at: 0.07, dur: 0.08, wave: "triangle", peak: 0.42 },
    { hz: 988, at: 0.14, dur: 0.16, wave: "sine", peak: 0.46 },
  ],
  // Descending, slower, flatter — an ending, not a punishment.
  gameOver: [
    { hz: 494, at: 0, dur: 0.14, wave: "triangle", peak: 0.4 },
    { hz: 392, at: 0.13, dur: 0.14, wave: "triangle", peak: 0.4 },
    { hz: 294, at: 0.26, dur: 0.28, wave: "sine", peak: 0.44 },
  ],
  // The one cue allowed to feel like a flourish: it plays once, at the
  // highest-attention moment of the session (see the peak-end note in
  // CLAUDE.md's hazards list).
  reward: [
    { hz: 523, at: 0, dur: 0.1, wave: "triangle", peak: 0.4 },
    { hz: 659, at: 0.09, dur: 0.1, wave: "triangle", peak: 0.42 },
    { hz: 784, at: 0.18, dur: 0.1, wave: "triangle", peak: 0.44 },
    { hz: 1047, at: 0.27, dur: 0.34, wave: "sine", peak: 0.48 },
  ],
};

/** Equal temperament. Guarded so a NaN/absurd semitone value from a caller
 * can't produce a non-finite frequency (which throws on an AudioParam). */
function transpose(hz: number, semitones: number): number {
  if (!Number.isFinite(semitones) || semitones === 0) return hz;
  const clamped = Math.max(-24, Math.min(24, semitones));
  const shifted = hz * Math.pow(2, clamped / 12);
  return Number.isFinite(shifted) ? Math.max(20, Math.min(18000, shifted)) : hz;
}

type Ctor = typeof AudioContext;

function audioContextCtor(): Ctor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    AudioContext?: Ctor;
    webkitAudioContext?: Ctor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function createAudio(initialMuted = false): GameAudio {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  // Cues get their own bus so the background bed can be attenuated and
  // ducked independently — the bed must never mask a success/fail cue,
  // because those are game state and the bed is only atmosphere.
  let cueBus: GainNode | null = null;
  let music: MusicController | null = null;
  let pendingBed: TemplateId | null = null; // requested before unlock()
  // The bed the game asked for, remembered independently of whether it is
  // currently sequencing — muting stops the sequencer outright (see
  // setMuted) and unmuting has to know what to bring back.
  let activeBed: TemplateId | null = null;
  let muted = initialMuted;
  let unavailable = false; // set once we know this browser can't do it
  let voices = 0;

  function ensureContext(): AudioContext | null {
    if (ctx || unavailable) return ctx;
    const Ctor = audioContextCtor();
    if (!Ctor) {
      unavailable = true;
      return null;
    }
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_VOLUME;
      master.connect(ctx.destination);
      cueBus = ctx.createGain();
      cueBus.gain.value = 1;
      cueBus.connect(master);
      music = createMusic(ctx, master);
      return ctx;
    } catch {
      // Blocked by policy, or too many live contexts on the page. Silence is
      // the correct outcome, not an error the caller has to handle.
      unavailable = true;
      ctx = null;
      master = null;
      cueBus = null;
      music = null;
      return null;
    }
  }

  function unlock(): void {
    const c = ensureContext();
    if (!c) return;
    // Created inside a gesture handler a context usually starts "running",
    // but Safari hands back "suspended" until resume() is called — and
    // resume() only works from within the gesture, which is why this is a
    // separate explicit step rather than something play() could do lazily.
    if (c.state === "suspended") void c.resume().catch(() => {});
    // A bed asked for before the gesture was deferred, not dropped — mount
    // calls startMusic() in the same handler as unlock(), and ordering
    // between the two shouldn't matter to the caller.
    if (pendingBed) {
      const bed = pendingBed;
      pendingBed = null;
      startMusic(bed);
    }
  }

  function startMusic(template: TemplateId): void {
    if (unavailable) return;
    const c = ctx;
    if (!c || !music || c.state !== "running") {
      // Never open a context here — that would be sound before the gesture.
      pendingBed = template;
      return;
    }
    activeBed = template;
    // Muting stops the sequencer rather than just gating its output, so
    // don't start one now; setMuted(false) will.
    if (muted) return;
    const bed = MUSIC_BEDS[template];
    if (bed) music.start(bed);
  }

  function stopMusic(): void {
    pendingBed = null;
    activeBed = null;
    music?.stop();
  }

  function setMusicIntensity(value: number): void {
    music?.setIntensity(value);
  }

  function play(cue: SoundCue, options?: PlayOptions): void {
    if (muted || unavailable) return;
    // Never open a context here — that would be a sound before the gesture.
    // A cue fired before unlock() is simply dropped.
    const c = ctx;
    const out = cueBus;
    if (!c || !out || c.state !== "running") return;
    if (voices >= MAX_CONCURRENT_VOICES) return;

    const notes = CUES[cue];
    if (!notes) return;
    // Dip the bed briefly so the cue reads clearly over it.
    music?.duck();
    const semitones = options?.semitones ?? 0;
    const now = c.currentTime;

    for (const note of notes) {
      if (voices >= MAX_CONCURRENT_VOICES) break;
      try {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = note.wave;
        const fromHz = transpose(note.hz, semitones);
        osc.frequency.value = fromHz;

        const start = now + note.at;
        const end = start + note.dur;
        if (note.toHz !== undefined) {
          // Exponential, not linear: pitch is perceived logarithmically, so
          // a linear sweep sounds like it slows down as it rises.
          osc.frequency.setValueAtTime(fromHz, start);
          osc.frequency.exponentialRampToValueAtTime(transpose(note.toHz, semitones), end);
        }
        // Ramped, never stepped: assigning gain directly produces an audible
        // click at both ends of every note.
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(note.peak, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        osc.connect(gain);
        gain.connect(out);

        voices += 1;
        osc.onended = () => {
          voices = Math.max(0, voices - 1);
          try {
            gain.disconnect();
            osc.disconnect();
          } catch {
            // Already torn down with the context — nothing to release.
          }
        };
        osc.start(start);
        osc.stop(end + 0.02);
      } catch {
        // One failed note must not abort the rest of the cue, and must not
        // surface to the game module.
        voices = Math.max(0, voices - 1);
      }
    }
  }

  function setMuted(next: boolean): void {
    muted = next;
    // Cutting the master gain alone would leave the sequencer building
    // oscillators forever for output nobody can hear — a muted 144bpm bed
    // was still allocating ~9 nodes a second. Stop it outright and bring it
    // back on unmute instead.
    if (next) {
      music?.stop();
    } else if (activeBed) {
      const bed = MUSIC_BEDS[activeBed];
      if (bed) music?.start(bed);
    }
    if (!master || !ctx) return;
    try {
      // Short ramp rather than a jump, so toggling mid-cue doesn't click.
      const now = ctx.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(next ? 0 : MASTER_VOLUME, now + 0.05);
    } catch {
      master.gain.value = next ? 0 : MASTER_VOLUME;
    }
  }

  function destroy(): void {
    const c = ctx;
    music?.destroy();
    music = null;
    pendingBed = null;
    ctx = null;
    master = null;
    cueBus = null;
    voices = 0;
    if (!c) return;
    // close() releases the underlying hardware stream. Browsers cap live
    // contexts per page (Safari notoriously low), and this runtime can be
    // mounted and torn down repeatedly in the editor preview, so leaking one
    // per mount eventually makes every later mount silent.
    try {
      void c.close().catch(() => {});
    } catch {
      // Older implementations have no close(); nothing further to do.
    }
  }

  return { play, startMusic, stopMusic, setMusicIntensity, setMuted, isMuted: () => muted, unlock, destroy };
}

// ---------------------------------------------------------------------------
// Mute preference
// ---------------------------------------------------------------------------

const MUTE_KEY = "playloop:muted";

/** Per-viewer, per-origin, and best-effort by design: every access is wrapped
 * because reading localStorage THROWS (not returns null) in a private window
 * or with site data blocked, and the embed runs inside an iframe whose
 * storage a host page's cookie policy can block outright. A viewer whose
 * preference can't be stored just gets the default each session. */
export function loadMutePreference(): boolean {
  try {
    return window.localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveMutePreference(muted: boolean): void {
  try {
    window.localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
  } catch {
    // Nothing to do — the in-memory setting still applies for this session.
  }
}
