/* Assistant: recibe las notificaciones push y abre la app al tocarlas */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { texto: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.titulo || "Assistant", {
    body: d.texto || "",
    icon: "assets/icono-192.png",
    badge: "assets/logo-a-negro.png",
    tag: d.etiqueta || undefined,
    renotify: !!d.etiqueta,
    data: { vista: d.vista || "" }
  }));
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const vista = e.notification.data && e.notification.data.vista;
  const url = new URL("./" + (vista ? "#" + vista : ""), self.registration.scope).href;
  e.waitUntil((async () => {
    const lista = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of lista) { if (c.url.startsWith(self.registration.scope)) { await c.focus(); if (vista) c.postMessage({ vista }); return; } }
    await self.clients.openWindow(url);
  })());
});
