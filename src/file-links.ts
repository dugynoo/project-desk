import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { writeClipboard } from "./clipboard.ts";
import { call } from "./ipc.ts";
import { popupMenu, type MenuItem } from "./dom.ts";
import { errorText, type Key, t } from "./i18n.ts";
import { fileOpenTarget, findFileRefs, linkEditorMode, relativePath, type EditorInfo, type PersistedState, type Session } from "./model.ts";
import type { Runtime } from "./terminal-runtime.ts";
import type { createDialogs } from "./dialogs.ts";

interface Dependencies {
  getState(): PersistedState;
  platform(): string;
  toast(message: string): void;
  confirmBox: ReturnType<typeof createDialogs>["confirmBox"];
  /** The built-in text editor was shown or hidden. */
  editorVisibilityChanged(visible: boolean): void;
}

const REVEAL_LABEL: Record<string, Key> = { windows: "menu.revealWindows", macos: "menu.revealMac" };
const OPEN_FOLDER_LABEL: Record<string, Key> = { windows: "project.openFolderWindows", macos: "project.openFolderMac" };

/** Links in terminals and opening files, folders and URLs: external editor, built-in editor, default app. */
export function createFileLinks({ getState, platform, toast, confirmBox, editorVisibilityChanged }: Dependencies) {
  const project = (id: string) => getState().projects.find(p => p.id === id);
  let textEditor: ReturnType<typeof import("./text-editor.ts")["createTextEditor"]> | undefined;
  let loadingEditor: Promise<void> | undefined;
  let installedEditors: EditorInfo[] = [];
  void call("list_editors").then(editors => {
    installedEditors = editors; textEditor?.configure();
  }).catch(() => {});

  function openLink(url: string) {
    void openUrl(url).catch((err) => toast(t("link.openFailed", { detail: String(err) })));
  }

  function externalEditorLabel() {
    const settings = getState().settings;
    const name = settings.editorId === "custom" ? settings.customEditorPath.split(/[\\/]/).at(-1)
      : installedEditors.find(editor => editor.id === settings.editorId)?.label
        ?? (!settings.editorId ? installedEditors[0]?.label : undefined);
    return name ? t("editor.openNamed", { name }) : t("editor.external");
  }

  function openEditor(path: string, line?: number) {
    const { editorId: id, customEditorPath: customPath, customEditorArgs: customArgs } = getState().settings;
    call("open_in_editor", { editor: { id, customPath, customArgs }, path, line: line ?? null }).catch((e) =>
      toast(errorText(e)),
    );
  }

  async function openTextEditor(file?: string, line?: number, mode: "preview" | "edit" = "edit") {
    try {
      if (!file) {
        const selected = await openDialog({ directory: false, multiple: false });
        if (!selected || typeof selected !== "string") return;
        file = selected;
      }
      loadingEditor ??= import("./text-editor.ts").then(module => {
        textEditor = module.createTextEditor(
          () => confirmBox(t("textEditor.discard"), t("textEditor.discardBody"), t("textEditor.discardOk")),
          path => openEditor(path),
          editorVisibilityChanged,
          () => getState().settings,
          externalEditorLabel,
          openLink,
        );
      }).catch(e => { loadingEditor = undefined; throw e; });
      await loadingEditor;
      await textEditor!.open(file, line, false, mode);
    } catch (e) { toast(errorText(e)); }
  }

  /** Ctrl+klik na súbor: prípony z nastavení idú do predvolenej aplikácie, ostatné do editora. */
  function openFile(file: string, line?: number) {
    const settings = getState().settings;
    const target = fileOpenTarget(file, settings);
    const openPreferred = () => settings.fileEditor === "external" ? openEditor(file, line)
      : void openTextEditor(file, line, linkEditorMode(file, settings));
    if (target !== "system") return openPreferred();
    // Spustiteľný súbor backend odmietne; vtedy ho otvoríme aspoň v editore.
    void openDefault(file, false).then((ok) => {
      if (!ok) openPreferred();
    });
  }

  /** false = spustiteľný súbor, ktorý sa predvolenou aplikáciou neotvára (s `explain` to aj povie). */
  async function openDefault(file: string, explain = true): Promise<boolean> {
    try {
      await call("open_file_default", { path: file });
      return true;
    } catch (e) {
      if (e === "file.runnable" && !explain) return false;
      toast(errorText(e));
      return e !== "file.runnable";
    }
  }

  async function revealFile(file: string) {
    await call("reveal_file", { path: file }).catch((e) => toast(errorText(e)));
  }

  const openFolderLabel = () => t(OPEN_FOLDER_LABEL[platform()] ?? "project.openFolderLinux");
  function openFolder(path: string) {
    void call("open_folder", { path }).catch((e) => toast(errorText(e)));
  }

  const resolved = new Map<string, string | null>();
  async function resolveFile(cwd: string, candidate: string): Promise<string | null> {
    const key = `${cwd}\n${candidate}`;
    if (resolved.has(key)) return resolved.get(key)!;
    const file = await call("resolve_file", { cwd, candidate }).catch(() => null);
    if (resolved.size > 2000) resolved.clear();
    // Neexistujúce cesty si pamätáme len chvíľu, súbor môže agent práve vytvoriť.
    resolved.set(key, file);
    if (!file) window.setTimeout(() => resolved.delete(key), 10_000);
    return file;
  }

  /** Ctrl+klik na URL otvorí prehliadač, na cestu k súboru editor alebo predvolenú aplikáciu. Pravý klik ukáže menu. */
  function setupLinks(rt: Runtime, s: Session) {
    const hover = (key: Key, link: NonNullable<Runtime["hoverLink"]>) => {
      rt.host.title = t(key);
      rt.hoverLink = link;
    };
    const leave = () => {
      rt.host.title = "";
      rt.hoverLink = undefined;
    };
    const wantsOpen = (e: MouseEvent) => e.ctrlKey || e.metaKey;
    rt.term.loadAddon(
      new WebLinksAddon(
        (e, uri) => {
          if (wantsOpen(e)) openLink(uri);
        },
        { hover: (_e, uri) => hover("link.urlHint", { url: uri }), leave },
      ),
    );
    rt.term.registerLinkProvider({
      provideLinks(y, callback) {
        const p = project(s.projectId);
        const text = rt.term.buffer.active.getLine(y - 1)?.translateToString(true) ?? "";
        const refs = p ? findFileRefs(text, p.path) : [];
        if (!refs.length) return callback(undefined);
        void Promise.all(refs.map((r) => resolveFile(p!.path, r.path))).then((resolved) => {
          const links = refs.flatMap((r, i) => {
            const file = resolved[i];
            if (!file) return [];
            return [
              {
                range: { start: { x: r.index + 1, y }, end: { x: r.index + r.length, y } },
                text: text.slice(r.index, r.index + r.length),
                activate: (e: MouseEvent) => {
                  if (wantsOpen(e)) openFile(file, r.line);
                },
                hover: () => hover("link.fileHint", { file, line: r.line }),
                leave,
              },
            ];
          });
          callback(links.length ? links : undefined);
        });
      },
    });
    rt.host.addEventListener("contextmenu", (e) => {
      const link = rt.hoverLink;
      if (!link) return;
      e.preventDefault();
      e.stopPropagation();
      // macOS posiela Ctrl+klik ako pravý klik (bez click), takže ho tu otvoríme rovnako ako na iných systémoch.
      if (e.ctrlKey && platform() === "macos") {
        if ("url" in link) openLink(link.url);
        else openFile(link.file, link.line);
        return;
      }
      if ("url" in link) {
        popupMenu(e.clientX, e.clientY, [
          [t("menu.openLink"), () => openLink(link.url)],
          [t("menu.copyLink"), () => void writeClipboard(link.url)],
        ]);
        return;
      }
      const rel = relativePath(project(s.projectId)?.path ?? "", link.file);
      const items: MenuItem[] = [
        [t("textEditor.title"), () => void openTextEditor(link.file, link.line)],
        [externalEditorLabel(), () => openEditor(link.file, link.line)],
        [t("menu.openDefault"), () => void openDefault(link.file)],
        [t(REVEAL_LABEL[platform()] ?? "menu.revealLinux"), () => void revealFile(link.file)],
        [t("menu.copyPath"), () => void writeClipboard(link.file)],
      ];
      if (rel) items.push([t("menu.copyRelative"), () => void writeClipboard(rel)]);
      popupMenu(e.clientX, e.clientY, items);
    });
  }

  return {
    setupLinks, openEditor, openTextEditor, openFolder, openFolderLabel,
    /** Settings changed: the built-in editor rereads its options. */
    configureEditor: () => textEditor?.configure(),
    /** Unsaved changes in the built-in editor. */
    editorPending: () => textEditor?.pending() ?? false,
    /** The built-in editor agrees to close (asks about unsaved changes). */
    editorMayClose: async () => !textEditor || await textEditor.mayClose(),
  };
}
