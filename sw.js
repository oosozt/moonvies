// Service worker for the home-screen app. It caches nothing that changes (the page,
// the API and videos always come from the PC); it only shows a friendly page when
// the PC can't be reached, instead of the browser's error screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

const OFFLINE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Moonvies</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0520; color: #dff8ff;
    font: 15px/1.5 ui-monospace, Menlo, Consolas, monospace; text-align: center; padding: 24px; box-sizing: border-box; }
  b { display: block; color: #ff2e88; font-size: 18px; letter-spacing: .12em; margin-bottom: 10px; }
  button { margin-top: 18px; background: #ff2e88; color: #fff; border: 0; padding: 12px 22px; font: inherit; font-weight: 700; }
</style>
<div><b>CAN'T REACH THE CATALOG</b>The PC (or home server) is off, asleep, or not running the catalog.<br>
Start it with start-phone.cmd, then try again.<br><button onclick="location.reload()">Try again</button></div>`;

self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return; // everything else goes straight to the network
  e.respondWith(fetch(e.request).catch(() => new Response(OFFLINE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});
