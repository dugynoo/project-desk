// Malý markdown pre chat na mobile: text → AST, ktorý stránka vykreslí cez DOM (nikdy innerHTML).

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "b"; c: Inline[] }
  | { t: "i"; c: Inline[] }
  | { t: "a"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: number; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "code"; lang: string; v: string }
  | { t: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { t: "quote"; c: Block[] }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "hr" };

const FENCE = /^ {0,3}(```+|~~~+)\s*([^`\s]*)/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;
const HR = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;
/** Hlbšie vnorené citácie ostanú textom (ochrana zásobníka). */
const MAX_QUOTE_DEPTH = 8;
/** Dlhší úsek ostane textom: hľadanie uzatváracích značiek je kvadratické. */
const MAX_INLINE = 4000;
const LINK = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/y;
const BARE_URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** Bloky textu; neznáme konštrukcie ostanú ako obyčajný text. */
export function parseMarkdown(src: string, depth = 0): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  const isBlank = (l: string) => l.trim() === "";
  const isQuote = (l: string) => depth < MAX_QUOTE_DEPTH && /^\s*>/.test(l);
  const startsBlock = (l: string) =>
    FENCE.test(l) || HEADING.test(l) || BULLET.test(l) || ORDERED.test(l) || HR.test(l) || isQuote(l);

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith(marker)) body.push(lines[i++]);
      i++; // uzatváracia značka (alebo koniec textu)
      out.push({ t: "code", lang: fence[2], v: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1].length, c: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (HR.test(line)) { out.push({ t: "hr" }); i++; continue; }

    if (isQuote(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push({ t: "quote", c: parseMarkdown(body.join("\n"), depth + 1) });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes("-")) {
      const head = cells(line).map(parseInline);
      i += 2;
      const rows: Inline[][][] = [];
      while (i < lines.length && lines[i].includes("|") && !isBlank(lines[i])) rows.push(cells(lines[i++]).map(parseInline));
      out.push({ t: "table", head, rows });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet || ordered) {
      const isOrdered = !bullet;
      const items: string[] = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = isOrdered ? ORDERED.exec(l) : BULLET.exec(l);
        if (m) { items.push(isOrdered ? m[2] : m[1]); i++; continue; }
        // Pokračovanie položky (odsadený riadok); prázdny riadok alebo iný blok zoznam končí.
        if (!isBlank(l) && /^\s+/.test(l) && !startsBlock(l) && items.length) { items[items.length - 1] += " " + l.trim(); i++; continue; }
        break;
      }
      out.push({ t: "list", ordered: isOrdered, start: ordered ? Number(ordered[1]) : 1, items: items.map(parseInline) });
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && !isBlank(lines[i]) && (para.length === 0 || !startsBlock(lines[i]))) para.push(lines[i++]);
    out.push({ t: "p", c: parseInline(para.join("\n")) });
  }
  return out;
}

function cells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

/** Inline kód, tučné, kurzíva a http(s) odkazy; ostatné je text. */
export function parseInline(src: string): Inline[] {
  if (src.length > MAX_INLINE) return [{ t: "text", v: src }];
  const out: Inline[] = [];
  let text = "";
  const flush = () => { if (text) { out.push({ t: "text", v: text }); text = ""; } };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\" && i + 1 < src.length && /[\\`*_[\]()#|>-]/.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
    if (ch === "`") {
      let n = i;
      while (src[n] === "`") n++;
      const run = src.slice(i, n);
      const end = src.indexOf(run, i + run.length);
      if (end > 0) {
        flush();
        out.push({ t: "code", v: src.slice(i + run.length, end).replace(/^ (.+) $/, "$1") });
        i = end + run.length;
        continue;
      }
    }
    if ((ch === "*" || ch === "_") && src[i + 1] === ch) {
      const end = src.indexOf(ch + ch, i + 2);
      if (end > i + 2) {
        flush();
        out.push({ t: "b", c: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    if (ch === "*" || (ch === "_" && !/\w/.test(src[i - 1] ?? ""))) {
      const end = findClose(src, ch, i + 1);
      if (end > i + 1 && src[i + 1] !== " ") {
        flush();
        out.push({ t: "i", c: parseInline(src.slice(i + 1, end)) });
        i = end + 1;
        continue;
      }
    }
    if (ch === "[") {
      LINK.lastIndex = i;
      const m = LINK.exec(src);
      if (m) {
        flush();
        out.push({ t: "a", href: m[2], c: parseInline(m[1]) });
        i += m[0].length;
        continue;
      }
    }
    if (ch === "h") {
      BARE_URL.lastIndex = i;
      const m = BARE_URL.exec(src);
      if (m && !/\w/.test(src[i - 1] ?? "")) {
        flush();
        out.push({ t: "a", href: m[0], c: [{ t: "text", v: m[0] }] });
        i += m[0].length;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flush();
  return out;
}

/** Jednoduchá uzatváracia `*` alebo `_` (nie dvojitá, nie pred medzerou). */
function findClose(src: string, ch: string, from: number): number {
  for (let j = from; j < src.length; j++) {
    if (src[j] === "\n" && src[j + 1] === "\n") return -1;
    if (src[j] !== ch || src[j - 1] === " " || src[j + 1] === ch) continue;
    if (ch === "_" && /\w/.test(src[j + 1] ?? "")) continue;
    return j;
  }
  return -1;
}
