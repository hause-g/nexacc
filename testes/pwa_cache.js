'use strict';
const assert=require('assert/strict'),vm=require('vm'),fs=require('fs'),path=require('path');
const events={};let called=0,matchCalls=[],failInstall=false;
const env={self:{location:{origin:'http://localhost:8765'},addEventListener:(n,f)=>events[n]=f,skipWaiting:()=>called++,clients:{claim:()=>{}}},URL,Response,fetch:async()=>{throw Error('offline');},caches:{open:async()=>({addAll:async()=>{if(failInstall)throw Error('missing asset');},put:async()=>{}}),keys:async()=>[],delete:async()=>{},match:async key=>{matchCalls.push(key);return key==='./index.html'?new Response('HTML'):undefined;}}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../service-worker.js'),'utf8'),env);
async function get(url,mode){let result;events.fetch({request:{url,method:'GET',mode},respondWith:p=>result=p,waitUntil:()=>{}});return result;}
(async()=>{
 let n=0;
 const asset=await get('http://localhost:8765/missing.js','cors');assert.equal(asset.type,'error');assert.equal(matchCalls.includes('./index.html'),false);n+=2;
 const page=await get('http://localhost:8765/index.html','navigate');assert.equal(await page.text(),'HTML');n++;
 matchCalls=[];await assert.rejects(get('http://localhost:8765/api/estado','cors'));assert.equal(matchCalls.length,0);n+=2;
 assert.equal(await get('https://outside.example/script.js','cors'),undefined);n++;
 failInstall=true;let install;events.install({waitUntil:p=>install=p});await assert.rejects(install);assert.equal(called,0);n+=2;
 failInstall=false;events.install({waitUntil:p=>install=p});await install;assert.equal(called,1);n++;
 console.log('PWA: '+n+' verificações aprovadas');
})().catch(e=>{console.error(e);process.exitCode=1;});
