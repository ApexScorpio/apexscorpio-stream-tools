(function () {
  'use strict';
  const box = document.getElementById('alert-box');
  const image = document.getElementById('alert-img');
  const logo = document.getElementById('logo-box');
  const title = document.getElementById('alert-title');
  const message = document.getElementById('alert-message');
  const subtext = document.getElementById('alert-subtext');

  let config = { showTwitch:true, showYoutube:true, showFacebook:true, playSound:true, durationSeconds:5 };
  let queue = [];
  let showing = false;
  let current = null;
  let activeTimer = null;
  let exitTimer = null;
  const seen = new Set();

  const logos = {
    twitch:'<svg width="28" height="28" viewBox="0 0 24 24" fill="#9146FF"><path d="M11.571 4.714h1.715v5.143H11.571V4.714zm4.715 0H18v5.143h-1.714V4.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0H6zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714v9.429z"/></svg>',
    youtube:'<svg width="32" height="32" viewBox="0 0 24 24" fill="#E8181F"><path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/></svg>',
    facebook:'<svg width="30" height="30" viewBox="0 0 24 24" fill="#1877F2"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>'
  };
  const images = {
    follower:'brandkit/Apex_Scorpio_Brand_Assets/03_Scorpion/Apex_Scorpion_Full_Metallic.png',
    subscriber:'brandkit/Apex_Scorpio_Brand_Assets/02_Jewel/AS_Jewel_Full_Metallic.png',
    gift_subscriber:'brandkit/Apex_Scorpio_Brand_Assets/02_Jewel/AS_Jewel_Full_Metallic.png',
    membership:'brandkit/Apex_Scorpio_Brand_Assets/02_Jewel/AS_Jewel_Full_Metallic.png',
    donation:'brandkit/Apex_Scorpio_Brand_Assets/02_Jewel/AS_Jewel_Full_Metallic.png',
    cheer:'brandkit/Apex_Scorpio_Brand_Assets/02_Jewel/AS_Jewel_Full_Metallic.png',
    raid:'brandkit/Apex_Scorpio_Brand_Assets/03_Scorpion/Apex_Stinger_A_Symbol.png'
  };

  function loadConfig(){
    const p=new URLSearchParams(location.search);
    const bool=v=>/^(1|true)$/i.test(String(v));
    if(p.has('tw'))config.showTwitch=bool(p.get('tw'));if(p.has('yt'))config.showYoutube=bool(p.get('yt'));if(p.has('fb'))config.showFacebook=bool(p.get('fb'));if(p.has('snd'))config.playSound=bool(p.get('snd'));if(p.has('dur'))config.durationSeconds=Number(p.get('dur'))||5;
    try{const saved=localStorage.getItem('apex_cfg_alerts');if(saved&&[...p.keys()].length===0)config={...config,...JSON.parse(saved)}}catch(_){}
  }
  function allowed(platform){return platform==='twitch'?config.showTwitch:platform==='youtube'?config.showYoutube:platform==='facebook'?config.showFacebook:true}
  function duplicate(event){const key=event.id||`${event.platform}|${event.type}|${event.username}|${event.timestamp||''}`;if(seen.has(key))return true;seen.add(key);setTimeout(()=>seen.delete(key),120000);return false}
  function playSound(){if(!config.playSound)return;try{const ctx=new(window.AudioContext||window.webkitAudioContext)();const osc=ctx.createOscillator();const gain=ctx.createGain();osc.type='sine';osc.frequency.setValueAtTime(523.25,ctx.currentTime);osc.frequency.exponentialRampToValueAtTime(880,ctx.currentTime+.3);gain.gain.setValueAtTime(.3,ctx.currentTime);gain.gain.exponentialRampToValueAtTime(.01,ctx.currentTime+.5);osc.connect(gain);gain.connect(ctx.destination);osc.start();osc.stop(ctx.currentTime+.5)}catch(_){} }
  function copy(event){
    const platform=String(event.platform||'twitch').toLowerCase();const platformName={twitch:'Twitch',youtube:'YouTube',facebook:'Facebook'}[platform]||platform;
    const username=`@${event.username||'Viewer'}`;
    if(event.type==='subscriber')return['NOVO SUBSCRITOR!',username,`Tornou-se subscritor/membro no ${platformName}!`,'#F59E0B'];
    if(event.type==='gift_subscriber')return['SUBSCRIÇÕES OFERECIDAS!',username,`Ofereceu ${event.giftCount||''} subscrições no ${platformName}!`.replace('  ',' '),'#F59E0B'];
    if(event.type==='membership')return['MENSAGEM DE MEMBRO!',username,event.months?`${event.months} meses como membro!`:'Partilhou uma mensagem de membro!','#F59E0B'];
    if(event.type==='raid')return['RAID EM DIRETO!',username,`Entrou em raid com ${Number(event.viewers||0)} espectadores!`,'#9146FF'];
    if(event.type==='donation')return['NOVO APOIO!',username,`Enviou ${event.amount||'um apoio'} no ${platformName}!`,'#10B981'];
    if(event.type==='cheer')return['NOVOS BITS!',username,`Enviou ${event.amount||'Bits'} no ${platformName}!`,'#10B981'];
    return['NOVO SEGUIDOR!',username,`Acabou de seguir no ${platformName}!`,'#E8181F'];
  }
  function resetVisual(){box.removeEventListener('animationend',finishExit);box.style.removeProperty('animation');box.style.removeProperty('display');box.className='alert-box'}
  function finishExit(e){if(e&&e.target!==box)return;if(exitTimer)clearTimeout(exitTimer);exitTimer=null;resetVisual();current=null;showing=false;setTimeout(process,200)}
  function beginExit(){box.className='alert-box pop-out';box.addEventListener('animationend',finishExit,{once:true});exitTimer=setTimeout(finishExit,750)}
  function process(){
    if(showing||!queue.length)return;showing=true;current=queue.shift();const platform=String(current.platform||'twitch').toLowerCase();const texts=copy(current);box.dataset.platform=platform;logo.innerHTML=logos[platform]||logos.twitch;image.src=images[current.type]||images.follower;title.textContent=texts[0];title.style.color=texts[3];message.textContent=texts[1];subtext.textContent=texts[2];playSound();if(activeTimer)clearTimeout(activeTimer);if(exitTimer)clearTimeout(exitTimer);resetVisual();box.className='alert-box pop-in';activeTimer=setTimeout(beginExit,(Number(config.durationSeconds)||5)*1000)
  }
  function enqueue(event){if(!event||!allowed(String(event.platform||'twitch').toLowerCase())||duplicate(event))return;queue.push(event);process()}
  function clear(onlyTests){queue=onlyTests?queue.filter(e=>!e.isTest):[];if(current&&(!onlyTests||current.isTest)){if(activeTimer)clearTimeout(activeTimer);if(exitTimer)clearTimeout(exitTimer);activeTimer=exitTimer=null;resetVisual();current=null;showing=false;process()}}
  function handle(type,payload){if(!type)return;const lower=String(type).toLowerCase();if(lower==='clear_alerts'||lower==='clear_all'){clear(Boolean(payload?.onlyTests??true));return}if(type==='config_update'){const c=payload?.alerts||payload?.config||payload;if(c)config={...config,...c};return}if((type==='new_event'||type==='trigger_alert')&&payload)enqueue(payload.event||payload)}

  const bc=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('apex_scorpio_stream_tools'):null;if(bc)bc.onmessage=e=>handle(e.data?.type,e.data?.data||e.data?.payload);window.addEventListener('message',e=>handle(e.data?.type,e.data?.data||e.data));window.addEventListener('storage',e=>{if(!e.key?.startsWith('apex_event_')||!e.newValue)return;try{const p=JSON.parse(e.newValue);handle(e.key.replace('apex_event_',''),p.payload)}catch(_){}});
  const brokers=['wss://broker.emqx.io:443/mqtt','wss://broker.hivemq.com:8000/mqtt','wss://broker.emqx.io:8084/mqtt'];if(typeof mqtt!=='undefined')brokers.forEach(url=>{try{const client=mqtt.connect(url,{clientId:`scorpio_alerts_${Math.random().toString(16).slice(2,8)}`,connectTimeout:4000,keepalive:30});client.on('connect',()=>client.subscribe('apexscorpio/streamtools/v1/#'));client.on('message',(topic,msg)=>{try{const data=JSON.parse(msg.toString());if(topic.includes('/cfg/alerts'))config={...config,...data};else if(data?.type||data?.payload)handle(data.type||data.payload?.type,data.payload||data)}catch(_){}})}catch(_){}});
  loadConfig();if(window.YoutubeLive)window.YoutubeLive.startChat(null,event=>{if(config.showYoutube)enqueue(event)});
})();
