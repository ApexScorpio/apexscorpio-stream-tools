(function(global){
 'use strict';
 if(!global.mqtt || !global.ApexOverlaySession)return;
 const crypto=global.crypto;
 const raw=Uint8Array.from(global.ApexOverlaySession.key.match(/../g),x=>parseInt(x,16));
 const imported=crypto.subtle.importKey('raw',raw,{name:'AES-GCM'},false,['encrypt','decrypt']);
 const encode=bytes=>global.btoa(String.fromCharCode(...new Uint8Array(bytes)));
 const decode=value=>Uint8Array.from(global.atob(value),x=>x.charCodeAt(0));
 async function encrypt(message){const iv=crypto.getRandomValues(new Uint8Array(12));const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},await imported,new TextEncoder().encode(String(message)));return JSON.stringify({v:2,iv:encode(iv),ciphertext:encode(ciphertext)});}
 async function decrypt(message){const packet=JSON.parse(String(message));if(packet.v!==2||typeof packet.iv!=='string'||typeof packet.ciphertext!=='string')throw Error('Mensagem sem autenticação');const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:decode(packet.iv)},await imported,decode(packet.ciphertext));return new TextDecoder().decode(clear);}
 const connect=global.mqtt.connect.bind(global.mqtt);
 function secureConnect(...args){const client=connect(...args),publish=client.publish.bind(client),on=client.on.bind(client);
  client.publish=function(topic,message,...options){encrypt(message).then(packet=>publish(topic,packet,...options)).catch(()=>{});return client;};
  client.on=function(event,callback){if(event!=='message')return on(event,callback);return on('message',(topic,message,...extra)=>{decrypt(message).then(clear=>callback(topic,clear,...extra)).catch(()=>{});});};
  return client;
 }
 global.mqtt={...global.mqtt,connect:secureConnect};
})(window);
