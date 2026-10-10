import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { watchPlayback, frameRate, codecLabel, type PlaybackStats } from '../src/services/playbackTelemetry.ts';

test('codec and source fps are decoded without inventing missing metadata', () => {
  assert.equal(codecLabel('hvc1.1.6.L153.B0'),'HEVC');
  assert.equal(codecLabel('avc1.640033'),'H.264');
  assert.equal(frameRate({fpsNum:60000,fpsDen:1001}),59.9);
  assert.equal(frameRate(undefined),null);
  assert.equal(frameRate(90000),null);
});

test('watchdog distinguishes pause from stalls, honors generations and cleans listeners', t => {
  t.mock.timers.enable({apis:['setInterval','Date'],now:10000});
  const doc = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible'}});
  const video = Object.assign(new EventTarget(), {
    currentTime:1, paused:false, ended:false, error:null, readyState:4,
    videoWidth:1920,videoHeight:1080,buffered:{length:0},
    getVideoPlaybackQuality:()=>({totalVideoFrames:600,droppedVideoFrames:2}),
  });
  const player=Object.assign(new EventEmitter(),{video});
  let active=true, failures=0, progresses=0, pauses=0;
  let stats: PlaybackStats | null=null;
  const cleanup=watchPlayback(player,{active:()=>active,stats:s=>{stats=s;},progress:()=>{progresses++;},pause:()=>{pauses++;},failure:()=>{failures++;}});
  try {
    player.emit('core_event',{eventName:'core.metadataparsed',type:'video',meta:{codec:'avc1.640033'},track:{fpsNum:60,fpsDen:1}});
    video.currentTime=2; t.mock.timers.tick(1000);
    assert.equal((stats as PlaybackStats|null)?.width,1920);
    assert.equal((stats as PlaybackStats|null)?.sourceFps,60);
    assert.equal(progresses,1);
    video.paused=true; video.dispatchEvent(new Event("pause")); t.mock.timers.tick(60000); assert.equal(failures,0); assert.equal(pauses,1);
    video.paused=false; t.mock.timers.tick(16000); assert.equal(failures,1);
    active=false; player.emit('error',new Error('old room')); t.mock.timers.tick(30000);
    assert.equal(failures,1);
    cleanup(); assert.equal(player.listenerCount('core_event'),0);
    assert.equal(player.listenerCount('error'),0);
  } finally { cleanup(); if(doc) Object.defineProperty(globalThis,'document',doc); else delete (globalThis as any).document; }
});

test('short compositor bursts ignore repeated frames and stop completely when the panel closes', t => {
  t.mock.timers.enable({apis:['setInterval','Date'],now:10000});
  const doc = Object.getOwnPropertyDescriptor(globalThis,'document');
  Object.defineProperty(globalThis,'document',{configurable:true,value:{visibilityState:'visible'}});
  let callback: ((time: number, meta: any) => void) | null = null;
  let cancelled = 0;
  let panelOpen = true;
  const video=Object.assign(new EventTarget(),{
    currentTime:0,paused:false,ended:false,error:null,readyState:4,videoWidth:1920,videoHeight:1080,buffered:{length:0},
    getVideoPlaybackQuality:()=>({totalVideoFrames:video.currentTime*120,droppedVideoFrames:0}),
    requestVideoFrameCallback:(cb: typeof callback)=>{callback=cb;return 42;},
    cancelVideoFrameCallback:()=>{cancelled++;},
  });
  const player=Object.assign(new EventEmitter(),{video});
  let stats: PlaybackStats | null=null;
  const cleanup=watchPlayback(player,{active:()=>true,measureFrames:()=>panelOpen,stats:s=>{stats=s;},progress:()=>{},failure:()=>{}});
  try {
    video.currentTime=1; t.mock.timers.tick(1000);
    // 120 Hz display callbacks but only 60 distinct source frames per second.
    for(let n=0;n<=48;n++) {
      (callback as ((time:number,meta:any)=>void)|null)?.(11000+n*1000/120,{presentedFrames:n,mediaTime:Math.floor(n/2)/60});
    }
    assert.equal((stats as PlaybackStats|null)?.playbackFps,60);
    video.currentTime=6; t.mock.timers.tick(5000);
    panelOpen=false; video.currentTime=7; t.mock.timers.tick(1000);
    assert.equal(cancelled,1);
    callback=null; video.currentTime=8; t.mock.timers.tick(1000); assert.equal(callback,null);

  } finally { cleanup(); if(doc) Object.defineProperty(globalThis,'document',doc); else delete (globalThis as any).document; }
});
