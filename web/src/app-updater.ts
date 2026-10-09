import { create } from "zustand";

export interface AppUpdateState {
  build: string;
  latestBuild: string | null;
  available: boolean;
  checking: boolean;
  applying: boolean;
  error: string | null;
  checked: boolean;
}
const build = typeof __APP_BUILD__ === "string" ? __APP_BUILD__ : "development";
export const useAppUpdate = create<AppUpdateState>(() => ({
  build, latestBuild: null, available: false, checking: false, applying: false, error: null, checked: false,
}));

interface Options {
  build: string;
  workers?: ServiceWorkerContainer;
  version: () => Promise<string>;
  publish: (patch: Partial<AppUpdateState>) => void;
  reload: () => void;
  timeoutMs?: number;
}

function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("更新检查超时，请重试")), timeoutMs);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

function waitForWorker(worker: ServiceWorker, timeoutMs: number, installedIsReady = true): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("更新下载超时，请重试")), timeoutMs);
    function finish(error?: Error) {
      clearTimeout(timer); worker.removeEventListener("statechange", changed);
      error ? reject(error) : resolve();
    }
    function changed() {
      if ((installedIsReady && worker.state === "installed") || worker.state === "activated") finish();
      else if (worker.state === "redundant") finish(new Error("新版安装失败，请重试"));
    }
    worker.addEventListener("statechange", changed); changed();
  });
}

function waitForController(workers: ServiceWorkerContainer, target: ServiceWorker, timeoutMs: number, activate?: () => void) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("更新启用超时，请重试")), timeoutMs);
    function finish(error?: Error) {
      clearTimeout(timer); workers.removeEventListener("controllerchange", changed);
      error ? reject(error) : resolve();
    }
    function changed() { if (workers.controller === target) finish(); }
    workers.addEventListener("controllerchange", changed);
    if (workers.controller === target) { finish(); return; }
    try { activate?.(); } catch { finish(new Error("更新启用失败，请重试")); }
  });
}

/** New caches can activate for legacy clients; only an explicit update reloads the page. */
export function createAppUpdater(options: Options) {
  const { workers, publish } = options;
  const timeoutMs = options.timeoutMs ?? 20000;
  let registrationPromise: Promise<ServiceWorkerRegistration> | null = null;
  let checkPromise: Promise<boolean> | null = null;
  let applyPromise: Promise<void> | null = null;
  const watched = new WeakSet<ServiceWorker>();
  function watch(registration: ServiceWorkerRegistration) {
    if (registration.waiting) publish({ available: true });
    const worker = registration.installing;
    if (!worker || watched.has(worker)) return;
    watched.add(worker);
    const changed = () => {
      if (worker.state === "installed" && registration.active) publish({ available: true });
      if (worker.state === "installed" || worker.state === "activated" || worker.state === "redundant") {
        worker.removeEventListener("statechange", changed);
      }
    };
    worker.addEventListener("statechange", changed); changed();
  }
  function registration() {
    if (!workers) return Promise.resolve(undefined);
    if (!registrationPromise) {
      registrationPromise = bounded(workers.register("/sw.js", { scope: "/", updateViaCache: "none" }), timeoutMs).then((reg) => {
        reg.addEventListener("updatefound", () => watch(reg)); watch(reg); return reg;
      }).catch((error) => { registrationPromise = null; throw error; });
    }
    return registrationPromise;
  }
  function check(): Promise<boolean> {
    if (checkPromise) return checkPromise;
    publish({ checking: true, error: null });
    checkPromise = (async () => {
      try {
        const latestBuild = await options.version();
        publish({ latestBuild, available: latestBuild !== options.build });
        const reg = await registration();
        if (reg) await bounded(reg.update(), timeoutMs);
        if (reg) watch(reg);
        publish({ checked: true }); return true;
      } catch {
        publish({ error: "无法检查或下载更新，请检查网络后重试" }); return false;
      } finally { publish({ checking: false }); checkPromise = null; }
    })();
    return checkPromise;
  }
  function apply(): Promise<void> {
    if (applyPromise) return applyPromise;
    publish({ applying: true, error: null });
    applyPromise = (async () => {
      try {
        if (!await check()) return;
        const reg = await registration();
        const installing = reg?.installing;
        if (installing) await waitForWorker(installing, timeoutMs);
        if (reg?.waiting && workers) {
          const waiting = reg.waiting;
          await waitForController(workers, waiting, timeoutMs, () => waiting.postMessage({ type: "SKIP_WAITING" }));
        } else {
          if (installing) await waitForWorker(installing, timeoutMs, false);
          if (reg?.active && workers && workers.controller !== reg.active) {
            await waitForController(workers, reg.active, timeoutMs);
          }
        }
        options.reload();
      } catch (error) {
        publish({ error: error instanceof Error ? error.message : "更新失败，请重试" });
      } finally { publish({ applying: false }); applyPromise = null; }
    })();
    return applyPromise;
  }
  return { check, apply };
}

const updater = createAppUpdater({
  build,
  workers: import.meta.env.PROD && "serviceWorker" in navigator ? navigator.serviceWorker : undefined,
  version: async () => {
    if (!import.meta.env.PROD) return build;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`/version.json?check=${Date.now()}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("Version request failed");
      const metadata = await response.json();
      if (typeof metadata.build !== "string" || !metadata.build) throw new Error("Invalid build metadata");
      return metadata.build;
    } finally { clearTimeout(timer); }
  },
  publish: (patch) => useAppUpdate.setState(patch),
  reload: () => window.location.reload(),
});
export const checkAppUpdate = updater.check;
export const applyAppUpdate = updater.apply;

export function startAppUpdates() {
  if (!import.meta.env.PROD) return () => {};
  const check = () => { if (document.visibilityState === "visible" && navigator.onLine) void updater.check(); };
  check();
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
  const workers = "serviceWorker" in navigator ? navigator.serviceWorker : undefined;
  workers?.addEventListener("controllerchange", check);
  const timer = setInterval(check, 60000);
  return () => {
    clearInterval(timer); document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check);
    workers?.removeEventListener("controllerchange", check);
  };
}
