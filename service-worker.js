/* Cache exclusivo de apresentação. Dados/API e recursos externos nunca são armazenados. */
const CACHE='agentum-v80-nexacc-orbita';
const ASSETS=['./index.html','./assets/agentum-identidades.js','./assets/agentum-identidades.css','./assets/agentum-operacao.js','./assets/agentum-operacao.css','./assets/agentum-pendentes.js','./assets/agentum-pendentes.css','./assets/agentum-gold.css?v=20260910.live1','./assets/agentum-gold-reference.png','./assets/onix.css?v=20260910.2','./assets/agentum-identidade.png','./assets/onix-motion.js?v=20260918.nexacc1','./assets/nexacc-brand.css?v=20260918.1','./assets/nexacc/nexacc-logo.png','./assets/nexacc/nexacc-simbolo.png','./assets/nexacc/nexacc-icone.png','./manifest.webmanifest','./icons/icon-192.png','./icons/icon-512.png'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE&&(key.startsWith('dash-operacoes-')||key.startsWith('agentum-'))).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
 if(event.request.method!=='GET')return;
 const url=new URL(event.request.url);
 if(url.origin!==self.location.origin)return;
 if(url.pathname.startsWith('/api/')){event.respondWith(fetch(event.request));return;}
 event.respondWith(fetch(event.request).then(response=>{
  if(response.ok&&response.type!=='opaque')event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,response.clone())).catch(()=>{}));
  return response;
 }).catch(async()=>{
  const hit=await caches.match(event.request);if(hit)return hit;
  if(event.request.mode==='navigate'){const page=await caches.match('./index.html');if(page)return page;}
  return Response.error();
 }));
});
