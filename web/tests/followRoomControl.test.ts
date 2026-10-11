import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const ts = require('typescript');

test('follow buttons dispatch once, update availability and remove listeners on destroy', () => {
  const buttons = [-1, 1].map(direction => Object.assign(new EventTarget(), {
    dataset: { direction: String(direction) }, disabled: false,
  }));
  let available = true;
  const switched: number[] = [];
  class Plugin {
    config = { canSwitch: () => available, onSwitch: (direction: number) => switched.push(direction) };
    find(selector: string) { return buttons[selector.includes('"-1"') ? 0 : 1]; }
  }
  const source = readFileSync(new URL('../src/components/player/playerControlsPlugins.ts', import.meta.url), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const exports: any = {};
  vm.runInNewContext(compiled, { exports, require: (id: string) => {
    if (id === 'xgplayer/es/plugin/plugin.js') return { __esModule: true, default: Plugin, POSITIONS: {} };
    if (id === './constants') return {};
    throw new Error(id);
  }});
  const control = new exports.FollowRoomControl();
  assert.match(control.render(), /aria-label="上一个关注的直播间"/);
  assert.match(control.render(), /aria-label="下一个关注的直播间"/);
  control.afterCreate();
  buttons[0].dispatchEvent(new Event('click'));
  buttons[1].dispatchEvent(new Event('click'));
  assert.deepEqual(switched, [-1, 1]);
  available = false;
  control.updateAvailability();
  assert.ok(buttons.every(button => button.disabled));
  buttons[1].dispatchEvent(new Event('click'));
  assert.equal(switched.length, 2);
  available = true;
  control.updateAvailability();
  assert.ok(buttons.every(button => !button.disabled));
  control.destroy();
  buttons[0].dispatchEvent(new Event('click'));
  assert.equal(switched.length, 2);
});
