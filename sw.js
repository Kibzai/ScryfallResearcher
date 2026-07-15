const CACHE_NAME = 'scryfall-researcher-v1';
const STATIC_URLS = [
  '/',
  '/index.html',
  // Si tienes CSS/JS externos añádelos aquí
  'https://cdn.quilljs.com/1.3.6/quill.snow.css',
  'https://cdn.quilljs.com/1.3.6/quill.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(STATIC_URLS))
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      );
    })
  );
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Para las peticiones a la API de Scryfall, NO las cacheamos (mejor usar IndexedDB)
  if (url.hostname === 'api.scryfall.com') {
    return;
  }

  // Para imágenes de Scryfall (cdn) usamos cache-first, pero el código ya tiene su propia caché.
  // Podemos dejar que el código maneje las imágenes, o añadirlas aquí.
  // En este ejemplo, cacheamos todo lo que no sea API.
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) return response;
        return fetch(event.request).then(fetchResponse => {
          // Guardamos en caché solo recursos GET exitosos (excepto API)
          if (event.request.method === 'GET' && fetchResponse.status === 200) {
            const clone = fetchResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return fetchResponse;
        });
      })
  );
});
