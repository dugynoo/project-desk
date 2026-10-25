import { test } from "node:test";
import assert from "node:assert/strict";
import { createFileDropHandler, type FileDrag, type FileDropTarget } from "./file-drop.ts";

function fixture() {
  const makeTarget = () => {
    const classes = new Set<string>();
    const host = {
      dataset: {} as Record<string, string>,
      contains: (node: unknown) => node === host,
      classList: {
        add: (name: string) => classes.add(name),
        remove: (...names: string[]) => names.forEach(name => classes.delete(name)),
        toggle: (name: string, on: boolean) => on ? classes.add(name) : classes.delete(name),
      },
    };
    const pasted: string[] = [];
    let focused = 0;
    const target: FileDropTarget = { host: host as unknown as HTMLElement, running: true, closing: false,
      term: { paste: text => pasted.push(text), focus: () => { focused++; } } };
    return { target, host, classes, pasted, focused: () => focused };
  };
  const first = makeTarget(), second = makeTarget();
  let blocked = false, invalid = 0;
  const handle = createFileDropHandler({
    targets: () => [first.target, second.target], blocked: () => blocked,
    platform: () => "windows", hint: ready => ready ? "ready" : "shift",
    invalid: () => { invalid++; }, scale: () => 2,
    hitTest: (x, y) => y < 0 ? null : (x < 100 ? first.target.host : second.target.host),
  });
  const event = (kind: FileDrag["kind"], shift = true): FileDrag => ({ kind, shift, paths: ["C:\\a b.txt"], position: { x: 300, y: 50 } });
  return { first, second, handle, event, block: () => { blocked = true; }, invalid: () => invalid };
}

test("Shift drop targets the pane under the physical pointer at high DPI", () => {
  const f = fixture();
  f.handle(f.event("enter", false));
  assert.equal(f.second.host.dataset.fileDropHint, "shift");
  f.handle(f.event("over"));
  assert.ok(f.second.classes.has("file-drop-ready"));
  f.handle(f.event("drop"));
  assert.deepEqual(f.first.pasted, []);
  assert.deepEqual(f.second.pasted, ["'C:\\a b.txt' "]);
  assert.equal(f.second.focused(), 1);
  assert.equal(f.second.classes.size, 0);
});

test("non-Shift, stopped, closing, modal and out-of-terminal drops do not write", () => {
  for (const condition of ["no-shift", "stopped", "closing", "modal", "outside"]) {
    const f = fixture();
    const event = f.event("drop", condition !== "no-shift");
    if (condition === "stopped") f.second.target.running = false;
    if (condition === "closing") f.second.target.closing = true;
    if (condition === "modal") f.block();
    if (condition === "outside") event.position!.y = -1;
    f.handle(event);
    assert.deepEqual(f.second.pasted, [], condition);
    assert.equal(f.second.focused(), 0, condition);
  }
});

test("cancel clears the hint and invalid paths never reach the terminal", () => {
  const f = fixture();
  f.handle(f.event("enter"));
  f.handle({ ...f.event("leave"), position: null });
  assert.equal(f.second.classes.size, 0);
  assert.equal(f.second.host.dataset.fileDropHint, undefined);
  f.handle({ ...f.event("drop"), paths: ["a\nb"] });
  assert.equal(f.invalid(), 1);
  assert.deepEqual(f.second.pasted, []);
});
