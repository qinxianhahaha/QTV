import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlaybackRecovery, type RecoveryState } from '../src/services/playbackRecovery.ts';

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
test('duplicate failures share one bounded exponential retry budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts: number[] = []; const states: RecoveryState[] = [];
  const r = createPlaybackRecovery({ online: () => true, onState: s => states.push(s), retry: async n => { attempts.push(n); throw new Error('expired signature'); } });
  r.fail(); r.fail(); r.fail();
  for (const delay of [1000,3000,8000,15000]) { t.mock.timers.tick(delay); await flush(); }
  assert.deepEqual(attempts,[1,2,3,4]);
  assert.equal(states.at(-1)?.phase,'failed');
  t.mock.timers.tick(600000); await flush();
  assert.equal(attempts.length,4);
  r.stop();
});
test('brief playback does not reset retry budget; sustained playback does', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const attempts: number[] = [];
  const r = createPlaybackRecovery({ online: () => true, onState: () => {}, retry: async n => { attempts.push(n); } });
  r.fail(); t.mock.timers.tick(1000); await flush();
  r.progress(1000); r.progress(2000); r.fail(); t.mock.timers.tick(3000); await flush();
  assert.deepEqual(attempts,[1,2]);
  for (let n=10000;n<=31000;n+=1000) r.progress(n);
  r.fail(); t.mock.timers.tick(1000); await flush();
  assert.deepEqual(attempts,[1,2,1]); r.stop();
});
test('offline waits without consuming attempts and resumes on reconnect', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let online = false; let calls = 0; let state: RecoveryState = null;
  const r = createPlaybackRecovery({ online: () => online, onState: s => { state=s; }, retry: async () => { calls++; } });
  r.fail(); t.mock.timers.tick(60000); await flush();
  assert.equal(calls,0); assert.equal((state as RecoveryState)?.phase,'waiting');
  online=true; r.networkChanged(); t.mock.timers.tick(1000); await flush();
  assert.equal(calls,1); r.stop();
});
test('close, manual refresh and the player own recovery cancel stale retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const r = createPlaybackRecovery({ online: () => true, onState: () => {}, retry: async () => { calls++; } });
  r.fail(); r.progress(1000); t.mock.timers.tick(30000); assert.equal(calls,0);
  r.fail(); r.reset(); t.mock.timers.tick(30000); assert.equal(calls,0);
  r.fail(); r.stop(); t.mock.timers.tick(30000); assert.equal(calls,0);
});
test('late failure from a replaced session cannot restart recovery', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reject!: (error: Error) => void;
  let calls=0;
  const r = createPlaybackRecovery({ online: () => true, onState: () => {}, retry: () => { calls++; return new Promise((_,no) => { reject=no; }); } });
  r.fail(); t.mock.timers.tick(1000);
  r.reset(); reject(new Error('old room')); await flush();
  t.mock.timers.tick(60000); await flush(); assert.equal(calls,1); r.stop();
});
