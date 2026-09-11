// lib/runtime/input.ts
//
// Unified pointer + touch + keyboard input for the two MVP templates:
// drag-to-move a basket (Catch) and slider drag / arrow-keys (Guess the
// Price). Pointer Events already unify mouse, touch and pen in every
// evergreen browser (iOS Safari 13+, Chrome, Firefox, Edge) which is why
// they're the primary path here; a raw touch-event fallback only kicks in
// when `window.PointerEvent` is missing, so nothing double-handles input
// in the normal case.

export interface InputState {
  /** Pointer position in CSS pixels, local to the target element. */
  pointerX: number;
  pointerY: number;
  pointerDown: boolean;
  /** True for exactly one `poll()` after a press/release. */
  justPressed: boolean;
  justReleased: boolean;
  /** Currently-held keyboard keys, using KeyboardEvent.key values
   * ("ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"). */
  keysDown: Set<string>;
  /** True for exactly one `poll()` after Enter/Space is pressed. Handy for
   * "lock in my guess" without the caller tracking key-repeat itself. */
  confirmPressed: boolean;
}

export interface InputController {
  state: InputState;
  /** Call once per frame (start of update()) to read the latest edge flags
   * and clear the one-shot ones for next frame. */
  poll(): InputState;
  destroy(): void;
}

const CAPTURED_KEYS = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"]);

/**
 * @param target The element to listen on — normally the canvas or its
 * wrapping container. Must support pointer capture (any HTMLElement does).
 */
export function createInput(target: HTMLElement): InputController {
  const state: InputState = {
    pointerX: 0,
    pointerY: 0,
    pointerDown: false,
    justPressed: false,
    justReleased: false,
    keysDown: new Set(),
    confirmPressed: false,
  };

  // Edge flags set by listeners, consumed (and cleared) by poll().
  let pendingPress = false;
  let pendingRelease = false;
  let pendingConfirm = false;

  function localPoint(clientX: number, clientY: number) {
    const rect = target.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  function setPointer(clientX: number, clientY: number) {
    const p = localPoint(clientX, clientY);
    state.pointerX = p.x;
    state.pointerY = p.y;
  }

  const hasPointerEvents = typeof window !== "undefined" && "PointerEvent" in window;

  function onPointerDown(e: PointerEvent) {
    setPointer(e.clientX, e.clientY);
    state.pointerDown = true;
    pendingPress = true;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {
      // Some browsers refuse capture for non-primary pointers; harmless to skip.
    }
  }
  function onPointerMove(e: PointerEvent) {
    if (!state.pointerDown && e.buttons === 0 && e.pointerType === "mouse") {
      // Track hover position for mouse even when not pressed (nice-to-have
      // for a slider that could highlight on hover); touch/pen only move
      // while down anyway.
    }
    setPointer(e.clientX, e.clientY);
  }
  function onPointerUp(e: PointerEvent) {
    setPointer(e.clientX, e.clientY);
    state.pointerDown = false;
    pendingRelease = true;
  }

  // Fallback for environments without Pointer Events (rare, old WebViews).
  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    setPointer(t.clientX, t.clientY);
    state.pointerDown = true;
    pendingPress = true;
  }
  function onTouchMove(e: TouchEvent) {
    const t = e.touches[0];
    if (!t) return;
    setPointer(t.clientX, t.clientY);
  }
  function onTouchEnd() {
    state.pointerDown = false;
    pendingRelease = true;
  }
  function onMouseDown(e: MouseEvent) {
    setPointer(e.clientX, e.clientY);
    state.pointerDown = true;
    pendingPress = true;
  }
  function onMouseMove(e: MouseEvent) {
    setPointer(e.clientX, e.clientY);
  }
  function onMouseUp(e: MouseEvent) {
    setPointer(e.clientX, e.clientY);
    state.pointerDown = false;
    pendingRelease = true;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!CAPTURED_KEYS.has(e.key)) return;
    // Prevent page scroll on arrow keys / space while the game has focus —
    // this listener is scoped to `target`, not the whole document, so it
    // never fights the host page outside the embed.
    e.preventDefault();
    state.keysDown.add(e.key);
    if (e.key === "Enter" || e.key === " ") pendingConfirm = true;
  }
  function onKeyUp(e: KeyboardEvent) {
    state.keysDown.delete(e.key);
  }

  if (hasPointerEvents) {
    target.addEventListener("pointerdown", onPointerDown);
    target.addEventListener("pointermove", onPointerMove);
    target.addEventListener("pointerup", onPointerUp);
    target.addEventListener("pointercancel", onPointerUp);
  } else {
    target.addEventListener("touchstart", onTouchStart, { passive: true });
    target.addEventListener("touchmove", onTouchMove, { passive: true });
    target.addEventListener("touchend", onTouchEnd, { passive: true });
    target.addEventListener("touchcancel", onTouchEnd, { passive: true });
    target.addEventListener("mousedown", onMouseDown);
    target.addEventListener("mousemove", onMouseMove);
    target.addEventListener("mouseup", onMouseUp);
  }

  // Keyboard needs a tabindex to receive focus inside an iframe reliably.
  if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "0");
  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);

  function poll(): InputState {
    state.justPressed = pendingPress;
    state.justReleased = pendingRelease;
    state.confirmPressed = pendingConfirm;
    pendingPress = false;
    pendingRelease = false;
    pendingConfirm = false;
    return state;
  }

  function destroy() {
    if (hasPointerEvents) {
      target.removeEventListener("pointerdown", onPointerDown);
      target.removeEventListener("pointermove", onPointerMove);
      target.removeEventListener("pointerup", onPointerUp);
      target.removeEventListener("pointercancel", onPointerUp);
    } else {
      target.removeEventListener("touchstart", onTouchStart);
      target.removeEventListener("touchmove", onTouchMove);
      target.removeEventListener("touchend", onTouchEnd);
      target.removeEventListener("touchcancel", onTouchEnd);
      target.removeEventListener("mousedown", onMouseDown);
      target.removeEventListener("mousemove", onMouseMove);
      target.removeEventListener("mouseup", onMouseUp);
    }
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
  }

  return { state, poll, destroy };
}
