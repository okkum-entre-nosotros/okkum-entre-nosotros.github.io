const C='okkum-v3';
const A=["./","index.html","manifest.webmanifest","svgs/okkum.svg","svgs/icono-app.svg","images/fondo.jpg","images/icon-192.png","images/icon-512.png","images/icon-512-maskable.png","images/escenas/01.svg","images/escenas/02.svg","images/escenas/03.svg","images/escenas/04.svg","images/escenas/05.svg","images/escenas/06.svg","images/escenas/07.svg","images/escenas/08.svg","images/escenas/09.svg","images/escenas/10.svg","images/escenas/11.svg","images/escenas/12.svg"];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(A)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
// Stale-while-revalidate: responde al instante desde caché y actualiza en segundo plano (solo mismo origen).
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url);
  if(r.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(caches.open(C).then(async c=>{
    const hit=await c.match(r,{ignoreSearch:true});
    const net=fetch(r).then(res=>{if(res.ok)c.put(r,res.clone());return res}).catch(()=>hit);
    if(hit){e.waitUntil(net);return hit}
    return net;
  }));
});
