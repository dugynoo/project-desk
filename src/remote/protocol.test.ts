import { test } from "node:test";
import assert from "node:assert/strict";
import { parseServerMsg, reconnectDelay } from "./protocol.ts";

test("parseServerMsg rejects unknown type", () => {
  assert.equal(parseServerMsg('{"type":"nope"}'), null);
  assert.equal(parseServerMsg("not json"), null);
  assert.equal(parseServerMsg('{"type":"output","id":1,"data":"x"}'), null);
});

test("parseServerMsg accepts output", () => {
  assert.deepEqual(parseServerMsg('{"type":"output","id":"a","data":"hi"}'), { type: "output", id: "a", data: "hi" });
  assert.deepEqual(parseServerMsg('{"type":"error","id":null,"code":"x"}'), { type: "error", id: null, code: "x" });
});

test("reconnectDelay caps at 10s", () => {
  assert.equal(reconnectDelay(0), 1000);
  assert.equal(reconnectDelay(2), 4000);
  assert.equal(reconnectDelay(10), 10000);
});
