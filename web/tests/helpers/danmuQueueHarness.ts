import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise the queue methods from the *installed* package, without a browser or
// copying its algorithms into a test. Rendering is disabled by a full-track stub.
export function createInstalledDanmuQueue(options: Record<string, unknown> = {}) {
  const map = JSON.parse(readFileSync(new URL('../../node_modules/danmu.js/browser/index.js.map', import.meta.url), 'utf8'));
  function load(name: string, symbol: string) {
    const index = map.sources.findIndex((path: string) => path.endsWith(`/src/${name}.js`));
    if (index < 0) throw new Error(`danmu.js source map lacks ${name}`);
    const source = map.sourcesContent[index]
      .replace(/^import .*$/gm, '')
      .replace(/^export default .*$/gm, '')
      .replace('export class ', 'class ');
    return vm.runInNewContext(`${source}\n;${symbol}`, { BaseClass: class {} });
  }
  const Main = load('main', 'Main');
  const Danmu = load('danmu', 'DanmuJs');
  const danmu = Object.create(Danmu.prototype);
  danmu.config = { live: false, interval: 2000, ...options };
  danmu.live = danmu.config.live;
  danmu.player = { currentTime: 1 };
  danmu.hideArr = [];
  danmu.isReady = true;
  const main = Object.create(Main.prototype);
  Object.assign(main, { danmu, interval: 2000, data: [], playedData: [], queue: [], channel: { checkAvailableTrack: () => false } });
  danmu.main = main;
  return {
    send(id: number) { danmu.sendComment({ id: String(id), txt: 'live comment', duration: 12000, mode: 'scroll' }); },
    tick(time: number) { danmu.player.currentTime = time; main.readData(); },
    get size(): number { return main.data.length; },
  };
}
