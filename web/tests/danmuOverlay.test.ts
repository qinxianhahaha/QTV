import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { LIVE_DANMU_OPTIONS } from '../src/services/livePlaybackPolicy.ts';

const require = createRequire(import.meta.url);
const ts = require('typescript');
const settings = { color: '#fff', strokeColor: '#444', fontSize: '20px', duration: 10000, area: 0.5, opacity: 1, mode: 'scroll' };

function harness(enabled = true, paused = false) {
  const calls = { starts: 0, stops: 0, clears: 0, destroys: 0, sent: 0, reads: 0, disconnects: 0, fonts: 0, areas: 0, durations: 0 };
  const media = Object.assign(new EventTarget(), { paused, ended: false, readyState: 3, currentTime: 0, seeking: false });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const host: any = { innerHTML: '', style: { setProperty() {} }, remove() {}, offsetWidth: 1200, get offsetHeight() { calls.reads++; return 675; } };
  const root = { querySelector(selector: string) { return selector === '.player-danmu-overlay' ? host : root; } };
  host.parentElement = root;
  class Danmu {
    state = { bullets: [] };
    constructor(options: any) { assert.equal(options.live, LIVE_DANMU_OPTIONS.live); }
    start() { calls.starts++; }
    stop() { calls.stops++; }
    clear() { calls.clears++; }
    destroy() { calls.destroys++; }
    sendComment() { calls.sent++; }
    show() {} hide() {} setOpacity() {} setFontSize() { calls.fonts++; } setArea() { calls.areas++; } setAllDuration() { calls.durations++; }
  }
  const frames = new Map<number, () => void>();
  let frameId = 0;
  const flushFrames = () => {
    for (let round = 0; round < 2; round++) {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach(callback => callback());
    }
  };
  function load(file: string, dependencies: Record<string, unknown>) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, require: (id: string) => {
      if (!(id in dependencies)) throw new Error(`Unexpected import ${id}`);
      return dependencies[id];
    }, document: doc, console, requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => frames.delete(id), ResizeObserver: class { observe() {} disconnect() { calls.disconnects++; } } });
    return exports as any;
  }
  const constants = load('../src/components/player/constants.ts', { '@tauri-apps/plugin-os': {} });
  const mod = load('../src/components/player/danmuOverlay.ts', { 'danmu.js': Danmu, './constants': constants, '@/services/livePlaybackPolicy': { LIVE_DANMU_OPTIONS } });
  const overlay = mod.createDanmuOverlay({ root, video: media }, settings, enabled);
  assert.ok(overlay);
  return { overlay, calls, media, doc, flushFrames, frames };
}

test('incoming comments do not read layout per message', () => {
  const { overlay, calls, flushFrames } = harness();
  flushFrames();
  const reads = calls.reads;
  for (let n = 0; n < 1000; n++) overlay.sendComment({ id: String(n), txt: 'hello' });
  assert.equal(calls.sent, 1000);
  assert.equal(calls.reads, reads);
  assert.equal(calls.starts, 1);
  overlay.destroy();
});

test('hidden or paused playback stops chat work; resuming starts only once', () => {
  const { overlay, calls, media, doc, flushFrames } = harness();
  flushFrames();
  doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange'));
  overlay.sendComment({ txt: 'hidden' });
  assert.equal(calls.sent, 0);
  assert.equal(calls.stops, 1);
  doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(calls.starts, 2);
  media.paused = true; media.dispatchEvent(new Event('pause'));
  overlay.sendComment({ txt: 'paused' });
  assert.equal(calls.sent, 0);
  media.paused = false; media.dispatchEvent(new Event('playing'));
  flushFrames();
  overlay.sendComment({ txt: 'resumed' });
  assert.equal(calls.sent, 1);
  assert.equal(calls.starts, 3);
  overlay.destroy();
  overlay.destroy();
  doc.dispatchEvent(new Event('visibilitychange'));
  media.dispatchEvent(new Event('playing'));
  assert.equal(calls.starts, 3);
  assert.equal(calls.destroys, 1);
  assert.equal(calls.disconnects, 1);
});

test('starting with chat disabled does no animation work and can be re-enabled', () => {
  const { overlay, calls, flushFrames } = harness(false);
  flushFrames();
  overlay.sendComment({ txt: 'off' });
  assert.equal(calls.starts, 0);
  assert.equal(calls.sent, 0);
  overlay.play();
  overlay.sendComment({ txt: 'on' });
  assert.equal(calls.starts, 1);
  assert.equal(calls.sent, 1);
  overlay.pause();
  overlay.sendComment({ txt: 'off again' });
  assert.equal(calls.stops, 1);
  assert.equal(calls.sent, 1);
  overlay.destroy();
});


test('play request does not launch the initial burst before playing and layout commit', () => {
  const { overlay, calls, media, flushFrames, frames } = harness(true, true);
  media.paused = false;
  for (let n = 0; n < 7; n++) overlay.sendComment({ txt: `early ${n}` });
  flushFrames();
  assert.equal(calls.starts, 0);
  assert.equal(calls.sent, 0);
  media.dispatchEvent(new Event('playing'));
  overlay.sendComment({ txt: 'layout not committed' });
  assert.equal(calls.sent, 0);
  flushFrames();
  overlay.sendComment({ txt: 'first smooth bullet' });
  assert.equal(calls.starts, 1);
  assert.equal(calls.sent, 1);
  media.dispatchEvent(new Event('waiting'));
  overlay.sendComment({ txt: 'buffering' });
  assert.equal(calls.stops, 1);
  assert.equal(calls.sent, 1);
  media.dispatchEvent(new Event('playing'));
  overlay.destroy();
  assert.equal(frames.size, 0);
  flushFrames();
  assert.equal(calls.starts, 1);
});


test('reapplying startup preferences does not interrupt moving bullets', () => {
  const { overlay, calls, flushFrames } = harness();
  flushFrames();
  overlay.sendComment({ txt: 'moving' });
  const before = { ...calls };
  for (let n = 0; n < 3; n++) {
    overlay.setFontSize(20);
    overlay.setArea({ start: 0, end: 0.5 });
    overlay.setAllDuration('scroll', 10000);
  }
  assert.equal(calls.fonts, before.fonts);
  assert.equal(calls.areas, before.areas);
  assert.equal(calls.durations, before.durations);
  overlay.setFontSize(24);
  overlay.setArea({ start: 0, end: 0.8 });
  overlay.setAllDuration('scroll', 15000);
  assert.equal(calls.fonts, before.fonts + 1);
  assert.equal(calls.areas, before.areas + 2);
  assert.equal(calls.durations, before.durations + 3);
  overlay.destroy();
});


test('WebKit live seek resumes on advancing decoded time without another playing event', () => {
  const { overlay, calls, media, flushFrames } = harness();
  flushFrames();
  media.dispatchEvent(new Event('seeking'));
  media.dispatchEvent(new Event('timeupdate'));
  flushFrames();
  overlay.sendComment({ txt: 'stationary media' });
  assert.equal(calls.sent, 0);
  media.currentTime = 1;
  media.readyState = 2;
  media.dispatchEvent(new Event('timeupdate'));
  flushFrames();
  overlay.sendComment({ txt: 'decoded media advancing' });
  assert.equal(calls.sent, 1);
  assert.equal(calls.starts, 2);
  overlay.destroy();
});
