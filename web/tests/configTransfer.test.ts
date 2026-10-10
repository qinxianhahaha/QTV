import test from 'node:test';
import assert from 'node:assert/strict';
import { isExportableStorageKey, parsePortableConfigPayload, buildPortableConfigFileName } from '../src/services/configTransfer.ts';

test('portable backups exclude credentials and arbitrary storage', () => {
  for (const key of ['bilibili_cookie', 'SESSDATA', 'token', '__proto__', 'unrelated']) assert.equal(isExportableStorageKey(key), false);
  for (const key of ['followedStreamers', 'followListOrder', 'dtv_danmu_preferences_v1', 'BILIBILI_preferred_quality']) assert.equal(isExportableStorageKey(key), true);
});
test('QTV accepts legacy DTV exports without importing cookies', () => {
  for (const kind of ['dtv-config', 'qtv-config']) {
    const parsed = parsePortableConfigPayload(JSON.stringify({kind, version:1, exportedAt:'2026-10-10T00:00:00Z', source:{client:'desktop'}, entries:{followedStreamers:'[]',bilibili_cookie:'test-only-placeholder'}}));
    assert.equal(parsed.kind, 'qtv-config');
    assert.deepEqual(parsed.entries, {followedStreamers:'[]'});
  }
  assert.match(buildPortableConfigFileName(), /^qtv-config-/);
});
