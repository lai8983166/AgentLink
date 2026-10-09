import { useEffect, useRef, useState, type RefObject } from "react";

export const PULL_THRESHOLD = 72;

/** Own the downward gesture at the list's top instead of relying on browser page reload. */
export function usePullToRefresh(
  container: RefObject<HTMLElement>, refresh: () => Promise<void>, refreshing: boolean,
) {
  const [distance, setDistance] = useState(0);
  const latest = useRef({ refresh, refreshing });
  latest.current = { refresh, refreshing };
  const pending = useRef(false);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    let start: { x: number; y: number; id: number } | null = null;
    let pulled = 0;
    const reset = () => { start = null; pulled = 0; setDistance(0); };
    const onStart = (event: TouchEvent) => {
      reset();
      if (pending.current || latest.current.refreshing || event.touches.length !== 1 || element.scrollTop > 0) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, button, [contenteditable=true]")) return;
      const touch = event.touches[0]!;
      start = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
    };
    const onMove = (event: TouchEvent) => {
      if (!start) return;
      const touch = event.touches[0];
      if (event.touches.length !== 1 || !touch || touch.identifier !== start.id || element.scrollTop > 0) {
        reset(); return;
      }
      const dy = touch.clientY - start.y;
      const dx = Math.abs(touch.clientX - start.x);
      if (dy < -6 || (dx > 6 && dx > Math.max(0, dy))) { reset(); return; }
      if (dy > 0 && dy > dx) {
        if (!event.cancelable) { reset(); return; }
        // Non-passive listener is necessary on iOS and on short/non-scrollable lists.
        event.preventDefault();
        pulled = Math.min(dy, 112);
        setDistance(pulled);
      } else {
        pulled = 0; setDistance(0);
      }
    };
    const onEnd = (event: TouchEvent) => {
      const ready = !!start && event.touches.length === 0 && pulled >= PULL_THRESHOLD;
      reset();
      if (!ready || pending.current || latest.current.refreshing) return;
      pending.current = true;
      // Also guard the interval before React publishes the parent's refreshing state.
      Promise.resolve().then(() => latest.current.refresh()).catch(() => {}).finally(() => { pending.current = false; });
    };
    element.addEventListener("touchstart", onStart, { passive: true });
    element.addEventListener("touchmove", onMove, { passive: false });
    element.addEventListener("touchend", onEnd, { passive: true });
    element.addEventListener("touchcancel", reset, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onStart);
      element.removeEventListener("touchmove", onMove);
      element.removeEventListener("touchend", onEnd);
      element.removeEventListener("touchcancel", reset);
    };
  }, [container]);
  return { distance, armed: distance >= PULL_THRESHOLD };
}
