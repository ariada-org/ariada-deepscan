// The fetch runs in the extension's service worker (extension origin + host_permissions),
// so the page cannot read or tamper with the request.
const DEFAULT_API = "http://localhost:8080";
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== "findings") return;
  chrome.storage.sync.get({ api: DEFAULT_API }, async ({ api }) => {
    try {
      const r = await fetch(`${api.replace(/\/$/, "")}/api/findings?site=${encodeURIComponent(msg.site)}`, { credentials: "include" });
      reply({ ok: r.ok, data: r.ok ? await r.json() : null, api });
    } catch (e) {
      reply({ ok: false, error: String(e), api });
    }
  });
  return true; // async reply
});
