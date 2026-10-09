import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";

export interface KeyboardGeometry extends EventTarget {
  overlaysContent: boolean;
  readonly boundingRect: DOMRectReadOnly;
}
export function virtualKeyboard() {
  return (navigator as Navigator & { virtualKeyboard?: KeyboardGeometry }).virtualKeyboard;
}
function standalone() {
  return !!window.matchMedia?.("(display-mode: standalone), (display-mode: fullscreen), (display-mode: minimal-ui)").matches ||
    !!(navigator as Navigator & { standalone?: boolean }).standalone;
}

/** Installed Chromium apps can expose the actual keyboard bounds, even without a viewport resize. */
export function configureKeyboardLayout() {
  const keyboard = virtualKeyboard();
  if (!keyboard || !standalone()) return;
  try { keyboard.overlaysContent = true; } catch { /* Use the browser's normal resize behavior when unavailable. */ }
}

function positive(value: number) { return Number.isFinite(value) && value > 0; }
function measure(baselineScale: number, previous?: { height: number; top: number; layoutHeight: number }) {
  const viewport = window.visualViewport;
  const heights = [window.innerHeight, document.documentElement.clientHeight].filter(positive);
  const layoutHeight = heights.length ? Math.min(...heights) : viewport?.height || 1;
  // An installed app can start with a non-1 scale. Track that baseline, without following pinch zoom.
  const atBaseline = !!viewport && Math.abs(viewport.scale - baselineScale) < 0.01;
  const keepZoomLayout = !atBaseline && previous?.layoutHeight === layoutHeight;
  const top = atBaseline && Number.isFinite(viewport.offsetTop) ? Math.max(0, viewport.offsetTop) : keepZoomLayout ? previous.top : 0;
  let bottom = keepZoomLayout ? Math.min(layoutHeight, previous.top + previous.height) : layoutHeight;
  if (atBaseline && positive(viewport.height)) bottom = Math.min(bottom, top + viewport.height);
  const keyboard = virtualKeyboard()?.boundingRect;
  if (keyboard && positive(keyboard.height) && positive(keyboard.width) && keyboard.bottom > top &&
      keyboard.left < window.innerWidth && keyboard.right > 0) {
    // Clip to its top edge; never subtract keyboard height again from an already resized viewport.
    bottom = Math.min(bottom, keyboard.top);
  }
  return { height: Math.max(1, bottom - top), top, layoutHeight };
}

function editable(element: Element | null): element is HTMLElement {
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled;
  if (element instanceof HTMLInputElement) return !element.readOnly && !element.disabled &&
    ["text", "search", "email", "tel", "url", "password", "number"].includes(element.type);
  return element instanceof HTMLElement && element.isContentEditable;
}

const diagnosticKey = "agentlink-keyboard-layout";
function record(bounds: { height: number; top: number }) {
  const active = document.activeElement;
  if (!editable(active)) return;
  const field = active.getBoundingClientRect();
  const viewport = window.visualViewport;
  const keyboard = virtualKeyboard()?.boundingRect;
  const snapshot = {
    at: new Date().toISOString(), innerHeight: window.innerHeight, clientHeight: document.documentElement.clientHeight,
    visibleHeight: viewport?.height ?? null, visibleTop: viewport?.offsetTop ?? null, scale: viewport?.scale ?? null,
    keyboardTop: keyboard?.top ?? null, keyboardHeight: keyboard?.height ?? null,
    pageTop: bounds.top, pageHeight: bounds.height, fieldTop: field.top, fieldBottom: field.bottom,
  };
  try {
    const previous = JSON.parse(sessionStorage.getItem(diagnosticKey) ?? "[]");
    const history = Array.isArray(previous) ? previous.slice(-11) : [];
    sessionStorage.setItem(diagnosticKey, JSON.stringify([...history, snapshot]));
  } catch { /* Diagnostics must never block input, including in private mode. */ }
}

/** Contains geometry and browser/build information only, never text, tokens, URLs or conversation IDs. */
export function keyboardDiagnosticReport() {
  let samples: unknown = [];
  try { samples = JSON.parse(sessionStorage.getItem(diagnosticKey) ?? "[]"); } catch { /* No samples available. */ }
  return JSON.stringify({ build: typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "development",
    browser: navigator.userAgent, standalone: standalone(), keyboardAPI: !!virtualKeyboard(),
    keyboardOverlay: virtualKeyboard()?.overlaysContent ?? null, samples }, null, 2);
}

/** Fixed containers must fit the visible area even when the keyboard leaves the layout viewport unchanged. */
export function useVisibleViewport(): CSSProperties {
  const baselineScale = useRef(window.visualViewport?.scale ?? 1);
  const [bounds, setBounds] = useState(() => measure(baselineScale.current));
  const lastMeasurement = useRef(bounds);
  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    const keyboard = virtualKeyboard();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settleUntil = 0;
    const update = () => {
      const next = measure(baselineScale.current, lastMeasurement.current);
      lastMeasurement.current = next;
      setBounds((old) => old.height === next.height && old.top === next.top ? old : next);
      record(next);
    };
    const poll = () => {
      clearTimeout(timer); timer = undefined;
      if (document.visibilityState !== "visible") return;
      update();
      // Some installed browsers update dimensions after focus without firing resize.
      if (editable(document.activeElement) || Date.now() < settleUntil) timer = setTimeout(poll, 150);
    };
    const settle = () => {
      settleUntil = Date.now() + 1200;
      poll();
    };
    update();
    if (editable(document.activeElement)) settle();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    keyboard?.addEventListener("geometrychange", update);
    window.addEventListener("resize", update);
    window.addEventListener("pageshow", settle);
    document.addEventListener("focusin", settle);
    document.addEventListener("focusout", settle);
    document.addEventListener("visibilitychange", settle);
    return () => {
      clearTimeout(timer);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      keyboard?.removeEventListener("geometrychange", update);
      window.removeEventListener("resize", update);
      window.removeEventListener("pageshow", settle);
      document.removeEventListener("focusin", settle);
      document.removeEventListener("focusout", settle);
      document.removeEventListener("visibilitychange", settle);
    };
  }, []);
  return { position: "fixed", left: 0, right: 0, top: bounds.top, height: bounds.height };
}
