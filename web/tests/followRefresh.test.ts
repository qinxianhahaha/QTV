import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFollowInfo } from "../src/services/followRefresh.ts";

const streamer = { id: "123", platform: "BILIBILI" as const, nickname: "原名称", avatarUrl: "https://example.org/avatar.jpg", currentRoomId: "123", liveStatus: "LIVE" as const, coverUrl: "https://example.org/old.jpg" };

test("network/API failure is not interpreted as offline", () => {
  assert.throws(() => normalizeFollowInfo(streamer, { error_message: "获取失败" }));
  assert.throws(() => normalizeFollowInfo(streamer, {}));
  assert.throws(() => normalizeFollowInfo(streamer, { status: null }));
});
test("Bilibili live metadata carries current cover and preserves stable IDs", () => {
  const result = normalizeFollowInfo(streamer, { status: 1, title: "当前直播", cover_url: "https://example.org/new.jpg", anchor_name: "新名称" });
  assert.equal(result.liveStatus, "LIVE");
  assert.equal(result.coverUrl, "https://example.org/new.jpg");
  assert.equal(result.nickname, "新名称");
  assert.equal(result.avatarUrl, streamer.avatarUrl);
  assert.equal(result.id, undefined);
});
test("replays/offline and missing live covers clear stale cover", () => {
  assert.equal(normalizeFollowInfo(streamer, { status: 2 }).liveStatus, "OFFLINE");
  assert.equal(normalizeFollowInfo(streamer, { status: 0 }).coverUrl, "");
  assert.equal(normalizeFollowInfo(streamer, { status: 1 }).coverUrl, "");
});
test("Douyin status 2 is live, unlike Bilibili replay status", () => {
  assert.equal(normalizeFollowInfo({ ...streamer, platform: "DOUYIN" }, { status: 2 }).liveStatus, "LIVE");
  assert.equal(normalizeFollowInfo({ ...streamer, platform: "DOUYIN" }, { status: 4 }).liveStatus, "OFFLINE");
});
test("Douyu loop streams are not live and unknown loop values stay unknown", () => {
  const s = { ...streamer, platform: "DOUYU" as const };
  assert.equal(normalizeFollowInfo(s, { show_status: "1", video_loop: "0" }).liveStatus, "LIVE");
  assert.equal(normalizeFollowInfo(s, { show_status: 1, video_loop: 1 }).liveStatus, "OFFLINE");
  assert.throws(() => normalizeFollowInfo(s, { show_status: 1 }));
});
test("Huya requires an explicit boolean status", () => {
  const s = { ...streamer, platform: "HUYA" as const };
  assert.equal(normalizeFollowInfo(s, { is_live: true }).liveStatus, "LIVE");
  assert.equal(normalizeFollowInfo(s, { is_live: false }).liveStatus, "OFFLINE");
  assert.throws(() => normalizeFollowInfo(s, { is_live: "false" }));
});
