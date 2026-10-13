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
  const win = new EventTarget();
  const fullscreenListeners = new Map<string, () => void>();
  let onResize = () => {};
  let height = 675;
  const bullets: string[] = [];
  const sentStyles: Record<string, string>[] = [];
  const fontSizes: number[] = [];
  const areaLines: number[] = [];
  let engine: any;
  const host: any = { innerHTML: '', style: { setProperty() {} }, remove() {}, offsetWidth: 1200, get offsetHeight() { calls.reads++; return height; } };
  const root = { querySelector(selector: string) { return selector === '.player-danmu-overlay' ? host : root; } };
  host.parentElement = root;
  class Danmu {
    state = { bullets: [] as any[], comments: [] as any[] };
    constructor(options: any) { assert.equal(options.live, LIVE_DANMU_OPTIONS.live); engine = this; }
    start() { calls.starts++; }
    stop() { calls.stops++; }
    clear() { calls.clears++; bullets.length = 0; this.state.bullets = []; this.state.comments = []; }
    destroy() { calls.destroys++; }
    sendComment(comment: any) { calls.sent++; bullets.push(comment.txt); sentStyles.push(comment.style); }
    show() {} hide() {} setOpacity() {} setFontSize(size: number) { calls.fonts++; fontSizes.push(size); } setArea(area: any) { calls.areas++; areaLines.push(area.lines); } setAllDuration() { calls.durations++; }
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
    }, document: doc, window: win, console, requestAnimationFrame: (callback: () => void) => { frames.set(++frameId, callback); return frameId; }, cancelAnimationFrame: (id: number) => frames.delete(id), ResizeObserver: class { constructor(callback: () => void) { onResize = callback; } observe() {} disconnect() { calls.disconnects++; } } });
    return exports as any;
  }
  const constants = load('../src/components/player/constants.ts', { '@tauri-apps/plugin-os': {} });
  const mod = load('../src/components/player/danmuOverlay.ts', { 'danmu.js': Danmu, './constants': constants, '@/services/livePlaybackPolicy': { LIVE_DANMU_OPTIONS } });
  const overlay = mod.createDanmuOverlay({ root, video: media, on(event: string, callback: () => void) { fullscreenListeners.set(event, callback); }, off(event: string) { fullscreenListeners.delete(event); } }, settings, enabled);
  assert.ok(overlay);
  return { overlay, calls, media, doc, win, flushFrames, frames, bullets, sentStyles, fontSizes, areaLines, fullscreenListeners, setLoad(visible: number, pending = 0) { engine.state.bullets = Array.from({ length: visible }, () => ({})); engine.state.comments = Array.from({ length: pending }, () => ({ attached_: false })); }, resize(width: number, nextHeight: number) { host.offsetWidth = width; height = nextHeight; onResize(); } };
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


test('fullscreen drops old bullets and resumes only after the resized layout commits', () => {
  const { overlay, calls, doc, bullets, resize, flushFrames } = harness();
  flushFrames();
  overlay.sendComment({ txt: 'old visible bullet' });
  assert.deepEqual(bullets, ['old visible bullet']);
  doc.dispatchEvent(new Event('fullscreenchange'));
  assert.equal(calls.stops, 1);
  assert.deepEqual(bullets, []);
  resize(1920, 1080);
  overlay.sendComment({ txt: 'during transition' });
  assert.equal(calls.sent, 1);
  assert.equal(calls.starts, 1);
  flushFrames();
  overlay.sendComment({ txt: 'new fullscreen bullet' });
  assert.equal(calls.starts, 2);
  assert.deepEqual(bullets, ['new fullscreen bullet']);
  const before = { ...calls };
  resize(1920, 1080);
  flushFrames();
  assert.equal(calls.starts, before.starts);
  assert.equal(calls.clears, before.clears);
  resize(1200, 675);
  assert.deepEqual(bullets, []);
  flushFrames();
  overlay.sendComment({ txt: 'new windowed bullet' });
  assert.equal(calls.starts, 3);
  assert.deepEqual(bullets, ['new windowed bullet']);
  overlay.destroy();
});

test('rapid CSS fullscreen changes coalesce and remove all transition listeners on destroy', () => {
  const { overlay, calls, fullscreenListeners, win, doc, resize, flushFrames, frames } = harness();
  flushFrames();
  for (let n = 0; n < 5; n++) {
    fullscreenListeners.get('cssFullscreen_change')!();
    win.dispatchEvent(new Event('resize'));
    resize(1500 + n * 100, 850 + n * 60);
  }
  assert.equal(calls.stops, 1);
  assert.equal(calls.clears, 1);
  assert.equal(frames.size, 1);
  flushFrames();
  assert.equal(calls.starts, 2);
  fullscreenListeners.get('fullscreen_change')!();
  overlay.destroy();
  assert.equal(frames.size, 0);
  assert.equal(fullscreenListeners.size, 0);
  const before = { ...calls };
  doc.dispatchEvent(new Event('webkitfullscreenchange'));
  win.dispatchEvent(new Event('resize'));
  resize(800, 450);
  flushFrames();
  assert.deepEqual(calls, before);
});

test('fullscreen never enables disabled or paused chat', () => {
  for (const paused of [false, true]) {
    const { overlay, calls, media, doc, resize, flushFrames } = harness(false, paused);
    flushFrames();
    doc.dispatchEvent(new Event('fullscreenchange'));
    resize(1920, 1080);
    flushFrames();
    overlay.sendComment({ txt: 'disabled' });
    assert.equal(calls.starts, 0);
    assert.equal(calls.sent, 0);
    overlay.play();
    flushFrames();
    if (paused) {
      assert.equal(calls.starts, 0);
      media.paused = false;
      media.dispatchEvent(new Event('playing'));
      flushFrames();
    }
    overlay.sendComment({ txt: 'enabled' });
    assert.equal(calls.starts, 1);
    assert.equal(calls.sent, 1);
    overlay.destroy();
  }
});


test('small windows scale text and halve density; restoring returns to the saved size', () => {
  const h = harness();
  h.flushFrames();
  h.overlay.sendComment({ txt: 'full size' });
  assert.equal(h.sentStyles.at(-1)!.fontSize, '20px');
  h.resize(640, 360);
  h.flushFrames();
  h.overlay.sendComment({ txt: 'small size', style: { fontSize: '30px', color: '#abc' } });
  assert.equal(h.sentStyles.at(-1)!.fontSize, '16px');
  assert.equal(h.sentStyles.at(-1)!.color, '#abc');
  assert.equal(h.fontSizes.at(-1), 16);
  assert.equal(h.areaLines.at(-1), 6);
  h.setLoad(11, 1); // Six lines × two bullets, including queued incoming comments.
  const sent = h.calls.sent;
  h.overlay.sendComment({ txt: 'over small-window capacity' });
  assert.equal(h.calls.sent, sent);
  h.setLoad(11);
  h.overlay.sendComment({ txt: 'one available slot' });
  assert.equal(h.calls.sent, sent + 1);
  h.resize(1200, 675);
  h.flushFrames();
  h.setLoad(24);
  h.overlay.sendComment({ txt: 'full-window capacity restored' });
  assert.equal(h.calls.sent, sent + 2);
  assert.equal(h.sentStyles.at(-1)!.fontSize, '20px');
  assert.equal(h.fontSizes.at(-1), 20);
  assert.equal(settings.fontSize, '20px');
  h.overlay.destroy();
});

test('the smallest window remains readable and keeps font edits for the restored window', () => {
  const h = harness();
  h.flushFrames();
  h.resize(320, 180);
  h.flushFrames();
  h.overlay.sendComment({ txt: 'smallest' });
  assert.equal(h.sentStyles.at(-1)!.fontSize, '12px');
  h.overlay.setFontSize(30);
  h.overlay.sendComment({ txt: 'changed preference in mini window' });
  assert.equal(h.sentStyles.at(-1)!.fontSize, '18px');
  h.setLoad(6); // Three readable rows × two bullets.
  const sent = h.calls.sent;
  h.overlay.sendComment({ txt: 'mini window filled' });
  assert.equal(h.calls.sent, sent);
  h.resize(1920, 1080);
  h.flushFrames();
  h.overlay.sendComment({ txt: 'saved size restored' });
  assert.equal(h.sentStyles.at(-1)!.fontSize, '30px');
  h.overlay.destroy();
});
