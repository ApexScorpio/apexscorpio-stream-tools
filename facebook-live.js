(function (root) {
  'use strict';
  const PAGE_ID = '111315703596465';
  function videoId(value) {
    const raw=String(value||'').trim();
    if(/^\d{5,30}$/.test(raw))return raw;
    try {const u=new URL(raw);if(!/(^|\.)facebook\.com$/.test(u.hostname))return null;
      return u.pathname.match(/\/videos\/(\d{5,30})(?:\/|$)/)?.[1] || (/^\d{5,30}$/.test(u.searchParams.get('v')||'')?u.searchParams.get('v'):null);
    }catch{return null;}
  }
  function count(value) {return (typeof value==='number'||typeof value==='string'&&/^\d+$/.test(value))&&Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;}
  function viewerState(raw) {
    if(!raw||raw.error||!['LIVE','LIVE_STOPPED','VOD','SCHEDULED_UNPUBLISHED','SCHEDULED_LIVE','SCHEDULED_CANCELED'].includes(raw.status))return {isLive:false,viewers:null,status:'unknown'};
    const isLive=raw.status==='LIVE',viewers=isLive?count(raw.live_views):null;
    return {isLive,viewers,status:!isLive||viewers!==null?'confirmed':'unknown'};
  }
  function createReader(options={}) {
    const request=options.fetch||root.fetch?.bind(root),emit=options.emit||(()=>{}),report=options.report||(()=>{});
    let token='',id='',timer=null,generation=0,busy=false,baseline=false,seen=new Set(),seenReactions=new Set(),controller=null;
    let sessionStartedAt=0;
    function state(s){emit('facebook_status',{...s,videoId:id||null,observedAt:Date.now()});}
    async function graph(resource,fields,signal) {
      const u=new URL('https://graph.facebook.com/v26.0/'+resource);u.searchParams.set('fields',fields);u.searchParams.set('limit','100');if(resource.endsWith('/comments')){u.searchParams.set('order','reverse_chronological');u.searchParams.set('filter','stream');}
      const r=await request(u.href,{headers:{Authorization:'Bearer '+token},cache:'no-store',signal});
      const body=await r.json();if(!r.ok||body.error){const error=new Error(body.error?.code===190?'A autorização Meta expirou. Volta a ligar a página.':'A Meta não permitiu esta leitura. Verifica as permissões da aplicação e da página.');error.code=body.error?.code;throw error;}
      return body;
    }
    async function tick() {
      if(!token||busy)return;busy=true;const run=generation;const ctrl=new AbortController();controller=ctrl;const timeout=setTimeout(()=>ctrl.abort(),8000);
      try {
        if(!id){const lives=await graph(PAGE_ID+'/live_videos','id,status,permalink_url',ctrl.signal);if(run!==generation)return;
          const live=lives.data?.find(item=>item.status==='LIVE');if(!live){state({isLive:false,viewers:null,status:'confirmed'});report('Sem live ativa na página.');return;}id=String(live.id);}
        // Independent requests: a missing viewer metric must never disable chat.
        const [metadata,comments,reactions]=await Promise.allSettled([
          graph(id,'id,status,live_views',ctrl.signal),
          graph(id+'/comments','id,from,message,created_time',ctrl.signal),
          graph(id+'/reactions','id,name,type',ctrl.signal)
        ]);
        if(run!==generation)return;
        if(metadata.status==='fulfilled')state(viewerState(metadata.value));else state({isLive:false,viewers:null,status:'unavailable'});
        if(comments.status==='fulfilled'){
          const items=(comments.value.data||[]).slice().sort((a,b)=>Date.parse(a.created_time)-Date.parse(b.created_time));
          for(const item of items){if(!item.id||seen.has(item.id))continue;seen.add(item.id);
            if(!baseline&&Date.parse(item.created_time)<sessionStartedAt)continue;
            if(typeof item.message!=='string'||!item.message.trim())continue;
            emit('chat_message',{id:'facebook-comment-'+id+'-'+item.id,platform:'facebook',username:item.from?.name||'Utilizador Facebook',text:item.message,message:item.message,timestamp:item.created_time,color:'#1877F2'});
          }
        }
        if(reactions.status==='fulfilled')for(const item of reactions.value.data||[]){const key=id+':'+item.id+':'+item.type;if(!item.id||seenReactions.has(key))continue;seenReactions.add(key);
          if(baseline&&item.name)emit('new_event',{id:'facebook-reaction-'+key,platform:'facebook',type:'reaction',username:item.name,reaction:item.type,timestamp:new Date().toISOString()});}
        baseline=true;
        if(seen.size>5000)seen=new Set([...seen].slice(-3000));if(seenReactions.size>5000)seenReactions=new Set([...seenReactions].slice(-3000));
        const issues=[];if(metadata.status==='rejected')issues.push('espectadores indisponíveis');if(comments.status==='rejected')issues.push('comentários sem acesso');if(reactions.status==='rejected')issues.push('reações sem acesso');
        report(issues.length?'Facebook: '+issues.join(' · '):'Facebook ligado: comentários, espectadores e reações.');
      }catch(error){if(run===generation){state({isLive:false,viewers:null,status:'unavailable'});report(error.name==='AbortError'?'Facebook: leitura demorou demasiado; nova tentativa automática.':error.message);}}
      finally{clearTimeout(timeout);if(controller===ctrl)controller=null;busy=false;}
    }
    function stop(){generation++;token='';if(timer)clearInterval(timer);timer=null;controller?.abort();state({isLive:false,viewers:null,status:'unavailable'});report('Facebook desligado.');}
    function start(accessToken,link){stop();const value=String(accessToken||'').trim();const selected=link?videoId(link):'';
      if(!value)throw Error('Introduz um token de acesso à página; a chave de transmissão RTMP não serve.');if(link&&!selected)throw Error('Usa o link direto do vídeo Facebook ou o seu ID.');
      token=value;id=selected;seen=new Set();seenReactions=new Set();baseline=false;sessionStartedAt=Date.now();report('A ligar à página Facebook…');tick();timer=setInterval(tick,5000);
    }
    return {start,stop,tick};
  }
  const api={videoId,count,viewerState,createReader};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root.document){root.ApexFacebookLive=api;root.addEventListener('DOMContentLoaded',()=>{
    const form=root.document.getElementById('facebook-live-form');if(!form)return;
    const status=root.document.getElementById('facebook-live-status');
    const reader=createReader({emit:(type,payload)=>root.broadcastEvent(type,payload),report:text=>{status.textContent=text;}});
    form.addEventListener('submit',e=>{e.preventDefault();const input=root.document.getElementById('facebook-page-token');const secret=input.value;input.value='';try{reader.start(secret,root.document.getElementById('facebook-live-url').value);}catch(error){status.textContent=error.message;}});
    root.document.getElementById('facebook-disconnect').onclick=()=>reader.stop();root.addEventListener('pagehide',()=>reader.stop());
  });}
})(typeof window!=='undefined'?window:globalThis);
