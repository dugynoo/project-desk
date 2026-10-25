import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mockIPC } from "@tauri-apps/api/mocks";
import { createUpdates } from "./updates.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const release = (rid: number) => ({ rid, version: `0.6.${rid}`, currentVersion: "0.6.1", body: "- Fix", rawJson: {} });

function fixture(t: TestContext, automatic = true) {
  const button = { hidden: true, disabled: false, textContent: "" };
  for (const [key, value] of Object.entries({ window: { crypto: globalThis.crypto }, document: { querySelector: () => button } })) {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => { if (old) Object.defineProperty(globalThis, key, old); else Reflect.deleteProperty(globalThis, key); });
  }
  const calls: { cmd: string; args: Record<string, unknown> }[] = [];
  let handler: (cmd: string) => unknown = cmd => cmd === "plugin:updater|check" ? release(2) : undefined;
  mockIPC((cmd, args) => {
    calls.push({ cmd, args: args as Record<string, unknown> });
    return handler(cmd);
  });
  const messages: string[] = [];
  const confirmations: string[] = [];
  const notes: string[] = [];
  let answer = () => Promise.resolve(true);
  const updates = createUpdates(async (title, _text, _ok, body) => { confirmations.push(title); notes.push(body ?? ""); return answer(); },
    text => { messages.push(text); }, async () => { calls.push({ cmd: "flush", args: {} }); }, () => automatic);
  return { ...updates, button, calls, messages, confirmations, notes,
    handle: (fn: typeof handler) => { handler = fn; },
    answer: (fn: typeof answer) => { answer = fn; },
    count: (cmd: string) => calls.filter(call => call.cmd === cmd).length,
  };
}

for (const automatic of [true, false]) {
  test(`release notes preserve paragraphs and all list styles (automatic=${automatic})`, async t => {
    const f = fixture(t, automatic);
    const body = "Summary\n\n- Fix\n* Another fix\n1. Restart when ready\n\n<b>Literal text</b>";
    f.handle(() => automatic ? { ...release(2), body } : { version: "0.6.2", body, url: "https://example.com/release" });
    f.answer(() => Promise.resolve(false));
    await f.checkUpdate();
    await f.installUpdate();
    assert.deepEqual(f.notes, [body]);
  });
}

test("checks coalesce, refresh cached versions, close replaced resources and clear stale offers", async t => {
  const f = fixture(t);
  const check = deferred<ReturnType<typeof release> | null>();
  f.handle(() => check.promise);
  const first = f.checkUpdate();
  const second = f.checkUpdate(true);
  assert.equal(f.count("plugin:updater|check"), 1);
  check.resolve(release(2));
  assert.deepEqual(await Promise.all([first, second]), [true, true]);
  f.handle(cmd => cmd === "plugin:updater|check" ? release(3) : undefined);
  assert.equal(await f.checkUpdate(true), true);
  assert.match(f.button.textContent, /0\.6\.3/);
  assert.deepEqual(f.calls.filter(c => c.cmd === "plugin:resources|close").map(c => c.args.rid), [2]);
  f.handle(cmd => cmd === "plugin:updater|check" ? null : "0.6.1");
  assert.equal(await f.checkUpdate(true), false);
  assert.equal(f.button.hidden, true);
  assert.deepEqual(f.calls.filter(c => c.cmd === "plugin:resources|close").map(c => c.args.rid), [2, 3]);
});

test("installation locks confirmation, download and rollback; failure permits retry", async t => {
  const f = fixture(t);
  await f.checkUpdate();
  const answer = deferred<boolean>();
  const download = deferred<number>();
  const rollback = deferred<void>();
  f.answer(() => answer.promise);
  f.handle(cmd => cmd === "plugin:updater|download" ? download.promise :
    cmd === "prepare_update" ? rollback.promise : undefined);
  const install = f.installUpdate();
  await f.installUpdate();
  assert.equal(f.confirmations.length, 1);
  assert.equal(await f.checkUpdate(true), false);
  assert.equal(f.count("plugin:updater|check"), 1);
  answer.resolve(true);
  await tick();
  await f.installUpdate();
  assert.equal(f.count("plugin:updater|download"), 1);
  download.reject(new Error("offline"));
  await tick();
  assert.equal(f.button.disabled, true);
  await f.installUpdate();
  assert.equal(f.confirmations.length, 1);
  rollback.resolve();
  await install;
  assert.equal(f.button.disabled, false);
  assert.equal(f.messages.length, 1);
  f.handle(cmd => cmd === "plugin:updater|download" ? 100 : undefined);
  await f.installUpdate();
  assert.equal(f.count("plugin:updater|download"), 2);
  assert.deepEqual(f.calls.slice(-5).map(c => c.cmd), ["plugin:updater|download", "flush", "prepare_update", "plugin:updater|install", "plugin:process|restart"]);
});

test("install waits for an in-flight refresh and cancellation allows another confirmation", async t => {
  const f = fixture(t);
  await f.checkUpdate();
  const refresh = deferred<ReturnType<typeof release>>();
  f.handle(cmd => cmd === "plugin:updater|check" ? refresh.promise : undefined);
  const checking = f.checkUpdate(true);
  f.answer(() => Promise.resolve(false));
  const installing = f.installUpdate();
  assert.equal(f.confirmations.length, 0);
  refresh.resolve(release(3));
  await Promise.all([checking, installing]);
  assert.match(f.confirmations[0], /0\.6\.3/);
  assert.equal(f.count("plugin:updater|download"), 0);
  await f.installUpdate();
  assert.equal(f.confirmations.length, 2);
});

test("failed refresh preserves available update without closing its resource", async t => {
  const f = fixture(t);
  await f.checkUpdate();
  f.handle(() => { throw new Error("offline"); });
  assert.equal(await f.checkUpdate(true), false);
  assert.equal(f.button.hidden, false);
  assert.equal(f.count("plugin:resources|close"), 0);
  assert.equal(f.messages.length, 1);
  f.answer(() => Promise.resolve(false));
  await f.installUpdate();
  assert.match(f.confirmations[0], /0\.6\.2/);
});

test("external Linux confirmations are also guarded", async t => {
  const f = fixture(t, false);
  f.handle(() => ({ version: "0.6.3", body: "- Fix", url: "https://example.com/release" }));
  await f.checkUpdate();
  const answer = deferred<boolean>();
  f.answer(() => answer.promise);
  const installing = f.installUpdate();
  await f.installUpdate();
  assert.equal(f.confirmations.length, 1);
  assert.equal(await f.checkUpdate(true), false);
  answer.resolve(true);
  await installing;
  assert.equal(f.count("plugin:opener|open_url"), 1);
  assert.equal(f.count("plugin:updater|download"), 0);
  assert.equal(f.button.disabled, false);
});
