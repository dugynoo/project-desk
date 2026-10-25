import type { Terminal } from "@xterm/xterm";
import type { SearchAddon } from "@xterm/addon-search";
import { el, iconButton } from "./dom.ts";
import { t, type Key } from "./i18n.ts";

const SEARCH_OPTIONS = {
  decorations: {
    matchBackground: "#3a4a63",
    matchOverviewRuler: "#7cc4ff",
    activeMatchBackground: "#b8860b",
    activeMatchColorOverviewRuler: "#ffb454",
  },
};

/** Hľadanie v histórii terminálu (Ctrl+Shift+F). */
export function createSearchBar(term: Terminal, search: SearchAddon, isAppShortcut: (e: KeyboardEvent) => boolean): HTMLElement {
  const bar = el("div", "search-bar");
  bar.hidden = true;
  const input = el("input");
  input.type = "text";
  // data-i18n-* nech sa texty preložia aj v už otvorených termináloch po zmene jazyka.
  input.dataset.i18nPlaceholder = "search.placeholder";
  input.placeholder = t("search.placeholder");
  input.spellcheck = false;
  const count = el("span", "count");
  const close = () => {
    bar.hidden = true;
    search.clearDecorations();
    term.focus();
  };
  const find = (back: boolean, incremental = false) => {
    if (!input.value) return;
    if (back) search.findPrevious(input.value, SEARCH_OPTIONS);
    else search.findNext(input.value, { ...SEARCH_OPTIONS, incremental });
  };
  search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = !input.value ? "" : resultCount ? `${resultIndex + 1}/${resultCount}` : t("search.none");
  });
  input.addEventListener("input", () => {
    if (input.value) find(false, true);
    else {
      search.clearDecorations();
      count.textContent = "";
    }
  });
  input.addEventListener("keydown", (e) => {
    if (isAppShortcut(e)) return;
    e.stopPropagation();
    if (e.key === "Enter") find(e.shiftKey);
    else if (e.key === "Escape") close();
  });
  const button = (label: string, key: Key, onClick: () => void) => {
    const b = iconButton(label, t(key), onClick);
    b.dataset.i18nTitle = key;
    return b;
  };
  bar.append(
    input,
    count,
    button("↑", "search.prev", () => find(true)),
    button("↓", "search.next", () => find(false)),
    button("✕", "search.close", close),
  );
  return bar;
}

export function openSearch(rt: { term: Terminal; search: SearchAddon; searchBar: HTMLElement }) {
  const input = rt.searchBar.querySelector("input")!;
  if (rt.term.hasSelection() && !rt.term.getSelection().includes("\n")) input.value = rt.term.getSelection();
  rt.searchBar.hidden = false;
  input.focus();
  input.select();
  if (input.value) rt.search.findNext(input.value, { ...SEARCH_OPTIONS, incremental: true });
}
