// lib/runtime/games/hud.ts
//
// The two pieces of chrome every timed game needs, in one place so all
// eleven templates read identically to a player — the same reason
// spriteRender.ts exists. A merchant embedding two PlayLoop games on one
// storefront should not get two different clocks.
//
// Both helpers are pure draw calls: they take the numbers and render. They
// hold no state, so a module can call them from `render()` without
// threading anything new through `update()`.

import type { BrandKit } from "@/lib/engine/types";
import { drawHeartShape } from "@/lib/runtime/games/shapeLibrary";

/** Height of the drain bar pinned to the very top edge. */
export const TIMER_BAR_HEIGHT = 5;

/** Vertical space the timer occupies in total, bar + numeral. A game whose
 * own HUD sits at the top should offset by this much. */
export const TIMER_HUD_HEIGHT = 26;

/** Below this many seconds the timer turns urgent. */
const URGENT_SEC = 10;
const URGENT_COLOR = "#d14343";

/** The lives row's right-hand inset. Sized to clear mount.ts's mute
 * button, which is absolutely positioned at top:8 right:8 at 28px square —
 * the hearts and the speaker both want the top-right corner, and the
 * hearts are the ones that can move. */
export const LIVES_ROW_INSET = 44;

/**
 * A drain bar across the very top edge, plus the seconds remaining.
 *
 * Pinned to the top edge rather than inset, and full width, because that is
 * the one strip no template draws in: score sits top-left in most, lives
 * top-right, and the play area starts below. That is what lets one timer
 * serve all eleven games without a per-game layout argument.
 *
 * Pass `secondsLeft` and `totalSeconds` for whatever clock actually matters
 * to the player. For nine of the templates that is the run's own
 * `durationSec`; for guess_price it is the per-round clock, which is where
 * the pressure really is — the total is only a safety cap there.
 */
export function drawTimerBar(
  c: CanvasRenderingContext2D,
  stageWidth: number,
  secondsLeft: number,
  totalSeconds: number,
  brand: BrandKit,
): void {
  if (!Number.isFinite(secondsLeft) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return;
  const left = Math.max(0, Math.min(secondsLeft, totalSeconds));
  const fraction = left / totalSeconds;
  const urgent = left <= URGENT_SEC;
  const color = urgent ? URGENT_COLOR : brand.accent;

  c.save();

  // Track, so the bar reads as "draining" rather than "a coloured edge".
  c.fillStyle = withAlpha(brand.foreground, 0.1);
  c.fillRect(0, 0, stageWidth, TIMER_BAR_HEIGHT);
  c.fillStyle = color;
  c.fillRect(0, 0, stageWidth * fraction, TIMER_BAR_HEIGHT);

  // Numeral, centre-top. Centre is deliberate: it is the only horizontal
  // slot free in every template (see the note above), and it keeps the
  // clock in the same place no matter which game you are playing.
  const secs = Math.ceil(left);
  c.font = `600 12px ${brand.fontFamily || "system-ui"}, system-ui, sans-serif`;
  c.textAlign = "center";
  c.textBaseline = "top";
  c.fillStyle = urgent ? URGENT_COLOR : withAlpha(brand.foreground, 0.55);
  c.fillText(formatClock(secs), stageWidth / 2, TIMER_BAR_HEIGHT + 4);

  c.restore();
}

/** Seconds under a minute read better bare ("9") than zero-padded ("0:09"),
 * and every template's default duration is well under a minute — but the
 * tuning ranges allow 60, so handle the minute case rather than printing
 * "60". */
function formatClock(totalSeconds: number): string {
  if (totalSeconds < 60) return String(totalSeconds);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Lives as hearts, top-right.
 *
 * Standardised on the right edge across every template: shooter used to put
 * its lives top-centre, which both collided with the timer numeral and made
 * the indicator move depending on which game you opened. Inset far enough
 * to clear the mute button in the same corner (LIVES_ROW_INSET).
 *
 * Spent lives stay visible as hollow outlines rather than disappearing — a
 * row that shrinks tells you how many you have, while a row that dims tells
 * you how many you have LEFT OF how many you started with, which is the
 * thing a player actually wants to know.
 */
export function drawLivesRow(
  c: CanvasRenderingContext2D,
  stageWidth: number,
  maxLives: number,
  livesLeft: number,
  brand: BrandKit,
  topY: number = TIMER_BAR_HEIGHT + 5,
): void {
  const total = Math.max(0, Math.round(maxLives));
  if (total === 0) return;
  const size = 13;
  const gap = size + 4;
  const cy = topY + size / 2;

  c.save();
  for (let i = 0; i < total; i++) {
    // Right-aligned, filling leftward, so the row grows away from the edge
    // and the first heart never shifts when maxLives changes.
    const cx = stageWidth - LIVES_ROW_INSET - size / 2 - (total - 1 - i) * gap;
    if (i < livesLeft) {
      drawHeartShape(c, cx, cy, size, brand.accent);
    } else {
      // Spent: a ghost heart, not a gap. Deliberately NOT tinted from
      // brand.foreground — that colour is contrast-forced against
      // brand.background, and several templates don't have
      // brand.background behind their HUD (runner draws over a sky, chomp
      // over a lattice), so a brand-derived ghost disappears there.
      // A light fill plus a dark hairline reads on any backdrop.
      drawHeartShape(c, cx, cy, size, "rgba(255,255,255,0.28)", {
        color: "rgba(0,0,0,0.22)",
      });
    }
  }
  c.restore();
}

/** #rrggbb -> rgba(). Falls back to the input when the brand hex is an
 * unexpected shape, so a malformed BrandKit degrades to a visible colour
 * rather than a transparent one. */
function withAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m || !m[1] || !m[2] || !m[3]) return hex;
  return `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, ${alpha})`;
}
