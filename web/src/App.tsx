import { useEffect } from "react";
import { Route, Routes } from "react-router-dom";
import { useStore } from "./store";
import { connectWs } from "./runtime";
import { PairScreen } from "./pages/PairScreen";
import { Home } from "./pages/Home";
import { Session } from "./pages/Session";
import { Settings } from "./pages/Settings";
import { Audit } from "./pages/Audit";

export function App() {
  const token = useStore((s) => s.token);

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
