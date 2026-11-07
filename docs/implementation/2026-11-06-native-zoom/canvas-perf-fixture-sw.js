let opening;
function database() {
  return opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('storyboard-copilot:workspace', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (!url.pathname.startsWith('/__canvas_perf_media/')) return;
  event.respondWith((async () => {
    const key = decodeURIComponent(url.pathname.slice('/__canvas_perf_media/'.length));
    const db = await database();
    const blob = await new Promise((resolve, reject) => {
      const request = db.transaction('media', 'readonly').objectStore('media').get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return blob instanceof Blob
      ? new Response(blob, { headers: { 'Content-Type': blob.type, 'Cache-Control': 'no-store' } })
      : new Response('Missing fixture asset', { status: 404 });
  })());
});
