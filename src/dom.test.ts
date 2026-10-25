import { test } from "node:test";
import assert from "node:assert/strict";
import { onNextFrame } from "./dom.ts";

test("frame scheduling coalesces bursts, reads latest state and permits another frame", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const frames: FrameRequestCallback[] = [];
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (fn: FrameRequestCallback) => { frames.push(fn); return frames.length; },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "requestAnimationFrame", previous);
    else Reflect.deleteProperty(globalThis, "requestAnimationFrame");
  });
  let state = 0;
  const drawn: number[] = [];
  const schedule = onNextFrame(() => {
    drawn.push(state);
    if (state === 100) schedule(); // Work requested during drawing belongs to the next frame.
  });
  for (state = 0; state < 100; state++) schedule();
  assert.equal(frames.length, 1);
  assert.deepEqual(drawn, []);
  frames.shift()!(0);
  assert.deepEqual(drawn, [100]);
  assert.equal(frames.length, 1);
  state = 101;
  schedule();
  frames.shift()!(16);
  assert.deepEqual(drawn, [100, 101]);
  assert.equal(frames.length, 0, "no idle animation loop");
  schedule();
  frames.shift()!(32);
  assert.deepEqual(drawn, [100, 101, 101]);
});
