import { el } from "./dom.ts";
import { PROVIDERS, PROVIDER_LABEL, type Provider } from "./model.ts";
import { t } from "./i18n.ts";

/** Body-level menu stays clear of the scrolling sidebar's clipping boundary. */
export function openSessionMenu(anchor: HTMLButtonElement, defaultProvider: Provider, choose: (provider: Provider) => void, importExisting?: () => void) {
  const menu = el("div", "session-menu");
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", anchor.title);
  const events = new AbortController();
  const close = (restoreFocus = false) => {
    events.abort();
    menu.remove();
    anchor.setAttribute("aria-expanded", "false");
    if (restoreFocus && anchor.isConnected) anchor.focus();
  };
  const items = PROVIDERS.filter((p) => p !== defaultProvider).map((p) => {
    const button = el("button", "", PROVIDER_LABEL[p]);
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.onclick = () => { close(true); choose(p); };
    menu.append(button);
    return button;
  });
  if (importExisting) {
    const button = el("button", "", t("import.open"));
    button.setAttribute("role", "menuitem");
    button.tabIndex = -1;
    button.onclick = () => { close(true); importExisting(); };
    menu.append(button);
    items.push(button);
  }
  document.body.append(menu);
  anchor.setAttribute("aria-expanded", "true");
  const rect = anchor.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 4))}px`;
  menu.style.top = `${Math.max(4, rect.bottom + menu.offsetHeight + 4 > window.innerHeight ? rect.top - menu.offsetHeight : rect.bottom + 4)}px`;
  items[0]?.focus();
  menu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); }
    if (e.key === "Tab") close(true);
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
