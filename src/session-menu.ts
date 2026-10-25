import { el } from "./dom.ts";
import { PROVIDERS, PROVIDER_LABEL, type Provider } from "./model.ts";
import { t } from "./i18n.ts";

export interface MenuAction { label: string; run: () => void; separator?: boolean; danger?: boolean }

/** Shared, keyboard-accessible popup outside the scrolling sidebar. */
export function openActionMenu(anchor: HTMLButtonElement, actions: MenuAction[], onClose: () => void = () => {}) {
  const menu = el("div", "session-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", anchor.title || anchor.textContent || "");
  const events = new AbortController();
  const close = (restoreFocus = false) => {
    if (events.signal.aborted) return;
    events.abort(); menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor.isConnected) anchor.focus();
    onClose();
  };
  const items = actions.map(action => {
    const button = el("button", `${action.separator ? "menu-separator" : ""}${action.danger ? " danger" : ""}`, action.label);
    button.setAttribute("role", "menuitem"); button.tabIndex = -1;
    button.onclick = () => { close(true); action.run(); };
    menu.append(button); return button;
  });
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, rect.bottom + menu.offsetHeight + 4 > window.innerHeight ? rect.top - menu.offsetHeight : rect.bottom + 4)}px`;
  items[0]?.focus();
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      items.find(item => item === document.activeElement)?.click();
    }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    if (e.key === "Tab") { e.preventDefault(); close(true); }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!menu.contains(e.target as Node) && !anchor.contains(e.target as Node)) close();
  }, { signal: events.signal });
  document.addEventListener("focusin", (e) => {
    if (!menu.contains(e.target as Node) && e.target !== anchor) close();
  }, { signal: events.signal });
  window.addEventListener("resize", () => close(), { signal: events.signal });
  document.addEventListener("scroll", () => close(), { capture: true, signal: events.signal });
  return close;
}

export function openSessionMenu(anchor: HTMLButtonElement, defaultProvider: Provider, choose: (provider: Provider) => void, importExisting?: () => void, onClose?: () => void) {
  const actions: MenuAction[] = PROVIDERS.filter(p => p !== defaultProvider).map(p => ({ label: PROVIDER_LABEL[p], run: () => choose(p) }));
  if (importExisting) actions.push({ label: t("import.open"), separator: true, run: importExisting });
  return openActionMenu(anchor, actions, onClose);
}
