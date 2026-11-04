(function(global){
 'use strict';
 if(!global.ApexOverlaySession||!global.crypto?.subtle)return;
 const key=global.ApexOverlaySession.key,bytes=Uint8Array.from(key.match(/../g),x=>parseInt(x,16));
 const imported=crypto.subtle.importKey('raw',bytes,{name:'AES-GCM'},false,['decrypt']);
 const namespace=crypto.subtle.digest('SHA-256',new TextEncoder().encode(key)).then(hash=>Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('').slice(0,32));
 const base='https://apexscorpio-stream-tools.scorpioapex.workers.dev/overlay-config';
 let busy=false,last=0;const seen=new Set();
 const decode=value=>Uint8Array.from(atob(value),x=>x.charCodeAt(0));
 async function poll(){if(busy)return;busy=true;const controller=typeof AbortController==='function'?new AbortController():null;const timeout=controller?setTimeout(()=>controller.abort(),6000):null;
  try{const r=await fetch(base+'?overlay='+await namespace+'-fb&cb='+Date.now(),{cache:'no-store',signal:controller?.signal});if(!r.ok)return;
   const {config}=await r.json(),packet=config?.packet;if(packet?.v!==2)return;
   const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(packet.iv)},await imported,decode(packet.ciphertext));const data=JSON.parse(new TextDecoder().decode(clear));
   if(!Number.isFinite(data.observedAt)||data.observedAt<=last||Date.now()-data.observedAt>30000||data.observedAt>Date.now()+5000)return;
   last=data.observedAt;
   global.postMessage({type:'facebook_status',data:data.state},global.location.origin);
   for(const item of data.deliveries||[]){if(!['chat_message','new_event'].includes(item.type)||item.payload?.platform!=='facebook'||!item.payload.id||seen.has(item.payload.id))continue;seen.add(item.payload.id);global.postMessage({type:item.type,data:item.payload},global.location.origin);}
   if(seen.size>3000){const recent=[...seen].slice(-2000);seen.clear();recent.forEach(x=>seen.add(x));}
  }catch(_){}finally{if(timeout)clearTimeout(timeout);busy=false;}}
 poll();setInterval(poll,5000);
})(window);
