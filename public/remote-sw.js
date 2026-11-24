// Service worker mobilnej stránky: zobrazí upozornenie od desktopu a klik otvorí jeho session.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let message = {};
  try { message = event.data ? event.data.json() : {}; } catch { /* poškodená správa */ }
  const id = typeof message.id === "string" ? message.id : undefined;
  event.waitUntil(self.registration.showNotification(typeof message.title === "string" ? message.title : "Project Desk", {
    body: typeof message.body === "string" ? message.body : "",
    icon: "remote-icon.png",
    // Nová správa tej istej session nahradí starú a znova upozorní.
    tag: id,
    renotify: !!id,
    data: { id },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const id = event.notification.data && event.notification.data.id;
  event.waitUntil((async () => {
    const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const page = pages.find((c) => new URL(c.url).pathname === "/remote.html");
    if (page) {
      await page.focus();
      if (id) page.postMessage({ type: "open", id });
      return;
    }
    await self.clients.openWindow(`/remote.html${id ? `#s=${encodeURIComponent(id)}` : ""}`);
  })());
});
