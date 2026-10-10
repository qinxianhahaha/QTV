import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDouyinRoomInput } from '../src/services/douyinRoomInput.ts';

test('extracts room ID from follow link, never anchor ID', () => {
  assert.equal(parseDouyinRoomInput('https://www.douyin.com/follow/live/980331516805?anchor_id=835220884948380'), '980331516805');
});
test('accepts normal live links, pasted share text and bare IDs', () => {
  for (const value of ['980331516805', 'https://live.douyin.com/980331516805?foo=1', 'www.douyin.com/live/980331516805/', '来看直播 https://live.douyin.com/980331516805 复制打开']) {
    assert.equal(parseDouyinRoomInput(value), '980331516805');
  }
  assert.equal(parseDouyinRoomInput('980331516805', false), null);
});
test('rejects unrelated links, profile IDs and spoofed domains', () => {
  for (const value of ['名字123', 'https://www.douyin.com/user/835220884948380', 'https://www.douyin.com/?anchor_id=123', 'https://live.douyin.com.evil.com/123', 'https://evil.com/follow/live/123', 'https://evil.com@live.douyin.com/123']) {
    assert.equal(parseDouyinRoomInput(value), null);
  }
});
