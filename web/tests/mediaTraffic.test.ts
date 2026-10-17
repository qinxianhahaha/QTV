import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrafficSampler, formatTrafficBytes, mediaTrafficUrl, watchMediaTraffic } from '../src/services/mediaTraffic.ts';

test('media traffic endpoint stays on the current private loopback relay', () => {
  const prefix = 'a'.repeat(32);
  assert.equal(mediaTrafficUrl(`http://127.0.0.1:1234/${prefix}/1/media.m3u8`), `http://127.0.0.1:1234/${prefix}/traffic`);
  assert.equal(mediaTrafficUrl(`http://127.0.0.1:1234/${prefix}/live.flv`), `http://127.0.0.1:1234/${prefix}/traffic`);
  assert.equal(mediaTrafficUrl('https://cdn.example.com/live.flv'), null);
  assert.equal(mediaTrafficUrl('http://127.0.0.1:1234/image?url=secret'), null);
});

test('network rate uses elapsed wall time, counts idle seconds and smooths HLS bursts', () => {
  const sample = createTrafficSampler();
  assert.equal(sample(5000000, 1000).bytesPerSecond, null);
  assert.equal(sample(6000000, 2000).bytesPerSecond, 1000000);
  const idle = sample(6000000, 3000);
  assert.equal(idle.bytesPerSecond, 0);
  assert.equal(idle.averageBytesPerSecond, 500000);
  assert.equal(sample(9000000, 6000).bytesPerSecond, 1000000);
  for (let time = 7000; time <= 16000; time += 1000) sample(9000000, time);
  assert.equal(sample(9000000, 17000).averageBytesPerSecond, 0);
  assert.equal(sample(100, 18000).bytesPerSecond, null); // new connection
  assert.equal(sample(200, 18000).bytesPerSecond, null); // invalid interval
  assert.equal(sample(NaN, 19000).totalBytes, null);
});

test('byte units match decimal bandwidth and retain zero versus unavailable', () => {
  assert.equal(formatTrafficBytes(1000000, true), '1.00 MB/s');
  assert.equal(formatTrafficBytes(625000, true), '625 KB/s'); // 5 Mbps
  assert.equal(formatTrafficBytes(3600000000), '3.60 GB');
  assert.equal(formatTrafficBytes(0, true), '0 B/s');
  assert.equal(formatTrafficBytes(null, true), '—');
});

test('closing the panel aborts its request and suppresses late results', async t => {
  let resolve!: (value: Response) => void;
  let signal: AbortSignal | null = null;
  t.mock.method(globalThis, 'fetch', (_url: unknown, options: RequestInit) => {
    signal = options.signal as AbortSignal;
    return new Promise<Response>(done => { resolve = done; });
  });
  let updates = 0;
  const stop = watchMediaTraffic('http://127.0.0.1/traffic', () => { updates++; });
  stop();
  assert.equal((signal as AbortSignal | null)?.aborted, true);
  resolve(new Response(JSON.stringify({ totalBytes: 1000 })));
  await new Promise(done => setTimeout(done, 0));
  assert.equal(updates, 0);
});
