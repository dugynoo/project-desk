import { test } from "node:test";
import assert from "node:assert/strict";
import { createPressGuard, onNextFrame } from "./dom.ts";

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

test("renders wait for a press on a guarded control to end, then run once after the click", async () => {
  const events = new EventTarget();
  const guarded = { inside: true };
  const guard = createPressGuard(target => (target as unknown as typeof guarded | null)?.inside === true, events);
  let renders = 0;
  const render = () => { renders++; };
  assert.equal(guard.defer(render), false, "no press: render now");
  const press = (type: string, target: object) => {
    const e = new Event(type);
    Object.defineProperty(e, "target", { value: target });
    events.dispatchEvent(e);
  };
  press("pointerdown", { inside: false });
  assert.equal(guard.defer(render), false, "a press elsewhere does not hold renders");
  press("pointerup", {});
  press("pointerdown", guarded);
  assert.equal(guard.defer(render), true);
  assert.equal(guard.defer(render), true);
  press("pointerup", guarded);
  assert.equal(renders, 0, "the click is dispatched before the deferred render");
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(renders, 1, "repeated requests collapse into one render");
  assert.equal(guard.defer(render), false);
  press("pointerdown", guarded);
  guard.defer(render);
  events.dispatchEvent(new Event("blur"));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(renders, 2, "leaving the window mid-press releases the hold");
});

