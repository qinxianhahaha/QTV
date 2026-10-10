import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("home launches resizable with both default and minimum sizes at 16:9", () => {
  const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const main = config.app.windows.find((w: { label: string }) => w.label === "main");
  assert.equal(main.resizable, true);
  assert.equal(main.width / main.height, 16 / 9);
  assert.equal(main.minWidth / main.minHeight, 16 / 9);
});
