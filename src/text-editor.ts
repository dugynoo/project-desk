import { EditorView, basicSetup } from "codemirror";
import { Compartment, EditorState, type Text } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { invoke } from "@tauri-apps/api/core";
import { Marked } from "marked";
import DOMPurify from "dompurify";
import { el, $ } from "./dom.ts";
import { t, errorText } from "./i18n.ts";
import { isMarkdown, linkEditorMode, textFileFormat, type Settings } from "./model.ts";

export type EditorMode = "preview" | "edit";

const escapeAttr = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
// Obrázky sa nenačítavajú (CSP aj súkromie); ostane z nich odkaz s alt textom.
const markdown = new Marked({ gfm: true, renderer: {
  image: ({ href, text }) => `<a href="${escapeAttr(href)}">${escapeAttr(text || href)}</a>`,
} });

/** Markdown ako bezpečné HTML: bez skriptov, štýlov a formulárov. */
export function markdownHtml(source: string): string {
  return DOMPurify.sanitize(markdown.parse(source, { async: false }), {
    FORBID_TAGS: ["style", "form", "img", "iframe"], FORBID_ATTR: ["style"],
  });
}

type Document = { path: string; text: string };
export function createTextEditor(confirmDiscard: () => Promise<boolean>, external: (path: string) => void,
  visibilityChanged: (visible: boolean) => void = () => {},
  getSettings: () => Pick<Settings, "editorFontSize" | "editorWordWrap" | "markdownOpen"> = () => ({ editorFontSize: 13, editorWordWrap: false, markdownOpen: "preview" }),
  externalLabel: () => string = () => t("editor.external"),
  openLink: (url: string) => void = () => {}) {
  const preview = el("div", "markdown-preview");
  preview.hidden = true;
  preview.tabIndex = 0;
  let mode: EditorMode = "edit";
  const appearance = new Compartment();
  const appearanceExtensions = () => {
    const settings = getSettings();
    preview.style.fontSize = `${settings.editorFontSize}px`;
    return [EditorView.theme({ "&": { fontSize: `${settings.editorFontSize}px` } }),
      ...(settings.editorWordWrap ? [EditorView.lineWrapping] : [])];
  };
  function configure() {
    view?.dispatch({ effects: appearance.reconfigure(appearanceExtensions()) });
    outside.textContent = fallback.textContent = externalLabel();
  }
  let view: EditorView | undefined;
  let document: Document | undefined;
  let savedDoc: Text | undefined;
  let bom = "", separator = "\n";
  let busy = false;
  let checking = false;
  const panel = el("section", "text-editor");
  panel.hidden = true;
  panel.setAttribute("aria-label", t("textEditor.title"));
  const bar = el("div", "text-editor-bar");
  const title = el("span", "text-editor-title");
  const saveButton = el("button", "", t("textEditor.save"));
  const reload = el("button", "", t("textEditor.reload"));
  const modeButton = el("button");
  modeButton.title = t("textEditor.modeHint");
  const outside = el("button", "", externalLabel());
  const fallback = el("button", "", externalLabel());
  fallback.hidden = true;
  const close = el("button", "", "×");
  close.setAttribute("aria-label", t("common.close"));
  const message = el("div", "text-editor-message");
  message.setAttribute("role", "status");
  const host = el("div", "text-editor-host");
  function reveal() {
    const wasHidden = panel.hidden;
    panel.hidden = divider.hidden = false;
    if (wasHidden) visibilityChanged(true);
  }
  bar.append(title, modeButton, saveButton, reload, outside, close);
  panel.append(bar, message, fallback, host, preview);
  const divider = el("div", "editor-divider");
  divider.hidden = true;
  divider.tabIndex = 0;
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "vertical");
  divider.setAttribute("aria-label", t("textEditor.resize"));
  divider.setAttribute("aria-valuemin", "25");
  divider.setAttribute("aria-valuemax", "75");
  let width = 50;
  function resize(value: number) {
    width = Math.max(25, Math.min(75, value));
    panel.style.flexBasis = `${width}%`;
    divider.setAttribute("aria-valuenow", String(Math.round(width)));
  }
  resize(width);
  divider.onpointerdown = e => { if (e.button === 0) { divider.setPointerCapture(e.pointerId); e.preventDefault(); } };
  divider.onpointermove = e => {
    if (!divider.hasPointerCapture(e.pointerId)) return;
    const rect = $("#workspace").getBoundingClientRect();
    resize((rect.right - e.clientX) / rect.width * 100);
  };
  divider.onkeydown = e => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); resize(width + (e.key === "ArrowLeft" ? 5 : -5)); }
  };
  $("#workspace").append(divider, panel);
  // Editor shortcuts must never become terminal/application shortcuts.
  panel.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key.toLowerCase() === "v" && e.shiftKey && (e.ctrlKey || e.metaKey) && !e.altKey && canPreview()) {
      e.preventDefault();
      setMode(mode === "preview" ? "edit" : "preview");
    }
  });
  const raw = () => bom + (view?.state.doc.toString() ?? "").replace(/\n/g, separator);
  const dirty = () => !!view && !!savedDoc && !view.state.doc.eq(savedDoc);
  const canPreview = () => !!view && !!document && isMarkdown(document.path);
  /** Náhľad vždy ukazuje aktuálny obsah editora, aj neuložený. */
  function setMode(next: EditorMode) {
    mode = canPreview() ? next : "edit";
    if (mode === "preview") {
      preview.innerHTML = markdownHtml(view!.state.doc.toString());
      for (const pre of preview.querySelectorAll("pre")) {
        const copy = el("button", "markdown-copy", t("textEditor.copy"));
        copy.onclick = () => void navigator.clipboard.writeText(pre.querySelector("code")?.textContent ?? "")
          .then(() => { copy.textContent = t("info.copied"); setTimeout(() => (copy.textContent = t("textEditor.copy")), 1500); });
        pre.append(copy);
      }
    } else preview.replaceChildren();
    preview.hidden = mode !== "preview";
    host.hidden = mode === "preview";
    refresh();
    if (mode === "preview") preview.focus(); else view?.focus();
  }
  preview.addEventListener("click", e => {
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (!link || !document) return;
    e.preventDefault();
    const href = link.getAttribute("href") ?? "";
    if (/^(https?:|mailto:)/i.test(href)) { openLink(href); return; }
    // Relatívny odkaz na súbor vedľa dokumentu; kotvy a iné schémy ignorujeme.
    let target: string;
    try { target = decodeURIComponent(href.split("#")[0]); } catch { return; }
    // Schéma má aspoň dve písmená; `C:` (disk na Windows) odmietne až kontrola nižšie.
    if (!target || /^[a-z][a-z0-9+.-]+:/i.test(target)) return;
    // Iba relatívne cesty: UNC (`\\server\share`) by na Windows poslal NTLM hash cudziemu serveru.
    if (/^([\\/]|[a-z]:)/i.test(target)) return;
    const base = document.path.replace(/[^\\/]*$/, "");
    void open(base + target, 1, false, linkEditorMode(target, getSettings()));
  });
  function refresh() {
    title.textContent = (dirty() ? "● " : "") + (document?.path.split(/[\\/]/).at(-1) ?? "");
    title.title = document?.path ?? "";
    saveButton.disabled = busy || !dirty();
    reload.disabled = busy || !document;
    outside.disabled = busy || !document;
    close.disabled = fallback.disabled = busy;
    modeButton.hidden = !canPreview();
    modeButton.textContent = t(mode === "preview" ? "textEditor.edit" : "textEditor.preview");
    modeButton.setAttribute("aria-pressed", String(mode === "preview"));
  }
  async function mayClose() {
    if (busy) return false;
    if (!dirty()) return true;
    const discard = await confirmDiscard();
    if (!discard) view?.focus();
    return discard;
  }
  async function save() {
    if (busy || !view || !document || !dirty()) return;
    busy = true; refresh();
    const text = raw();
    const snapshot = view.state.doc;
    try {
      await invoke("text_save", { path: document.path, expected: document.text, text });
      document.text = text; savedDoc = snapshot; message.textContent = t("textEditor.saved");
    } catch (e) { message.textContent = errorText(e); }
    finally { busy = false; refresh(); }
  }
  async function open(path: string, line = 1, force = false, requested: EditorMode = "edit") {
    if (busy) return;
    if (!force && document?.path === path && view) { setMode(requested); return; }
    if (!await mayClose() || busy) return;
    busy = true; refresh();
    fallback.hidden = true;
    try {
      const doc = await invoke<Document>("text_open", { path });
      const format = textFileFormat(doc.text);
      if (!format) throw "file.textOnly";
      view?.destroy(); host.replaceChildren();
      document = doc; bom = format.bom; separator = format.separator;
      const language = new Compartment();
      view = new EditorView({ parent: host, state: EditorState.create({
        doc: format.text,
        extensions: [basicSetup, oneDark, language.of([]), appearance.of(appearanceExtensions()),
          keymap.of([{ key: "Mod-s", run: () => { void save(); return true; } }]),
          EditorView.updateListener.of(update => { if (update.docChanged) refresh(); }),
          EditorView.contentAttributes.of({ "aria-label": doc.path }),
        ],
      }) });
      savedDoc = view.state.doc;
      reveal();
      message.textContent = "";
      const pos = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines))).from;
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      setMode(requested);
      const current = view;
      const description = LanguageDescription.matchFilename(languages, path.split(/[\\/]/).at(-1) ?? path);
      void description?.load().then(support => {
        if (view === current) current.dispatch({ effects: language.reconfigure(support) });
      }).catch(() => {}); // Plain text remains usable if a language chunk fails.
    } catch (e) {
      reveal();
      setMode("edit");
      message.textContent = errorText(e);
      fallback.textContent = externalLabel();
      fallback.onclick = () => external(path);
      fallback.hidden = false;
    } finally { busy = false; refresh(); }
  }
  saveButton.onclick = () => void save();
  reload.onclick = () => { if (document) void open(document.path, 1, true, mode); };
  modeButton.onclick = () => setMode(mode === "preview" ? "edit" : "preview");
  outside.onclick = () => { if (document) external(document.path); };
  close.onclick = async () => {
    if (!await mayClose() || busy) return;
    view?.destroy(); view = undefined; document = undefined; savedDoc = undefined;
    host.replaceChildren(); setMode("edit"); panel.hidden = divider.hidden = true;
    visibilityChanged(false);
    $("#stage").querySelector<HTMLTextAreaElement>(".pane.visible.focused textarea")?.focus();
  };
  // Event-driven check only when returning to the app. Save always rechecks in Rust.
  window.addEventListener("focus", async () => {
    if (!document || busy || checking) return;
    checking = true; const current = document;
    try {
      const fresh = await invoke<Document>("text_open", { path: current.path });
      if (document === current && fresh.text !== current.text) message.textContent = t("err.file.conflict");
    } catch (e) { if (document === current) message.textContent = errorText(e); }
    finally { checking = false; }
  });
  return { open, configure, mayClose, pending: () => busy || dirty() };
}
