// Mobilná stránka vzdialeného prístupu: zoznam sessions a živý terminál cez WebSocket.
import "@xterm/xterm/css/xterm.css";
import "./remote.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { errorText, setLang, t, type Key } from "../i18n.ts";
import { pasteSequence, type RemoteSnapshot } from "../model.ts";
import { PROTOCOL, REMOTE_KEYS, parseServerMsg, reconnectDelay, type ClientMsg, type ServerMsg } from "./protocol.ts";

type RemoteSession = RemoteSnapshot["sessions"][number];

const TOKEN_KEY = "pd.remote.token";
const app = document.getElementById("app")!;

let snapshot: RemoteSnapshot | null = null;
let openId: string | null = null;
let ws: WebSocket | null = null;
let attempt = 0;
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
    const token = decodeURIComponent(m[1]);
    try { localStorage.setItem(TOKEN_KEY, token); } catch { /* súkromný režim */ }
    history.replaceState(null, "", location.pathname + location.search);
    return token;
  }
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function send(msg: ClientMsg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function connect(token: string) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const sock = new WebSocket(`${scheme}//${location.host}/ws`, [PROTOCOL, `auth.${token}`]);
  ws = sock;
  sock.onopen = () => {
    connected = true;
    attempt = 0;
    renderBanner();
    if (openId) subscribe(openId); // po znovupripojení znova odoberáme otvorenú session
  };
  sock.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    let msg: ServerMsg | null = null;
    try { msg = parseServerMsg(ev.data); } catch { /* neplatná správa */ }
    if (msg) handle(msg);
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    connected = false;
    renderBanner();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => connect(token), reconnectDelay(attempt++));
  };
  sock.onerror = () => sock.close();
}

function handle(msg: ServerMsg) {
  switch (msg.type) {
    case "snapshot":
      snapshot = msg.snapshot;
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
    return;
  }
  renderList();
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
  r.row.className = `row${s.running ? "" : " dim"}`;
  r.dot.className = `dot ${statusOf(s)}`;
  r.title.textContent = s.title;
  r.status.textContent = statusLabel(s);
}

function renderList() {
  disposeTerminal();
  const sig = listSignature();
  if (listSig === sig && app.querySelector(".list")) {
    for (const s of snapshot?.sessions ?? []) fillRow(s);
    return;
  }
  const oldScroll = app.querySelector(".list")?.scrollTop ?? 0;
  app.replaceChildren();
  rowEls.clear();
  listSig = sig;
  const root = h("div", "list");
  root.append(h("h1", "list-title", t("remote.title")));
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
        root.append(row);
        rowEls.set(s.id, { row, dot, title, status });
        fillRow(s);
      }
    }
  }
  app.append(root);
  root.scrollTop = oldScroll;
}

function updateHeader(s: RemoteSession) {
  const project = snapshot?.projects.find((p) => p.id === s.projectId)?.name ?? "";
  const title = app.querySelector(".head-title");
  const status = app.querySelector(".head-status");
  if (title) title.textContent = project ? `${project} / ${s.title}` : s.title;
  if (status) status.replaceChildren(statusDot(s), document.createTextNode(statusLabel(s)));
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
  listSig = null;
  const s = snapshot?.sessions.find((x) => x.id === id);
  if (!s) return;
  openId = id;
  app.replaceChildren();
  const view = h("div", "session");

  const head = h("header", "head");
  const back = h("button", "back", `‹ ${t("remote.back")}`);
  back.type = "button";
  back.onclick = closeSession;
  head.append(back, h("div", "head-title"), h("div", "head-status"));

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
  app.append(view);
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
  renderList();
}

const token = loadToken();
if (!token) {
  app.append(h("p", "pair", t("remote.pairFirst")));
} else {
  renderList();
  renderBanner();
  connect(token);
}
