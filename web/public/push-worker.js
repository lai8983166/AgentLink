/* Imported by the existing Workbox worker; app updates keep their current lifecycle. */
self.addEventListener("push", function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { /* Generic visible notification for invalid data. */ }
  if (!data || typeof data !== "object") data = {};
  var url = typeof data.url === "string" && /^\/(?!\/)/.test(data.url) && !data.url.startsWith("/api/") ? data.url : "/";
  event.waitUntil(self.registration.showNotification(
    typeof data.title === "string" ? data.title : "AgentLink",
    { body: typeof data.body === "string" ? data.body : "任务状态有更新，点击查看。",
      icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
      tag: typeof data.tag === "string" ? data.tag : "agentlink-update", renotify: false,
      data: { url: url } }
  ));
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var path = event.notification.data && event.notification.data.url;
  var target;
  try { target = new URL(path || "/", self.location.origin); } catch (_) { target = new URL("/", self.location.origin); }
  if (target.origin !== self.location.origin || target.pathname.startsWith("/api/")) target = new URL("/", self.location.origin);
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async function (windows) {
    for (var client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try { await client.navigate(target.href); await client.focus(); return; } catch (_) { /* Open a fresh window below. */ }
    }
    return self.clients.openWindow(target.href);
  }));
});
