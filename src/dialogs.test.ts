import { test } from "node:test";
import assert from "node:assert/strict";
import { createDialogs } from "./dialogs.ts";
import { createSettings } from "./settings.ts";
import { DEFAULT_SETTINGS } from "./model.ts";
import { t as translate } from "./i18n.ts";

class Element {
  children: Element[] = [];
  hidden = true;
  className = "";
  textContent = "";
  onclick: ((event: { target: Element }) => void) | null = null;
  append(...children: Element[]) { this.children.push(...children); }
  replaceChildren(...children: Element[]) { this.children = children; }
  focus() {}
}

function fixture(t: { after: (fn: () => void) => void }) {
  const overlay = new Element();
  const doc = Object.assign(new EventTarget(), {
    querySelector: () => overlay,
    createElement: () => new Element(),
    createTextNode: () => new Element(),
  });
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: doc });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  });
  let focused = 0;
  const dialogs = createDialogs(() => { focused++; });
  const escape = () => {
    const event = Object.assign(new Event("keydown", { cancelable: true }), { key: "Escape" });
    doc.dispatchEvent(event);
    return event;
  };
  return { ...dialogs, overlay, escape, focused: () => focused };
}

test("replacement clears the old timer and listener; stale close cannot close its successor", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(t);
  let ticks = 0, cleanups = 0, closeOld!: () => void, oldSignal!: AbortSignal;
  let timer: ReturnType<typeof setInterval>;
  f.modal((_, close, signal) => {
    closeOld = close;
    oldSignal = signal;
    timer = setInterval(() => { ticks++; }, 2000);
  }, () => { cleanups++; clearInterval(timer); });
  t.mock.timers.tick(2000);
  assert.equal(ticks, 1);
  let newCleanups = 0;
  f.modal(() => {}, () => { newCleanups++; });
  assert.equal(oldSignal.aborted, true);
  assert.equal(cleanups, 1);
  assert.equal(f.focused(), 0, "replacement must not focus the terminal");
  closeOld();
  t.mock.timers.tick(60000);
  assert.equal(ticks, 1);
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.escape().defaultPrevented, true);
  assert.equal(newCleanups, 1);
  assert.equal(f.focused(), 1);
  assert.equal(f.overlay.onclick, null);
  assert.equal(f.escape().defaultPrevented, false, "no remaining Escape listener");
  assert.equal(cleanups, 1);
});

test("backdrop close is idempotent and replacing confirmation settles it as cancelled", async t => {
  const f = fixture(t);
  const answer = f.confirmBox("Confirm", "Text", "OK");
  f.modal(() => {}, () => {});
  assert.equal(await answer, false);
  f.overlay.onclick!({ target: new Element() });
  assert.equal(f.overlay.hidden, false);
  f.overlay.onclick!({ target: f.overlay });
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.focused(), 1);
});

test("failed construction cleans resources and cleanup may open a new dialog", t => {
  const f = fixture(t);
  let cleaned = 0, signal!: AbortSignal;
  assert.throws(() => f.modal((_, __, s) => {
    signal = s;
    throw new Error("build failed");
  }, () => { cleaned++; }), /build failed/);
  assert.equal(cleaned, 1);
  assert.equal(signal.aborted, true);
  assert.equal(f.overlay.hidden, true);
  assert.equal(f.escape().defaultPrevented, false);
  let close!: () => void;
  f.modal((_, c) => { close = c; }, () => f.modal(() => {}, () => {}));
  close();
  assert.equal(f.overlay.hidden, false);
  assert.equal(f.focused(), 1, "cleanup's new dialog retains focus");
  f.escape();
});

test("update checks from closed or replaced settings never install or close the current dialog", async t => {
  const f = fixture(t);
  for (const [key, value] of Object.entries({
    Option: Element,
    window: { __TAURI_INTERNALS__: { invoke: async () => [] } },
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  for (const action of ["close", "replace", "stay"]) {
    let resolve!: (value: boolean) => void;
    const pending = new Promise<boolean>(r => { resolve = r; });
    let installed = 0;
    const settings = createSettings(() => DEFAULT_SETTINGS, () => {}, f.modal, () => {},
      () => pending, async () => { installed++; });
    settings({ platform: "windows", hooksEnabled: true, stateFile: "/fixture", updates: true });
    const findCheck = (node: Element): Element | undefined =>
      node.textContent === translate("update.check") ? node : node.children.map(findCheck).find(Boolean);
    const button = findCheck(f.overlay)!;
    const result = button.onclick!({ target: button });
    if (action === "close") f.escape();
    if (action === "replace") f.modal(() => {}, () => {});
    resolve(true);
    await result;
    assert.equal(installed, action === "stay" ? 1 : 0);
    assert.equal(f.overlay.hidden, action !== "replace");
    f.escape();
  }
});
