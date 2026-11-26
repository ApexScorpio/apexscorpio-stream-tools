'use strict';
const statusEl=document.getElementById('status');
const show=s=>{statusEl.textContent=s;statusEl.hidden=!s};
const q=new URLSearchParams(location.search);
const valid=s=>typeof s==='string'&&/^[\w-]{11}$/.test(s);
function playlistId(s){if(typeof s!=='string')return '';s=s.trim();try{s=new URL(s).searchParams.get('list')||''}catch{}return /^[\w-]{12,150}$/.test(s)?s:''}
let cfg,groups=[],player,cursor=0,active=null,phase='init',timer,failedTurns=0;
function clearWatch(){clearTimeout(timer)}
function watch(){clearWatch();timer=setTimeout(()=>fail('Tempo limite do YouTube'),20000)}
function fail(message){clearWatch();if(phase==='stopped')return;phase='transition';if(++failedTurns>=groups.length){phase='stopped';show('Não foi possível reproduzir os vídeos: '+message);return}setTimeout(next,0)}
function next(){
 clearWatch();phase='transition';
 if(!cfg.loop&&groups.every(g=>g.done)){phase='stopped';show('Fim da reprodução.');return}
 for(let n=0;n<groups.length;n++){const g=groups[cursor];cursor=(cursor+1)%groups.length;if(g.done)continue;active=g;
 if(!g.ids){phase='cue';show('A consultar playlist…');watch();player.cuePlaylist({listType:'playlist',list:g.list});return}
 if(choose(g))return;
 }
 phase='stopped';show('Fim da reprodução.');
}
function choose(g){
 if(!g.ids.length){g.done=true;return false}
 let pool=g.ids.filter(v=>!g.bad.has(v)&&(!cfg.avoidRepeats||!g.used.has(v)));
 if(!pool.length&&cfg.loop){g.used.clear();pool=g.ids.filter(v=>!g.bad.has(v))}
 if(!pool.length){g.done=true;return false}
 const id=cfg.shuffle?pool[Math.floor(Math.random()*pool.length)]:pool[g.position++%pool.length];
 g.used.add(id);g.current=id;if(!cfg.loop&&g.used.size>=g.ids.length)g.done=true;
 phase='loading';show('A carregar vídeo…');watch();player.loadVideoById(id);return true;
}
function group(list,ids){return {list,ids,used:new Set(),bad:new Set(),position:0,done:false,current:null}}
function state(e){
 if(phase==='cue'&&e.data===5){clearWatch();const ids=e.target.getPlaylist();active.ids=[...new Set((Array.isArray(ids)?ids:[]).filter(valid))];if(!choose(active)){active.done=true;fail('Playlist vazia ou indisponível')}return}
 if(e.data===1&&(phase==='loading'||phase==='playing')){clearWatch();phase='playing';failedTurns=0;show('')}
 else if(e.data===0&&phase==='playing'){phase='transition';setTimeout(next,0)}
}
window.onYouTubeIframeAPIReady=()=>{
 const frame=document.createElement('iframe');frame.id='yt-frame';frame.title='YouTube';frame.allow='autoplay; encrypted-media; picture-in-picture; fullscreen';frame.allowFullscreen=true;frame.referrerPolicy='strict-origin-when-cross-origin';
 const p=new URLSearchParams({enablejsapi:'1',origin:location.origin,autoplay:'0',controls:'1',playsinline:'1',rel:'0'});
 frame.src='https://www.youtube.com/embed/?'+p;document.getElementById('player').append(frame);
 player=new YT.Player(frame,{events:{onReady:e=>{e.target.setVolume(cfg.volume);if(cfg.mute)e.target.mute();next()},onStateChange:state,onError:e=>{if(phase==='stopped'||phase==='init'||phase==='transition')return;if(e.data===153){clearWatch();phase='stopped';show('YouTube erro 153: identificação do leitor em falta.');return}if(phase==='cue'&&active)active.done=true;if(active&&active.current)active.bad.add(active.current);fail('Erro YouTube '+e.data)},onAutoplayBlocked:()=>{clearWatch();show('Reprodução automática bloqueada. Usa Interact e carrega em Play.')}}});
};
async function init(){try{
 const res=await fetch('./video-playlist.json',{cache:'no-store'});if(!res.ok)throw Error('HTTP '+res.status);const data=await res.json();
 cfg={loop:q.has('loop')?q.get('loop')==='1':data.loop!==false,shuffle:q.has('shuffle')?q.get('shuffle')==='1':data.shuffle!==false,avoidRepeats:q.has('unique')?q.get('unique')==='1':data.avoidRepeats!==false,volume:Math.max(0,Math.min(100,Number(q.get('volume')??data.volume??70))),mute:data.mute===true};
 if(!Number.isFinite(cfg.volume))cfg.volume=70;
 if(!cfg.loop)cfg.avoidRepeats=true;
 const lists=(q.has('lists')?q.get('lists').split(','):Array.isArray(data.playlists)?data.playlists:[]).map(playlistId).filter(Boolean);
 groups=[...new Set(lists)].map(id=>group(id,null));
 if(!groups.length){const ids=(q.has('ids')?q.get('ids').split(','):Array.isArray(data.videos)?data.videos:[]).filter(valid);if(ids.length)groups=[group(null,[...new Set(ids)])]}
 if(!groups.length){show('Lista vazia. Configura as playlists.');return}
 show('A carregar YouTube…');const s=document.createElement('script');s.src='https://www.youtube.com/iframe_api';s.onerror=()=>show('Não foi possível carregar a API YouTube.');document.head.append(s);
 }catch(e){show('Erro de configuração: '+e.message)}}
init();