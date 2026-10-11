import test from "node:test";
import assert from "node:assert/strict";
import { adjacentFollowRoom } from "../src/services/followNavigation.ts";
const a = { platform: "DOUYU", id: "1", liveStatus: "LIVE" };
const b = { platform: "HUYA", id: "1", liveStatus: "LIVE" };
const c = { platform: "DOUYIN", id: "3", currentRoomId: "real3", liveStatus: "UNKNOWN" };

test("up/down follow saved order across platforms and wrap", () => {
  assert.equal(adjacentFollowRoom([a,b,c], "douyu", "1", 1), b);
  assert.equal(adjacentFollowRoom([a,b,c], "DOUYU", "1", -1), c);
  assert.equal(adjacentFollowRoom([a,b,c], "DOUYIN", "3", 1), a);
  assert.equal(adjacentFollowRoom([c,b,a], "HUYA", "1", 1), a);
});
test("skip hidden and confirmed offline rooms but allow unknown status", () => {
  const rooms = [a, {...b, hidden: true}, {...b, id: "off", liveStatus: "OFFLINE"}, c];
  assert.equal(adjacentFollowRoom(rooms, "DOUYU", "1", 1), c);
  assert.equal(adjacentFollowRoom(rooms, "DOUYIN", "real3", -1), a);
});
test("unfollowed current room enters from first/last available follow", () => {
  assert.equal(adjacentFollowRoom([a,b,c], "BILIBILI", "other", 1), a);
  assert.equal(adjacentFollowRoom([a,b,c], "BILIBILI", "other", -1), c);
});
test("no alternative disables navigation without reloading the current room", () => {
  assert.equal(adjacentFollowRoom([], "DOUYU", "1", 1), null);
  assert.equal(adjacentFollowRoom([a], "DOUYU", "1", -1), null);
  assert.equal(adjacentFollowRoom([a,{...b, liveStatus:"OFFLINE"}], "DOUYU", "1", 1), null);
  assert.equal(adjacentFollowRoom([c], "DOUYIN", "real3", 1), null);
});
