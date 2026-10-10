import test from 'node:test';
import assert from 'node:assert/strict';
import { LIVE_DANMU_OPTIONS, withHlsTimerCleanup } from '../src/services/livePlaybackPolicy.ts';
import { createInstalledDanmuQueue } from './helpers/danmuQueueHarness.ts';

test('live comments do not accumulate an entire session of sorting/scanning work', () => {
  const old = createInstalledDanmuQueue();
  const live = createInstalledDanmuQueue(LIVE_DANMU_OPTIONS);
  for (let tick = 1; tick <= 400; tick++) {
    for (let n = 0; n < 10; n++) { old.send(tick * 10 + n); live.send(tick * 10 + n); }
    old.tick(tick / 4 + 1);
    live.tick(tick / 4 + 1);
    assert.equal(live.size, 0);
  }
  assert.equal(old.size, 4000); // Reproduce the original leak against the same library.
});

test('a burst while the render tick is delayed has a bounded pending queue', () => {
  const live = createInstalledDanmuQueue(LIVE_DANMU_OPTIONS);
  for (let n = 1; n <= 10000; n++) live.send(n);
  assert.equal(live.size, LIVE_DANMU_OPTIONS.maxCommentsLength);
  live.tick(5);
  assert.equal(live.size, 0);
});

test('HLS URL switches and destruction leave no statistics timers running', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  let ticks = 0;
  let destroyed = 0;
  class HlsPlugin {
    static pluginName = 'HlsJsPlugin';
    _statisticsTimmer: ReturnType<typeof setInterval> | undefined;
    _statistics() { this._statisticsTimmer = setInterval(() => { ticks++; }, 1000); }
    destroy() { destroyed++; }
  }
  const Managed = withHlsTimerCleanup(HlsPlugin);
  const plugin = new Managed();
  assert.equal(Managed.pluginName, HlsPlugin.pluginName);
  plugin._statistics();
  plugin._statistics();
  plugin._statistics();
  t.mock.timers.tick(1000);
  assert.equal(ticks, 1);
  plugin.destroy();
  t.mock.timers.tick(5000);
  assert.equal(ticks, 1);
  assert.equal(destroyed, 1);
});
