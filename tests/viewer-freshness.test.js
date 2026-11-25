const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require('path').join(__dirname,'..','viewers.js'),'utf8');
function harness(fetch){const ctx={window:{APEX_BACKEND_URL:'https://primary.example',location:{origin:'https://overlay.example'}},isTestActive:false,lastYoutubeFetch:0,realState:{youtube:{viewers:2,isLive:true}},YOUTUBE_BACKEND_BASE:'https://primary.example',AbortSignal,fetch,recalculateTotal(){},renderStatus(){}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('  let youtubeFetchInFlight'),source.indexOf('  function resetToRealState')),ctx);vm.runInContext(source.slice(source.indexOf('  function applyYoutubeLiveState'),source.indexOf('  if(window.YoutubeLive)')),ctx);return ctx;}
test('rate limited primary falls back and accepts decreasing counts including zero',async()=>{
 const calls=[];let count=1;const ctx=harness(async url=>{calls.push(url);return url.includes('primary.example')?{ok:false,status:429}:{ok:true,json:async()=>({isLive:true,viewers:count,updatedAt:new Date().toISOString()})};});
 await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,1);assert.equal(calls.length,2);
 count=0;await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,0);assert.equal(ctx.realState.youtube.isLive,true);
});
test('stale shared player heartbeat cannot overwrite a recent count',async()=>{
 const ctx=harness(async()=>({ok:true,json:async()=>({isLive:true,viewers:1,updatedAt:new Date().toISOString()})}));await ctx.checkNetlifyYoutubeStatus();
 ctx.applyYoutubeLiveState({isLive:true,viewers:2,updatedAt:Date.now()});assert.equal(ctx.realState.youtube.viewers,1);
 ctx.lastYoutubeFetch=Date.now()-60000;ctx.applyYoutubeLiveState({isLive:true,viewers:2,updatedAt:Date.now()});assert.equal(ctx.realState.youtube.viewers,null);
});

test('current endpoint wins over the saved November 22 offline snapshot',async()=>{
 const calls=[];const ctx=harness(async url=>{calls.push(url);return {ok:true,json:async()=>url.includes('overlay-config')?{config:{isLive:false,viewers:0,_updatedAt:1795373730475}}:{isLive:true,viewers:1,updatedAt:new Date().toISOString()}};});
 await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.isLive,true);assert.equal(ctx.realState.youtube.viewers,1);assert.equal(calls.length,1);assert.match(calls[0],/primary\.example\/youtube-status/);
});
test('stale live, stale offline, missing dates, future dates and unknown offline are rejected',async()=>{
 const bad=[{isLive:false,_updatedAt:1795373730475},{isLive:true,viewers:99,updatedAt:Date.now()-61000},{isLive:false},{isLive:true,updatedAt:Date.now()+60000},{isLive:false,status:'unknown',updatedAt:Date.now()}];
 for(const response of bad){const ctx=harness(async()=>({ok:true,json:async()=>response}));await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.status,'stale');assert.equal(ctx.realState.youtube.viewers,null);assert.equal(ctx.realState.youtube.isLive,true);}
});
test('fresh confirmed offline after a live is accepted',async()=>{
 const ctx=harness(async()=>({ok:true,json:async()=>({isLive:false,viewers:0,updatedAt:new Date().toISOString()})}));await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.isLive,false);assert.equal(ctx.realState.youtube.status,'confirmed');assert.equal(ctx.realState.youtube.viewers,null);
});
test('stale first endpoint falls back to a fresh observation',async()=>{
 const calls=[];const ctx=harness(async url=>{calls.push(url);return {ok:true,json:async()=>url.includes('primary.example')?{isLive:false,updatedAt:Date.now()-120000}:{isLive:true,viewers:0,updatedAt:Date.now()}};});await ctx.checkNetlifyYoutubeStatus();assert.equal(calls.length,2);assert.equal(ctx.realState.youtube.isLive,true);assert.equal(ctx.realState.youtube.viewers,0);
});
test('delayed HTTP and old dashboard status cannot replace a newer observation',async()=>{
 const ctx=harness(async()=>({ok:true,json:async()=>({isLive:false,updatedAt:Date.now()-10000})}));ctx.lastYoutubeFetch=Date.now();await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.isLive,true);assert.equal(ctx.realState.youtube.viewers,2);
 vm.runInContext(source.slice(source.indexOf('  function handleIncomingData('),source.indexOf('  window.ApexYoutubeScrapeDebug')),ctx);
 for(const data of [{isLive:false},{isLive:false,updatedAt:Date.now()-120000}])ctx.handleIncomingData('status_update',{youtube:data});assert.equal(ctx.realState.youtube.isLive,true);assert.equal(ctx.realState.youtube.viewers,2);
});
test('fresh saved state is only used when live endpoints fail',async()=>{
 const ctx=harness(async url=>url.includes('overlay-config')?{ok:true,json:async()=>({config:{isLive:true,viewers:3,_updatedAt:Date.now()}})}:{ok:false,status:503});await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,3);
});
test('unavailable backends expire old count without inventing zero',async()=>{
 const ctx=harness(async()=>({ok:false,status:429}));ctx.lastYoutubeFetch=Date.now()-60000;
 await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,null);assert.equal(ctx.realState.youtube.status,'stale');
});
