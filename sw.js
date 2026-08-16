// Kitchen Control Service Worker v4
const CACHE_NAME = 'kitchen-control-v4';
const STATIC_ASSETS = [
  '/dashboard.html',
  '/login.html',
  '/logo.png',
  '/favicon.png',
  '/manifest.json'
];

// Install - cache static assets
self.addEventListener('install', function(e){
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache){
      return cache.addAll(STATIC_ASSETS);
    }).catch(function(err){ console.log('Cache install error:', err); })
  );
});

// Activate - clean old caches
self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(
        keys.filter(function(k){ return k !== CACHE_NAME; })
            .map(function(k){ return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch - network first, fallback to cache
self.addEventListener('fetch', function(e){
  // Skip non-GET and API calls
  if(e.request.method !== 'GET') return;
  if(e.request.url.includes('/api/')) return;

  e.respondWith(
    fetch(e.request).then(function(response){
      // Cache successful responses
      if(response && response.status === 200){
        var clone = response.clone();
        caches.open(CACHE_NAME).then(function(cache){
          cache.put(e.request, clone);
        });
      }
      return response;
    }).catch(function(){
      // Network failed - try cache
      return caches.match(e.request).then(function(cached){
        return cached || caches.match('/dashboard.html');
      });
    })
  );
});

// Listen for skip waiting message from app
self.addEventListener('message', function(e){
  if(e.data === 'skipWaiting') self.skipWaiting();
});
