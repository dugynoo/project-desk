import { call } from "./ipc.ts";
import { writeClipboard } from "./clipboard.ts";
import { el } from "./dom.ts";
import { locale, t } from "./i18n.ts";
import {
  byRecent, formatTokens, importConversation, isUuid, matches, PROVIDER_LABEL, sessionDiagnostics,
  type AgentStats, type PersistedState, type Project, type Provider, type Session, type SessionObservation, type Status,
} from "./model.ts";
import type { createDialogs } from "./dialogs.ts";

interface Dependencies {
  getState(): PersistedState;
  getInfo(): { hooksEnabled: boolean };
  runtimes: ReadonlyMap<string, { running: boolean; observation?: SessionObservation }>;
  statuses: Map<string, Status>;
  modal: ReturnType<typeof createDialogs>["modal"];
  providerIcons: Record<Provider, string>;
  statusOf(id: string): Status;
  statusLabel(status: Status, sessionId?: string): string;
  statsOf(session: Session): AgentStats | undefined;
  select(id: string): void;
  start(session: Session): Promise<unknown>;
  save(): void;
  renderSidebar(): void;
  renderPaneHeads(): void;
  forgetAgent(id: string): void;
  pollAgents(): void;
}

/** Quick switch, session info with diagnostics, and opening or linking a conversation. */
export function createSessionDialogs(deps: Dependencies) {
  const { getState, getInfo, runtimes, statuses, modal, providerIcons, statusOf, statusLabel, statsOf,
    select, start, save, renderSidebar, renderPaneHeads, forgetAgent, pollAgents } = deps;
  const project = (id: string) => getState().projects.find(p => p.id === id);
  const session = (id: string | undefined) => (id ? getState().sessions.find(s => s.id === id) : undefined);

  function quickSwitch() {
    modal(
      (box, close) => {
        const input = el("input");
        input.type = "text";
        input.placeholder = t("switch.placeholder");
        const list = el("div", "switch-list");
        box.append(input, list);
        let items: Session[] = [];
        let sel = 0;
        const draw = () => {
          items = byRecent(getState().sessions).filter((s) => matches(s, project(s.projectId), input.value));
          sel = Math.min(sel, Math.max(0, items.length - 1));
          list.replaceChildren(
            ...items.map((s, i) => {
              const row = el("div", `switch-item${i === sel ? " sel" : ""}`);
              row.append(
                el("span", `dot ${statusOf(s.id)}`),
                el("span", "", `${providerIcons[s.provider]}  ${s.title}`),
                el("span", "meta", `${project(s.projectId)?.name ?? ""} · ${statusLabel(statusOf(s.id))}`),
              );
              row.onclick = () => {
                close();
                select(s.id);
              };
              return row;
            }),
          );
          if (!items.length) list.append(el("p", "", t("common.noResults")));
        };
        input.oninput = () => {
          sel = 0;
          draw();
        };
        input.onkeydown = (e) => {
          if (e.key === "ArrowDown") sel = Math.min(sel + 1, items.length - 1);
          else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
          else if (e.key === "Enter" && items[sel]) {
            const id = items[sel].id;
            close();
            select(id);
            return;
          } else return;
          e.preventDefault();
          draw();
        };
        draw();
        input.focus();
      },
      () => {},
    );
  }

  const dateTime = (ms: number | undefined) =>
    ms ? new Date(ms).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" }) : "–";

  function infoRows(s: Session): [string, string][] {
    const p = project(s.projectId);
    const rows: [string, string][] = [
      [t("info.project"), `${p?.name ?? "–"} · ${p?.path ?? ""}`],
      [t("info.tool"), PROVIDER_LABEL[s.provider]],
      [t("info.status"), statusLabel(statusOf(s.id))],
    ];
    const rt = runtimes.get(s.id);
    const diagnostic = sessionDiagnostics(s, rt?.running ?? false, getInfo().hooksEnabled, rt?.observation);
    rows.push([t("diag.process"), t(rt?.running ? "diag.running" : "diag.stopped")]);
    if (s.exitCode != null && !rt?.running) rows.push([t("diag.exitCode"), String(s.exitCode)]);
    if (s.provider !== "shell") rows.push([t("diag.link"), t(diagnostic.linked ? "diag.assigned" : "diag.unassigned")]);
    rows.push(
      [t("diag.method"), t(`diag.${diagnostic.method}`)],
      [t("diag.detail"), t(`diag.reason.${diagnostic.reason}`)],
    );
    if (s.provider !== "shell") {
      const observation = rt?.observation;
      rows.push([t("diag.lastEvent"), observation
        ? `${observation.event} · ${t(observation.snapshot ? "diag.snapshot" : "diag.received", { time: new Date(observation.receivedAt).toLocaleString(locale()) })}`
        : t("diag.noEvent")]);
    }
    if (s.provider !== "shell") rows.push([t("info.conversation"), s.agentSessionId ?? t("info.notDetected")]);
    const st = statsOf(s);
    if (st) {
      if (st.model) rows.push([t("info.model"), st.model]);
      if (st.contextTokens) {
        const pct = st.contextWindow
          ? t("info.contextOf", {
              window: formatTokens(st.contextWindow),
              pct: Math.round((st.contextTokens / st.contextWindow) * 100),
            })
          : "";
        rows.push([t("info.context"), `${formatTokens(st.contextTokens)}${pct}`]);
      }
      rows.push(
        [
          t("info.input"),
          t("info.inputValue", {
            fresh: formatTokens(st.inputTokens),
            read: formatTokens(st.cacheReadTokens),
            write: formatTokens(st.cacheWriteTokens),
          }),
        ],
        [t("info.output"), formatTokens(st.outputTokens)],
      );
      if (st.limitUsedPercent != null) {
        const days = st.limitWindowMinutes ? Math.round(st.limitWindowMinutes / 1440) : 0;
        const used = t("info.limitValue", { pct: st.limitUsedPercent.toFixed(0) });
        rows.push([t("info.codexLimit"), `${used}${days ? t("info.limitDays", { days }) : ""}`]);
      }
    } else if (s.provider !== "shell") {
      rows.push([t("info.tokens"), t(runtimes.get(s.id)?.running ? "info.tokensNone" : "info.asleep")]);
    }
    rows.push([t("info.created"), dateTime(s.createdAt)], [t("info.lastUsed"), dateTime(s.lastUsedAt)]);
    return rows;
  }

  function showImport(p: Project, target?: Session) {
    let alive = true;
    let generation = 0;
    modal((box, close) => {
      box.append(el("h3", "", t(target ? "import.link" : "import.open")));
      const provider = el("select");
      for (const value of ["claude", "codex", "antigravity"] as const) {
        const option = el("option", "", PROVIDER_LABEL[value]); option.value = value; provider.append(option);
      }
      provider.value = target?.provider ?? (getState().settings.defaultProvider === "shell" ? "claude" : getState().settings.defaultProvider);
      provider.disabled = !!target;
      provider.setAttribute("aria-label", t("import.provider"));
      const agentId = el("input");
      agentId.type = "text";
      agentId.placeholder = t("import.id"); agentId.setAttribute("aria-label", t("import.id"));
      agentId.value = target?.agentSessionId ?? "";
      const name = el("input");
      let suggestedName = "";
      name.type = "text";
      name.placeholder = t("import.name"); name.setAttribute("aria-label", t("import.name"));
      name.hidden = !!target;
      const note = el("p", "note", t(target ? "import.linkNote" : "import.note"));
      const hint = el("p", "hint");
      const list = el("div", "switch-list pane-session-list");
      const error = el("p", "note"); error.setAttribute("role", "alert");
      const actions = el("div", "actions");
      const cancel = el("button", "", t("common.cancel")); cancel.onclick = close;
      const apply = el("button", "primary", t(target ? "import.link" : "import.add"));
      const validate = () => { apply.disabled = !isUuid(agentId.value.trim()); error.textContent = ""; };
      agentId.oninput = validate;
      apply.onclick = () => {
        if (project(p.id) !== p || (target && session(target.id) !== target)) { close(); return; }
        const result = importConversation(getState(), p.id, provider.value as Provider, agentId.value, name.value, crypto.randomUUID(), Date.now(), target?.id);
        if (typeof result === "string") { error.textContent = t(`import.${result}`); return; }
        forgetAgent(result.id);
        const rt = runtimes.get(result.id);
        if (rt) rt.observation = undefined;
        statuses.set(result.id, rt?.running ? "untracked" : "exited");
        p.collapsed = false;
        save();
        close();
        if (target) { renderSidebar(); renderPaneHeads(); pollAgents(); }
        else select(result.id);
      };
      const load = async () => {
        const request = ++generation;
        const selected = provider.value;
        list.replaceChildren(el("p", "hint", t("import.loading")));
        hint.textContent = t(selected === "antigravity" ? "import.agy" : "import.files");
        try {
          const choices = await call("list_conversations", { provider: selected, cwd: p.path });
          if (!alive || generation !== request) return;
          list.replaceChildren();
          for (const choice of choices) {
            const existing = getState().sessions.find(s => s.provider === selected && s.agentSessionId?.toLowerCase() === choice.id.toLowerCase() && s.id !== target?.id);
            const title = existing?.title || choice.title || t("import.untitled");
            const button = el("button", "conversation-choice");
            button.append(el("strong", "", title), el("span", "hint", `${choice.id} · ${new Date(choice.modifiedAt).toLocaleString(locale())}${existing ? ` · ${t("import.added")}` : ""}`));
            button.disabled = !!existing;
            button.onclick = () => {
              agentId.value = choice.id;
              if (!name.value.trim() || name.value === suggestedName) name.value = choice.title ?? "";
              suggestedName = choice.title ?? "";
              validate(); agentId.focus();
            };
            list.append(button);
          }
          if (!choices.length) list.append(el("p", "hint", t("import.empty")));
        } catch {
          if (alive && generation === request) list.replaceChildren(el("p", "hint", t("import.failed")));
        }
      };
      provider.onchange = () => { agentId.value = ""; validate(); void load(); };
      actions.append(cancel, apply);
      const idLabel = el("label", "", t("import.id")); idLabel.append(agentId);
      const nameLabel = el("label", "", t("import.name")); nameLabel.append(name); nameLabel.hidden = !!target;
      box.append(provider, note, hint, list, idLabel, nameLabel, error, actions);
      validate(); void load(); agentId.focus();
    }, () => { alive = false; });
  }

  function showInfo(s: Session) {
    let timer: number | undefined;
    modal(
      (box, close) => {
        const grid = el("dl", "info");
        const recovery = el("div", "note");
        const repair = el("button");
        const draw = () => {
          grid.replaceChildren(...infoRows(s).flatMap(([k, v]) => [el("dt", "", k), el("dd", "", v)]));
          const rt = runtimes.get(s.id);
          const action = sessionDiagnostics(s, rt?.running ?? false, getInfo().hooksEnabled, rt?.observation).recovery;
          recovery.hidden = !action;
          recovery.textContent = action ? t(`diag.help.${action}`) : "";
          repair.hidden = !action || action === "link" || action === "restartApp";
          repair.textContent = action === "resume" ? t("session.restart") : t("diag.openTerminal");
          repair.onclick = () => {
            close();
            select(s.id);
            if (action === "resume" && !runtimes.get(s.id)?.running) void start(s);
          };
        };
        draw();
        timer = window.setInterval(draw, 2000);
        const note = s.provider === "claude" ? t("info.noteClaude") : s.provider === "codex" ? t("info.noteCodex") : s.provider === "antigravity" ? t("info.noteAntigravity") : "";
        const actions = el("div", "actions");
        actions.append(repair);
        if (s.provider !== "shell") {
          const link = el("button", "", t("import.link"));
          link.onclick = () => { const p = project(s.projectId); close(); if (p) showImport(p, s); };
          actions.append(link);
        }
        if (s.agentSessionId) {
          const copy = el("button", "", t("info.copyId"));
          copy.onclick = () =>
            void writeClipboard(s.agentSessionId!).then(() => (copy.textContent = t("info.copied")));
          actions.append(copy);
        }
        const ok = el("button", "primary", t("common.close"));
        ok.onclick = close;
        actions.append(ok);
        box.append(el("h3", "", `${providerIcons[s.provider]}  ${s.title}`), grid);
        box.append(recovery);
        if (note) box.append(el("div", "note", note));
        box.append(actions);
        ok.focus();
      },
      () => window.clearInterval(timer),
    );
  }

  return { quickSwitch, showImport, showInfo };
}
