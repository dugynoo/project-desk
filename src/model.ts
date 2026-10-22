// Čistá doménová logika bez DOM a Tauri, aby sa dala testovať v Node.

export type Provider = "claude" | "codex" | "shell";
export const PROVIDERS: Provider[] = ["claude", "codex", "shell"];
export const PROVIDER_LABEL: Record<Provider, string> = { claude: "Claude", codex: "Codex", shell: "Shell" };

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
  createdAt: number;
  lastUsedAt: number;
}

export interface Settings {
  claudeCommand: string;
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
  version: 1;
  projects: Project[];
  sessions: Session[];
  templates: PromptTemplate[];
  settings: Settings;
  settingsRev: number;
  ui: { sidebarWidth: number; grid: boolean; activeSessionId?: string };
}

export const DEFAULT_SETTINGS: Settings = {
  claudeCommand: "claude --dangerously-skip-permissions",
  codexCommand: "codex --dangerously-bypass-approvals-and-sandbox",
  codexResumeCommand: "codex resume --dangerously-bypass-approvals-and-sandbox",
  shell: "",
  language: "en",
  editorId: "",
  customEditorPath: "",
  customEditorArgs: "%TARGET_PATH%",
  notifications: true,
  autoResume: true,
};

/** Predvolené hodnoty z rev 1; ak ich používateľ nezmenil, prejdú na nové. */
const REV1_DEFAULTS: Partial<Settings> = { codexCommand: "codex", codexResumeCommand: "codex resume" };

export function emptyState(): PersistedState {
  return {
    version: 1,
    projects: [],
    sessions: [],
    templates: [],
    settings: { ...DEFAULT_SETTINGS },
    settingsRev: SETTINGS_REV,
    ui: { sidebarWidth: 280, grid: false },
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
        lastStartAt: typeof s.lastStartAt === "number" ? s.lastStartAt : undefined,
        createdAt: num(s.createdAt, Date.now()),
        lastUsedAt: num(s.lastUsedAt, Date.now()),
      });
    } else dropped++;
  }
  if (isObj(data.settings)) {
    for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
      const v = data.settings[key];
      if (typeof v === typeof DEFAULT_SETTINGS[key]) (state.settings as unknown as Record<string, unknown>)[key] = v;
    }
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
  | "sleeping"
  | "starting"
  | "running"
  | "idle"
  | "working"
  | "needs-you"
  | "done"
  | "agent-exited";

export interface AgentEvent {
  deskSessionId: string;
  agentSessionId?: string | null;
  event: string;
  notificationType?: string | null;
}

const NEEDS_INPUT = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

/** Nový stav relácie po udalosti z Claude hooku. `undefined` = udalosť stav nemení. */
export function statusAfter(prev: Status, ev: AgentEvent): Status | undefined {
  switch (ev.event) {
    case "SessionStart":
      return "idle";
    case "UserPromptSubmit":
    case "PostToolUse":
      return "working";
    case "Stop":
      return "done";
    case "SessionEnd":
      return "agent-exited";
    case "Notification":
      if (ev.notificationType && NEEDS_INPUT.has(ev.notificationType)) return "needs-you";
      if (ev.notificationType === "idle_prompt" && prev === "working") return "done";
      return undefined;
    default:
      return undefined;
  }
}

/** Stavy, pri ktorých má zmysel upozorniť, ak sa používateľ práve nepozerá. */
export const ATTENTION: ReadonlySet<Status> = new Set<Status>(["needs-you", "done"]);

/** Stav podľa udalosti zo session súboru Codexu. */
export function codexStatusAfter(event: string): Status | undefined {
  if (event === "task_started") return "working";
  if (event === "task_complete") return "done";
  if (event === "turn_aborted") return "idle";
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
