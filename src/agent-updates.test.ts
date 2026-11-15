import { test } from "node:test";
import assert from "node:assert/strict";
import { createAgentUpdates, shortVersion, type UpdatableRuntime } from "./agent-updates.ts";
import { emptyState, type Session, type Status } from "./model.ts";

const conversation = "11111111-1111-4111-8111-111111111111";

function fixture() {
  const state = emptyState();
  state.projects = [{ id: "p", name: "Fixture", path: "/fixture", collapsed: false, pinned: false }];
  const session = (id: string, provider: Session["provider"], extra: Partial<Session> = {}): Session =>
    ({ id, projectId: "p", provider, title: id, createdAt: 1, lastUsedAt: 1, started: true, agentSessionId: conversation, ...extra });
  state.sessions = [session("claude", "claude"), session("codex", "codex"), session("shell", "shell"), session("bg", "claude", { background: true })];
  const runtimes = new Map<string, UpdatableRuntime>(state.sessions.map(s => [s.id, { running: true, closing: false }]));
  const statuses = new Map<string, Status>(state.sessions.map(s => [s.id, "idle"]));
  const unread = new Set<string>(), watched = new Set<string>();
  let versions = { claude: "2.1.323 (Claude Code)", codex: "codex-cli 0.167.2" };
  const probes: unknown[] = [], restarted: string[] = [], announced: string[] = [];
  let probe: () => Promise<unknown> = async () => [
    { status: "available", version: versions.claude }, { status: "available", version: versions.codex }, { status: "unsupported", version: "" }];
  const updates = createAgentUpdates({
    getState: () => state, runtimes, statusOf: id => statuses.get(id) ?? "sleeping", unread,
    isWatched: id => watched.has(id), isClosing: () => false,
    invoke: async <T>(_command: string, args: Record<string, unknown>) => { probes.push(args); return await probe() as T; },
    restart: (s, version) => { restarted.push(`${s.id}@${version}`); },
    announce: (agent, version) => { announced.push(`${agent}@${version}`); },
  });
  return { state, runtimes, statuses, unread, watched, updates, probes, restarted, announced,
    set versions(v: typeof versions) { versions = v; }, set probe(p: () => Promise<unknown>) { probe = p; } };
}

test("short versions drop the product name for messages", () => {
  assert.equal(shortVersion("2.1.324 (Claude Code)"), "2.1.324");
  assert.equal(shortVersion("codex-cli 0.168.0-alpha.1"), "0.168.0-alpha.1");
  assert.equal(shortVersion("weird"), "weird");
});

test("the first check sets a baseline; a newer installed version restarts idle foreground agents once", async () => {
  const f = fixture();
  await f.updates.check();
  assert.deepEqual(f.restarted, []);
  assert.deepEqual((f.probes[0] as { commands: string[] }).commands.at(-1), "");
  f.versions = { claude: "2.1.324 (Claude Code)", codex: "codex-cli 0.167.2" };
  await f.updates.check();
  // Shells, background workers, and Codex (unchanged) stay running.
  assert.deepEqual(f.restarted, ["claude@2.1.324"]);
  assert.deepEqual(f.announced, ["claude@2.1.324"]);
  await f.updates.check();
  f.updates.restartIdle();
  assert.deepEqual(f.restarted, ["claude@2.1.324"]);
  assert.deepEqual(f.announced, ["claude@2.1.324"]);
});

test("busy, watched, unseen and half-typed sessions wait until they are safe to restart", async () => {
  const f = fixture();
  await f.updates.check();
  f.versions = { claude: "2.1.324", codex: "codex-cli 0.168.0" };
  f.statuses.set("claude", "working");
  f.watched.add("codex");
  await f.updates.check();
  assert.deepEqual(f.restarted, []);
  assert.equal(f.announced.length, 2);

  f.updates.input("claude");
  f.statuses.set("claude", "done");
  f.unread.add("claude");
  f.updates.restartIdle();
  assert.deepEqual(f.restarted, []);
  f.unread.delete("claude");
  f.updates.restartIdle();
  assert.deepEqual(f.restarted, [], "typed text since the last turn would be lost");
  f.updates.statusChanged("claude", "working");
  f.updates.restartIdle();
  assert.deepEqual(f.restarted, ["claude@2.1.324"]);

  f.watched.delete("codex");
  f.updates.restartIdle();
  assert.deepEqual(f.restarted, ["claude@2.1.324", "codex@0.168.0"]);
});

test("a session started on the new version is current; failed probes and the setting change nothing", async () => {
  const f = fixture();
  await f.updates.check();
  f.versions = { claude: "2.1.324", codex: "codex-cli 0.167.2" };
  f.probe = async () => { throw Error("fixture probe failure"); };
  await f.updates.check();
  f.probe = async () => [{ status: "timeout", version: "" }, { status: "failed", version: "" }, { status: "unsupported", version: "" }];
  await f.updates.check();
  assert.deepEqual(f.restarted, []);

  f.probe = async () => [{ status: "available", version: "2.1.324" }, { status: "available", version: "codex-cli 0.167.2" }, { status: "unsupported", version: "" }];
  f.state.settings.restartOnAgentUpdate = false;
  const before = f.probes.length;
  await f.updates.check();
  assert.equal(f.probes.length, before);
  f.state.settings.restartOnAgentUpdate = true;
  await f.updates.check();
  assert.deepEqual(f.restarted, ["claude@2.1.324"]);
  // The restarted process runs what is installed now.
  f.updates.spawned(f.state.sessions[0]);
  await f.updates.check();
  assert.deepEqual(f.restarted, ["claude@2.1.324"]);
});

test("no probe without running agents; a spawn during a probe gets the probed version as its baseline", async () => {
  const f = fixture();
  for (const rt of f.runtimes.values()) rt.running = false;
  await f.updates.check();
  assert.equal(f.probes.length, 0);
  f.runtimes.get("claude")!.running = true;
  let finish!: () => void;
  f.versions = { claude: "2.1.324", codex: "codex-cli 0.167.2" };
  const inner = async () => [{ status: "available", version: "2.1.324" }, { status: "unsupported", version: "" }, { status: "unsupported", version: "" }];
  f.probe = () => new Promise(done => { finish = () => done(inner()); });
  const checking = f.updates.check();
  f.updates.spawned(f.state.sessions[0]);
  finish(); await checking;
  assert.deepEqual(f.restarted, []);
});
