const CACHE_VERSION = 'retail-recall-router-v1'
const APP_SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/recall-router.svg',
  './icons/recall-router-maskable.svg',
  './recall-list-template.csv',
]

const installAppShell = async () => {
  const cache = await caches.open(CACHE_VERSION)
  await cache.addAll(APP_SHELL)
  const response = await fetch('./index.html', { cache: 'reload' })
  const html = await response.clone().text()
  await cache.put('./index.html', response.clone())
  await cache.put('./', response)
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter((path) => path.startsWith('./assets/'))
  if (assets.length) await cache.addAll([...new Set(assets)])
}

const offlineResponse = () =>
  new Response('Retail Recall Router is offline. Reconnect once to finish loading this resource.', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  })

self.addEventListener('install', (event) => {
  event.waitUntil(installAppShell().then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request

  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(async (response) => {
          const copy = response.clone()
          const cache = await caches.open(CACHE_VERSION)
          await cache.put('./index.html', copy)
          await cache.put('./', response.clone())
          return response
        })
        .catch(async () =>
          (await caches.match('./index.html')) || (await caches.match('./')) || offlineResponse(),
        ),
    )
    return
  }

  event.respondWith(
    caches.match(request).then(async (cached) => {
      if (cached) return cached
      try {
        const response = await fetch(request)
        if (response.ok) {
          const cache = await caches.open(CACHE_VERSION)
          await cache.put(request, response.clone())
        }
        return response
      } catch {
        return offlineResponse()
      }
    }),
  )
})
