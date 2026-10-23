// Čistá doménová logika bez DOM a Tauri, aby sa dala testovať v Node.

export type Provider = "claude" | "codex" | "antigravity" | "shell";
export const PROVIDERS: Provider[] = ["claude", "codex", "antigravity", "shell"];
export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", shell: "Shell" };

export interface Project {
  id: string;
  name: string;
  path: string;
  collapsed?: boolean;
  /** Pripnuté projekty sú vždy hore. */
  pinned?: boolean;
}

/** Text, ktorý sa vloží do terminálu ako prompt. Bez `projectId` platí pre všetky projekty. */
export interface PromptTemplate {
  id: string;
  name: string;
  text: string;
  /** Po vložení hneď odoslať (Enter). */
  send: boolean;
  projectId?: string;
}

export interface Session {
  id: string;
  projectId: string;
  provider: Provider;
  title: string;
  /** ID konverzácie agenta. Claude: zadáme ho cez `--session-id`, hooky ho môžu zmeniť (napr. po /clear).
   *  Codex: dohľadá sa z jeho session súborov po spustení. */
  agentSessionId?: string;
  /** Kedy sa naposledy spustil terminál (pre dohľadanie Codex konverzácie). */
  lastStartAt?: number;
  /** Claude už dostal aspoň jeden prompt, takže `--resume` má čo obnoviť. */
  hasConversation?: boolean;
  /** Proces už niekedy bežal (pre Codex: ponúknuť `codex resume` namiesto nového štartu). */
  started?: boolean;
  stopped?: boolean;
  exitCode?: number | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface Settings {
  defaultProvider: Provider;
  claudeCommand: string;
  antigravityCommand: string;
  codexCommand: string;
  codexResumeCommand: string;
  shell: string;
  /** Jazyk UI: "en" | "sk" | "cs". */
  language: string;
  /** ID nájdeného editora, "" = prvý nájdený, "custom" = vlastný program. */
  editorId: string;
  customEditorPath: string;
  /** Argumenty vlastného editora; `%TARGET_PATH%` = súbor alebo priečinok, `%LINE%` = riadok. */
  customEditorArgs: string;
  notifications: boolean;
  /** Po spustení aplikácie hneď obnoviť všetky relácie (Claude/Codex pokračujú v tej istej konverzácii). */
  autoResume: boolean;
  /** Prípony, ktoré Ctrl+klik otvorí v predvolenej aplikácii systému namiesto editora. */
  systemOpenExts: string;
}

/** Nainštalovaný editor z backendu (`list_editors`). */
export interface EditorInfo {
  id: string;
  label: string;
  path: string;
}

export const CUSTOM_EDITOR = "custom";

/** ID editorov z backendu; starý `editorCommand` (napr. "cursor") sa na ne mapuje 1:1. */
const KNOWN_EDITORS = new Set(
  "cursor code code-insiders windsurf codium trae zed subl idea webstorm phpstorm pycharm rider goland rustrover clion notepad++".split(" "),
);

/** Starý príkaz editora → ID. Neznámy príkaz (vlastný) → "" = prvý nájdený editor. */
export function migrateEditorCommand(command: string): string {
  const c = command.trim().toLowerCase();
  return KNOWN_EDITORS.has(c) ? c : "";
}

/** Verzia predvolených nastavení; pri zvýšení sa staré predvolené hodnoty nahradia novými. */
export const SETTINGS_REV = 2;

export interface PersistedState {
  notifications: AttentionEvent[];
  version: 1;
  projects: Project[];
  sessions: Session[];
  templates: PromptTemplate[];
  closedSessions: Session[];
  settings: Settings;
  settingsRev: number;
  ui: { sidebarWidth: number; grid: boolean; paneLayout: PaneLayout; paneSizes: Record<string, number[]>; pinnedSessionIds: string[]; activeSessionId?: string };
}

export const DEFAULT_SETTINGS: Settings = {
  defaultProvider: "claude",
  claudeCommand: "claude --dangerously-skip-permissions",
  codexCommand: "codex --dangerously-bypass-approvals-and-sandbox",
  codexResumeCommand: "codex resume --dangerously-bypass-approvals-and-sandbox",
  antigravityCommand: "agy",
  shell: "",
  language: "en",
  editorId: "",
  customEditorPath: "",
  customEditorArgs: "%TARGET_PATH%",
  notifications: true,
  autoResume: true,
  systemOpenExts: "html htm pdf png jpg jpeg gif webp svg",
};

/** Predvolené hodnoty z rev 1; ak ich používateľ nezmenil, prejdú na nové. */
const REV1_DEFAULTS: Partial<Settings> = { codexCommand: "codex", codexResumeCommand: "codex resume" };

export function emptyState(): PersistedState {
  return {
    notifications: [],
    version: 1,
    projects: [],
    sessions: [],
    templates: [],
    closedSessions: [],
    settings: { ...DEFAULT_SETTINGS },
    settingsRev: SETTINGS_REV,
    ui: { sidebarWidth: 280, grid: false, paneLayout: "grid", paneSizes: {}, pinnedSessionIds: [] },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Načíta uložený stav; poškodené záznamy zahodí namiesto pádu celej aplikácie. */
export function parseState(raw: string | null | undefined): { state: PersistedState; dropped: number } {
  const state = emptyState();
  let dropped = 0;
  if (!raw) return { state, dropped };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state, dropped: 1 };
  }
  if (!isObj(data)) return { state, dropped: 1 };

  for (const p of Array.isArray(data.projects) ? data.projects : []) {
    if (isObj(p) && str(p.id) && str(p.name) && str(p.path)) {
      state.projects.push({ id: p.id, name: p.name, path: p.path, collapsed: p.collapsed === true, pinned: p.pinned === true });
    } else dropped++;
  }
  const projectIds = new Set(state.projects.map((p) => p.id));
  for (const t of Array.isArray(data.templates) ? data.templates : []) {
    if (isObj(t) && str(t.id) && str(t.name) && typeof t.text === "string" && (t.projectId === undefined || projectIds.has(t.projectId as string))) {
      state.templates.push({
        id: t.id,
        name: t.name,
        text: t.text,
        send: t.send === true,
        projectId: str(t.projectId) ? t.projectId : undefined,
      });
    } else dropped++;
  }
  for (const s of Array.isArray(data.sessions) ? data.sessions : []) {
    if (
      isObj(s) &&
      str(s.id) &&
      str(s.projectId) &&
      projectIds.has(s.projectId) &&
      PROVIDERS.includes(s.provider as Provider) &&
      typeof s.title === "string"
    ) {
      state.sessions.push({
        id: s.id,
        projectId: s.projectId,
        provider: s.provider as Provider,
        title: s.title,
        agentSessionId: isUuid(s.agentSessionId) ? s.agentSessionId : undefined,
        hasConversation: s.hasConversation === true,
        started: s.started === true,
        stopped: s.stopped === true,
        exitCode: typeof s.exitCode === "number" && Number.isInteger(s.exitCode) ? s.exitCode : undefined,
        lastStartAt: typeof s.lastStartAt === "number" ? s.lastStartAt : undefined,
        createdAt: num(s.createdAt, Date.now()),
        lastUsedAt: num(s.lastUsedAt, Date.now()),
      });
    } else dropped++;
  }
  if (Array.isArray(data.closedSessions)) {
    const archived = parseState(JSON.stringify({ projects: state.projects, sessions: data.closedSessions }));
    const activeIds = new Set(state.sessions.map((s) => s.id));
    state.closedSessions = archived.state.sessions.filter((s) => !activeIds.has(s.id)).slice(0, 20);
    dropped += archived.dropped;
  }
  const notificationIds = new Set<string>();
  for (const n of Array.isArray(data.notifications) ? data.notifications : []) {
    if (!isObj(n) || !str(n.id) || notificationIds.has(n.id) || !str(n.sessionId)
      || typeof n.sessionTitle !== "string" || typeof n.projectName !== "string"
      || !PROVIDERS.includes(n.provider as Provider) || n.provider === "shell"
      || (n.kind !== "done" && n.kind !== "needs-you")
      || typeof n.at !== "number" || !Number.isFinite(n.at) || n.at < 0 || n.at > 8_640_000_000_000_000) { dropped++; continue; }
    notificationIds.add(n.id);
    state.notifications.push({ id: n.id, sessionId: n.sessionId, sessionTitle: n.sessionTitle.slice(0, 300),
      projectName: n.projectName.slice(0, 300), provider: n.provider as Provider,
      kind: n.kind, at: n.at, read: n.read === true });
  }
  state.notifications.sort((a, b) => b.at - a.at);
  state.notifications = state.notifications.slice(0, ATTENTION_HISTORY_LIMIT);
  if (isObj(data.settings)) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = data.settings[key];
      if (typeof v === typeof DEFAULT_SETTINGS[key]) (state.settings as unknown as Record<string, unknown>)[key] = v;
    }
    if (!PROVIDERS.includes(state.settings.defaultProvider)) state.settings.defaultProvider = DEFAULT_SETTINGS.defaultProvider;
    if (!["en", "sk", "cs"].includes(state.settings.language)) state.settings.language = DEFAULT_SETTINGS.language;
    if (typeof data.settings.editorId !== "string" && typeof data.settings.editorCommand === "string") {
      state.settings.editorId = migrateEditorCommand(data.settings.editorCommand);
    }
    const rev = num(data.settingsRev, 1);
    if (rev < 2) {
      for (const [key, old] of Object.entries(REV1_DEFAULTS) as [keyof Settings, string][]) {
        if (state.settings[key] === old) (state.settings as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
      }
    }
  }
  if (isObj(data.ui)) {
    state.ui.sidebarWidth = clampSidebar(num(data.ui.sidebarWidth, 280));
    state.ui.grid = data.ui.grid === true;
    if (["grid", "columns", "rows"].includes(data.ui.paneLayout as string)) state.ui.paneLayout = data.ui.paneLayout as PaneLayout;
    if (isObj(data.ui.paneSizes)) {
      for (const [key, value] of Object.entries(data.ui.paneSizes)) {
        if (/^(columns|rows)-[234]$|^grid-[xy]$/.test(key)) {
          const count = key.startsWith("grid") ? 2 : Number(key.at(-1));
          state.ui.paneSizes[key] = paneWeights(value, count);
        }
      }
    }
    if (Array.isArray(data.ui.pinnedSessionIds)) {
      state.ui.pinnedSessionIds = [...new Set(data.ui.pinnedSessionIds.filter((id): id is string =>
        typeof id === "string" && state.sessions.some((s) => s.id === id)))].slice(0, 4);
    }
    if (str(data.ui.activeSessionId)) state.ui.activeSessionId = data.ui.activeSessionId;
  }
  return { state, dropped };
}

export const clampSidebar = (w: number) => Math.min(640, Math.max(180, Math.round(w)));

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isUuid(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

export type Platform = "windows" | "macos" | "linux" | string;

/** Odkaz na env premennú v syntaxe shellu, aby sa cesta nevkladala do príkazu ako text. */
function envRef(platform: Platform, name: string): string {
  return platform === "windows" ? `"$env:${name}"` : `"$${name}"`;
}

/**
 * Príkaz, ktorý shell spustí pri štarte relácie. Do príkazu ide iba text z nastavení,
 * overené UUID a odkaz na env premennú. Názov projektu ani úlohy nikdy.
 */
export function agentCommand(
  s: Session,
  settings: Settings,
  platform: Platform,
  hooksEnabled: boolean,
): string | undefined {
  if (s.provider === "shell") return undefined;
  if (s.provider === "antigravity") {
    const base = settings.antigravityCommand.trim() || "agy";
    return isUuid(s.agentSessionId) ? `${base} --conversation ${s.agentSessionId}` : base;
  }
  if (s.provider === "codex") {
    if (!s.started) return settings.codexCommand.trim() || "codex";
    const resume = settings.codexResumeCommand.trim() || "codex resume";
    // So známym ID sa otvorí presne tá konverzácia, inak Codex ukáže výber.
    return isUuid(s.agentSessionId) ? `${resume} ${s.agentSessionId}` : resume;
  }
  const base = settings.claudeCommand.trim() || "claude";
  const parts = [base];
  const id = s.agentSessionId;
  if (isUuid(id)) parts.push(s.hasConversation ? `--resume ${id}` : `--session-id ${id}`);
  if (hooksEnabled) parts.push(`--settings ${envRef(platform, "PROJECT_DESK_HOOK_SETTINGS")}`);
  return parts.join(" ");
}

export type Status =
  | "exited"
  | "sleeping"
  | "starting"
  | "untracked"
  | "running"
  | "idle"
  | "working"
  | "needs-you"
  | "done"
  | "agent-exited";

/** Spawning the shell must not overwrite an agent event received during IPC. */
export function statusAfterSpawn(prev: Status, s: Pick<Session, "provider" | "started" | "agentSessionId">, hooksEnabled: boolean): Status {
  if (prev !== "starting") return prev;
  if (s.provider === "shell") return "running";
  if (s.provider === "codex") return s.started && !isUuid(s.agentSessionId) ? "untracked" : "starting";
  return hooksEnabled ? "starting" : "untracked";
}

/** A missing readiness event is not proof that the agent finished or is working. */
export function statusAfterStartupTimeout(prev: Status): Status {
  return prev === "starting" ? "untracked" : prev;
}

export interface AgentEvent {
  deskSessionId: string;
  agentSessionId?: string | null;
  event: string;
  notificationType?: string | null;
  provider?: "claude" | "antigravity";
  toolName?: string | null;
  fullyIdle?: boolean | null;
}

export interface SessionObservation {
  event: string;
  receivedAt: number;
  snapshot: boolean;
}

/** Snapshot timestamps describe when Desk read the file, not when the event happened. */
export function observeSession(previous: SessionObservation | undefined, event: string, snapshot: boolean, now: number): SessionObservation {
  if (snapshot && previous?.event === event) return previous;
  return { event, snapshot, receivedAt: now };
}

export function sessionDiagnostics(s: Pick<Session, "provider" | "agentSessionId">, running: boolean, hooksEnabled: boolean, observation?: SessionObservation) {
  const linked = isUuid(s.agentSessionId);
  const method = s.provider === "shell" ? "none" : s.provider === "codex" ? "file" : "hooks";
  const reason = !running ? "stopped" : method === "none" ? "shell"
    : method === "hooks" && !hooksEnabled ? "hooksUnavailable"
    : s.provider === "codex" && !linked ? "missingId"
    : !observation ? (method === "file" ? "awaitingFile" : "awaitingHook") : "receiving";
  return { linked, method, reason } as const;
}

const NEEDS_INPUT = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

/** Nový stav relácie po udalosti z Claude hooku. `undefined` = udalosť stav nemení. */
export function statusAfter(prev: Status, ev: AgentEvent): Status | undefined {
  switch (ev.event) {
    case "SessionStart":
      return "done";
    case "PreInvocation":
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "PreToolUse":
      return ev.toolName === "ask_permission" || ev.toolName === "ask_question" ? "needs-you" : "working";
    case "Stop":
      return ev.provider === "antigravity" && ev.fullyIdle === false ? "working" : "done";
    case "SessionEnd":
      return "agent-exited";
    case "Notification":
      if (ev.notificationType && NEEDS_INPUT.has(ev.notificationType)) return "needs-you";
      if (ev.notificationType === "idle_prompt" && ["working", "starting", "untracked", "idle"].includes(prev)) return "done";
      return undefined;
    default:
      return undefined;
  }
}

/** Stavy, pri ktorých má zmysel upozorniť, ak sa používateľ práve nepozerá. */
export const ATTENTION: ReadonlySet<Status> = new Set<Status>(["needs-you", "done"]);

export interface AttentionEvent {
  id: string;
  sessionId: string;
  sessionTitle: string;
  projectName: string;
  provider: Provider;
  kind: "done" | "needs-you";
  at: number;
  read: boolean;
}
export const ATTENTION_HISTORY_LIMIT = 100;

/** Readiness and restored snapshots are not new work completions. */
export function attentionEventKind(previous: Status, next: Status, silent: boolean): AttentionEvent["kind"] | undefined {
  if (silent || previous === next) return;
  if (next === "needs-you") return next;
  if (next === "done" && (previous === "working" || previous === "needs-you")) return next;
}

export function recordAttention(state: PersistedState, s: Session, kind: AttentionEvent["kind"], id: string, at: number, read: boolean) {
  if (s.provider === "shell") return;
  state.notifications.unshift({ id, sessionId: s.id, sessionTitle: s.title.slice(0, 300),
    projectName: (state.projects.find(p => p.id === s.projectId)?.name ?? "").slice(0, 300),
    provider: s.provider, kind, at, read });
  state.notifications = state.notifications.slice(0, ATTENTION_HISTORY_LIMIT);
}

export function readAttention(state: PersistedState, sessionId?: string): boolean {
  let changed = false;
  for (const n of state.notifications) {
    if (!n.read && (sessionId === undefined || n.sessionId === sessionId)) { n.read = true; changed = true; }
  }
  return changed;
}

/** Stav podľa udalosti zo session súboru Codexu. */
export function codexStatusAfter(event: string): Status | undefined {
  if (event === "task_started" || event === "turn_started") return "working";
  if (event === "task_complete" || event === "turn_complete") return "done";
  if (event === "turn_aborted") return "done";
  return undefined;
}

/** Poradie v zozname: pripnuté hore, inak tak, ako ich používateľ usporiadal. */
export function orderedProjects(projects: Project[]): Project[] {
  return [...projects.filter((p) => p.pinned), ...projects.filter((p) => !p.pinned)];
}

/** Presunie projekt pred alebo za cieľový. Pri presune medzi pripnuté/nepripnuté prevezme stav cieľa. */
export function moveProject(projects: Project[], fromId: string, toId: string, after: boolean): Project[] {
  const from = projects.find((p) => p.id === fromId);
  const to = projects.find((p) => p.id === toId);
  if (!from || !to || from === to) return projects;
  const rest = projects.filter((p) => p !== from);
  const moved = { ...from, pinned: to.pinned };
  rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, moved);
  return rest;
}

/** Šablóny pre projekt: najprv jeho vlastné, potom spoločné. */
export function templatesFor(templates: PromptTemplate[], projectId: string | undefined): PromptTemplate[] {
  const byName = (a: PromptTemplate, b: PromptTemplate) => a.name.localeCompare(b.name, "sk");
  return [
    ...templates.filter((t) => t.projectId && t.projectId === projectId).sort(byName),
    ...templates.filter((t) => !t.projectId).sort(byName),
  ];
}

/** Text pripravený na vloženie do terminálu ako jeden celok (bracketed paste). */
export function pasteSequence(text: string): string {
  // Ukončovacia sekvencia v texte by paste predčasne ukončila a zvyšok by sa vykonal ako príkaz.
  const clean = text.replace(/\x1b\[20[01]~/g, "").replace(/\r?\n/g, "\r");
  return `\x1b[200~${clean}\x1b[201~`;
}

export interface FileRef {
  /** Index začiatku v riadku (od 0). */
  index: number;
  length: number;
  path: string;
  line?: number;
}

const FILE_RE = /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+-]+[\\/])*[\w@+-][\w.@+-]*\.[A-Za-z][A-Za-z0-9]{0,7}(?::(\d+)(?::\d+)?|\((\d+)(?:,\d+)?\))?/g;

/** Kandidáti na cesty k súborom v riadku terminálu (napr. `src/main.ts:120`). Existenciu overí backend. */
export function findFileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  for (const m of text.matchAll(FILE_RE)) {
    const index = m.index ?? 0;
    // Časť URL nechávame na odkazy z webu.
    if (/[\w-]:\/{0,2}\S*$/.test(text.slice(0, index)) || /^\/\//.test(m[0])) continue;
    const suffix = m[1] ?? m[2];
    const path = suffix ? m[0].slice(0, m[0].search(/[:(]\d+[\d:,)]*$/)) : m[0];
    out.push({ index, length: m[0].length, path, line: suffix ? Number(suffix) : undefined });
  }
  return out;
}

export interface AgentStats {
  model?: string | null;
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  contextTokens?: number | null;
  contextWindow?: number | null;
  limitUsedPercent?: number | null;
  limitWindowMinutes?: number | null;
}

/** 1234 → „1,2k“, 1234567 → „1,2M“. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const [v, unit] = n < 1_000_000 ? [n / 1000, "k"] : [n / 1_000_000, "M"];
  return `${v < 10 ? v.toFixed(1).replace(".", ",") : Math.round(v)}${unit}`;
}

export function sessionsOf(state: PersistedState, projectId: string): Session[] {
  return state.sessions.filter((s) => s.projectId === projectId).sort((a, b) => a.createdAt - b.createdAt);
}

/** Relácia pre Ctrl+1–8 v poradí zoznamu (aj zo zbalených projektov); Ctrl+9 je vždy posledná. */
export function sessionByNumber(state: PersistedState, n: number): Session | undefined {
  const all = orderedProjects(state.projects).flatMap((p) => sessionsOf(state, p.id));
  return n === 9 ? all.at(-1) : all[n - 1];
}

/** Poradie pre Quick Switch: naposledy použité hore. */
export function byRecent(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

export function matches(s: Session, project: Project | undefined, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = `${s.title} ${project?.name ?? ""} ${PROVIDER_LABEL[s.provider]}`.toLowerCase();
  return q.split(/\s+/).every((part) => hay.includes(part));
}

export function folderName(path: string): string {
  const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** "html, .PDF  svg" → {"html", "pdf", "svg"} */
export function parseExtensions(list: string): Set<string> {
  return new Set(
    list
      .toLowerCase()
      .split(/[\s,;]+/)
      .map((e) => e.replace(/^\.+/, ""))
      .filter(Boolean),
  );
}

/** Má Ctrl+klik otvoriť súbor v predvolenej aplikácii? Spustiteľné súbory backend aj tak odmietne. */
export function opensInSystem(path: string, list: string): boolean {
  const name = path.split(/[\\/]/).pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && parseExtensions(list).has(name.slice(dot + 1).toLowerCase());
}

/** Cesta k súboru relatívne k priečinku projektu, alebo undefined, ak je mimo neho. */
export function relativePath(root: string, file: string): string | undefined {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const r = norm(root);
  const f = norm(file);
  if (f.length <= r.length + 1 || f[r.length] !== "/" || f.slice(0, r.length).toLowerCase() !== r.toLowerCase()) return undefined;
  return f.slice(r.length + 1);
}

/** Close explicitly, retaining only metadata for the last 20 closed sessions. */
export function archiveSession(state: PersistedState, id: string): void {
  const s = state.sessions.find((s) => s.id === id);
  if (!s) return;
  state.closedSessions = [{ ...s, stopped: true }, ...state.closedSessions.filter((x) => x.id !== id)].slice(0, 20);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  state.ui.pinnedSessionIds = state.ui.pinnedSessionIds.filter((x) => x !== id);
  if (state.ui.activeSessionId === id) state.ui.activeSessionId = byRecent(state.sessions)[0]?.id;
}

export function restoreSession(state: PersistedState, id: string): Session | undefined {
  const s = state.closedSessions.find((s) => s.id === id);
  if (!s || !state.projects.some((p) => p.id === s.projectId) || state.sessions.some((x) => x.id === id)) return;
  state.closedSessions = state.closedSessions.filter((s) => s.id !== id);
  state.sessions.push(s);
  return s;
}

export function recordSessionExit(state: PersistedState, id: string, code: number | null, closing: boolean): void {
  if (closing) { archiveSession(state, id); return; }
  const s = state.sessions.find((s) => s.id === id);
  if (s) { s.stopped = true; s.exitCode = code; }
}

/** Focus never reorders visible panels. A newly selected session replaces one unpinned slot. */
export function gridSessions(sessions: Session[], available: ReadonlySet<string>, pins: string[], active?: string, previous: string[] = []): string[] {
  const pinned = [...new Set(pins)].filter((id) => available.has(id)).slice(0, 4);
  const recent = byRecent(sessions).map((s) => s.id).filter((id) => available.has(id) && !pinned.includes(id));
  if (active && recent.includes(active)) recent.splice(0, 0, ...recent.splice(recent.indexOf(active), 1));
  const capacity = 4 - pinned.length;
  const stable = [...new Set(previous)].filter(id => recent.includes(id)).slice(0, capacity);
  if (capacity && active && recent.includes(active) && !stable.includes(active)) {
    if (stable.length === capacity) stable[capacity - 1] = active;
    else stable.push(active);
  }
  return [...pinned, ...stable, ...recent.filter(id => !stable.includes(id))].slice(0, 4);
}

export type PaneLayout = "grid" | "columns" | "rows";

/** Normalized tracks, with a minimum 10% share so a pane cannot disappear. */
export function paneWeights(value: unknown, count: number): number[] {
  const equal = () => Array.from({ length: count }, () => 1 / count);
  if (!Array.isArray(value) || value.length !== count || value.some(v => typeof v !== "number" || !Number.isFinite(v) || v <= 0)) return equal();
  const sum = value.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum)) return equal();
  const normalized = value.map(v => v / sum);
  return normalized.some(v => v < 0.099999) ? equal() : normalized;
}

/** Moving a boundary changes only its adjacent tracks. Position is a fraction of usable space. */
export function resizePaneTracks(weights: number[], boundary: number, position: number): number[] {
  if (boundary < 0 || boundary >= weights.length - 1 || !Number.isFinite(position)) return weights;
  const next = [...weights];
  const before = weights.slice(0, boundary).reduce((a, b) => a + b, 0);
  const pair = weights[boundary] + weights[boundary + 1];
  next[boundary] = Math.max(0.1, Math.min(pair - 0.1, position - before));
  next[boundary + 1] = pair - next[boundary];
  return next;
}

export function paneGeometry(mode: PaneLayout, count: number) {
  const columns = mode === "columns" ? count : mode === "rows" ? 1 : Math.min(2, count);
  const rows = mode === "rows" ? count : mode === "columns" ? 1 : Math.ceil(count / 2);
  return {
    columns, rows,
    xKey: mode === "grid" ? "grid-x" : `${mode}-${count}`,
    yKey: mode === "grid" ? "grid-y" : `${mode}-${count}`,
    cells: Array.from({ length: count }, (_, i) => ({
      column: (i % columns) * 2 + 1,
      row: Math.floor(i / columns) * 2 + 1,
      span: mode === "grid" && count === 3 && i === 2 ? 3 : 1,
    })),
  };
}

export function nextAttention(sessions: Session[], statuses: ReadonlyMap<string, Status>, active?: string): string | undefined {
  const ids = sessions.filter((s) => ATTENTION.has(statuses.get(s.id) ?? "sleeping")).map((s) => s.id);
  return ids.length ? ids[(ids.indexOf(active ?? "") + 1) % ids.length] : undefined;
}

/** Validate before constructing new settings; callers commit only successful results. */
export function settingsDraft(current: Settings, changes: Partial<Settings>, editor: Partial<Settings> | string): Settings | string {
  return typeof editor === "string" ? editor : { ...current, ...changes, ...editor };
}

/** Serialize discovery and invalidate results when a launch is replaced or removed. */
export function createDiscovery() {
  const entries = new Map<string, { path: string; ambiguous: boolean }>();
  let busy = false;
  return {
    add(id: string, path: string) {
      const entry = { path, ambiguous: false };
      for (const [otherId, other] of entries) {
        if (otherId !== id && other.path === path) other.ambiguous = entry.ambiguous = true;
      }
      entries.set(id, entry);
    },
    delete(id: string) { entries.delete(id); },
    async run(lookup: (id: string, current: () => boolean) => Promise<void>) {
      if (busy) return;
      busy = true;
      try {
        for (const [id, entry] of [...entries]) {
          const current = () => entries.get(id) === entry && !entry.ambiguous;
          if (current()) await lookup(id, current);
        }
      } finally { busy = false; }
    },
  };
}
