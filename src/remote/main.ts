// Mobilná stránka vzdialeného prístupu: zoznam sessions a živý terminál cez WebSocket.
import "@xterm/xterm/css/xterm.css";
import "./remote.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { errorText, setLang, t, type Key } from "../i18n.ts";
import { pasteSequence, type RemoteSnapshot } from "../model.ts";
import { PROTOCOL, REMOTE_KEYS, closeAction, parseServerMsg, reconnectDelay, type ChatItem, type ClientMsg, type ServerMsg } from "./protocol.ts";
import { parseMarkdown, type Block, type Inline } from "./markdown.ts";

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

/** Chat číta session súbor a veľkosť PTY nemení; terminál je živý PTY ako na desktope. */
type Mode = "chat" | "terminal";
let mode: Mode = "terminal";
let chatEl: HTMLElement | null = null;
/** Najviac toľko správ v DOM; staršie sa odstránia zhora. */
const CHAT_DOM_LIMIT = 600;

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
    if (openId && !document.hidden) attach();
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
    case "chat":
      if (msg.id === openId && mode === "chat") appendChat(msg.items, msg.reset);
      break;
    case "error":
      // Chat sa nedá čítať (napr. konverzácia ešte nemá súbor): ostáva terminál.
      if (msg.code === "remote.chatUnavailable" && msg.id === openId && mode === "chat") {
        setMode("terminal");
        break;
      }
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
  const tabs = paneEl.querySelector<HTMLElement>(".tabs");
  if (tabs) {
    tabs.hidden = !s.chat;
    for (const b of tabs.querySelectorAll<HTMLButtonElement>("button")) b.setAttribute("aria-selected", String(b.dataset.mode === mode));
  }
  // Konverzácia sa zmenila tak, že chat už nemá zdroj: zostane terminál.
  if (!s.chat && mode === "chat") setMode("terminal");
  const notice = paneEl.querySelector<HTMLElement>(".notice");
  if (notice) notice.hidden = !(mode === "chat" && statusOf(s) === "needs-you");
  paneEl.querySelector(".head-actions")?.replaceChildren(...sessionActions(s).map((a) => {
    const b = h("button", "head-action", a.icon);
    b.type = "button";
    b.title = a.label;
    b.setAttribute("aria-label", a.label);
    b.onclick = a.run;
    return b;
  }));
}

/** Terminál chce odber, ale ešte nemal rozmery (skrytý panel); pošle sa pri prvom resize. */
let pendingSubscribe = false;

function subscribe(id: string) {
  const d = fit?.proposeDimensions();
  pendingSubscribe = !d || isNaN(d.cols) || isNaN(d.rows);
  if (!d || pendingSubscribe) return;
  send({ type: "subscribe", id, cols: d.cols, rows: d.rows });
}

function sendResize() {
  if (!openId || !term || !fit) return;
  const d = fit.proposeDimensions();
  if (!d || isNaN(d.cols) || isNaN(d.rows)) return;
  if (d.cols !== term.cols || d.rows !== term.rows) term.resize(d.cols, d.rows);
  if (pendingSubscribe) {
    if (!document.hidden) subscribe(openId);
    return;
  }
  send({ type: "resize", id: openId, cols: d.cols, rows: d.rows });
}

function openSession(id: string) {
  const s = snapshot?.sessions.find((x) => x.id === id);
  if (!s || id === openId) return;
  // Prepnutie na širokej obrazovke: predchádzajúcu session prestaneme sledovať.
  detach();
  openId = id;
  const view = h("div", "session");

  const head = h("header", "head");
  const back = h("button", "back", `‹ ${t("remote.back")}`);
  back.type = "button";
  back.onclick = closeSession;
  head.append(back, h("div", "head-title"), h("div", "head-status"), h("div", "head-actions"));

  const tabs = h("div", "tabs");
  tabs.setAttribute("role", "tablist");
  for (const m of ["chat", "terminal"] as const) {
    const b = h("button", "tab", t(m === "chat" ? "remote.tabChat" : "remote.tabTerminal"));
    b.type = "button";
    b.dataset.mode = m;
    b.setAttribute("role", "tab");
    b.onclick = () => setMode(m);
    tabs.append(b);
  }

  // Agent čaká na voľbu alebo povolenie, ktoré chat neukáže.
  const notice = h("div", "notice");
  notice.hidden = true;
  const noticeBtn = h("button", "notice-btn", t("remote.openTerminal"));
  noticeBtn.type = "button";
  noticeBtn.onclick = () => setMode("terminal");
  notice.append(h("span", "", t("remote.chatNeedsYou")), noticeBtn);

  const body = h("div", "body");
  const keys = h("div", "keys");

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
    if (chatEl) chatEl.scrollTop = chatEl.scrollHeight;
  };

  view.append(head, tabs, body, notice, keys, form);
  paneEl.replaceChildren(view);
  mode = s.chat ? "chat" : "terminal";
  // Najprv zobraziť panel (na úzkej obrazovke je dovtedy skrytý), potom merať terminál.
  renderList();
  mountBody();
  updateHeader(s);
}

/** Obsah podľa režimu: chat alebo terminál, a k nemu klávesy. */
function mountBody() {
  const id = openId;
  const body = paneEl.querySelector<HTMLElement>(".body");
  const keys = paneEl.querySelector<HTMLElement>(".keys");
  if (!id || !body || !keys) return;
  // V chate stačí Esc (prerušenie); šípky a Tab patria k terminálu.
  keys.replaceChildren(...REMOTE_KEYS.filter((k) => mode === "terminal" || k.id === "esc").map((k) => {
    const b = h("button", "key", t(`remote.keys.${k.id}` as Key));
    b.type = "button";
    // mousedown nesmie zobrať fokus poľu, inak sa zavrie klávesnica
    b.onmousedown = (e) => e.preventDefault();
    b.onclick = () => send({ type: "input", id, data: k.seq });
    return b;
  }));
  if (mode === "chat") {
    chatEl = h("div", "chat");
    chatEl.setAttribute("role", "log");
    chatEl.append(h("p", "chat-empty", t("remote.chatEmpty")));
    body.replaceChildren(chatEl);
  } else {
    const host = h("div", "term");
    body.replaceChildren(host);
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
    resizeObserver = new ResizeObserver(() => sendResize());
    resizeObserver.observe(host);
  }
  if (!document.hidden) attach();
}

function setMode(next: Mode) {
  if (!openId || next === mode) return;
  detach();
  mode = next;
  mountBody();
  const s = snapshot?.sessions.find((x) => x.id === openId);
  if (s) updateHeader(s);
}

/** Začne sledovať otvorenú session podľa režimu (aj po znovupripojení či návrate na stránku). */
function attach() {
  if (!openId) return;
  if (mode === "chat") send({ type: "chatOpen", id: openId });
  else subscribe(openId);
}

/** Prestane sledovať otvorenú session a uvoľní terminál. */
function detach() {
  if (openId) send(mode === "chat" ? { type: "chatClose", id: openId } : { type: "unsubscribe", id: openId });
  pendingSubscribe = false;
  disposeTerminal();
  chatEl = null;
}

function disposeTerminal() {
  resizeObserver?.disconnect();
  resizeObserver = null;
  term?.dispose();
  term = null;
  fit = null;
}

function closeSession() {
  detach();
  openId = null;
  paneEl.replaceChildren(h("p", "pane-empty", t("remote.pick")));
  renderList();
}

function appendChat(items: ChatItem[], reset: boolean) {
  const el = chatEl;
  if (!el) return;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  if (reset) el.replaceChildren();
  if (items.length) el.querySelector(".chat-empty")?.remove();
  else if (reset) el.append(h("p", "chat-empty", t("remote.chatEmpty")));
  for (const item of items) el.append(safeChatItem(item));
  while (el.childElementCount > CHAT_DOM_LIMIT) el.firstElementChild?.remove();
  if (reset || atBottom) el.scrollTop = el.scrollHeight;
}

/** Správa, ktorú sa nepodarí vykresliť, ostane ako obyčajný text, nezastaví zvyšok chatu. */
function safeChatItem(item: ChatItem): HTMLElement {
  try {
    return chatItem(item);
  } catch {
    const row = h("div", `msg ${item.role}`);
    row.append(h("div", item.role === "user" ? "bubble" : "plain", item.text));
    return row;
  }
}

function chatItem(item: ChatItem): HTMLElement {
  if (item.role === "user") {
    const row = h("div", "msg user");
    row.append(h("div", "bubble", item.text));
    return row;
  }
  if (item.role === "tool") {
    const row = h("div", "msg tool");
    row.append(h("span", "tool-name", `⚙ ${item.name ?? ""}`), h("span", "tool-text", item.text));
    return row;
  }
  const row = h("div", "msg assistant md");
  row.append(...parseMarkdown(item.text).map(blockNode));
  return row;
}

function blockNode(b: Block): HTMLElement {
  switch (b.t) {
    case "h": return withInline(h(`h${Math.min(b.level + 2, 6)}` as "h3"), b.c);
    case "p": return withInline(h("p"), b.c);
    case "code": {
      const pre = h("pre");
      pre.append(h("code", "", b.v));
      return pre;
    }
    case "list": {
      const list = h(b.ordered ? "ol" : "ul");
      if (b.ordered && b.start !== 1) (list as HTMLOListElement).start = b.start;
      for (const item of b.items) list.append(withInline(h("li"), item));
      return list;
    }
    case "quote": {
      const q = h("blockquote");
      q.append(...b.c.map(blockNode));
      return q;
    }
    case "table": {
      const wrap = h("div", "table-wrap");
      const table = h("table");
      const head = h("tr");
      for (const c of b.head) head.append(withInline(h("th"), c));
      const thead = h("thead");
      thead.append(head);
      const tbody = h("tbody");
      for (const r of b.rows) {
        const tr = h("tr");
        for (const c of r) tr.append(withInline(h("td"), c));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      wrap.append(table);
      return wrap;
    }
    case "hr": return h("hr");
  }
}

function withInline<E extends HTMLElement>(e: E, parts: Inline[]): E {
  e.append(...parts.map(inlineNode));
  return e;
}

function inlineNode(p: Inline): Node {
  switch (p.t) {
    case "text": return document.createTextNode(p.v);
    case "code": return h("code", "", p.v);
    case "b": return withInline(h("strong"), p.c);
    case "i": return withInline(h("em"), p.c);
    case "a": {
      const a = withInline(h("a"), p.c);
      a.href = p.href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      return a;
    }
  }
}

// Skrytá stránka (zamknutý telefón, iná appka) sessions nesleduje, inak by na desktope stlmila upozornenia.
document.addEventListener("visibilitychange", () => {
  if (!openId) return;
  if (document.hidden) {
    send(mode === "chat" ? { type: "chatClose", id: openId } : { type: "unsubscribe", id: openId });
    pendingSubscribe = false;
  } else {
    attach();
  }
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
