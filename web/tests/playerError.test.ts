import test from "node:test";
import assert from "node:assert/strict";
import { isConfirmedOfflineError } from "../src/services/playerError.ts";

test("confirmed offline errors are distinguished from missing streams and network failures", () => {
  for (const message of ["主播未开播", "主播未开播。", "当前直播间未开播"]) assert.equal(isConfirmedOfflineError(message), true);
  for (const message of ["请求超时", "HTTP 403", "主播未开播或无法获取直播流", "主播在线，但获取直播流失败。", "HEVC 解码失败", "房间不存在"]) {
    assert.equal(isConfirmedOfflineError(message), false, message);
  }
});
