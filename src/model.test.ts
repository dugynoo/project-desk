import { test } from "node:test";
import assert from "node:assert/strict";
import {
  agentCommand,
  codexStatusAfter,
  findFileRefs,
  formatTokens,
  moveProject,
  orderedProjects,
  pasteSequence,
  templatesFor,
  DEFAULT_SETTINGS,
  folderName,
  matches,
  parseState,
  sessionByNumber,
  statusAfter,
  type Session,
} from "./model.ts";

const ID = "0b8c5a8e-4f3c-4d2a-9b8e-1c2d3e4f5a6b";
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
