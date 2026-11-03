(function(global){
 'use strict';
 const valid=value=>/^[a-f0-9]{64}$/.test(value||'');
 const params=new URLSearchParams(global.location.hash.slice(1));
 let key=params.get('overlayKey');
 if(!valid(key)){try{key=global.localStorage.getItem('apex_overlay_key_v1');}catch{}}
 const isDashboard=/\/(?:index\.html)?$/.test(global.location.pathname);
 if(!valid(key)&&isDashboard){const bytes=global.crypto.getRandomValues(new Uint8Array(32));key=Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join('');}
 if(!valid(key)){global.ApexOverlaySession=null;return;}
 try{global.localStorage.setItem('apex_overlay_key_v1',key);}catch{}
 global.ApexOverlaySession=Object.freeze({key,topic:'apexscorpio/streamtools/v2/encrypted',url(value){const u=new URL(value,global.location.href);u.hash=new URLSearchParams({overlayKey:key}).toString();return u.href;}});
})(window);
