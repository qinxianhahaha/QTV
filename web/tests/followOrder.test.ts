import test from "node:test";
import assert from "node:assert/strict";
import { moveFollowedStreamer } from "../src/services/followOrder.ts";

const a = { platform: "DOUYIN", id: "123", nickname: "A", liveStatus: "LIVE" };
const b = { platform: "DOUYU", id: "123", nickname: "B", liveStatus: "OFFLINE" };
const c = { platform: "HUYA", id: "456", nickname: "C", liveStatus: "LIVE" };
const keys = (items: typeof a[]) => items.map(item => item.nickname);

test("move to front keeps every follow and distinguishes matching room IDs on different platforms", () => {
  const original = [a, b, c];
  const result = moveFollowedStreamer(original, "HUYA:456", "DOUYIN:123");
  assert.deepEqual(keys(result), ["C", "A", "B"]);
  assert.deepEqual(keys(original), ["A", "B", "C"]);
  assert.equal(result[0], c);
});

test("moving down then up restores order, and live/offline groups retain relative priority", () => {
  const down = moveFollowedStreamer([a, b, c], "DOUYIN:123", "HUYA:456");
  assert.deepEqual(keys(down), ["B", "C", "A"]);
  assert.deepEqual(keys(down.filter(s => s.liveStatus === "LIVE")), ["C", "A"]);
  assert.deepEqual(keys(moveFollowedStreamer(down, "DOUYIN:123", "DOUYU:123")), ["A", "B", "C"]);
});

test("stale or unchanged targets neither remove nor duplicate subscriptions", () => {
  const items = [a, b, c];
  assert.equal(moveFollowedStreamer(items, "missing:1", "DOUYU:123"), items);
  assert.equal(moveFollowedStreamer(items, "DOUYU:123", "missing:1"), items);
  assert.equal(moveFollowedStreamer(items, "DOUYU:123", "DOUYU:123"), items);
});

test("moving after a refresh preserves the latest metadata and survives JSON persistence", () => {
  const updated = { ...c, nickname: "Updated C", liveStatus: "OFFLINE" };
  const result = moveFollowedStreamer([a, b, updated], "HUYA:456", "DOUYIN:123");
  assert.equal(result[0], updated);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [updated, a, b]);
});

test("undoing removal can restore the original priority instead of appending at the end", () => {
  assert.deepEqual(keys(moveFollowedStreamer([a, c, b], "DOUYU:123", "HUYA:456")), ["A", "B", "C"]);
});
