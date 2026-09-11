// lib/runtime/loop.ts
//
// requestAnimationFrame loop with delta-time and pause/resume. Deliberately
// tiny and framework-free (build spec §2: Canvas 2D, vanilla TS, no engine
// dependency — the future ad exporter needs the bundle small).

export interface LoopHandle {
  /** Stop for good. The handle is unusable afterwards. */
  stop(): void;
  /** Freeze update+render (frames keep scheduling but do nothing). */
  pause(): void;
  /** Resume from pause. The next frame's dt is reset to avoid a huge jump
   * for the wall-clock time spent paused. */
  resume(): void;
  readonly paused: boolean;
}

export interface LoopOptions {
  /** Upper bound on a single frame's dt, in seconds. Guards against a huge
   * dt after a backgrounded tab or a slow first frame. Default 0.1 (100ms). */
  maxDtSeconds?: number;
}

/**
 * Starts a rAF loop. `update(dt)` receives delta time in seconds.
 * `render()` is called every non-paused frame right after `update`.
 */
export function startLoop(
  update: (dtSeconds: number) => void,
  render: () => void,
  options: LoopOptions = {},
): LoopHandle {
  const maxDt = options.maxDtSeconds ?? 0.1;

  let running = true;
  let paused = false;
  let lastTimeMs = 0;
  let rafId = 0;

  function frame(timeMs: number) {
    if (!running) return;
    if (lastTimeMs === 0) lastTimeMs = timeMs;
    const dt = Math.min(Math.max((timeMs - lastTimeMs) / 1000, 0), maxDt);
    lastTimeMs = timeMs;

    if (!paused) {
      update(dt);
      render();
    }

    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);

  return {
    stop() {
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      // Force the next frame to treat "now" as the new baseline instead of
      // reporting a multi-second dt for however long the game was paused.
      lastTimeMs = 0;
    },
    get paused() {
      return paused;
    },
  };
}
