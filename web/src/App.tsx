import { useEffect } from "react";
import { Route, Routes, useNavigate } from "react-router-dom";
import { isAndroidApp, native, notificationPath } from "./native";
import { useStore } from "./store";
import { connectWs } from "./runtime";
import { PairScreen } from "./pages/PairScreen";
import { Home } from "./pages/Home";
import { Session } from "./pages/Session";
import { Settings } from "./pages/Settings";
import { Audit } from "./pages/Audit";

export function App() {
  const token = useStore((s) => s.token);
  const navigate = useNavigate();
  useEffect(() => {
    if (!token || !isAndroidApp()) return;
    let disposed = false;
    const visit = ({ path }: { path?: string }) => { const safe = path && notificationPath(path); if (!disposed && safe) navigate(safe); };
    let remove: (() => void) | undefined;
    const consume = () => { void native.consumeNavigation().then(visit).catch(() => {}); };
    void native.addListener("navigation", consume).then((listener) => {
      if (disposed) { void listener.remove(); return; }
      remove = () => { void listener.remove(); }; consume();
    }).catch(() => {});
    return () => { disposed = true; remove?.(); };
  }, [token, navigate]);

  useEffect(() => {
    if (token) return connectWs();
  }, [token]);

  if (!token) return <PairScreen />;

  return (
    <Routes>
      <Route path="/" element={<Home />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/settings/audit" element={<Audit />} />
      <Route path="/:sessionId" element={<Session />} />
    </Routes>
  );
}
