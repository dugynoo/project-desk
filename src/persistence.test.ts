import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveQueue } from "./persistence.ts";

test("close flush cancels debounce and saves the latest snapshot", async () => {
  let state = "before";
  const writes: string[] = [];
  const queue = createSaveQueue(() => state, async (json) => { writes.push(json); }, (e) => assert.fail(String(e)));
  queue.schedule();
  state = "after";
  await queue.flush();
  assert.deepEqual(writes, ["after"]);
});

test("a flush waits behind an in-flight write without overwriting newer state", async () => {
  let state = "first";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const writes: string[] = [];
  const queue = createSaveQueue(() => state, async (json) => {
    if (json === "first") await gate;
    writes.push(json);
  }, (e) => assert.fail(String(e)));
  const first = queue.flush();
  state = "second";
  const second = queue.flush();
  await Promise.resolve();
  assert.deepEqual(writes, []);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(writes, ["first", "second"]);
});

test("save failure rejects the close flush and a later retry can succeed", async () => {
  let fail = true;
  const writes: string[] = [];
  const queue = createSaveQueue(() => "state", async (json) => {
    if (fail) throw new Error("disk full");
    writes.push(json);
  }, (e) => assert.fail(String(e)));
  await assert.rejects(queue.flush(), /disk full/);
  fail = false;
  await queue.flush();
  assert.deepEqual(writes, ["state"]);
});
