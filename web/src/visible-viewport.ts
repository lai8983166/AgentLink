import { useLayoutEffect, useState, type CSSProperties } from "react";

function measure() {
  const viewport = window.visualViewport;
  // Keep normal page zoom and panning available; only track unzoomed keyboard/browser changes.
  if (viewport && Math.abs(viewport.scale - 1) < 0.01 && viewport.height > 0) {
    return { height: viewport.height, top: viewport.offsetTop };
  }
  return { height: window.innerHeight, top: 0 };
}

/** Fixed containers must fit the visible area even when the keyboard leaves the layout viewport unchanged. */
export function useVisibleViewport(): CSSProperties {
  const [bounds, setBounds] = useState(measure);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      if (viewport && Math.abs(viewport.scale - 1) >= 0.01) return;
      const next = measure();
      setBounds((old) => old.height === next.height && old.top === next.top ? old : next);
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return { position: "fixed", left: 0, right: 0, top: bounds.top, height: bounds.height };
}
