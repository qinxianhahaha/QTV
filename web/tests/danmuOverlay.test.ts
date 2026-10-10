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
  const calls = { starts: 0, stops: 0, clears: 0, destroys: 0, sent: 0, reads: 0, disconnects: 0 };
  const media = Object.assign(new EventTarget(), { paused, ended: false });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const host: any = { innerHTML: '', style: { setProperty() {} }, remove() {}, get offsetHeight() { calls.reads++; return 675; } };
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
    show() {} hide() {} setOpacity() {} setFontSize() {} setArea() {} setAllDuration() {}
  }
  function load(file: string, dependencies: Record<string, unknown>) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const exports = {};
    vm.runInNewContext(compiled, { exports, require: (id: string) => {
      if (!(id in dependencies)) throw new Error(`Unexpected import ${id}`);
      return dependencies[id];
    }, document: doc, console, ResizeObserver: class { observe() {} disconnect() { calls.disconnects++; } } });
    return exports as any;
  }
  const constants = load('../src/components/player/constants.ts', { '@tauri-apps/plugin-os': {} });
  const mod = load('../src/components/player/danmuOverlay.ts', { 'danmu.js': Danmu, './constants': constants, '@/services/livePlaybackPolicy': { LIVE_DANMU_OPTIONS } });
  const overlay = mod.createDanmuOverlay({ root, video: media }, settings, enabled);
  assert.ok(overlay);
  return { overlay, calls, media, doc };
}

test('incoming comments do not read layout per message', () => {
  const { overlay, calls } = harness();
  const reads = calls.reads;
  for (let n = 0; n < 1000; n++) overlay.sendComment({ id: String(n), txt: 'hello' });
  assert.equal(calls.sent, 1000);
  assert.equal(calls.reads, reads);
  assert.equal(calls.starts, 1);
  overlay.destroy();
});

test('hidden or paused playback stops chat work; resuming starts only once', () => {
  const { overlay, calls, media, doc } = harness();
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
  const { overlay, calls } = harness(false);
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
