import { droppedFilePaths } from "./model.ts";

export interface FileDrag {
  kind: "enter" | "over" | "drop" | "leave";
  paths: string[];
  position: { x: number; y: number } | null;
  shift: boolean;
}

export interface FileDropTarget {
  host: HTMLElement;
  running: boolean;
  closing: boolean;
  term: { paste(text: string): void; focus(): void };
}

export function createFileDropHandler(options: {
  targets: () => Iterable<FileDropTarget>;
  blocked: () => boolean;
  platform: () => string;
  hint: (ready: boolean) => string;
  invalid: () => void;
  hitTest?: (x: number, y: number) => Element | null;
  scale?: () => number;
}) {
  let highlighted: HTMLElement | undefined;
  let ready: boolean | undefined;
  const clear = () => {
    highlighted?.classList.remove("file-drop", "file-drop-ready");
    if (highlighted) delete highlighted.dataset.fileDropHint;
    highlighted = undefined;
    ready = undefined;
  };
  return (event: FileDrag) => {
    if (event.kind === "leave" || !event.position || options.blocked()) { clear(); return; }
    const scale = options.scale?.() ?? window.devicePixelRatio;
    const hit = (options.hitTest ?? ((x, y) => document.elementFromPoint(x, y)))(event.position.x / scale, event.position.y / scale);
    let target: FileDropTarget | undefined;
    if (hit) {
      for (const candidate of options.targets()) {
        if (candidate.host.contains(hit)) { target = candidate; break; }
      }
    }
    if (!target?.running || target.closing) { clear(); return; }
    if (event.kind !== "drop") {
      if (highlighted !== target.host) {
        clear();
        highlighted = target.host;
        highlighted.classList.add("file-drop");
      }
      if (ready !== event.shift) {
        ready = event.shift;
        highlighted.classList.toggle("file-drop-ready", ready);
        highlighted.dataset.fileDropHint = options.hint(ready);
      }
      return;
    }
    clear();
    if (!event.shift) return;
    const text = droppedFilePaths(event.paths, options.platform());
    if (text === undefined) { options.invalid(); return; }
    // xterm honors the receiving process's bracketed-paste mode. No Enter.
    target.term.paste(text);
    target.term.focus();
  };
}
