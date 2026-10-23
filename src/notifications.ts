import { el } from "./dom.ts";
import { locale, t } from "./i18n.ts";
import { readAttention, PROVIDER_LABEL, type PersistedState } from "./model.ts";

export function createNotificationCenter(deps: {
  state: () => PersistedState;
  modal: (build: (box: HTMLElement, close: () => void) => void, onClose: () => void) => void;
  changed: () => void;
  select: (id: string) => void;
}) {
  let refresh: (() => void) | undefined;
  function show() {
    let timer: number | undefined;
    deps.modal((box, close) => {
      box.classList.add("notification-center");
      const heading = el("h3", "", t("notifications.title"));
      const list = el("div", "notification-list");
      const actions = el("div", "actions");
      const all = el("button", "", t("notifications.readAll"));
      all.onclick = () => { if (readAttention(deps.state())) deps.changed(); };
      const clear = el("button", "", t("notifications.clearRead"));
      clear.onclick = () => {
        deps.state().notifications = deps.state().notifications.filter(n => !n.read);
        deps.changed();
      };
      const done = el("button", "primary", t("common.close"));
      done.onclick = close;
      actions.append(all, clear, done);
      box.append(heading, el("p", "note", t("notifications.limit")), list, actions);
      const updateTimes = () => {
        const formatter = new Intl.RelativeTimeFormat(locale(), { numeric: "auto" });
        for (const node of list.querySelectorAll<HTMLTimeElement>("time")) {
          const seconds = Math.max(0, (Date.now() - Number(node.dataset.at)) / 1000);
          const unit = seconds < 3600 ? "minute" : seconds < 86400 ? "hour" : "day";
          const value = Math.floor(seconds / (unit === "minute" ? 60 : unit === "hour" ? 3600 : 86400));
          node.textContent = seconds < 60 ? t("notifications.now") : formatter.format(-value, unit);
        }
      };
      refresh = () => {
        const focused = list.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.id : undefined;
        const state = deps.state();
        list.replaceChildren();
        all.disabled = !state.notifications.some(n => !n.read);
        clear.disabled = !state.notifications.some(n => n.read);
        for (const n of state.notifications) {
          const s = state.sessions.find(s => s.id === n.sessionId);
          const p = s && state.projects.find(p => p.id === s.projectId);
          const row = el("button", `notification-row${n.read ? "" : " unread"}`);
          row.dataset.id = n.id;
          const text = el("span", "notification-text");
          text.append(el("span", "", `${p?.name ?? n.projectName} / ${s?.title ?? n.sessionTitle}`));
          text.append(el("span", "meta", `${PROVIDER_LABEL[n.provider]} · ${t(n.kind === "done" ? "notifications.done" : "notifications.waiting")}${n.read ? "" : ` · ${t("notifications.unread")}`}`));
          if (!s) text.append(el("span", "meta", t("notifications.unavailable")));
          const time = el("time");
          time.dataset.at = String(n.at);
          time.dateTime = new Date(n.at).toISOString();
          time.title = new Date(n.at).toLocaleString(locale());
          row.append(el("span", `dot ${n.kind}`), text, time);
          row.onclick = () => {
            n.read = true;
            deps.changed();
            if (s) { close(); deps.select(s.id); }
          };
          list.append(row);
          if (focused === n.id) row.focus();
        }
        if (!state.notifications.length) list.append(el("p", "", t("notifications.empty")));
        updateTimes();
      };
      refresh();
      timer = window.setInterval(updateTimes, 30_000);
      done.focus();
    }, () => { refresh = undefined; window.clearInterval(timer); });
  }
  return { show, refresh: () => refresh?.() };
}
