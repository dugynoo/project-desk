// Čistá doménová logika bez DOM a Tauri, aby sa dala testovať v Node.

export type Provider = "claude" | "codex" | "antigravity" | "shell";
export const PROVIDERS: Provider[] = ["claude", "codex", "antigravity", "shell"];
export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex", antigravity: "Antigravity", shell: "Shell" };

/** Import stays stopped until explicitly launched. Linking never restarts a process. */
export function importConversation(state: PersistedState, projectId: string, provider: Provider, agentId: string,
  title: string, id: string, now: number, targetId?: string): Session | "invalid" | "duplicate" {
  const normalized = agentId.trim().toLowerCase();
  const target = targetId ? state.sessions.find(s => s.id === targetId) : undefined;
  if (provider === "shell" || !isUuid(normalized) || !state.projects.some(p => p.id === projectId)
    || target?.background
    || (targetId && (!target || target.projectId !== projectId || target.provider !== provider))) return "invalid";
  if (state.sessions.some(s => s.id !== targetId && s.provider === provider && s.agentSessionId?.toLowerCase() === normalized)) return "duplicate";
  const s: Session = target ?? { id, projectId, provider, title: title.trim().slice(0, 300) || `${PROVIDER_LABEL[provider]} ${normalized.slice(0, 8)}`,
    createdAt: now, lastUsedAt: now, stopped: true };
  s.agentSessionId = normalized;
  s.started = true;
  s.hasConversation = true;
  if (!target) state.sessions.push(s);
  state.closedSessions = state.closedSessions.filter(old => old.provider !== provider || old.agentSessionId?.toLowerCase() !== normalized);
  return s;
}

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
  /** Native worker ownership survives attachment/app exit. Only set for new sessions. */
  background?: boolean;
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
  /** Windows ended the process during shutdown; eligible for configured auto-resume. */
  resumeAfterShutdown?: boolean;
  /** The agent was working when the app closed; cleared once it works again. */
  interrupted?: boolean;
  /** Skrytá v sidebare; proces beží ďalej a vráti sa, keď na teba čaká. */
  hidden?: boolean;
  exitCode?: number | null;
  createdAt: number;
  lastUsedAt: number;
}

export interface Settings {
  claudeBackground: boolean;
  showGitBranch: boolean;
  fontSize: number;
  shortcuts: Partial<Record<ActionId, string>>;
  defaultProvider: Provider;
  claudeCommand: string;
  antigravityCommand: string;
  codexCommand: string;
  codexResumeCommand: string;
  shell: string;
  /** Jazyk UI: "en" | "sk" | "cs". */
  language: string;
  /** ID nájdeného editora, "" = prvý nájdený, "custom" = vlastný program. */
  fileEditor: "builtin" | "external";
  /** Ako vstavaný editor otvorí Markdown z odkazu v termináli. */
  markdownOpen: "preview" | "edit";
  editorFontSize: number;
  editorWordWrap: boolean;
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
export const SETTINGS_REV = 3;

export interface PersistedState {
  savedLayouts: SavedLayout[];
  notifications: AttentionEvent[];
  version: 1;
  projects: Project[];
  sessions: Session[];
  templates: PromptTemplate[];
  closedSessions: Session[];
  settings: Settings;
  settingsRev: number;
  ui: { sidebarWidth: number; sidebarAutoHide?: boolean; grid: boolean; paneLayout: PaneLayout; paneSlots: (string | null)[]; paneSizes: Record<string, number[]>; pinnedSessionIds: string[]; activeSessionId?: string };
}

export const DEFAULT_SETTINGS: Settings = {
  claudeBackground: false,
  showGitBranch: false,
  fontSize: 13,
  shortcuts: {},
  defaultProvider: "claude",
  claudeCommand: "claude --dangerously-skip-permissions",
  // Without the shared Codex daemon the conversation belongs to this terminal's process tree,
  // so restarting Project Desk does not leave it "open in another app".
  codexCommand: "codex --dangerously-bypass-approvals-and-sandbox --no-daemon",
  codexResumeCommand: "codex resume --dangerously-bypass-approvals-and-sandbox --no-daemon",
  antigravityCommand: "agy",
  shell: "",
  language: "en",
  fileEditor: "builtin",
  markdownOpen: "preview",
  editorFontSize: 13,
  editorWordWrap: false,
  editorId: "",
  customEditorPath: "",
  customEditorArgs: "%TARGET_PATH%",
  notifications: true,
  autoResume: true,
  systemOpenExts: "html htm pdf png jpg jpeg gif webp svg",
};

/** Predvolené hodnoty z rev 1; ak ich používateľ nezmenil, prejdú na nové. */
const REV1_DEFAULTS: Partial<Settings> = { codexCommand: "codex", codexResumeCommand: "codex resume" };
const REV2_DEFAULTS: Partial<Settings> = {
  codexCommand: "codex --dangerously-bypass-approvals-and-sandbox",
  codexResumeCommand: "codex resume --dangerously-bypass-approvals-and-sandbox",
};

export function emptyState(): PersistedState {
  return {
    savedLayouts: [],
    notifications: [],
    version: 1,
    projects: [],
    sessions: [],
    templates: [],
    closedSessions: [],
    settings: { ...DEFAULT_SETTINGS },
    settingsRev: SETTINGS_REV,
    ui: { sidebarWidth: 280, grid: false, paneLayout: "grid", paneSlots: [null, null], paneSizes: {}, pinnedSessionIds: [] },
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
        background: s.provider === "claude" && s.background === true,
        agentSessionId: isUuid(s.agentSessionId) ? s.agentSessionId : undefined,
        hasConversation: s.hasConversation === true,
        started: s.started === true,
        stopped: s.stopped === true,
        resumeAfterShutdown: s.stopped === true && s.resumeAfterShutdown === true,
        interrupted: s.interrupted === true,
        hidden: s.hidden === true,
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
      if (key === "shortcuts") continue;
      const v = data.settings[key];
      if (typeof v === typeof DEFAULT_SETTINGS[key]) (state.settings as unknown as Record<string, unknown>)[key] = v;
    }
    state.settings.editorFontSize = normalizeFontSize(data.settings.editorFontSize);
    if (!["builtin", "external"].includes(state.settings.fileEditor)) state.settings.fileEditor = "builtin";
    if (!["preview", "edit"].includes(state.settings.markdownOpen)) state.settings.markdownOpen = DEFAULT_SETTINGS.markdownOpen;
    state.settings.fontSize = normalizeFontSize(data.settings.fontSize);
    state.settings.shortcuts = parseShortcuts(data.settings.shortcuts);
    if (!PROVIDERS.includes(state.settings.defaultProvider)) state.settings.defaultProvider = DEFAULT_SETTINGS.defaultProvider;
    if (!["en", "sk", "cs"].includes(state.settings.language)) state.settings.language = DEFAULT_SETTINGS.language;
    if (typeof data.settings.editorId !== "string" && typeof data.settings.editorCommand === "string") {
      state.settings.editorId = migrateEditorCommand(data.settings.editorCommand);
    }
    const rev = num(data.settingsRev, 1);
    for (const [since, defaults] of [[2, REV1_DEFAULTS], [3, REV2_DEFAULTS]] as const) {
      if (rev >= since) continue;
      for (const [key, old] of Object.entries(defaults) as [keyof Settings, string][]) {
        if (state.settings[key] === old) (state.settings as unknown as Record<string, unknown>)[key] = DEFAULT_SETTINGS[key];
      }
    }
  }
  if (isObj(data.ui)) {
    state.ui.sidebarWidth = clampSidebar(num(data.ui.sidebarWidth, 280));
    state.ui.sidebarAutoHide = data.ui.sidebarAutoHide === true;
    state.ui.grid = data.ui.grid === true;
    if (["grid", "columns", "rows"].includes(data.ui.paneLayout as string)) state.ui.paneLayout = data.ui.paneLayout as PaneLayout;
    if (isObj(data.ui.paneSizes)) {
      for (const [key, value] of Object.entries(data.ui.paneSizes)) {
        if (/^(columns|rows)-[2-8]$|^grid-[xy]$|^grid-x-[34]$/.test(key)) {
          const count = /^grid-[xy]$/.test(key) ? 2 : Number(key.at(-1));
          state.ui.paneSizes[key] = paneWeights(value, count);
        }
      }
    }
    if (Array.isArray(data.ui.pinnedSessionIds)) {
      state.ui.pinnedSessionIds = [...new Set(data.ui.pinnedSessionIds.filter((id): id is string =>
        typeof id === "string" && state.sessions.some((s) => s.id === id)))].slice(0, 4);
    }
    if (str(data.ui.activeSessionId)) state.ui.activeSessionId = data.ui.activeSessionId;
    const legacy = [...new Set([...state.ui.pinnedSessionIds, ...(state.ui.activeSessionId ? [state.ui.activeSessionId] : [])])].slice(0, 4);
    state.ui.paneSlots = normalizePaneSlots(Array.isArray(data.ui.paneSlots) ? data.ui.paneSlots : legacy, new Set(state.sessions.map(s => s.id)));
  }
  const layoutIds = new Set<string>();
  for (const item of Array.isArray(data.savedLayouts) ? data.savedLayouts : []) {
    if (!isObj(item) || !str(item.id) || layoutIds.has(item.id) || !str(item.name)
      || !item.name.trim() || !["grid", "columns", "rows"].includes(item.paneLayout as string)
      || !Array.isArray(item.paneSlots)) { dropped++; continue; }
    layoutIds.add(item.id);
    state.savedLayouts.push({ id: item.id, name: item.name.trim().slice(0, 80),
      paneLayout: item.paneLayout as PaneLayout,
      paneSlots: normalizePaneSlots(item.paneSlots, new Set(state.sessions.map(s => s.id))),
      paneSizes: parsePaneSizes(item.paneSizes) });
  }
  return { state, dropped };
}

export interface SavedLayout {
  id: string;
  name: string;
  paneLayout: PaneLayout;
  paneSlots: (string | null)[];
  paneSizes: Record<string, number[]>;
}

function parsePaneSizes(value: unknown): Record<string, number[]> {
  const sizes: Record<string, number[]> = {};
  if (isObj(value)) for (const [key, weights] of Object.entries(value)) {
    if (/^(columns|rows)-[2-8]$|^grid-[xy]$|^grid-x-[34]$/.test(key)) {
      sizes[key] = paneWeights(weights, /^grid-[xy]$/.test(key) ? 2 : Number(key.at(-1)));
    }
  }
  return sizes;
}

/** Explicit snapshots: editing the visible panes never changes a saved layout. */
export function savePanePreset(state: PersistedState, id: string, name: string): boolean {
  const trimmed = name.trim().slice(0, 80);
  if (!trimmed) return false;
  const preset: SavedLayout = { id, name: trimmed, paneLayout: state.ui.paneLayout,
    paneSlots: normalizePaneSlots(state.ui.paneSlots, new Set(state.sessions.map(s => s.id))),
    paneSizes: parsePaneSizes(state.ui.paneSizes) };
  const index = state.savedLayouts.findIndex(item => item.id === id);
  if (index < 0) state.savedLayouts.push(preset); else state.savedLayouts[index] = preset;
  return true;
}

export function applyPanePreset(state: PersistedState, id: string): boolean {
  const preset = state.savedLayouts.find(item => item.id === id);
  if (!preset) return false;
  state.ui.paneLayout = preset.paneLayout;
  state.ui.paneSlots = normalizePaneSlots(preset.paneSlots, new Set(state.sessions.map(s => s.id)));
  state.ui.paneSizes = parsePaneSizes(preset.paneSizes);
  state.ui.grid = true;
  if (!state.ui.activeSessionId || !state.ui.paneSlots.includes(state.ui.activeSessionId)) {
    state.ui.activeSessionId = state.ui.paneSlots.find(id => id !== null) ?? undefined;
  }
  return true;
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
/** On Windows the Codex hook override keys the project path as a TOML literal string, which cannot hold `'`. */
export function codexHooksFit(platform: Platform, projectPath: string): boolean {
  return platform !== "windows" || !projectPath.includes("'");
}

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
    // SessionStart hook len pre toto spustenie (`-c`), aby Desk poznal ID aj po /resume.
    // Windows override uses TOML literal strings to survive legacy PowerShell argument passing.
    const hooks = hooksEnabled ? ` -c ${envRef(platform, "PROJECT_DESK_CODEX_HOOKS")}` : "";
    if (!s.started) return (settings.codexCommand.trim() || "codex") + hooks;
    const resume = (settings.codexResumeCommand.trim() || "codex resume") + hooks;
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

/** Native snapshot is used only on reconnect, never as a periodic status poll. */
export function backgroundStatus(state: string): Status {
  if (state === "working") return "working";
  if (["needs_input", "needs-input", "needsInput"].includes(state)) return "needs-you";
  if (["idle", "completed"].includes(state)) return "done";
  if (["failed", "stopped"].includes(state)) return "agent-exited";
  return "untracked";
}

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
  provider?: "claude" | "antigravity" | "codex";
  toolName?: string | null;
  fullyIdle?: boolean | null;
  /** SessionStart only: startup, resume, clear, compact (Codex also fork). */
  source?: string | null;
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
    : observation?.event === "SessionEnd" ? "agentExited"
    : !observation ? (method === "file" ? "awaitingFile" : "awaitingHook") : "receiving";
  const recovery = reason === "stopped" ? "resume"
    : reason === "missingId" || reason === "awaitingFile" ? "link"
    : reason === "awaitingHook" || reason === "agentExited" ? "terminal"
    : reason === "hooksUnavailable" ? "restartApp" : undefined;
  return { linked, method, reason, recovery } as const;
}

// Bez `agent_needs_input`: ten hlási agenta na pozadí, hlavná relácia vtedy nič nerobí.
const NEEDS_INPUT = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog"]);

/** Nový stav relácie po udalosti z Claude hooku. `undefined` = udalosť stav nemení. */
export function statusAfter(prev: Status, ev: AgentEvent): Status | undefined {
  switch (ev.event) {
    case "SessionStart":
      return "done";
    case "PreInvocation":
    case "UserPromptSubmit":
    case "PostToolUse":
    case "PostToolUseFailure":
      return "working";
    case "PermissionRequest":
    case "StopFailure":
      return "needs-you";
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

/** No event means no evidence; never invent completion from usage metadata. */
export function codexPollEvents(poll: { events: string[]; status: string | null }): string[] {
  return poll.events.length ? poll.events : poll.status ? [poll.status] : [];
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

/** Text z terminálu na skopírovanie: bez medzier na konci riadkov a bez spoločného odsadenia.
 * `startColumn` je stĺpec, kde výber začína; prvý riadok sa počíta, akoby mal pred sebou toľko medzier.
 * S `columns` spojí riadky, ktoré agent zalomil len preto, že ďalšie slovo by sa do šírky terminálu nezmestilo.
 */
export function copiedText(text: string, startColumn = 0, columns = Infinity): string {
  const lines = text.split("\n").map(line => line.trimEnd());
  const offset = (i: number) => i === 0 ? startColumn : 0;
  const indents = lines.map((line, i) => line.length - line.trimStart().length + offset(i));
  const indent = Math.min(...lines.flatMap((line, i) => line ? [indents[i]] : []));
  if (!Number.isFinite(indent)) return lines.join("\n");
  const wrapped = (i: number) => {
    const [previous, next] = [lines[i - 1], lines[i].trimStart()];
    if (!previous || !next || LIST_ITEM.test(next) || !/^[\p{L}\p{N}("'„“]/u.test(next)) return false;
    // Pokračovanie odrážky začína pod textom, nie pod značkou.
    const continuation = indents[i - 1] + (previous.trimStart().match(LIST_ITEM)?.[0].length ?? 0);
    const width = [...previous].length + offset(i - 1);
    return indents[i] === continuation && width + 1 + [...next.split(" ")[0]].length > columns - WRAP_SLACK;
  };
  const result: string[] = [];
  lines.forEach((line, i) => {
    const rest = line.slice(Math.max(0, indent - offset(i)));
    if (i > 0 && wrapped(i)) result[result.length - 1] += " " + rest.trimStart();
    else result.push(rest);
  });
  return result.join("\n");
}
const LIST_ITEM = /^(?:[-*+•⏺]|\d+[.)])\s+/;
/** Agenti nechávajú pri pravom okraji pár voľných stĺpcov. */
const WRAP_SLACK = 4;

/** Literal file references for a single paste, never an Enter or a command.
 * Quote for the default shells (PowerShell on Windows, POSIX elsewhere).
 * Reject control characters instead of silently changing a filename.
 */
export function droppedFilePaths(paths: readonly string[], platform: string): string | undefined {
  if (!paths.length || paths.some(path => !path || /[\x00-\x1f\x7f-\x9f]/.test(path))) return;
  return paths.map(path => `'${path.replace(/'/g, platform === "windows" ? "''" : "'\\''")}'`).join(" ") + " ";
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

/** Relácie projektu v poradí, ako ich používateľ usporiadal (nové pribúdajú na koniec). */
/** Bodky v zúženom paneli: skryté relácie len keď čakajú na teba (vtedy sa aj tak vrátia). */
export function railSessions(state: PersistedState, statusOf: (id: string) => Status): { project: Project; sessions: Session[] }[] {
  return orderedProjects(state.projects)
    .map(project => ({ project, sessions: sessionsOf(state, project.id).filter(s => !s.hidden || statusOf(s.id) === "needs-you") }))
    .filter(group => group.sessions.length);
}

export function sessionsOf(state: PersistedState, projectId: string): Session[] {
  return state.sessions.filter((s) => s.projectId === projectId);
}

/** Presunie reláciu pred alebo za cieľovú v tom istom projekte. */
export function moveSession(sessions: Session[], fromId: string, toId: string, after: boolean): Session[] {
  const from = sessions.find((s) => s.id === fromId);
  const to = sessions.find((s) => s.id === toId);
  if (!from || !to || from === to || from.projectId !== to.projectId) return sessions;
  const rest = sessions.filter((s) => s !== from);
  rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, from);
  return rest;
}

/** Relácia pre Ctrl+1–8 v poradí zoznamu (aj zo zbalených projektov, bez skrytých); Ctrl+9 je vždy posledná. */
export function sessionByNumber(state: PersistedState, n: number): Session | undefined {
  const all = orderedProjects(state.projects).flatMap((p) => sessionsOf(state, p.id)).filter((s) => !s.hidden);
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
  state.closedSessions = [{ ...s, stopped: true, resumeAfterShutdown: false, interrupted: false, hidden: false }, ...state.closedSessions.filter((x) => x.id !== id)].slice(0, 20);
  state.sessions = state.sessions.filter((s) => s.id !== id);
  state.ui.pinnedSessionIds = state.ui.pinnedSessionIds.filter((x) => x !== id);
  state.ui.paneSlots = state.ui.paneSlots.map(value => value === id ? null : value);
  if (state.ui.activeSessionId === id) state.ui.activeSessionId = byRecent(state.sessions)[0]?.id;
}

export function restoreSession(state: PersistedState, id: string): Session | undefined {
  const s = state.closedSessions.find((s) => s.id === id);
  if (!s || !state.projects.some((p) => p.id === s.projectId) || state.sessions.some((x) => x.id === id)) return;
  state.closedSessions = state.closedSessions.filter((s) => s.id !== id);
  state.sessions.push(s);
  return s;
}

export function recordSessionExit(state: PersistedState, id: string, code: number | null, closing: boolean, systemShutdown = false): void {
  if (closing) { archiveSession(state, id); return; }
  const s = state.sessions.find((s) => s.id === id);
  if (s) { s.stopped = true; s.exitCode = code; s.resumeAfterShutdown = systemShutdown; }
}

/** Agents whose current step closing the app would interrupt; detached workers keep running. */
export function busyAgents(sessions: Session[], statusOf: (id: string) => Status, running: (id: string) => boolean): Session[] {
  return sessions.filter(s => s.provider !== "shell" && !s.background && running(s.id)
    && (statusOf(s.id) === "working" || statusOf(s.id) === "needs-you"));
}

/** Only a step in progress is interrupted; an open question merely warrants the quit warning. */
export function interruptedAgents(sessions: Session[], statusOf: (id: string) => Status, running: (id: string) => boolean): Session[] {
  return busyAgents(sessions, statusOf, running).filter(s => statusOf(s.id) === "working");
}

export function shouldAutoResume(s: Session, enabled: boolean): boolean {
  return enabled && (!s.stopped || s.resumeAfterShutdown === true);
}

/** Fixed slots preserve holes and order; missing/duplicate sessions never auto-fill. */
export function normalizePaneSlots(value: unknown[], available: ReadonlySet<string>): (string | null)[] {
  const seen = new Set<string>();
  return Array.from({ length: Math.min(8, Math.max(2, value.length)) }, (_, i) => {
    const id = value[i];
    if (typeof id !== "string" || !available.has(id) || seen.has(id)) return null;
    seen.add(id);
    return id;
  });
}

export function assignPaneSlot(slots: (string | null)[], index: number, id: string): (string | null)[] {
  if (index < 0 || index >= slots.length || slots.includes(id)) return slots;
  return slots.map((value, i) => i === index ? id : value);
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
  const columns = mode === "columns" ? count : mode === "rows" ? 1 : Math.min(count, Math.max(2, Math.ceil(count / 2)));
  const rows = mode === "rows" ? count : mode === "columns" ? 1 : Math.ceil(count / columns);
  return {
    columns, rows,
    xKey: mode === "grid" ? (columns > 2 ? `grid-x-${columns}` : "grid-x") : `${mode}-${count}`,
    yKey: mode === "grid" ? "grid-y" : `${mode}-${count}`,
    cells: Array.from({ length: count }, (_, i) => ({
      column: (i % columns) * 2 + 1,
      row: Math.floor(i / columns) * 2 + 1,
      span: mode === "grid" && i === count - 1 ? (columns - i % columns) * 2 - 1 : 1,
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
export function createDiscovery(now: () => number = () => performance.now()) {
  const entries = new Map<string, { path: string; ambiguous: boolean; delay: number; retryAt: number }>();
  let busy = false;
  return {
    add(id: string, path: string) {
      const entry = { path, ambiguous: false, delay: 3000, retryAt: 0 };
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
          if (!current() || now() < entry.retryAt) continue;
          try {
            await lookup(id, current);
          } finally {
            if (current()) {
              entry.retryAt = now() + entry.delay;
              entry.delay = Math.min(entry.delay * 2, 30_000);
            }
          }
        }
      } finally { busy = false; }
    },
  };
}

// App actions share one binding registry. Empty strings explicitly disable bindings.
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;
export function normalizeFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value))) : 13;
}

export const ACTION_DEFAULTS = {
  palette: 'Mod+Shift+P', switch: 'Mod+K', grid: 'Mod+G',
  search: 'Mod+Shift+F', templates: 'Mod+Shift+T', attention: 'Mod+Shift+A', zoom: 'Mod+Shift+Enter',
  session1: 'Mod+1', session2: 'Mod+2', session3: 'Mod+3', session4: 'Mod+4',
  session5: 'Mod+5', session6: 'Mod+6', session7: 'Mod+7', session8: 'Mod+8', session9: 'Mod+9',
  fontIncrease: 'Mod+Plus', fontDecrease: 'Mod+Minus', fontReset: 'Mod+0',
  settings: '', shortcuts: '', layouts: '', notifications: '', history: '', editor: '', sidebar: '',
  addProject: '', claude: '', codex: '', antigravity: '', shell: '',
} as const;
export type ActionId = keyof typeof ACTION_DEFAULTS;
export const ACTION_IDS = Object.keys(ACTION_DEFAULTS) as ActionId[];
export type Shortcuts = Partial<Record<ActionId, string>>;
// Outside macOS, Mod is Ctrl: bare Ctrl+K/G belong to the terminal (kill-line, Claude's external editor).
const NON_MAC_DEFAULTS: Partial<Record<ActionId, string>> = { switch: 'Mod+Shift+K', grid: 'Mod+Shift+G' };
export function bindingFor(id: ActionId, bindings: Shortcuts, mac: boolean): string {
  return bindings[id] ?? (mac ? undefined : NON_MAC_DEFAULTS[id]) ?? ACTION_DEFAULTS[id];
}
export function validBinding(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || /^Mod\+(Shift\+)?([A-Z0-9]|Plus|Minus|Enter|F(?:[1-9]|1[0-2]))$/.test(value)
    && !['Mod+Shift+Plus', 'Mod+Shift+Minus', 'Mod+C', 'Mod+V', 'Mod+X', 'Mod+Q', 'Mod+W', 'Mod+Z', 'Mod+Shift+C', 'Mod+Shift+V'].includes(value));
}
export function shortcutConflict(bindings: Shortcuts, mac: boolean): ActionId | undefined {
  const seen = new Set<string>();
  for (const id of ACTION_IDS) {
    const value = bindingFor(id, bindings, mac);
    if (value && seen.has(value)) return id;
    if (value) seen.add(value);
  }
}
export function parseShortcuts(value: unknown): Shortcuts {
  if (!isObj(value)) return {};
  const result: Shortcuts = {};
  for (const id of ACTION_IDS) if (validBinding(value[id])) result[id] = value[id];
  // Added defaults must not override an older custom assignment.
  for (const id of ['fontIncrease', 'fontDecrease', 'fontReset'] as const) {
    if (result[id] === undefined && Object.values(result).includes(ACTION_DEFAULTS[id])) result[id] = '';
  }
  // Platform defaults differ: a custom binding taken from one platform pins the other's default.
  for (const [id, value] of Object.entries(NON_MAC_DEFAULTS) as [ActionId, string][]) {
    if (result[id] !== undefined) continue;
    const used = Object.values(result);
    if (used.includes(value)) result[id] = ACTION_DEFAULTS[id];
    else if (used.includes(ACTION_DEFAULTS[id])) result[id] = value;
  }
  // Invalid saved collisions must never make dispatch depend on object order.
  return shortcutConflict(result, true) || shortcutConflict(result, false) ? {} : result;
}
export interface ShortcutEvent {
  key: string; code: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
  isComposing?: boolean; getModifierState?: (key: string) => boolean;
}
/** Mod is Cmd on macOS and Ctrl elsewhere; the other key always reaches the terminal. */
export function bindingFromEvent(e: ShortcutEvent, mac: boolean): string | undefined {
  if (e.isComposing || e.getModifierState?.('AltGraph') || e.altKey || !(mac ? e.metaKey : e.ctrlKey) || (e.ctrlKey && e.metaKey)) return;
  // Symbol keys normalize Shift needed to type +; digit-row navigation stays layout-independent.
  if (e.code === 'NumpadAdd' || e.code === 'Equal' || (e.key === '+' && !/^Digit/.test(e.code))) return 'Mod+Plus';
  if (e.code === 'NumpadSubtract' || e.key === '-') return 'Mod+Minus';
  const digit = /^(?:Digit|Numpad)([0-9])$/.exec(e.code);
  const key = digit?.[1] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  const binding = `Mod+${e.shiftKey ? 'Shift+' : ''}${key}`;
  return validBinding(binding) && binding ? binding : undefined;
}
export function shortcutAction(e: ShortcutEvent, bindings: Shortcuts, mac: boolean): ActionId | undefined {
  const binding = bindingFromEvent(e, mac);
  return binding ? ACTION_IDS.find(id => bindingFor(id, bindings, mac) === binding) : undefined;
}

/** Preserve UTF-8 BOM and uniform line endings; reject ambiguous conversions. */
export function textFileFormat(raw: string): { bom: string; separator: string; text: string } | undefined {
  const bom = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = raw.slice(bom.length);
  const normalized = body.replace(/\r\n/g, "\n");
  if (body.includes("\0") || normalized.includes("\r") || (body.includes("\r\n") && body.replace(/\r\n/g, "").includes("\n"))) return undefined;
  return { bom, separator: body.includes("\r\n") ? "\r\n" : "\n", text: normalized };
}

export function isMarkdown(file: string): boolean {
  return /\.(md|markdown|mdown|mkd)$/i.test(file);
}

/** Režim vstavaného editora pre odkaz z terminálu: Markdown podľa nastavenia, inak úprava. */
export function linkEditorMode(file: string, settings: Pick<Settings, "markdownOpen">): "preview" | "edit" {
  return isMarkdown(file) ? settings.markdownOpen : "edit";
}

/** System file associations take precedence over the preferred text editor. */
export function fileOpenTarget(file: string, settings: Settings): "system" | "builtin" | "external" {
  return opensInSystem(file, settings.systemOpenExts) ? "system" : settings.fileEditor;
}
