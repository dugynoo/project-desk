import { test } from "node:test";
import assert from "node:assert/strict";
import { CLOSE_REVOKED, closeAction, parseServerMsg, reconnectDelay } from "./protocol.ts";

test("parseServerMsg rejects unknown type", () => {
  assert.equal(parseServerMsg('{"type":"nope"}'), null);
  assert.equal(parseServerMsg("not json"), null);
  assert.equal(parseServerMsg('{"type":"output","id":1,"data":"x"}'), null);
});

test("parseServerMsg accepts output", () => {
  assert.deepEqual(parseServerMsg('{"type":"output","id":"a","data":"hi"}'), { type: "output", id: "a", data: "hi" });
  assert.deepEqual(parseServerMsg('{"type":"error","id":null,"code":"x"}'), { type: "error", id: null, code: "x" });
});

test("parseServerMsg accepts chat and drops malformed items", () => {
  const raw = JSON.stringify({ type: "chat", id: "a", reset: true, items: [
    { role: "user", text: "hi" }, { role: "tool", text: "npm test", name: "Bash" }, { role: "x", text: "?" }, { role: "assistant" },
  ] });
  assert.deepEqual(parseServerMsg(raw), { type: "chat", id: "a", reset: true, items: [
    { role: "user", text: "hi" }, { role: "tool", text: "npm test", name: "Bash" },
  ] });
  assert.equal(parseServerMsg('{"type":"chat","id":"a","items":[]}'), null);
});

test("reconnectDelay caps at 10s", () => {
  assert.equal(reconnectDelay(0), 1000);
  assert.equal(reconnectDelay(2), 4000);
  assert.equal(reconnectDelay(10), 10000);
});

test("closeAction asks to re-pair on revoke and probes after repeated failed connects", () => {
  assert.equal(closeAction(CLOSE_REVOKED, true, 1), "repair");
  assert.equal(closeAction(1006, true, 5), "retry");
  assert.equal(closeAction(1006, false, 2), "retry");
  assert.equal(closeAction(1006, false, 3), "probe");
});
