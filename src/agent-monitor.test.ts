import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentMonitor, type MonitoredRuntime } from "./agent-monitor.ts";
import { emptyState, type AgentStats, type Status } from "./model.ts";

const agentId = "11111111-1111-4111-8111-111111111111";
const stats: AgentStats = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, contextTokens: 12 };
const result = { stats, status: "task_complete", events: ["task_started", "task_complete"] };

function fixture(query: (command: string, args: Record<string, unknown>) => Promise<unknown>) {
  let state = emptyState();
  state.projects = [{ id: "p", name: "Fixture", path: "/fixture", collapsed: false, pinned: false }];
  state.sessions = [{ id: "s", projectId: "p", provider: "codex", title: "Fixture", started: true,
    createdAt: 1, lastUsedAt: 1, lastStartAt: 10, agentSessionId: agentId }];
  const runtimes = new Map<string, MonitoredRuntime>([["s", { running: true, closing: false }]]);
  const changes: { status: Status; silent: boolean | undefined }[] = [];
  let saves = 0, renders = 0;
  const monitor = createAgentMonitor({
    getState: () => state, runtimes, isClosing: () => false,
    invoke: async <T>(command: string, args: Record<string, unknown>) => await query(command, args) as T,
    save: () => { saves++; }, statusOf: () => "untracked",
    setStatus: (_id, status, silent) => { changes.push({ status, silent }); },
    renderStatusSoon: () => { renders++; },
  });
  return { monitor, runtimes, changes, get state() { return state; }, set state(value) { state = value; },
    get saves() { return saves; }, get renders() { return renders; } };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test("monitor preserves live event ordering, silent snapshots, and usage without a status", async () => {
  let response: { stats: AgentStats; status: string | null; events: string[] } = result;
  const f = fixture(async command => command === "agent_poll" ? response : null);
  // Startup replaces the initial state object; the monitor must read the current one.
  f.state = structuredClone(f.state);
  await f.monitor.pollAgents();
  assert.deepEqual(f.changes, [{ status: "working", silent: false }, { status: "done", silent: false }]);
  assert.deepEqual(f.monitor.statsOf(f.state.sessions[0]), stats);
  assert.equal(f.renders, 1);
  response = { ...result, events: [] };
  await f.monitor.pollAgents();
  assert.deepEqual(f.changes.at(-1), { status: "done", silent: true });
  const count = f.changes.length;
  response = { ...result, status: null, events: [] };
  await f.monitor.pollAgents();
  assert.equal(f.changes.length, count);
  f.monitor.forget("s");
  assert.equal(f.monitor.statsOf(f.state.sessions[0]), undefined);
});

test("overlapping polls are skipped and a reply from before restart is discarded", async () => {
  const pending = deferred<typeof result>();
  let polls = 0;
  const f = fixture(async command => {
    if (command === "agent_poll") { polls++; return pending.promise; }
    return null;
  });
  const first = f.monitor.pollAgents();
  await f.monitor.pollAgents();
  assert.equal(polls, 1);
  f.state.sessions[0].lastStartAt = 20;
  pending.resolve(result);
  await first;
  assert.deepEqual(f.changes, []);
  assert.equal(f.monitor.statsOf(f.state.sessions[0]), undefined);
  await f.monitor.pollAgents();
  assert.equal(polls, 2);
  assert.equal(f.changes.length, 2);
});

test("closing a session during a poll discards the result and releases its native watch", async () => {
  const pending = deferred<typeof result>();
  const retained: unknown[] = [];
  const f = fixture(async (command, args) => {
    if (command === "agent_poll") return pending.promise;
    retained.push(args.activeIds);
    return null;
  });
  const read = f.monitor.pollAgents();
  const removed = f.state.sessions.pop()!;
  f.runtimes.delete("s");
  f.monitor.forget("s");
  pending.resolve(result);
  await read;
  assert.deepEqual(retained, [[]]);
  assert.equal(f.monitor.statsOf(removed), undefined);
  assert.deepEqual(f.changes, []);
});

test("cancelled discovery cannot attach an old conversation; a new lookup can", async () => {
  const pending = deferred<string>();
  const f = fixture(async () => pending.promise);
  f.state.sessions[0].agentSessionId = undefined;
  f.monitor.discover("s", "/fixture");
  const lookup = f.monitor.lookupCodexSessions();
  f.monitor.cancelDiscovery("s");
  pending.resolve(agentId);
  await lookup;
  assert.equal(f.state.sessions[0].agentSessionId, undefined);
  assert.equal(f.saves, 0);
  f.monitor.discover("s", "/fixture");
  await f.monitor.lookupCodexSessions();
  assert.equal(f.state.sessions[0].agentSessionId, agentId);
  assert.equal(f.saves, 1);
});

test("hooks preserve conversation updates and ignore other providers or stopped runtimes", () => {
  const f = fixture(async () => null);
  const s = f.state.sessions[0];
  s.provider = "claude";
  s.agentSessionId = undefined;
  f.monitor.onAgentEvent({ deskSessionId: "s", provider: "antigravity", event: "Stop", agentSessionId: agentId });
  assert.equal(s.agentSessionId, undefined);
  f.monitor.onAgentEvent({ deskSessionId: "s", event: "SessionStart", agentSessionId: agentId });
  assert.equal(s.agentSessionId, agentId);
  assert.equal(s.hasConversation, false);
  assert.equal(f.changes.at(-1)?.silent, true);
  f.monitor.onAgentEvent({ deskSessionId: "s", event: "UserPromptSubmit", agentSessionId: agentId });
  assert.equal(s.hasConversation, true);
  assert.equal(f.changes.at(-1)?.status, "working");
  const count = f.changes.length;
  f.runtimes.get("s")!.running = false;
  f.monitor.onAgentEvent({ deskSessionId: "s", event: "Stop", agentSessionId: agentId });
  assert.equal(f.changes.length, count);
});

test("/resume to another conversation reopens it with --resume; a cleared one starts fresh", () => {
  const f = fixture(async () => null);
  const s = f.state.sessions[0];
  s.provider = "claude";
  s.hasConversation = true;
  const resumed = "22222222-2222-4222-8222-222222222222";
  f.monitor.onAgentEvent({ deskSessionId: "s", event: "SessionStart", agentSessionId: resumed, source: "resume" });
  assert.equal(s.agentSessionId, resumed);
  assert.equal(s.hasConversation, true);
  const cleared = "33333333-3333-4333-8333-333333333333";
  f.monitor.onAgentEvent({ deskSessionId: "s", event: "SessionStart", agentSessionId: cleared, source: "clear" });
  assert.equal(s.agentSessionId, cleared);
  assert.equal(s.hasConversation, false);
});

test("Codex SessionStart hook names the conversation after /resume without changing status", () => {
  const f = fixture(async () => null);
  const s = f.state.sessions[0];
  s.agentSessionId = undefined;
  const resumed = "01a177c5-7875-7103-9cdb-9ebb23eebd1f";
  f.monitor.onAgentEvent({ deskSessionId: "s", provider: "codex", event: "SessionStart", agentSessionId: resumed, source: "resume" });
  assert.equal(s.agentSessionId, resumed);
  assert.equal(f.changes.length, 0);
  assert.equal(f.saves, 1);
  // A Claude event cannot rename a Codex session.
  f.monitor.onAgentEvent({ deskSessionId: "s", event: "SessionStart", agentSessionId: agentId });
  assert.equal(s.agentSessionId, resumed);
});
