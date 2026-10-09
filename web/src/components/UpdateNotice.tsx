import { Link } from "react-router-dom";
import { useAppUpdate } from "../app-updater";

export function UpdateNotice() {
  const available = useAppUpdate((s) => s.available);
  if (!available) return null;
  return <Link to="/settings" className="update-notice" role="status">
    有新版本可用 · 前往设置更新页面 ›
  </Link>;
}
