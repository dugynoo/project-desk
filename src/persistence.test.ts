import { test } from "node:test";
import assert from "node:assert/strict";
import { createSaveQueue, createShutdownHandler } from "./persistence.ts";

test("close flush cancels debounce and saves the latest snapshot", async () => {
  let state = "before";
  const writes: string[] = [];
  const queue = createSaveQueue(() => state, async (json) => { writes.push(json); }, (e) => assert.fail(String(e)));
  queue.schedule();
  state = "after";
  await queue.flush();
  assert.deepEqual(writes, ["after"]);
});

test("native shutdown acknowledgement waits for disk, deduplicates requests and reports save failure", async () => {
  let release!: () => void;
  const disk = new Promise<void>(resolve => { release = resolve; });
  const events: string[] = [];
  const handler = createShutdownHandler(() => disk, async (id, saved) => { events.push(`${id}:${saved}`); },
    () => events.push("preparing"), error => assert.fail(String(error)));
  const first = handler("quit");
  await handler("quit");
  assert.deepEqual(events, ["preparing"]);
  release(); await first;
  assert.deepEqual(events, ["preparing", "quit:true"]);
  const failed = createShutdownHandler(async () => { throw Error("disk full"); },
    async (id, saved) => { events.push(`${id}:${saved}`); }, () => {}, () => events.push("error"));
  await failed("logout");
  assert.deepEqual(events.slice(-2), ["error", "logout:false"]);
});

test("a declined quit is acknowledged unsaved without preparing or writing", async () => {
  const events: string[] = [];
  const handler = createShutdownHandler(async () => { events.push("flush"); }, async (id, saved) => { events.push(`${id}:${saved}`); },
    () => events.push("preparing"), error => assert.fail(String(error)), async () => false);
  await handler("quit");
  assert.deepEqual(events, ["quit:false"]);
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
