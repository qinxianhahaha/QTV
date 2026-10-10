import test from "node:test";
import assert from "node:assert/strict";
import { FollowRefreshSchedule } from "../src/services/followRefreshSchedule.ts";

test("first launch refreshes, then waits exactly three minutes", () => {
  const schedule = new FollowRefreshSchedule();
  assert.equal(schedule.delay(1_000), 0);
  schedule.started(1_000);
  assert.equal(schedule.delay(61_000), 120_000);
  assert.equal(schedule.delay(180_999), 1);
  assert.equal(schedule.delay(181_000), 0);
});

test("returning home or making the app visible does not reset the interval", () => {
  const schedule = new FollowRefreshSchedule();
  schedule.started(1_000);
  assert.equal(schedule.delay(11_000), 170_000);
  assert.equal(schedule.delay(101_000), 80_000);
  assert.equal(schedule.delay(901_000), 0);
  schedule.started(901_000);
  assert.equal(schedule.delay(901_001), 179_999);
});

test("manual refresh postpones the next automatic refresh for three minutes", () => {
  const schedule = new FollowRefreshSchedule();
  schedule.started(1_000);
  schedule.started(121_000);
  assert.equal(schedule.delay(181_000), 120_000);
  assert.equal(schedule.delay(301_000), 0);
});
