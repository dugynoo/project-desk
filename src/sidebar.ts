import { $, el, iconButton, onNextFrame } from "./dom.ts";
import { createBranches } from "./branches.ts";
import { openSessionMenu, openActionMenu, type MenuAction } from "./session-menu.ts";
import { ATTENTION, moveProject, orderedProjects, sessionsOf, PROVIDER_LABEL,
  type PersistedState, type Project, type Provider, type Session, type Status } from "./model.ts";
import { t } from "./i18n.ts";

interface SidebarDependencies {
  getState(): PersistedState;
  runtimes: ReadonlyMap<string, { running: boolean; term: { focus(): void } }>;
  unread: ReadonlySet<string>;
  providerIcons: Record<Provider, string>;
  loadBranch(path: string): Promise<string | null>;
  statusOf(id: string): Status;
  statusLabel(status: Status): string;
  contextLabel(session: Session): string;
  save(): void;
  renderPaneHeads(): void;
  select(id: string): void;
  createSession(project: Project, provider: Provider): void;
  start(session: Session): Promise<unknown>;
  closeSession(session: Session): Promise<unknown>;
  removeProject(project: Project): Promise<unknown>;
  openEditor(path: string): void;
  showImport(project: Project): void;
  showInfo(session: Session): void;
  jumpAttention(): void;
  showClosedSessions(): void;
  showNotifications(): void;
  refreshNotifications(): void;
}

/** Owns sidebar DOM and transient interaction state; application state stays with the caller. */
export function createSidebar(deps: SidebarDependencies) {
  const { getState, runtimes, unread, statusOf, statusLabel, contextLabel, save,
    renderPaneHeads, select, createSession, start, closeSession, removeProject,
    openEditor, showImport, showInfo, jumpAttention, showClosedSessions } = deps;
  const PROVIDER_ICON = deps.providerIcons;
  const session = (id: string) => getState().sessions.find(s => s.id === id);
  let attentionOnly = false;
  // Premenovanie priamo v zozname. Sidebar sa prekresľuje aj pri zmene stavu,
  // preto si rozpísaný text držíme mimo DOM.
  let editing: { id: string; draft: string; selectAll: boolean } | undefined;
  let rerendering = false;

  function startRename(s: Session, render = true) {
    editing = { id: s.id, draft: s.title, selectAll: true };
    if (render) renderSidebar();
  }

  function finishRename(commit: boolean) {
    if (!editing) return;
    const s = session(editing.id);
    const title = editing.draft.trim();
    editing = undefined;
    if (s && commit && title) {
      s.title = title;
      save();
      renderPaneHeads();
    }
    renderSidebar();
    runtimes.get(getState().ui.activeSessionId ?? "")?.term.focus();
  }

  function renameInput(): HTMLInputElement {
    const input = el("input", "title-edit");
    input.type = "text";
    input.value = editing!.draft;
    input.spellcheck = false;
    input.addEventListener("input", () => {
      if (editing) editing.draft = input.value;
    });
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") finishRename(true);
      else if (e.key === "Escape") finishRename(false);
    });
    input.addEventListener("blur", () => {
      if (!rerendering) finishRename(true);
    });
    for (const ev of ["click", "dblclick", "mousedown"]) input.addEventListener(ev, (e) => e.stopPropagation());
    return input;
  }

  function renderAttention() {
    const root = $("#attention");
    const count = (status: Status) => getState().sessions.filter((s) => statusOf(s.id) === status).length;
    const summary = el("div", "attention-summary", t("attention.summary", {
      waiting: count("needs-you"), done: count("done"), working: count("working"),
    }));
    const filter = el("button", attentionOnly ? "on" : "", t("sidebar.attention"));
    filter.id = "btn-attention";
    filter.setAttribute("aria-pressed", String(attentionOnly));
    filter.onclick = () => { attentionOnly = !attentionOnly; renderSidebar(); };
    const next = iconButton("→", t("attention.next"), jumpAttention);
    next.disabled = !getState().sessions.some(s => ATTENTION.has(statusOf(s.id)));
    root.replaceChildren(summary, filter, next);
    const footer = $("#sidebar-footer");
    const history = el("button", "", t("sidebar.history"));
    history.id = "btn-history";
    history.onclick = showClosedSessions;
    const alerts = el("button", "", t("sidebar.notifications"));
    alerts.id = "btn-notifications";
    const unreadCount = getState().notifications.filter(n => !n.read).length;
    if (unreadCount) alerts.append(el("span", "count-badge", String(unreadCount)));
    alerts.onclick = deps.showNotifications;
    footer.replaceChildren(alerts, history);
    deps.refreshNotifications();
  }


  // Presúvanie projektov ťahaním. Počas ťahania sa zoznam neprekresľuje, inak by zmizol cieľ.
  let projectDrag: { id: string; moved: boolean } | undefined;

  function startProjectDrag(e: PointerEvent, p: Project, box: HTMLElement) {
    if (e.button !== 0 || (e.target as HTMLElement).closest("button, input")) return;
    const startY = e.clientY;
    projectDrag = { id: p.id, moved: false };
    let target: { id: string; after: boolean } | undefined;
    const clearMarks = () => document.querySelectorAll(".project.drop-before, .project.drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    const move = (ev: PointerEvent) => {
      if (!projectDrag) return;
      if (!projectDrag.moved && Math.abs(ev.clientY - startY) < 5) return;
      projectDrag.moved = true;
      box.classList.add("dragging");
      clearMarks();
      const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest<HTMLElement>(".project");
      target = undefined;
      if (over?.dataset.id && over.dataset.id !== p.id) {
        const r = over.getBoundingClientRect();
        target = { id: over.dataset.id, after: ev.clientY > r.top + r.height / 2 };
        over.classList.add(target.after ? "drop-after" : "drop-before");
      }
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      clearMarks();
      box.classList.remove("dragging");
      if (!projectDrag?.moved) {
        projectDrag = undefined;
        return;
      }
      if (target) {
        getState().projects = moveProject(getState().projects, p.id, target.id, target.after);
        save();
      }
      // Click, ktorý príde hneď po pustení, ešte uvidí `moved` a projekt nezbalí.
      window.setTimeout(() => {
        projectDrag = undefined;
        renderSidebar();
      }, 0);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  let closeSessionMenu: (() => void) | undefined;
  let sidebarMenuOpen = false;
  const refreshAfterMenu = onNextFrame(() => renderSidebar());
  function sidebarMenuClosed() {
    sidebarMenuOpen = false; closeSessionMenu = undefined; refreshAfterMenu();
  }
  function actionsButton(actions: () => MenuAction[], focusId: string) {
    const button = iconButton("⋯", t("sidebar.more"), () => {
      const wasOpen = button.getAttribute("aria-expanded") === "true";
      closeSessionMenu?.();
      if (wasOpen) return;
      sidebarMenuOpen = true;
      closeSessionMenu = openActionMenu(button, actions(), sidebarMenuClosed);
    });
    button.dataset.focusId = focusId;
    button.setAttribute("aria-haspopup", "menu"); button.setAttribute("aria-expanded", "false");
    button.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); button.click(); } };
    return button;
  }

  const branches = createBranches(deps.loadBranch, () => renderSidebar());
  function refreshBranches(revisit = false, paths = getState().projects.map(p => p.path)) {
    branches.configure(getState().settings.showGitBranch, getState().projects.map(p => p.path));
    branches.refresh(paths, revisit);
  }
  function renderSidebar() {
    refreshBranches();
    if (projectDrag || sidebarMenuOpen) return;
    closeSessionMenu?.();
    closeSessionMenu = undefined;
    const focused = document.activeElement as HTMLElement;
    const focusId = focused.closest("#sidebar") ? focused.dataset.focusId || focused.id : undefined;
    renderAttention();
    const root = $("#projects");
    const prevInput = root.querySelector<HTMLInputElement>("input.title-edit");
    const caret = prevInput ? [prevInput.selectionStart ?? 0, prevInput.selectionEnd ?? 0] : undefined;
    rerendering = true;
    root.replaceChildren();
    rerendering = false;
    let editInput: HTMLInputElement | undefined;
    for (const p of orderedProjects(getState().projects)) {
      if (attentionOnly && !sessionsOf(getState(), p.id).some((s) => ATTENTION.has(statusOf(s.id)))) continue;
      const box = el("div", "project");
      box.dataset.id = p.id;
      const row = el("div", "project-row");
      row.title = t("project.rowTitle", { path: p.path });
      const actions = el("span", "row-actions");
      const defaultProvider = getState().settings.defaultProvider;
      const launch = iconButton("+", t("project.newDefault", { provider: PROVIDER_LABEL[defaultProvider] }), () => void createSession(p, getState().settings.defaultProvider));
      const more = iconButton("▾", t("project.otherSessions"), () => {
        const wasOpen = more.getAttribute("aria-expanded") === "true";
        closeSessionMenu?.();
        if (!wasOpen) {
          sidebarMenuOpen = true;
          closeSessionMenu = openSessionMenu(more, getState().settings.defaultProvider, (provider) => void createSession(p, provider), () => showImport(p), sidebarMenuClosed);
        }
      });
      more.setAttribute("aria-haspopup", "menu");
      more.setAttribute("aria-expanded", "false");
      more.onkeydown = (e) => {
        if (e.key === "ArrowDown") { e.preventDefault(); more.click(); }
      };
      const launcher = el("span", "session-launcher");
      launcher.append(launch, more);
      launch.dataset.focusId = `launch-${p.id}`; more.dataset.focusId = `providers-${p.id}`;
      actions.append(launcher, actionsButton(() => [
        { label: t("project.openEditor"), run: () => openEditor(p.path) },
        { label: t(p.pinned ? "project.unpin" : "project.pin"), run: () => { p.pinned = !p.pinned; save(); renderSidebar(); } },
        { label: t("project.remove"), danger: true, separator: true, run: () => void removeProject(p) },
      ], `project-menu-${p.id}`));
      const name = el("span", "name", p.name);
      name.title = p.name;
      const branch = branches.get(p.path);
      if (branch) {
        name.append(el("span", "git-branch", " · " + branch));
        name.title = p.name + " · " + branch;
      }
      if (p.pinned) name.prepend(el("span", "pin", "★ "));
      const disclosure = el("div", "project-disclosure");
      disclosure.setAttribute("role", "button"); disclosure.tabIndex = 0;
      disclosure.dataset.focusId = `project-${p.id}`;
      disclosure.setAttribute("aria-expanded", String(!p.collapsed || attentionOnly));
      disclosure.setAttribute("aria-label", p.name);
      disclosure.append(el("span", "chev", p.collapsed ? "▸" : "▾"), name);
      const waiting = sessionsOf(getState(), p.id).filter(s => statusOf(s.id) === "needs-you").length;
      if (p.collapsed && waiting) {
        const badge = el("span", "count-badge waiting", String(waiting));
        badge.title = t("sidebar.waiting", { n: waiting }); disclosure.append(badge);
        disclosure.setAttribute("aria-label", `${p.name}: ${badge.title}`);
      }
      row.append(disclosure, actions);
      disclosure.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); row.click(); } };
      row.addEventListener("pointerdown", (e) => startProjectDrag(e, p, box));
      row.addEventListener("click", () => {
        if (projectDrag?.moved) return;
        p.collapsed = !p.collapsed;
        if (!p.collapsed) refreshBranches(true, [p.path]);
        save();
        renderSidebar();
      });
      box.append(row);

      if (!p.collapsed || attentionOnly) {
        for (const s of sessionsOf(getState(), p.id)) {
          if (attentionOnly && !ATTENTION.has(statusOf(s.id))) continue;
          const st = statusOf(s.id);
          const item = el("div", "session");
          item.classList.toggle("active", s.id === getState().ui.activeSessionId);
          item.classList.toggle("unread", unread.has(s.id) || getState().notifications.some(n => n.sessionId === s.id && !n.read));
          const body = el("div", "body");
          body.tabIndex = 0; body.setAttribute("role", "button"); body.dataset.focusId = `session-${s.id}`;
          body.setAttribute("aria-label", `${s.title}, ${PROVIDER_LABEL[s.provider]}, ${statusLabel(st)}`);
          body.setAttribute("aria-pressed", String(s.id === getState().ui.activeSessionId));
          body.onkeydown = e => {
            if (e.target instanceof HTMLInputElement) return;
            if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(s.id); }
          };
          if (editing?.id === s.id) {
            body.removeAttribute("role"); body.removeAttribute("aria-pressed"); body.tabIndex = -1;
            editInput = renameInput();
            const line = el("div", "title");
            line.append(document.createTextNode(`${PROVIDER_ICON[s.provider]}  `), editInput);
            body.append(line);
          } else {
            body.append(el("div", "title", `${PROVIDER_ICON[s.provider]}  ${s.title}`));
          }
          body.append(el("div", "sub", `${statusLabel(st)}${s.stopped && s.exitCode != null ? ` (${s.exitCode})` : ""}${contextLabel(s)}`));
          const actions = el("span", "row-actions");
          if (!runtimes.get(s.id)?.running) {
            const restart = iconButton("↻", t("session.restart"), () => void start(s));
            restart.dataset.focusId = `restart-${s.id}`; actions.append(restart);
          }
          const sessionActions = () => [
            { label: t("session.rename"), run: () => startRename(s) },
            { label: t("session.info"), run: () => showInfo(s) },
            { label: t(runtimes.get(s.id)?.running ? "session.closeTerminal" : "session.removeFromList"), danger: true, separator: true, run: () => void closeSession(s) },
          ];
          const moreActions = actionsButton(sessionActions, `session-menu-${s.id}`);
          actions.append(moreActions);
          item.append(el("span", `dot ${st}`), body, actions);
          item.addEventListener("click", () => select(s.id));
          item.addEventListener("dblclick", () => startRename(s));
          item.addEventListener("contextmenu", (e) => {
            e.preventDefault();
            moreActions.click();
          });
          box.append(item);
        }
      }
      root.append(box);
    }
    if (!root.children.length && attentionOnly) root.append(el("p", "sidebar-empty", t("sidebar.empty")));
    if (focusId && !focused.isConnected && document.activeElement === document.body) {
      const target = Array.from(document.querySelectorAll<HTMLElement>("#sidebar [data-focus-id], #sidebar [id]"))
        .find(node => node.dataset.focusId === focusId || node.id === focusId);
      target?.focus({ preventScroll: true });
    }
    if (editInput && editing) {
      editInput.focus();
      if (editing.selectAll) {
        editInput.select();
        editing.selectAll = false;
      } else {
        const [from, to] = caret ?? [editInput.value.length, editInput.value.length];
        editInput.setSelectionRange(from, to);
      }
    }
  }

  return {
    render: renderSidebar, refreshBranches, startRename,
    editingId: () => editing?.id,
    revealSession(id: string) {
      if (attentionOnly && !ATTENTION.has(statusOf(id))) attentionOnly = false;
    },
  };
}
