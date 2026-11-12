// Mobilná stránka vzdialeného prístupu: zoznam sessions a živý terminál cez WebSocket.
import "@xterm/xterm/css/xterm.css";
import "./remote.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { errorText, setLang, t, type Key } from "../i18n.ts";
import { pasteSequence, type RemoteSnapshot } from "../model.ts";
import { PROTOCOL, REMOTE_KEYS, closeAction, parseServerMsg, reconnectDelay, type ClientMsg, type ServerMsg } from "./protocol.ts";

type RemoteSession = RemoteSnapshot["sessions"][number];

const TOKEN_KEY = "pd.remote.token";
const app = document.getElementById("app")!;
// Zoznam a otvorená session; na úzkej obrazovke sa striedajú, na širokej sú vedľa seba (CSS).
const listEl = h("div", "list");
const paneEl = h("div", "pane");

let snapshot: RemoteSnapshot | null = null;
let openId: string | null = null;
let ws: WebSocket | null = null;
let attempt = 0;
/** Neúspešné pripojenia za sebou (socket sa ani neotvoril). */
let failures = 0;
/** Token neplatí: čakáme na nové spárovanie, nepripájame sa. */
let stopped = false;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let connected = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let resizeObserver: ResizeObserver | null = null;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Token z odkazu `#t=...`; uloží sa a z URL zmizne.
function loadToken(): string | null {
  const m = /^#t=(.+)$/.exec(location.hash);
  if (m) {
    history.replaceState(null, "", location.pathname + location.search);
    let token: string;
    try { token = decodeURIComponent(m[1]); } catch { return null; } // poškodený odkaz: znova spárovať
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* súkromný režim */ }
    return token;
  }
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function send(msg: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(token: string) {
  if (stopped) return;
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  let sock: WebSocket;
  try {
    sock = new WebSocket(`${scheme}//${location.host}/ws`, [PROTOCOL, `auth.${token}`]);
  } catch {
    failures++;
    scheduleReconnect(token);
    return;
  }
  ws = sock;
  let opened = false;
  sock.onopen = () => {
    opened = true;
    connected = true;
    attempt = 0;
    failures = 0;
    renderBanner();
    // po znovupripojení znova odoberáme otvorenú session (skrytá stránka až po návrate)
    if (openId && !document.hidden) subscribe(openId);
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: ServerMsg | null = null;
    try { msg = parseServerMsg(ev.data); } catch { /* neplatná správa */ }
    if (msg) handle(msg);
  };
  sock.onclose = (ev) => {
    if (ws !== sock) return;
    ws = null;
    connected = false;
    if (!opened) failures++;
    const action = closeAction(ev.code, opened, failures);
    if (action === "repair") return showRepair();
    renderBanner();
    if (action === "retry") return scheduleReconnect(token);
    // Stránka odpovedá, ale socket nás odmieta: token už neplatí.
    void serverAnswers().then((up) => (up ? showRepair() : scheduleReconnect(token)));
  };
  sock.onerror = () => sock.close();
}

function scheduleReconnect(token: string) {
  if (stopped) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => connect(token), reconnectDelay(attempt++));
}

async function serverAnswers(): Promise<boolean> {
  try {
    return (await fetch(location.pathname, { cache: "no-store" })).ok;
  } catch {
    return false;
  }
}

/** Párovací kód sa zmenil; ďalšie pokusy by len zlyhávali. */
function showRepair() {
  stopped = true;
  clearTimeout(reconnectTimer);
  disposeTerminal();
  openId = null;
  listSig = null;
  document.querySelector(".banner")?.remove();
  app.replaceChildren(h("p", "pair", t("remote.repair")));
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "snapshot":
      snapshot = msg.snapshot;
      // Ponuka patrí starému stavu (napr. ⏸ pri session, ktorá už skončila).
      closeSheet();
      setLang(snapshot.language);
      document.documentElement.lang = snapshot.language;
      render();
      break;
    case "history":
      if (msg.id === openId && term) {
        term.reset();
        term.write(msg.data);
      }
      break;
    case "output":
      if (msg.id === openId) term?.write(msg.data);
      break;
    case "error":
      showToast(errorText(msg.code));
      break;
  }
}

function showToast(text: string) {
  document.querySelector(".toast")?.remove();
  const el = h("div", "toast", text);
  el.setAttribute("role", "alert");
  document.body.append(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 4000);
}

function renderBanner() {
  if (stopped) return;
  let banner = document.querySelector<HTMLElement>(".banner");
  if (connected) {
    banner?.remove();
    return;
  }
  if (!banner) {
    banner = h("div", "banner");
    banner.setAttribute("role", "status");
    document.body.prepend(banner);
  }
  banner.textContent = t("remote.disconnected");
}

function render() {
  if (openId) {
    const s = snapshot?.sessions.find((x) => x.id === openId);
    // Session zmizla zo snímku: späť na zoznam.
    if (!s) return closeSession();
    updateHeader(s);
  }
  renderList();
}

function mount() {
  if (listEl.parentElement !== app || paneEl.parentElement !== app) app.replaceChildren(listEl, paneEl);
  app.classList.toggle("open", openId !== null);
}

function statusOf(session: RemoteSession) {
  return session.running ? session.status : "exited";
}

function statusDot(session: RemoteSession) {
  const dot = h("span", `dot ${statusOf(session)}`);
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function statusLabel(session: RemoteSession) {
  return t(`status.${statusOf(session)}` as Key);
}

// Riadky zoznamu podľa id; pri zmene stavu sa mení len text a trieda, nie prvky.
const rowEls = new Map<string, { row: HTMLElement; dot: HTMLElement; title: HTMLElement; status: HTMLElement }>();
let listSig: string | null = null;

function listSignature(): string {
  if (!snapshot) return "";
  return snapshot.projects
    .map((p) => `${p.id}:${p.name}:` + snapshot!.sessions.filter((s) => s.projectId === p.id).map((s) => s.id).join(","))
    .join("|");
}

function fillRow(s: RemoteSession) {
  const r = rowEls.get(s.id);
  if (!r) return;
  r.row.className = `row${s.running ? "" : " dim"}${s.id === openId ? " active" : ""}`;
  r.dot.className = `dot ${statusOf(s)}`;
  r.title.textContent = s.title;
  r.status.textContent = statusLabel(s);
}

function renderList() {
  mount();
  const sig = listSignature();
  if (listSig === sig) {
    for (const s of snapshot?.sessions ?? []) fillRow(s);
    return;
  }
  const oldScroll = listEl.scrollTop;
  rowEls.clear();
  listSig = sig;
  const root = listEl;
  root.replaceChildren(h("h1", "list-title", t("remote.title")));
  if (!snapshot || !snapshot.sessions.length) {
    root.append(h("p", "empty", t("remote.empty")));
  } else {
    for (const p of snapshot.projects) {
      const sessions = snapshot.sessions.filter((s) => s.projectId === p.id);
      if (!sessions.length) continue;
      root.append(h("h2", "project", p.name));
      for (const s of sessions) {
        const row = h("button", "row");
        row.type = "button";
        const text = h("span", "row-text");
        const title = h("span", "row-title");
        const status = h("span", "row-status");
        const dot = h("span", "dot");
        dot.setAttribute("aria-hidden", "true");
        text.append(title, status);
        row.append(dot, text);
        row.onclick = () => openSession(s.id);
        onLongPress(row, s.id);
        root.append(row);
        rowEls.set(s.id, { row, dot, title, status });
        fillRow(s);
      }
    }
  }
  root.scrollTop = oldScroll;
}

/** Ako ⏸ a ↻ na desktope; pozastavenie pracujúceho agenta treba potvrdiť. */
function sessionActions(s: RemoteSession): { icon: string; label: string; run: () => void }[] {
  if (s.canPause) {
    return [{
      icon: "⏸",
      label: t("session.pause"),
      run: () => {
        if (s.status === "working" && !confirm(t("pause.body", { title: s.title }))) return;
        send({ type: "pause", id: s.id });
      },
    }];
  }
  if (!s.running) return [{ icon: "↻", label: t("session.restart"), run: () => send({ type: "start", id: s.id }) }];
  return [];
}

function closeSheet() {
  document.querySelector(".sheet-backdrop")?.remove();
}

/** Ponuka po podržaní riadku (alebo pravom kliknutí). */
function openSheet(id: string) {
  const s = snapshot?.sessions.find((x) => x.id === id);
  const actions = s ? sessionActions(s) : [];
  closeSheet();
  if (!s || !actions.length) return;
  const backdrop = h("div", "sheet-backdrop");
  const sheet = h("div", "sheet");
  sheet.setAttribute("role", "dialog");
  sheet.append(h("div", "sheet-title", s.title));
  for (const a of actions) {
    const b = h("button", "sheet-item", `${a.icon}  ${a.label}`);
    b.type = "button";
    b.onclick = () => { closeSheet(); a.run(); };
    sheet.append(b);
  }
  const cancel = h("button", "sheet-item sheet-cancel", t("common.cancel"));
  cancel.type = "button";
  cancel.onclick = closeSheet;
  sheet.append(cancel);
  backdrop.onclick = (e) => { if (e.target === backdrop) closeSheet(); };
  backdrop.append(sheet);
  document.body.append(backdrop);
}

const LONG_PRESS_MS = 500;

/** Podržanie otvorí ponuku a nasledujúci klik session neotvorí. */
function onLongPress(row: HTMLElement, id: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fired = false;
  let x = 0, y = 0;
  const cancel = () => clearTimeout(timer);
  row.addEventListener("pointerdown", (e) => {
    fired = false;
    x = e.clientX; y = e.clientY;
    cancel();
    timer = setTimeout(() => { fired = true; openSheet(id); }, LONG_PRESS_MS);
  });
  row.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) cancel(); });
  row.addEventListener("pointerup", cancel);
  row.addEventListener("pointercancel", cancel);
  // Android a myš: kontextové menu; vlastná ponuka namiesto systémovej.
  row.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    cancel();
    fired = true;
    openSheet(id);
  });
  row.addEventListener("click", (e) => {
    if (!fired) return;
    fired = false;
    e.stopImmediatePropagation();
    e.preventDefault();
  }, true);
}

function updateHeader(s: RemoteSession) {
  const project = snapshot?.projects.find((p) => p.id === s.projectId)?.name ?? "";
  const title = paneEl.querySelector(".head-title");
  const status = paneEl.querySelector(".head-status");
  if (title) title.textContent = project ? `${project} / ${s.title}` : s.title;
  if (status) status.replaceChildren(statusDot(s), document.createTextNode(statusLabel(s)));
  paneEl.querySelector(".head-actions")?.replaceChildren(...sessionActions(s).map((a) => {
    const b = h("button", "head-action", a.icon);
    b.type = "button";
    b.title = a.label;
    b.setAttribute("aria-label", a.label);
    b.onclick = a.run;
    return b;
  }));
}

function subscribe(id: string) {
  const d = fit?.proposeDimensions();
  if (!d || isNaN(d.cols) || isNaN(d.rows)) return;
  send({ type: "subscribe", id, cols: d.cols, rows: d.rows });
}

function sendResize() {
  if (!openId || !term || !fit) return;
  const d = fit.proposeDimensions();
  if (!d || isNaN(d.cols) || isNaN(d.rows)) return;
  if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows);
  send({ type: "resize", id: openId, cols: d.cols, rows: d.rows });
}

function openSession(id: string) {
  const s = snapshot?.sessions.find((x) => x.id === id);
  if (!s || id === openId) return;
  // Prepnutie na širokej obrazovke: predchádzajúcu session prestaneme sledovať.
  if (openId) send({ type: "unsubscribe", id: openId });
  disposeTerminal();
  openId = id;
  const view = h("div", "session");

  const head = h("header", "head");
  const back = h("button", "back", `‹ ${t("remote.back")}`);
  back.type = "button";
  back.onclick = closeSession;
  head.append(back, h("div", "head-title"), h("div", "head-status"), h("div", "head-actions"));

  const host = h("div", "term");
  const keys = h("div", "keys");
  for (const k of REMOTE_KEYS) {
    const b = h("button", "key", t(`remote.keys.${k.id}` as Key));
    b.type = "button";
    // mousedown nesmie zobrať fokus poľu, inak sa zavrie klávesnica
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => send({ type: "input", id, data: k.seq });
    keys.append(b);
  }

  const form = h("form", "compose");
  const input = h("input", "text");
  input.type = "text";
  input.placeholder = t("remote.placeholder");
  input.enterKeyHint = "send";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  const sendBtn = h("button", "send", t("remote.send"));
  sendBtn.type = "submit";
  form.append(input, sendBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    // Text ide ako bracketed paste, Enter zvlášť; prázdny text pošle len Enter.
    if (input.value) send({ type: "input", id, data: pasteSequence(input.value) });
    send({ type: "input", id, data: "\r" });
    input.value = "";
  };

  view.append(head, host, keys, form);
  paneEl.replaceChildren(view);
  renderList();
  updateHeader(s);

  term = new Terminal({
    fontFamily: '"Cascadia Mono", "Cascadia Code", Consolas, "SF Mono", Menlo, monospace',
    fontSize: 13,
    scrollback: 5000,
    allowProposedApi: true,
    disableStdin: true,
    theme: { background: "#111317", foreground: "#e6e8ee", cursor: "#7cc4ff", selectionBackground: "#2d3a52" },
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new UnicodeGraphemesAddon());
  term.open(host);
  fit.fit();
  subscribe(id);
  resizeObserver = new ResizeObserver(() => sendResize());
  resizeObserver.observe(host);
}

function disposeTerminal() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  term?.dispose();
  term = null;
  fit = null;
}

function closeSession() {
  if (openId) send({ type: "unsubscribe", id: openId });
  openId = null;
  disposeTerminal();
  paneEl.replaceChildren(h("p", "pane-empty", t("remote.pick")));
  renderList();
}

// Skrytá stránka (zamknutý telefón, iná appka) sessions nesleduje, inak by na desktope stlmila upozornenia.
document.addEventListener("visibilitychange", () => {
  if (!openId) return;
  if (document.hidden) send({ type: "unsubscribe", id: openId });
  else subscribe(openId);
});

const token = loadToken();
if (!token) {
  app.append(h("p", "pair", t("remote.pairFirst")));
} else {
  paneEl.append(h("p", "pane-empty", t("remote.pick")));
  renderList();
  renderBanner();
  connect(token);
}
