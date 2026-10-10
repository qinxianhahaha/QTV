import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeDanmuColor, sanitizeDanmuFontSize } from '../src/components/player/constants.ts';

test('imported danmu styling cannot inject markup or CSS', () => {
  assert.equal(sanitizeDanmuColor('\"><img src=x onerror=alert(1)>', '#ffffff'), '#ffffff');
  assert.equal(sanitizeDanmuColor('url(https://example.com)', '#ffffff'), '#ffffff');
  assert.equal(sanitizeDanmuColor('#bBcCdD', '#ffffff'), '#bBcCdD');
  assert.equal(sanitizeDanmuFontSize('<img src=x>'), '20px');
  assert.equal(sanitizeDanmuFontSize('20px;position:fixed'), '20px');
  assert.equal(sanitizeDanmuFontSize('99999px'), '30px');
  assert.equal(sanitizeDanmuFontSize('0px'), '14px');
});
