import test from "node:test";
import assert from "node:assert/strict";
import { createSerialTaskQueue } from "../src/services/serialTaskQueue.ts";

test("closing and reopening cannot start new playback before old startup and cleanup finish", async () => {
  const enqueue = createSerialTaskQueue();
  const events: string[] = [];
  let finishOld!: () => void;
  const oldRequest = new Promise<void>(resolve => { finishOld = resolve; });
  const old = enqueue(async () => { events.push("old request"); await oldRequest; events.push("old finished"); });
  const close = enqueue(async () => { events.push("cleanup"); });
  const next = enqueue(async () => { events.push("new playback"); });
  await Promise.resolve();
  assert.deepEqual(events, ["old request"]);
  finishOld();
  await Promise.all([old, close, next]);
  assert.deepEqual(events, ["old request", "old finished", "cleanup", "new playback"]);
});

test("a failed request does not block cleanup or the next room", async () => {
  const enqueue = createSerialTaskQueue();
  const failed = enqueue(async () => { throw new Error("network timeout"); });
  const next = enqueue(async () => "next room");
  await assert.rejects(failed, /network timeout/);
  assert.equal(await next, "next room");
});
