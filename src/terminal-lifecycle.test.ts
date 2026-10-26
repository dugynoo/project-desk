import { test } from "node:test";
import assert from "node:assert/strict";
import { createTerminalLifecycle, type LifecycleRuntime, type OutputChunk } from "./terminal-lifecycle.ts";
import { emptyState, type Status } from "./model.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(query: (command: string) => Promise<unknown> = async () => null) {
  const state = emptyState();
  state.projects = [{ id: "p", name: "Fixture", path: "/fixture", collapsed: false, pinned: false }];
  state.sessions = [{ id: "s", projectId: "p", provider: "shell", title: "Fixture", createdAt: 1, lastUsedAt: 1 }];
  state.ui.activeSessionId = "s";
  const runtimes = new Map<string, LifecycleRuntime>();
  const statuses = new Map<string, Status>();
  const unread = new Set<string>();
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const channels: { onmessage: (chunk: OutputChunk) => void }[] = [];
  const written: string[] = [], notices: string[] = [];
  const acknowledgements: (() => void)[] = [], timers: (() => void)[] = [];
  let disposed = 0, removed = 0, flushed = 0, confirmAnswer = true;
  const rt: LifecycleRuntime = {
    running: false, closing: false,
    term: { cols: 80, rows: 24,
      write(data, done) { written.push(data); if (done) acknowledgements.push(done); },
      writeln(data) { written.push(data); }, focus() {}, dispose() { disposed++; } },
    fit: { fit() {} }, pane: { remove() { removed++; } },
  };
  const lifecycle = createTerminalLifecycle({
    getState: () => state, getInfo: () => ({ platform: "windows", hooksEnabled: true }),
    runtimes, statuses, unread,
    agentMonitor: { cancelDiscovery() {}, discover() {}, forget() {} },
    isClosing: () => false, editingId: () => undefined,
    createRuntime(s) { runtimes.set(s.id, rt); return rt; },
    invoke: async <T>(command: string, args: Record<string, unknown>) => {
      calls.push({ command, args }); return await query(command) as T;
    },
    createOutput() { const channel = { onmessage: (_chunk: OutputChunk) => {} }; channels.push(channel); return channel; },
    schedule(callback) { timers.push(callback); }, save() {}, async flush() { flushed++; },
    statusOf: id => statuses.get(id) ?? "sleeping", setStatus: (id, status) => { statuses.set(id, status); },
    isWatched: () => false, layout() {}, renderSidebar() {}, renderPaneHeads() {},
    toast: message => { notices.push(message); }, confirmBox: async () => confirmAnswer,
  });
  return { lifecycle, state, rt, runtimes, statuses, unread, calls, channels, written, acknowledgements, timers, notices,
    get disposed() { return disposed; }, get removed() { return removed; }, get flushed() { return flushed; },
    set confirmAnswer(value: boolean) { confirmAnswer = value; } };
}

test("one pending spawn, render acknowledgement, and old output rejected after restart/disposal", async () => {
  const spawn = deferred<null>();
  const f = fixture(async command => command === "pty_spawn" ? spawn.promise : null);
  const s = f.state.sessions[0];
  const starting = f.lifecycle.start(s);
  await f.lifecycle.start(s);
  await f.lifecycle.closeSession(s);
  assert.equal(f.calls.filter(c => c.command === "pty_spawn").length, 1);
  assert.equal(f.calls.some(c => c.command === "pty_kill"), false);
  assert.equal(f.lifecycle.isStarting(s.id), true);
  spawn.resolve(null); await starting;
  assert.equal(f.lifecycle.isStarting(s.id), false);
  f.channels[0].onmessage({ data: "first", ack: 1 });
  assert.equal(f.calls.some(c => c.command === "pty_output_ack"), false);
  f.acknowledgements[0]();
  assert.equal(f.calls.filter(c => c.command === "pty_output_ack").length, 1);
  f.lifecycle.onExit(s.id, 1);
  await f.lifecycle.start(s);
  const count = f.written.length;
  f.channels[0].onmessage({ data: "stale", ack: 2 });
  assert.equal(f.written.length, count);
  f.channels[1].onmessage({ data: "new" });
  assert.equal(f.written.at(-1), "new");
  f.lifecycle.forgetRuntime(s.id);
  f.channels[1].onmessage({ data: "disposed" });
  assert.equal(f.written.at(-1), "new");
  assert.equal(f.disposed, 1);
  assert.equal(f.removed, 1);
});

test("exit before spawn resolves retains a stopped terminal and does not revive it", async () => {
  const spawn = deferred<null>();
  const f = fixture(async () => spawn.promise);
  const s = f.state.sessions[0];
  const starting = f.lifecycle.start(s);
  f.lifecycle.onExit(s.id, 7);
  spawn.resolve(null); await starting;
  assert.equal(s.stopped, true);
  assert.equal(s.exitCode, 7);
  assert.equal(f.rt.running, false);
  assert.equal(f.statuses.get(s.id), "exited");
  assert.equal(f.runtimes.has(s.id), true);
  assert.equal(f.state.closedSessions.length, 0);
  assert.equal(f.timers.length, 0);
});

test("failed spawn can be retried, and an old startup timeout cannot change a restarted session", async () => {
  let fail = true;
  const f = fixture(async command => { if (command === "pty_spawn" && fail) throw Error("fixture spawn failure"); return null; });
  const s = f.state.sessions[0];
  await f.lifecycle.start(s);
  assert.equal(s.stopped, true);
  assert.equal(f.lifecycle.isStarting(s.id), false);
  assert.equal(f.notices.length, 1);
  fail = false; await f.lifecycle.start(s);
  assert.equal(s.stopped, false);
  assert.equal(f.rt.running, true);
  s.lastStartAt! += 1;
  f.statuses.set(s.id, "starting");
  f.timers[0]();
  assert.equal(f.statuses.get(s.id), "starting");
});

test("explicit close archives only after exit and releases terminal resources", async () => {
  const f = fixture();
  const s = f.state.sessions[0];
  await f.lifecycle.start(s);
  await f.lifecycle.closeSession(s);
  assert.equal(f.rt.closing, true);
  assert.equal(f.state.sessions.length, 1);
  f.lifecycle.onExit(s.id, 0);
  assert.equal(f.state.sessions.length, 0);
  assert.equal(f.state.closedSessions[0].id, s.id);
  assert.equal(f.runtimes.size, 0);
  assert.equal(f.disposed, 1);
  assert.equal(f.statuses.has(s.id), false);
});

test("failed kill leaves the running session open and unarchived", async () => {
  const f = fixture(async command => { if (command === "pty_kill") throw Error("fixture kill failure"); return null; });
  const s = f.state.sessions[0];
  await f.lifecycle.start(s);
  await f.lifecycle.closeSession(s);
  assert.equal(f.rt.running, true);
  assert.equal(f.rt.closing, false);
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.closedSessions.length, 0);
  assert.equal(f.notices.length, 1);
});

test("background detach preserves the session; explicit close kills the detached worker", async () => {
  const f = fixture();
  const s = f.state.sessions[0];
  s.provider = "claude"; s.background = true;
  await f.lifecycle.start(s);
  assert.equal(f.flushed, 1);
  f.lifecycle.onExit(s.id, 0);
  assert.equal(s.stopped, false);
  assert.equal(f.statuses.get(s.id), "sleeping");
  assert.equal(f.state.closedSessions.length, 0);
  assert.equal(f.runtimes.has(s.id), true);
  await f.lifecycle.closeSession(s);
  assert.equal(f.calls.some(c => c.command === "pty_kill"), true);
  assert.equal(f.state.sessions.length, 0);
  assert.equal(f.state.closedSessions.length, 1);
});

test("system shutdown persists recovery immediately without archiving", async () => {
  const f = fixture();
  const s = f.state.sessions[0];
  await f.lifecycle.start(s);
  f.lifecycle.onExit(s.id, null, true);
  assert.equal(s.resumeAfterShutdown, true);
  assert.equal(f.flushed, 1);
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.closedSessions.length, 0);
});

test("pause stops an agent but keeps it listed, stopped, and resumable", async () => {
  const f = fixture();
  const s = f.state.sessions[0];
  s.provider = "claude"; s.hasConversation = true; s.agentSessionId = "11111111-1111-4111-8111-111111111111";
  await f.lifecycle.start(s);
  assert.equal(f.lifecycle.canPause(s), true);
  await f.lifecycle.pauseSession(s);
  assert.equal(f.calls.filter(c => c.command === "pty_kill").length, 1);
  f.lifecycle.onExit(s.id, 129);
  assert.equal(s.stopped, true);
  assert.equal(s.exitCode, undefined);
  assert.equal(f.state.sessions.length, 1);
  assert.equal(f.state.closedSessions.length, 0);
  assert.equal(f.runtimes.has(s.id), true);
  assert.equal(f.unread.has(s.id), false);
  assert.equal(f.lifecycle.canPause(s), false);
  await f.lifecycle.start(s);
  const spawn = f.calls.filter(c => c.command === "pty_spawn").at(-1)!;
  assert.match((spawn.args.args as { command: string }).command, /--resume 11111111/);
});

test("pause is unavailable for shells and background workers, and working agents need confirmation", async () => {
  const f = fixture();
  const s = f.state.sessions[0];
  await f.lifecycle.start(s);
  assert.equal(f.lifecycle.canPause(s), false);
  s.provider = "claude"; s.background = true;
  assert.equal(f.lifecycle.canPause(s), false);
  s.background = false;
  f.statuses.set(s.id, "working");
  f.confirmAnswer = false;
  await f.lifecycle.pauseSession(s);
  assert.equal(f.calls.some(c => c.command === "pty_kill"), false);
});
