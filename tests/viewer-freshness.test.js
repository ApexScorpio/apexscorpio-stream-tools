const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const source=fs.readFileSync(require('path').join(__dirname,'..','viewers.js'),'utf8');
function harness(fetch){const ctx={isTestActive:false,lastYoutubeFetch:0,realState:{youtube:{viewers:2,isLive:true}},YOUTUBE_BACKEND_BASE:'https://primary.example',AbortSignal,fetch,recalculateTotal(){},renderStatus(){}};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('  let youtubeFetchInFlight'),source.indexOf('  function resetToRealState')),ctx);vm.runInContext(source.slice(source.indexOf('  function applyYoutubeLiveState'),source.indexOf('  if(window.YoutubeLive)')),ctx);return ctx;}
test('rate limited primary falls back and accepts decreasing counts including zero',async()=>{
 const calls=[];let count=1;const ctx=harness(async url=>{calls.push(url);return url.includes('primary.example')?{ok:false,status:429}:{ok:true,json:async()=>({isLive:true,viewers:count})};});
 await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,1);assert.equal(calls.length,2);
 count=0;await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,0);assert.equal(ctx.realState.youtube.isLive,true);
});
test('stale shared player heartbeat cannot overwrite a recent count',async()=>{
 const ctx=harness(async()=>({ok:true,json:async()=>({isLive:true,viewers:1})}));await ctx.checkNetlifyYoutubeStatus();
 ctx.applyYoutubeLiveState({isLive:true,viewers:2,updatedAt:Date.now()});assert.equal(ctx.realState.youtube.viewers,1);
 ctx.lastYoutubeFetch=Date.now()-60000;ctx.applyYoutubeLiveState({isLive:true,viewers:2,updatedAt:Date.now()});assert.equal(ctx.realState.youtube.viewers,null);
});
test('unavailable backends expire old count without inventing zero',async()=>{
 const ctx=harness(async()=>({ok:false,status:429}));ctx.lastYoutubeFetch=Date.now()-60000;
 await ctx.checkNetlifyYoutubeStatus();assert.equal(ctx.realState.youtube.viewers,null);assert.equal(ctx.realState.youtube.status,'stale');
});
