import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fileOpenTarget,
  backgroundStatus,
  droppedFilePaths,
  savePanePreset,
  applyPanePreset,
  createDiscovery,
  importConversation,
  normalizePaneSlots,
  assignPaneSlot,
  paneGeometry,
  paneWeights,
  resizePaneTracks,
  attentionEventKind,
  recordAttention,
  readAttention,
  observeSession,
  sessionDiagnostics,
  agentCommand,
  archiveSession,
  busyAgents,
  restoreSession,
  recordSessionExit,
  shouldAutoResume,
  nextAttention,
  settingsDraft,
  emptyState,
  codexStatusAfter,
  codexPollEvents,
  findFileRefs,
  formatTokens,
  moveProject,
  opensInSystem,
  orderedProjects,
  relativePath,
  pasteSequence,
  copiedText,
  templatesFor,
  DEFAULT_SETTINGS,
  folderName,
  matches,
  parseState,
  sessionByNumber,
  statusAfter,
  statusAfterSpawn,
  statusAfterStartupTimeout,
  type Session,
} from "./model.ts";

test("Codex usage-only polls cannot invent completion or notifications", () => {
  assert.deepEqual(codexPollEvents({ status: null, events: [] }), []);
  assert.deepEqual(codexPollEvents({ status: "task_started", events: [] }), ["task_started"]);
  assert.deepEqual(codexPollEvents({ status: "task_complete", events: ["task_started", "task_complete"] }), ["task_started", "task_complete"]);
});

test("Claude reports immediate permission requests and recovers after failed tools and API errors", () => {
  const ev = (event: string) => ({ deskSessionId: "s", event });
  assert.equal(statusAfter("working", ev("PermissionRequest")), "needs-you");
  assert.equal(statusAfter("needs-you", ev("PostToolUseFailure")), "working");
  assert.equal(statusAfter("working", ev("StopFailure")), "needs-you");
  assert.equal(statusAfter("needs-you", ev("UserPromptSubmit")), "working");
  assert.equal(statusAfter("working", ev("Stop")), "done");
});

test("file drops quote complete paths without sending a command or Enter", () => {
  assert.equal(droppedFilePaths(["C:\\My files\\žluťoučký.png", "C:\\O'Brien.txt"], "windows"), "'C:\\My files\\žluťoučký.png' 'C:\\O''Brien.txt' ");
  assert.equal(droppedFilePaths(["/tmp/a b.txt", "/tmp/O'Brien $(echo hi).txt"], "linux"), "'/tmp/a b.txt' '/tmp/O'\\''Brien $(echo hi).txt' ");
  assert.equal(droppedFilePaths(["/tmp/a"], "macos"), "'/tmp/a' ");
  for (const paths of [[], [""], ["/safe", "/bad\nname"], ["/bad\rname"], ["/bad\x1b[201~name"], ["/bad\x00name"], ["/bad\x7fname"]]) {
    assert.equal(droppedFilePaths(paths, "linux"), undefined);
  }
});

const ID = "0b8c5a8e-4f3c-4d2a-9b8e-1c2d3e4f5a6b";
test("confirmed OS shutdown preserves resume eligibility without disguising stopped processes", () => {
  const state = parseState(JSON.stringify({ projects: [{ id: "p", name: "P", path: "/p" }],
    sessions: [{ id: "s", projectId: "p", provider: "codex", title: "Test", agentSessionId: ID }] })).state;
  const s = state.sessions[0];
  recordSessionExit(state, s.id, 0x40010004, false);
  assert.equal(shouldAutoResume(s, true), false, "exit code alone does not prove shutdown");
  recordSessionExit(state, s.id, 0x40010004, false, true);
  assert.equal(s.stopped, true);
  assert.equal(shouldAutoResume(s, true), true);
  assert.equal(shouldAutoResume(s, false), false, "respect disabled auto-resume");
  const restored = parseState(JSON.stringify(state)).state.sessions[0];
  assert.equal(shouldAutoResume(restored, true), true);
  assert.equal(restored.agentSessionId, ID);
  recordSessionExit(state, s.id, 1, false);
  assert.equal(shouldAutoResume(s, true), false, "later ordinary exit clears recovery");
  recordSessionExit(state, s.id, 0, true, true);
  assert.equal(state.sessions.length, 0);
  assert.equal(shouldAutoResume(state.closedSessions[0], true), false, "explicit close wins over shutdown");
});
test("closing the app interrupts only running agents mid-step and the mark survives restart", () => {
  const state = parseState(JSON.stringify({ projects: [{ id: "p", name: "P", path: "/p" }],
    sessions: ["work", "ask", "done", "shell", "stopped", "worker"].map(id => ({ id, projectId: "p", title: id,
      provider: id === "shell" ? "shell" : "claude", background: id === "worker" })) })).state;
  const status: Record<string, string> = { work: "working", ask: "needs-you", done: "done", shell: "working", stopped: "working", worker: "working" };
  const busy = busyAgents(state.sessions, id => status[id] as never, id => id !== "stopped");
  assert.deepEqual(busy.map(s => s.id), ["work", "ask"]);
  for (const s of busy) s.interrupted = true;
  const restored = parseState(JSON.stringify(state)).state;
  assert.deepEqual(restored.sessions.filter(s => s.interrupted).map(s => s.id), ["work", "ask"]);
  archiveSession(restored, "work");
  assert.equal(restored.closedSessions[0].interrupted, false, "explicit close discards the mark");
});
test("saved layouts are independent snapshots and switching never changes session lifecycle", () => {
  const state = parseState(JSON.stringify({ projects: [{ id: "p", name: "P", path: "/p" }],
    sessions: ["a", "b"].map(id => ({ id, projectId: "p", title: id, provider: "shell", stopped: id === "b" })) })).state;
  state.ui.paneSlots = ["b", "a", null];
  state.ui.paneLayout = "columns";
  state.ui.paneSizes = { "columns-3": [0.2, 0.3, 0.5] };
  const sessions = JSON.stringify(state.sessions);
  assert.equal(savePanePreset(state, "web", "  Web  "), true);
  state.ui.paneSlots[0] = null;
  state.ui.paneSizes["columns-3"][0] = 0.8;
  assert.equal(state.savedLayouts[0].paneSlots[0], "b");
  assert.equal(state.savedLayouts[0].paneSizes["columns-3"][0], 0.2);
  assert.equal(applyPanePreset(state, "web"), true);
  assert.equal(state.ui.grid, true);
  assert.equal(state.ui.activeSessionId, "b");
  assert.deepEqual(state.ui.paneSlots, ["b", "a", null]);
  assert.deepEqual(state.ui.paneSizes["columns-3"], [0.2, 0.3, 0.5]);
  assert.equal(JSON.stringify(state.sessions), sessions);
  state.ui.paneSlots[0] = null;
  assert.equal(state.savedLayouts[0].paneSlots[0], "b");
  savePanePreset(state, "web", "Updated");
  assert.equal(state.savedLayouts.length, 1);
  assert.equal(state.savedLayouts[0].name, "Updated");
  assert.equal(state.savedLayouts[0].paneSlots[0], null);
  assert.equal(savePanePreset(state, "bad", "  "), false);
  assert.equal(applyPanePreset(state, "missing"), false);
  state.sessions = [];
  applyPanePreset(state, "web");
  assert.deepEqual(state.ui.paneSlots, [null, null, null]);
  assert.equal(state.ui.activeSessionId, undefined);
});

test("saved layouts survive restart, migrate older state, and validate damaged entries", () => {
  assert.deepEqual(parseState('{"ui":{"paneSlots":[null,null,null]}}').state.savedLayouts, []);
  const raw = { savedLayouts: [
    { id: "a", name: " Web ", paneLayout: "rows", paneSlots: ["gone", null, null], paneSizes: { "rows-3": [0.2, 0.3, 0.5], bad: [1] } },
    { id: "a", name: "Duplicate", paneLayout: "grid", paneSlots: [] },
    { id: "b", name: " ", paneLayout: "grid", paneSlots: [] },
    { id: "c", name: "Broken", paneLayout: "wrong", paneSlots: [] },
  ] };
  const { state, dropped } = parseState(JSON.stringify(raw));
  assert.equal(dropped, 3);
  assert.equal(state.savedLayouts.length, 1);
  assert.equal(state.savedLayouts[0].name, "Web");
  assert.deepEqual(state.savedLayouts[0].paneSlots, [null, null, null]);
  assert.deepEqual(state.savedLayouts[0].paneSizes, { "rows-3": [0.2, 0.3, 0.5] });
  assert.deepEqual(parseState(JSON.stringify(state)).state.savedLayouts, state.savedLayouts);
});
test("conversation import validates IDs, stays stopped, deduplicates and resumes all agents by ID", () => {
  for (const provider of ["claude", "codex", "antigravity"] as const) {
    const state = emptyState();
    state.projects = [{ id: "p", name: "Project", path: "/project" }];
    assert.equal(importConversation(state, "p", provider, "bad; command", "", "s", 1), "invalid");
    const result = importConversation(state, "p", provider, ` ${ID.toUpperCase()} `, "Existing", "s", 1);
    assert.notEqual(typeof result, "string");
    if (typeof result === "string") return;
    assert.equal(result.stopped, true);
    assert.equal(result.started, true);
    assert.equal(result.hasConversation, true);
    assert.equal(result.agentSessionId, ID);
    const command = agentCommand(result, state.settings, "windows", false)!;
    assert.ok(command.endsWith(ID));
    assert.ok(command.includes(provider === "antigravity" ? "--conversation " : "resume "));
    assert.equal(importConversation(state, "p", provider, ID, "Duplicate", "s2", 2), "duplicate");
    assert.equal(state.sessions.length, 1);
    const linked = importConversation(state, "p", provider, ID, "Ignored rename", "unused", 3, result.id);
    assert.equal(linked, result);
    assert.equal(result.title, "Existing");
    assert.equal(parseState(JSON.stringify(state)).state.sessions[0].agentSessionId, ID);
    assert.equal(importConversation(state, "p", provider, ID, "", "s3", 4, "missing"), "invalid");
  }
});
test("panel geometry supports rows, columns and a full-width third grid pane", () => {
  for (const count of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const columns = paneGeometry("columns", count);
    const rows = paneGeometry("rows", count);
    assert.equal(columns.columns, count);
    assert.equal(columns.rows, 1);
    assert.equal(rows.rows, count);
    assert.equal(rows.columns, 1);
    assert.equal(new Set(columns.cells.map(c => c.column)).size, count);
    assert.equal(new Set(rows.cells.map(c => c.row)).size, count);
  }
  assert.deepEqual(paneGeometry("grid", 3).cells, [
    { column: 1, row: 1, span: 1 }, { column: 3, row: 1, span: 1 }, { column: 1, row: 3, span: 3 },
  ]);
  assert.equal(paneGeometry("grid", 4).cells[3].column, 3);
});

test("resizing preserves adjacent total and other panes, with bounded nonzero sizes", () => {
  assert.deepEqual(resizePaneTracks([0.5, 0.5], 0, 0.7), [0.7, 0.30000000000000004]);
  const sizes = resizePaneTracks([0.25, 0.25, 0.25, 0.25], 1, 0.99);
  assert.equal(sizes[0], 0.25);
  assert.equal(sizes[3], 0.25);
  assert.ok(Math.abs(sizes[1] - 0.4) < 1e-9);
  assert.ok(Math.abs(sizes[2] - 0.1) < 1e-9);
  assert.deepEqual(resizePaneTracks([0.5, 0.5], 0, -1), [0.1, 0.9]);
  assert.deepEqual(paneWeights([NaN, 1], 2), [0.5, 0.5]);
  assert.deepEqual(paneWeights([0, 1], 2), [0.5, 0.5]);
  assert.deepEqual(paneWeights([1, 1, 1], 2), [0.5, 0.5]);
});

test("panel preferences migrate and round-trip without accepting invalid layouts or ratios", () => {
  const old = parseState('{"ui":{"grid":true}}').state;
  assert.equal(old.ui.paneLayout, "grid");
  assert.deepEqual(old.ui.paneSizes, {});
  old.ui.paneLayout = "rows";
  old.ui.paneSizes = { "rows-2": [0.7, 0.3], "grid-x": [0.4, 0.6] };
  assert.deepEqual(parseState(JSON.stringify(old)).state.ui, old.ui);
  const bad = parseState(JSON.stringify({ ui: { paneLayout: "bad", paneSizes: { arbitrary: [1, 2], "grid-x": [0, 1], "rows-4": [1, 1] } } })).state;
  assert.equal(bad.ui.paneLayout, "grid");
  assert.deepEqual(bad.ui.paneSizes, { "grid-x": [0.5, 0.5], "rows-4": [0.25, 0.25, 0.25, 0.25] });
});
test("attention history excludes readiness, snapshots and duplicate states but includes quick Codex turns", () => {
  for (const prev of ["starting", "untracked", "sleeping", "idle", "done"] as const) assert.equal(attentionEventKind(prev, "done", false), undefined);
  assert.equal(attentionEventKind("working", "done", true), undefined);
  assert.equal(attentionEventKind("working", "done", false), "done");
  assert.equal(attentionEventKind("working", "needs-you", false), "needs-you");
  assert.equal(attentionEventKind("needs-you", "needs-you", false), undefined);
  assert.equal(attentionEventKind("needs-you", "done", false), "done");
  let previous: import("./model.ts").Status = "done";
  const events = [];
  for (const event of ["task_started", "task_complete"]) {
    const next = codexStatusAfter(event)!;
    const kind = attentionEventKind(previous, next, false);
    if (kind) events.push(kind);
    previous = next;
  }
  assert.deepEqual(events, ["done"]);
});

test("attention history is bounded, metadata-only, persisted and readable after session removal", () => {
  const state = emptyState();
  state.projects.push({ id: "p", name: "Project", path: "/tmp/test" });
  const s: Session = { id: "s", projectId: "p", provider: "claude", title: "Task", createdAt: 1, lastUsedAt: 1 };
  for (let i = 0; i < 105; i++) recordAttention(state, s, "done", `n${i}`, i, false);
  assert.equal(state.notifications.length, 100);
  assert.equal(state.notifications[0].id, "n104");
  assert.equal(readAttention(state, "other"), false);
  assert.equal(readAttention(state, "s"), true);
  assert.equal(readAttention(state, "s"), false);
  recordAttention(state, { ...s, id: "second" }, "needs-you", "second", 106, false);
  const restored = parseState(JSON.stringify(state));
  assert.equal(restored.dropped, 0);
  assert.deepEqual(restored.state.notifications, state.notifications);
  assert.equal(readAttention(restored.state), true);
  const bad = { ...state.notifications[0], prompt: "must not persist", read: "false" };
  const parsed = parseState(JSON.stringify({ notifications: [bad, bad, { ...bad, id: "bad", at: 1e20 }] }));
  assert.equal(parsed.dropped, 2);
  assert.equal(parsed.state.notifications.length, 1);
  assert.equal(parsed.state.notifications[0].read, false);
  assert.equal("prompt" in parsed.state.notifications[0], false);
  assert.deepEqual(parseState('{"projects":[],"sessions":[]}').state.notifications, []);
});
test("diagnostics distinguish missing IDs, missing evidence, disabled hooks and stopped processes", () => {
  const codex = { provider: "codex" as const, agentSessionId: ID };
  assert.equal(sessionDiagnostics(codex, true, false).reason, "awaitingFile");
  assert.equal(sessionDiagnostics({ ...codex, agentSessionId: "invalid" }, true, true).reason, "missingId");
  const observation = observeSession(undefined, "task_complete", true, 100);
  assert.equal(sessionDiagnostics(codex, true, false, observation).reason, "receiving");
  assert.equal(sessionDiagnostics(codex, false, true, observation).reason, "stopped");
  for (const provider of ["claude", "antigravity"] as const) {
    assert.equal(sessionDiagnostics({ provider }, true, false).reason, "hooksUnavailable");
    assert.equal(sessionDiagnostics({ provider, agentSessionId: ID }, true, true).reason, "awaitingHook");
    assert.equal(sessionDiagnostics({ provider }, true, true, observation).method, "hooks");
  }
  assert.equal(sessionDiagnostics({ provider: "shell" }, true, false).reason, "shell");
  assert.equal(sessionDiagnostics({ provider: "shell" }, false, false).reason, "stopped");
  assert.equal(sessionDiagnostics(codex, true, true).recovery, "link");
  assert.equal(sessionDiagnostics(codex, false, true).recovery, "resume");
  assert.equal(sessionDiagnostics(codex, true, true, observation).recovery, undefined);
  const claude = { provider: "claude" as const, agentSessionId: ID };
  assert.equal(sessionDiagnostics(claude, true, true).recovery, "terminal");
  assert.equal(sessionDiagnostics(claude, true, false).recovery, "restartApp");
  const exited = observeSession(undefined, "SessionEnd", false, 200);
  assert.equal(sessionDiagnostics(claude, true, true, exited).reason, "agentExited");
  assert.equal(sessionDiagnostics(claude, true, true, exited).recovery, "terminal");
});

test("repeated snapshots do not invent fresh events or replace live receipt times", () => {
  const saved = observeSession(undefined, "task_complete", true, 100);
  assert.equal(observeSession(saved, "task_complete", true, 200), saved);
  const live = observeSession(saved, "task_complete", false, 300);
  assert.deepEqual(live, { event: "task_complete", snapshot: false, receivedAt: 300 });
  assert.equal(observeSession(live, "task_complete", true, 400), live);
  assert.deepEqual(observeSession(live, "task_started", true, 500), { event: "task_started", snapshot: true, receivedAt: 500 });
});
test("spawn completion preserves early agent events and missing readiness stays unknown", () => {
  for (const provider of ["claude", "codex", "antigravity"] as const) {
    const s = { provider, started: true, agentSessionId: ID };
    for (const status of ["done", "working", "needs-you", "agent-exited", "exited"] as const) {
      assert.equal(statusAfterSpawn(status, s, true), status);
      assert.equal(statusAfterStartupTimeout(status), status);
    }
    assert.equal(statusAfterSpawn("starting", s, true), "starting");
  }
  assert.equal(statusAfterStartupTimeout("starting"), "untracked");
  assert.equal(statusAfterSpawn("starting", { provider: "codex", started: true }, true), "untracked");
  assert.equal(statusAfterSpawn("starting", { provider: "codex", started: false }, true), "starting");
  assert.equal(statusAfterSpawn("starting", { provider: "claude" }, false), "untracked");
  assert.equal(statusAfterSpawn("starting", { provider: "shell" }, false), "running");
});

test("late Claude readiness recovers missing startup hook without clearing approval requests", () => {
  const idle = { deskSessionId: "s", event: "Notification", notificationType: "idle_prompt" };
  for (const status of ["starting", "untracked", "working"] as const) assert.equal(statusAfter(status, idle), "done");
  for (const status of ["needs-you", "agent-exited", "exited", "done"] as const) assert.equal(statusAfter(status, idle), undefined);
  assert.equal(statusAfter("untracked", { deskSessionId: "s", event: "UserPromptSubmit" }), "working");
});
test("default provider migrates safely and preserves every supported selection", () => {
  for (const provider of [undefined, "unknown", null, 42]) {
    assert.equal(parseState(JSON.stringify({ settings: { defaultProvider: provider } })).state.settings.defaultProvider, "claude");
  }
  for (const provider of ["claude", "codex", "antigravity", "shell"] as const) {
    const state = emptyState();
    state.settings.defaultProvider = provider;
    assert.equal(parseState(JSON.stringify(state)).state.settings.defaultProvider, provider);
  }
});
const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  projectId: "p1",
  provider: "claude",
  title: "Úloha; rm -rf /",
  agentSessionId: ID,
  createdAt: 1,
  lastUsedAt: 1,
  ...over,
});

test("Ctrl+číslo ide podľa poradia v zozname, pripnuté projekty prvé, Ctrl+9 je posledná", () => {
  const st = parseState("{}").state;
  st.projects = [
    { id: "a", name: "a", path: "/a" },
    { id: "b", name: "b", path: "/b", pinned: true, collapsed: true },
  ];
  st.sessions = [
    session({ id: "a2", projectId: "a", createdAt: 2 }),
    session({ id: "a1", projectId: "a", createdAt: 1 }),
    session({ id: "b1", projectId: "b", createdAt: 3 }),
  ];
  assert.deepEqual([1, 2, 3, 4].map((n) => sessionByNumber(st, n)?.id), ["b1", "a1", "a2", undefined]);
  assert.equal(sessionByNumber(st, 9)?.id, "a2");
});

test("nový Claude dostane --session-id a odkaz na hook settings cez env", () => {
  const cmd = agentCommand(session(), DEFAULT_SETTINGS, "windows", true);
  assert.equal(cmd, `claude --dangerously-skip-permissions --session-id ${ID} --settings "$env:PROJECT_DESK_HOOK_SETTINGS"`);
});

test("Claude s konverzáciou sa obnoví cez --resume", () => {
  const cmd = agentCommand(session({ hasConversation: true }), DEFAULT_SETTINGS, "linux", true);
  assert.equal(cmd, `claude --dangerously-skip-permissions --resume ${ID} --settings "$PROJECT_DESK_HOOK_SETTINGS"`);
});

test("názov úlohy sa nikdy nedostane do príkazu", () => {
  for (const provider of ["claude", "codex"] as const) {
    const cmd = agentCommand(session({ provider }), DEFAULT_SETTINGS, "windows", true) ?? "";
    assert.ok(!cmd.includes("rm -rf"), cmd);
  }
});

test("nevalidné agentSessionId sa do príkazu nevloží", () => {
  const cmd = agentCommand(session({ agentSessionId: "x; calc" }), DEFAULT_SETTINGS, "windows", false);
  assert.equal(cmd, "claude --dangerously-skip-permissions");
});

test("Codex: prvý štart, pokračovanie v známej konverzácii, výber pri neznámej", () => {
  const bypass = "--dangerously-bypass-approvals-and-sandbox";
  const codex = (over: Partial<Session>) => agentCommand(session({ provider: "codex", ...over }), DEFAULT_SETTINGS, "windows", true);
  assert.equal(codex({ agentSessionId: undefined }), `codex ${bypass}`);
  assert.equal(codex({ started: true }), `codex resume ${bypass} ${ID}`);
  assert.equal(codex({ started: true, agentSessionId: "x; calc" }), `codex resume ${bypass}`);
  assert.equal(agentCommand(session({ provider: "shell" }), DEFAULT_SETTINGS, "windows", true), undefined);
});

test("staré predvolené Codex príkazy sa prepnú na bypass, vlastné ostanú", () => {
  const old = parseState(JSON.stringify({ settings: { codexCommand: "codex", codexResumeCommand: "codex resume" } })).state;
  assert.equal(old.settings.codexCommand, DEFAULT_SETTINGS.codexCommand);
  assert.equal(old.settings.codexResumeCommand, DEFAULT_SETTINGS.codexResumeCommand);
  const custom = parseState(JSON.stringify({ settings: { codexCommand: "codex -m o3" } })).state;
  assert.equal(custom.settings.codexCommand, "codex -m o3");
  const rev2 = parseState(JSON.stringify({ settingsRev: 2, settings: { codexCommand: "codex" } })).state;
  assert.equal(rev2.settings.codexCommand, "codex");
});

test("starý príkaz editora sa prevedie na ID, nový výber ostane", () => {
  assert.equal(parseState(JSON.stringify({ settings: { editorCommand: "cursor" } })).state.settings.editorId, "cursor");
  assert.equal(parseState(JSON.stringify({ settings: { editorCommand: "code --new-window" } })).state.settings.editorId, "");
  const now = parseState(JSON.stringify({ settings: { editorCommand: "cursor", editorId: "custom" } })).state;
  assert.equal(now.settings.editorId, "custom");
  assert.equal(parseState("{}").state.settings.customEditorArgs, "%TARGET_PATH%");
});

test("jazyk: predvolene angličtina, neznámy jazyk sa zahodí", () => {
  assert.equal(parseState("{}").state.settings.language, "en");
  assert.equal(parseState(JSON.stringify({ settings: { language: "cs" } })).state.settings.language, "cs");
  assert.equal(parseState(JSON.stringify({ settings: { language: "de" } })).state.settings.language, "en");
});

test("stavy z hookov", () => {
  const ev = (event: string, notificationType?: string) => ({ deskSessionId: "s1", event, notificationType });
  assert.equal(statusAfter("idle", ev("UserPromptSubmit")), "working");
  assert.equal(statusAfter("working", ev("Notification", "permission_prompt")), "needs-you");
  assert.equal(statusAfter("needs-you", ev("PostToolUse")), "working");
  assert.equal(statusAfter("working", ev("Stop")), "done");
  assert.equal(statusAfter("done", ev("Notification", "idle_prompt")), undefined);
  assert.equal(statusAfter("working", ev("Notification", "auth_success")), undefined);
  assert.equal(statusAfter("done", ev("SessionEnd")), "agent-exited");
});

test("parseState zahodí poškodené záznamy a relácie bez projektu", () => {
  const raw = JSON.stringify({
    projects: [{ id: "p1", name: "A", path: "C:\\a" }, { id: 5 }],
    sessions: [
      { id: "s1", projectId: "p1", provider: "claude", title: "x", agentSessionId: "zlé" },
      { id: "s2", projectId: "chýba", provider: "shell", title: "y" },
      { id: "s3", projectId: "p1", provider: "vim", title: "z" },
    ],
    settings: { claudeCommand: "claude", notifications: "áno" },
    ui: { sidebarWidth: 5000 },
  });
  const { state, dropped } = parseState(raw);
  assert.equal(state.projects.length, 1);
  assert.deepEqual(state.sessions.map((s) => s.id), ["s1"]);
  assert.equal(state.sessions[0].agentSessionId, undefined);
  assert.equal(dropped, 3);
  assert.equal(state.settings.claudeCommand, "claude");
  assert.equal(state.settings.notifications, true);
  assert.equal(state.ui.sidebarWidth, 640);
});

test("parseState prežije nezmysel", () => {
  assert.equal(parseState("{").dropped, 1);
  assert.equal(parseState(null).state.projects.length, 0);
});

test("hľadanie podľa úlohy, projektu aj nástroja", () => {
  const s = session({ title: "Fix login" });
  const p = { id: "p1", name: "EffiOS", path: "C:\\x" };
  assert.ok(matches(s, p, "effi login"));
  assert.ok(matches(s, p, "claude"));
  assert.ok(!matches(s, p, "codex"));
});

test("folderName", () => {
  assert.equal(folderName("C:\\Users\\adria\\effistream-os\\"), "effistream-os");
  assert.equal(folderName("/home/a/proj"), "proj");
});

test("pripnuté projekty hore a presun medzi skupinami preberie pripnutie", () => {
  const ps = [
    { id: "a", name: "A", path: "a" },
    { id: "b", name: "B", path: "b", pinned: true },
    { id: "c", name: "C", path: "c" },
  ];
  assert.deepEqual(orderedProjects(ps).map((p) => p.id), ["b", "a", "c"]);
  const moved = moveProject(ps, "c", "b", false);
  assert.deepEqual(orderedProjects(moved).map((p) => p.id), ["c", "b", "a"]);
  assert.equal(moved.find((p) => p.id === "c")?.pinned, true);
  assert.deepEqual(moveProject(ps, "a", "c", true).map((p) => p.id), ["b", "c", "a"]);
});

test("šablóny: projektové pred spoločnými, cudzí projekt nie", () => {
  const t = (id: string, name: string, projectId?: string) => ({ id, name, text: "", send: false, projectId });
  const list = templatesFor([t("1", "Review"), t("2", "Deploy", "p1"), t("3", "Iný", "p2"), t("4", "Audit")], "p1");
  assert.deepEqual(list.map((x) => x.id), ["2", "4", "1"]);
});

test("vloženie šablóny je jeden paste a nedá sa z neho utiecť", () => {
  assert.equal(pasteSequence("a\nb"), "\x1b[200~a\rb\x1b[201~");
  assert.equal(pasteSequence("x\x1b[201~; calc"), "\x1b[200~x; calc\x1b[201~");
});

test("kopírovanie z terminálu odstráni spoločné odsadenie a medzery na konci, štruktúru nechá", () => {
  // Výber začína za „⏺ “ v odpovedi Claude Code, ďalšie riadky majú jeho dve medzery odsadenia.
  assert.equal(copiedText("Čau Kubo,   \n  druhý riadok\n\n  1. krok\n     pokračovanie", 2),
    "Čau Kubo,\ndruhý riadok\n\n1. krok\n   pokračovanie");
  // Celé riadky bloku kódu: vnútorné odsadenie zostane.
  assert.equal(copiedText("    def f():\n        return 1"), "def f():\n    return 1");
  // Riadok s menším odsadením než prvý nesmie prísť o text.
  assert.equal(copiedText("  ⏺ odpoveď\n    pokračuje"), "⏺ odpoveď\n  pokračuje");
  assert.equal(copiedText("a\n   \nb"), "a\n\nb");
  assert.equal(copiedText("   "), "");
});

test("cesty k súborom v texte terminálu", () => {
  const refs = (s: string) => findFileRefs(s).map((r) => [r.path, r.line ?? null, s.slice(r.index, r.index + r.length)]);
  assert.deepEqual(refs("Upravil som src/main.ts:120 a README.md."), [
    ["src/main.ts", 120, "src/main.ts:120"],
    ["README.md", null, "README.md"],
  ]);
  assert.deepEqual(refs("chyba v C:\\p\\lib.rs:12:5"), [["C:\\p\\lib.rs", 12, "C:\\p\\lib.rs:12:5"]]);
  assert.deepEqual(refs("src\\x.ts(40,2): error"), [["src\\x.ts", 40, "src\\x.ts(40,2)"]]);
  assert.deepEqual(refs("pozri https://example.com/a/b.html"), []);
});

test("formátovanie tokenov", () => {
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1234), "1,2k");
  assert.equal(formatTokens(86751), "87k");
  assert.equal(formatTokens(1_004_572), "1,0M");
});

test("udalosti Codexu", () => {
  assert.equal(codexStatusAfter("turn_aborted"), "done");
  assert.equal(codexStatusAfter("turn_started"), "working");
  assert.equal(codexStatusAfter("turn_complete"), "done");
  assert.equal(statusAfter("starting", { deskSessionId: "s", event: "SessionStart" }), "done");
  assert.equal(codexStatusAfter("task_started"), "working");
  assert.equal(codexStatusAfter("task_complete"), "done");
  assert.equal(codexStatusAfter("token_count"), undefined);
});

test("parseState načíta šablóny a zahodí tie k neexistujúcemu projektu", () => {
  const raw = JSON.stringify({
    projects: [{ id: "p1", name: "A", path: "a", pinned: true }],
    templates: [
      { id: "t1", name: "Review", text: "sprav review", send: true, projectId: "p1" },
      { id: "t2", name: "Spoločná", text: "x" },
      { id: "t3", name: "Sirota", text: "x", projectId: "zmazaný" },
    ],
  });
  const { state, dropped } = parseState(raw);
  assert.deepEqual(state.templates.map((t) => t.id), ["t1", "t2"]);
  assert.equal(state.templates[0].send, true);
  assert.equal(state.projects[0].pinned, true);
  assert.equal(dropped, 1);
});

test("opensInSystem podľa prípony z nastavení", () => {
  const list = "html, .PDF  svg";
  assert.equal(opensInSystem("C:/web/index.HTML", list), true);
  assert.equal(opensInSystem("/tmp/report.pdf", list), true);
  assert.equal(opensInSystem("src/main.ts", list), false);
  assert.equal(opensInSystem("html", list), false);
  assert.equal(opensInSystem("/a/.svg", list), false);
  assert.equal(opensInSystem("x.html", DEFAULT_SETTINGS.systemOpenExts), true);
});

test("relativePath len pre súbory vnútri projektu", () => {
  assert.equal(relativePath("C:\\Users\\a\\web", "C:\\Users\\a\\web\\src\\index.html"), "src/index.html");
  assert.equal(relativePath("/home/a/web/", "/home/a/web/a.ts"), "a.ts");
  assert.equal(relativePath("/home/a/web", "/home/a/website/a.ts"), undefined);
  assert.equal(relativePath("/home/a/web", "/etc/passwd"), undefined);
});


function lifecycleState() {
  const state = emptyState();
  state.projects = [{ id: "p1", name: "Project", path: "/test" }];
  state.sessions = [session({ hasConversation: true, started: true })];
  state.ui.activeSessionId = "s1";
  state.ui.pinnedSessionIds = ["s1"];
  return state;
}

test("unexpected exit retains conversation metadata and produces a resume command after reload", () => {
  const state = lifecycleState();
  recordSessionExit(state, "s1", 7, false);
  assert.equal(state.closedSessions.length, 0);
  const reloaded = parseState(JSON.stringify(state)).state;
  assert.equal(reloaded.sessions[0].exitCode, 7);
  assert.equal(reloaded.sessions[0].stopped, true);
  assert.match(agentCommand(reloaded.sessions[0], reloaded.settings, "windows", false)!, new RegExp(`--resume ${ID}`));
});

test("explicit close archives, removes grid pin and restores the same conversation once", () => {
  const state = lifecycleState();
  recordSessionExit(state, "s1", 0, true);
  assert.equal(state.sessions.length, 0);
  assert.deepEqual(state.ui.pinnedSessionIds, []);
  assert.equal(state.ui.activeSessionId, undefined);
  const reloaded = parseState(JSON.stringify(state)).state;
  const restored = restoreSession(reloaded, "s1")!;
  assert.equal(restored.agentSessionId, ID);
  assert.equal(reloaded.closedSessions.length, 0);
  assert.equal(restoreSession(reloaded, "s1"), undefined);
  assert.equal(reloaded.sessions.length, 1);
});

test("closed history is bounded and cannot restore sessions from removed projects", () => {
  const state = lifecycleState();
  state.sessions = Array.from({ length: 25 }, (_, i) => session({ id: String(i) }));
  for (const s of [...state.sessions]) archiveSession(state, s.id);
  assert.equal(state.closedSessions.length, 20);
  assert.equal(state.closedSessions[0].id, "24");
  state.projects = [];
  assert.equal(restoreSession(state, "24"), undefined);
  assert.deepEqual(parseState(JSON.stringify(state)).state.closedSessions, []);
});

test("old state migrates and grid pins are deduplicated and checked against active sessions", () => {
  const state = lifecycleState();
  const parsed = parseState(JSON.stringify({ ...state, ui: { grid: true, pinnedSessionIds: ["missing", "s1", "s1"] } })).state;
  assert.deepEqual(parsed.ui.pinnedSessionIds, ["s1"]);
  assert.deepEqual(parseState('{"projects":[],"sessions":[]}').state.closedSessions, []);
  assert.deepEqual(parseState('{"projects":[],"sessions":[]}').state.ui.pinnedSessionIds, []);
});

test("attention navigation wraps and skips working sessions", () => {
  const sessions = [session({ id: "a" }), session({ id: "b" }), session({ id: "c" })];
  const statuses = new Map<string, import("./model.ts").Status>([["a", "needs-you"], ["b", "working"], ["c", "done"]]);
  assert.equal(nextAttention(sessions, statuses, "a"), "c");
  assert.equal(nextAttention(sessions, statuses, "c"), "a");
  assert.equal(nextAttention(sessions, new Map()), undefined);
});

test("invalid editor leaves every setting unchanged; valid settings commit as a new object", () => {
  const before = { ...DEFAULT_SETTINGS };
  const current = { ...before };
  assert.equal(settingsDraft(current, { shell: "changed", claudeCommand: "changed" }, "missing editor"), "missing editor");
  assert.deepEqual(current, before);
  const draft = settingsDraft(current, { shell: "changed" }, { editorId: "code" });
  assert.equal(typeof draft, "object");
  if (typeof draft === "string") assert.fail(draft);
  assert.equal(draft.shell, "changed");
  assert.equal(draft.editorId, "code");
  assert.deepEqual(current, before);
});


test("Antigravity resumes only a validated conversation and survives state/history round trips", () => {
  const fresh = session({ provider: "antigravity", agentSessionId: undefined });
  assert.equal(agentCommand(fresh, DEFAULT_SETTINGS, "windows", true), "agy");
  assert.equal(agentCommand({ ...fresh, started: true, agentSessionId: "bad; command" }, DEFAULT_SETTINGS, "linux", true), "agy");
  const st = emptyState();
  st.projects = [{ id: "p1", name: "project", path: "/project" }];
  st.sessions = [{ ...fresh, agentSessionId: ID }];
  archiveSession(st, fresh.id);
  const loaded = parseState(JSON.stringify(st)).state;
  const restored = restoreSession(loaded, fresh.id)!;
  assert.equal(restored.provider, "antigravity");
  assert.equal(agentCommand(restored, { ...DEFAULT_SETTINGS, antigravityCommand: "agy --model custom" }, "linux", true),
    `agy --model custom --conversation ${ID}`);
  assert.equal(parseState('{"settings":{"claudeCommand":"custom"}}').state.settings.antigravityCommand, "agy");
});

test("Antigravity hooks distinguish questions, activity and background work", () => {
  const ev = { deskSessionId: "s1", provider: "antigravity" as const, event: "SessionStart" };
  assert.equal(statusAfter("starting", ev), "done");
  assert.equal(statusAfter("idle", { ...ev, event: "PreInvocation" }), "working");
  for (const toolName of ["ask_permission", "ask_question"]) {
    assert.equal(statusAfter("working", { ...ev, event: "PreToolUse", toolName }), "needs-you");
  }
  assert.equal(statusAfter("working", { ...ev, event: "PreToolUse", toolName: "run_command" }), "working");
  assert.equal(statusAfter("needs-you", { ...ev, event: "PostToolUse" }), "working");
  assert.equal(statusAfter("working", { ...ev, event: "Stop", fullyIdle: false }), "working");
  assert.equal(statusAfter("working", { ...ev, event: "Stop", fullyIdle: true }), "done");
  assert.equal(statusAfter("working", { ...ev, event: "PostInvocation" }), undefined);
});


test("overlapping launches in one directory remain ambiguous after one closes", async () => {
  const d = createDiscovery();
  d.add("a", "/project");
  d.add("b", "/project");
  d.add("c", "/other");
  d.delete("b");
  const visited: string[] = [];
  await d.run(async (id) => { visited.push(id); });
  assert.deepEqual(visited, ["c"]);
});

test("slow discovery cannot overlap or apply after removal, replacement, or a competing launch", async () => {
  for (const change of ["remove", "replace", "compete"] as const) {
    const d = createDiscovery();
    d.add("a", "/project");
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    let applied = false;
    const first = d.run(async (_, current) => { await wait; applied = current(); });
    await d.run(async () => { assert.fail("overlapping lookup"); });
    if (change === "remove") d.delete("a");
    if (change === "replace") d.add("a", "/project");
    if (change === "compete") d.add("b", "/project");
    release();
    await first;
    assert.equal(applied, false, change);
  }
});

test("lookup errors release the lock for a later retry", async () => {
  let now = 0;
  const d = createDiscovery(() => now);
  d.add("a", "/project");
  await assert.rejects(d.run(async () => { throw new Error("failed"); }));
  let applied = false;
  await d.run(async (_, current) => { applied = current(); });
  assert.equal(applied, false);
  now = 3000;
  await d.run(async (_, current) => { applied = current(); });
  assert.equal(applied, true);
});


test("fixed panel slots preserve holes, validate ids and never auto-fill", () => {
  const available = new Set(["a", "b", "c"]);
  assert.deepEqual(normalizePaneSlots(["a", null, "b", "c", "extra"], available), ["a", null, "b", "c", null]);
  assert.deepEqual(normalizePaneSlots(["a", "a", "missing", 123], available), ["a", null, null, null]);
  assert.deepEqual(normalizePaneSlots([], available), [null, null]);
  assert.deepEqual(assignPaneSlot(["a", null, "b"], 1, "c"), ["a", "c", "b"]);
  assert.deepEqual(assignPaneSlot(["a", null, "b"], 1, "b"), ["a", null, "b"]);
  assert.deepEqual(assignPaneSlot(["a", "b"], -1, "c"), ["a", "b"]);
});

test("panel assignments persist and old pins migrate without filling other sessions", () => {
  const state = emptyState();
  state.projects = [{ id: "p", name: "Test", path: "/test" }];
  state.sessions = ["a", "b", "c"].map(id => ({ id, projectId: "p", provider: "shell", title: id, createdAt: 1, lastUsedAt: 1 }));
  state.ui.paneSlots = ["a", null, "b"];
  assert.deepEqual(parseState(JSON.stringify(state)).state.ui.paneSlots, ["a", null, "b"]);
  const legacy = JSON.parse(JSON.stringify(state));
  delete legacy.ui.paneSlots;
  legacy.ui.pinnedSessionIds = ["b", "a"];
  legacy.ui.activeSessionId = "b";
  assert.deepEqual(parseState(JSON.stringify(legacy)).state.ui.paneSlots, ["b", "a"]);
  state.sessions = state.sessions.filter(s => s.id !== "a");
  assert.deepEqual(parseState(JSON.stringify(state)).state.ui.paneSlots, [null, null, "b"]);
});


test("five to eight grid panels fill two rows without overlap and retain resize preferences", () => {
  for (const count of [5, 6, 7, 8]) {
    const g = paneGeometry("grid", count);
    assert.equal(g.columns, Math.ceil(count / 2));
    assert.equal(g.rows, 2);
    const occupied = new Set<string>();
    for (const c of g.cells) {
      for (let x = c.column; x < c.column + c.span; x += 2) {
        const key = `${x}:${c.row}`;
        assert.ok(!occupied.has(key));
        occupied.add(key);
      }
    }
    assert.equal(occupied.size, g.columns * 2);
    assert.equal(g.cells.at(-1)!.span, count % 2 ? 3 : 1);
    const state = emptyState();
    state.ui.paneSizes[g.xKey] = Array.from({ length: g.columns }, () => 1 / g.columns);
    state.ui.paneSizes[`columns-${count}`] = resizePaneTracks(Array.from({ length: count }, () => 1 / count), 0, 0.1);
    const restored = parseState(JSON.stringify(state)).state.ui.paneSizes;
    assert.deepEqual(Object.keys(restored), Object.keys(state.ui.paneSizes));
    for (const [key, weights] of Object.entries(state.ui.paneSizes)) {
      assert.equal(restored[key].length, weights.length);
      weights.forEach((w, i) => assert.ok(Math.abs(restored[key][i] - w) < 1e-12));
    }
  }
  const ids = Array.from({length: 9}, (_, i) => String(i));
  assert.deepEqual(normalizePaneSlots(ids, new Set(ids)), ids.slice(0, 8));
  const state = emptyState();
  state.projects = [{id: "p", name: "P", path: "/test"}];
  state.sessions = ids.map(id => ({id, projectId: "p", title: id, provider: "shell", createdAt: 1, lastUsedAt: 1}));
  state.ui.paneSlots = ids.slice(0, 8);
  assert.deepEqual(parseState(JSON.stringify(state)).state.ui.paneSlots, ids.slice(0, 8));
});


test("discovery backs off misses, caps delay, resets on restart and removes completed lookups", async () => {
  let now = 0;
  const d = createDiscovery(() => now);
  d.add("a", "/a");
  let calls = 0;
  const miss = async () => { calls++; };
  for (const delay of [3000, 6000, 12000, 24000, 30000, 30000]) {
    await d.run(miss);
    const count = calls;
    now += delay - 1;
    await d.run(miss);
    assert.equal(calls, count);
    now++;
  }
  assert.equal(calls, 6);
  d.add("a", "/a");
  await d.run(miss);
  assert.equal(calls, 7, "restart bypasses old deadline");
  d.add("b", "/b");
  await d.run(async id => { assert.equal(id, "b"); d.delete(id); });
  now += 30000;
  await d.run(async id => { assert.equal(id, "a"); d.delete(id); });
  await d.run(async () => assert.fail("completed entries must be removed"));
});

test("a slow stale lookup cannot postpone a replacement session", async () => {
  const d = createDiscovery(() => 0);
  d.add("a", "/a");
  let release!: () => void;
  const first = d.run(async () => new Promise<void>(resolve => { release = resolve; }));
  d.add("a", "/a");
  release();
  await first;
  let calls = 0;
  await d.run(async () => { calls++; });
  assert.equal(calls, 1);
});

import { ACTION_DEFAULTS, bindingFor, bindingFromEvent, shortcutAction, shortcutConflict, parseShortcuts, validBinding } from './model.ts';

test('shortcuts preserve defaults, custom bindings and explicit disabling through persistence', () => {
  assert.equal(bindingFor('palette', {}), 'Mod+Shift+P');
  assert.equal(shortcutConflict(ACTION_DEFAULTS), undefined);
  const state = emptyState();
  state.settings.shortcuts = { switch: 'Mod+Shift+K', palette: '' };
  const loaded = parseState(JSON.stringify(state)).state;
  assert.deepEqual(loaded.settings.shortcuts, state.settings.shortcuts);
  assert.equal(bindingFor('palette', loaded.settings.shortcuts), '');
  assert.equal(bindingFor('grid', loaded.settings.shortcuts), 'Mod+G');
  assert.deepEqual(parseState('{"settings":{"shortcuts":null}}').state.settings.shortcuts, {});
  assert.deepEqual(parseShortcuts({ grid: 'Mod+K' }), {});
  assert.deepEqual(parseShortcuts({ palette: 'Mod+C', unknown: 'Mod+J' }), {});
  assert.deepEqual(parseShortcuts({ grid: 'Mod+K', switch: 'Mod+G' }), { switch: 'Mod+G', grid: 'Mod+K' });
});

test('shortcut dispatch handles Ctrl/Cmd, localized digits and protects terminal input', () => {
  const event = { key: 'k', code: 'KeyK', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false };
  assert.equal(shortcutAction(event, {}), 'switch');
  assert.equal(shortcutAction({ ...event, ctrlKey: false, metaKey: true }, {}), 'switch');
  assert.equal(shortcutAction(event, { switch: '' }), undefined);
  assert.equal(shortcutAction(event, { switch: 'Mod+J' }), undefined);
  assert.equal(shortcutAction({ ...event, key: 'j' }, { switch: 'Mod+J' }), 'switch');
  assert.equal(shortcutAction({ ...event, key: '+', code: 'Digit1' }, {}), 'session1');
  assert.equal(shortcutAction({ ...event, key: '1', code: 'Numpad1' }, {}), 'session1');
  for (const extra of [{ ctrlKey: false }, { isComposing: true }, { altKey: true }, { metaKey: true }, { getModifierState: () => true }])
    assert.equal(bindingFromEvent({ ...event, ...extra }), undefined);
  for (const key of ['c', 'v', 'x', 'w', 'q', 'z', 'Escape', 'Tab', 'Dead', 'Process'])
    assert.equal(bindingFromEvent({ ...event, key }), undefined);
  assert.equal(validBinding('Mod+Shift+F12'), true);
  assert.equal(validBinding('Mod+F13'), false);
  assert.equal(validBinding('Shift+K'), false);
});

import { normalizeFontSize } from './model.ts';
test('terminal font size migrates, persists and stays finite within bounds', () => {
  assert.equal(parseState('{}').state.settings.fontSize, 13);
  for (const [value, expected] of [[null, 13], ['18', 13], [7, 8], [99, 32], [16.6, 17], [18, 18]]) {
    assert.equal(parseState(JSON.stringify({ settings: { fontSize: value } })).state.settings.fontSize, expected);
  }
  assert.equal(normalizeFontSize(NaN), 13);
  assert.equal(normalizeFontSize(Infinity), 13);
  const state = emptyState(); state.settings.fontSize = 21;
  assert.equal(parseState(JSON.stringify(state)).state.settings.fontSize, 21);
});
test('font shortcuts support symbols, numpad and remapping without stealing localized session digits', () => {
  const e = { key: '+', code: 'Equal', ctrlKey: true, metaKey: false, altKey: false, shiftKey: true };
  for (const code of ['Equal', 'NumpadAdd', 'BracketRight'])
    assert.equal(shortcutAction({ ...e, code }, {}), 'fontIncrease');
  assert.equal(shortcutAction({ ...e, key: '=', shiftKey: false }, {}), 'fontIncrease');
  assert.equal(shortcutAction({ ...e, key: '-', code: 'Minus', shiftKey: false }, {}), 'fontDecrease');
  assert.equal(shortcutAction({ ...e, key: 'Subtract', code: 'NumpadSubtract' }, {}), 'fontDecrease');
  assert.equal(shortcutAction({ ...e, key: '0', code: 'Digit0', shiftKey: false }, {}), 'fontReset');
  assert.equal(shortcutAction({ ...e, code: 'Digit1', shiftKey: false }, {}), 'session1');
  assert.equal(shortcutAction(e, { fontIncrease: '' }), undefined);
  assert.equal(shortcutAction(e, { fontIncrease: 'Mod+J' }), undefined);
  assert.equal(shortcutAction({ ...e, altKey: true }, {}), undefined);
  assert.equal(validBinding('Mod+Shift+Plus'), false);
  assert.deepEqual(parseShortcuts({ palette: 'Mod+0' }), { palette: 'Mod+0', fontReset: '' });
});


test("background mode is opt-in and preserves only explicitly marked Claude sessions", () => {
  const state = emptyState();
  assert.equal(state.settings.claudeBackground, false);
  state.settings.claudeBackground = true;
  state.projects.push({ id: "p", name: "Test", path: "/test" });
  state.sessions.push(...["claude", "codex"].map((provider, i) => ({ id: String(i), projectId: "p", provider: provider as "claude" | "codex", title: provider, background: true, createdAt: 1, lastUsedAt: 1 })));
  const restored = parseState(JSON.stringify(state)).state;
  assert.equal(restored.settings.claudeBackground, true);
  assert.equal(restored.sessions[0].background, true);
  assert.equal(restored.sessions[1].background, false);
  assert.equal(importConversation(restored, "p", "claude", "11111111-1111-4111-8111-111111111111", "other", "new", 1, "0"), "invalid");
  delete state.sessions[0].background;
  assert.equal(parseState(JSON.stringify(state)).state.sessions[0].background, false);
});

test("background reconnect status does not claim unknown workers are done", () => {
  assert.equal(backgroundStatus("working"), "working");
  assert.equal(backgroundStatus("needs_input"), "needs-you");
  assert.equal(backgroundStatus("idle"), "done");
  assert.equal(backgroundStatus("completed"), "done");
  assert.equal(backgroundStatus("failed"), "agent-exited");
  assert.equal(backgroundStatus("future-state"), "untracked");
});


import { textFileFormat } from "./model.ts";
test("text editor preserves BOM and line endings without silently normalizing mixed files", () => {
  assert.deepEqual(textFileFormat("\uFEFFa\r\nb\r\n"), { bom: "\uFEFF", separator: "\r\n", text: "a\nb\n" });
  assert.deepEqual(textFileFormat("hello\n"), { bom: "", separator: "\n", text: "hello\n" });
  assert.equal(textFileFormat("a\r\nb\n"), undefined);
  assert.equal(textFileFormat("a\0"), undefined);
  assert.equal(textFileFormat("a\rb"), undefined);
});


test("editor preferences migrate independently of the external editor and survive reload", () => {
  const old = parseState(JSON.stringify({ settings: { editorId: "cursor" } })).state;
  assert.equal(old.settings.fileEditor, "builtin");
  assert.equal(old.settings.editorId, "cursor");
  assert.equal(old.settings.editorFontSize, 13);
  assert.equal(old.settings.editorWordWrap, false);
  Object.assign(old.settings, { fileEditor: "external", editorFontSize: 18, editorWordWrap: true });
  assert.deepEqual(parseState(JSON.stringify(old)).state.settings, old.settings);
  const invalid = parseState(JSON.stringify({ settings: { fileEditor: "unknown", editorFontSize: 999, editorWordWrap: "yes" } })).state.settings;
  assert.equal(invalid.fileEditor, "builtin");
  assert.equal(invalid.editorFontSize, 32);
  assert.equal(invalid.editorWordWrap, false);
});

test("file links use preferred editor with system-extension precedence", () => {
  const settings = emptyState().settings;
  assert.equal(fileOpenTarget("/project/main.ts", settings), "builtin");
  settings.fileEditor = "external";
  assert.equal(fileOpenTarget("/project/main.ts", settings), "external");
  assert.equal(fileOpenTarget("/project/photo.PNG", settings), "system");
  settings.systemOpenExts = "";
  assert.equal(fileOpenTarget("/project/photo.PNG", settings), "external");
});
