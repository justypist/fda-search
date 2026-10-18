// 正文提取: 把 HTML / PDF / Office 文档统一压成纯文本, 供 FTS5 建索引。
// 这里只做"够用"的提取 —— 目标是可检索, 不是还原排版。

export type DocKind = "html" | "pdf" | "xlsx" | "docx" | "pptx" | "text" | "unknown";

export interface Extracted {
  kind: DocKind;
  title: string;
  text: string;
  date: string | null;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”",
  deg: "°", plusmn: "±", times: "×", micro: "µ", reg: "®", trade: "™", copy: "©",
};

export const decodeEntities = (value: string): string =>
  value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, name: string) => {
    if (name.startsWith("#")) {
      const code = name[1]?.toLowerCase() === "x" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });

// 收起空白但保留块级换行: FTS5 只关心分词, 换行用于检索结果里做片段截取。
export const normalizeText = (value: string): string =>
  value
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

const DROP_ELEMENTS = /<(script|style|noscript|svg|nav|header|footer|aside|form|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

const BLOCK_ELEMENTS = /<\/?(p|div|br|li|tr|h[1-6]|section|article|blockquote|pre|td|th)\b[^>]*>/gi;

export const htmlToText = (html: string): string => {
  const without = html.replace(/<!--[\s\S]*?-->/g, " ").replace(DROP_ELEMENTS, " ");
  const spaced = without.replace(BLOCK_ELEMENTS, "\n").replace(/<[^>]*>/g, " ");
  return normalizeText(decodeEntities(spaced));
};

const MAIN_PATTERNS = [
  /<article\b[^>]*id="main-content"[^>]*>([\s\S]*?)<\/article>/i,
  /<main\b[^>]*>([\s\S]*?)<\/main>/i,
  /<article\b[^>]*>([\s\S]*?)<\/article>/i,
  /<body\b[^>]*>([\s\S]*?)<\/body>/i,
];

const TITLE_PATTERNS = [/<h1\b[^>]*>([\s\S]*?)<\/h1>/i, /<title\b[^>]*>([\s\S]*?)<\/title>/i];

const firstMatch = (patterns: RegExp[], html: string): string | null => {
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
};

// FDA 的 ld+json 日期形如 "Thu, 10/15/2026 - 08:00" (美式月/日/年),
// new Date() 解析不了这种格式, 需要显式拆开。
const FDA_DATE = /^(\w{3}),\s*(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s*-\s*(\d{1,2}):(\d{2}))?$/;

const parseDate = (value: string): string | null => {
  const fda = FDA_DATE.exec(value.trim());
  if (fda !== null) {
    const [, , month, day, year, hour, minute] = fda;
    const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour ?? 0), Number(minute ?? 0)));
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  const standard = new Date(value);
  return Number.isNaN(standard.getTime()) ? null : standard.toISOString();
};

const metaDate = (html: string): string | null => {
  const ld = /<script\b[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (ld?.[1] !== undefined) {
    // 取 dateModified 优先, 因为它才是"内容变了没有"的信号; 没有才退到 datePublished。
    const found = /"dateModified"\s*:\s*"([^"]+)"/.exec(ld[1]) ?? /"datePublished"\s*:\s*"([^"]+)"/.exec(ld[1]);
    if (found?.[1] !== undefined) {
      const parsed = parseDate(found[1]);
      if (parsed !== null) return parsed;
    }
  }
  const meta = /<meta\b[^>]*property="article:published_time"[^>]*content="([^"]+)"/i.exec(html);
  if (meta?.[1] !== undefined) return parseDate(meta[1]);
  return null;
};

export const extractHtml = (html: string): Extracted => {
  const body = firstMatch(MAIN_PATTERNS, html) ?? html;
  const rawTitle = firstMatch(TITLE_PATTERNS, html) ?? "";
  const title = normalizeText(decodeEntities(rawTitle.replace(/<[^>]*>/g, " "))).replace(/\s*\|\s*FDA\s*$/, "");
  const text = htmlToText(body);
  return { kind: "html", title, text, date: metaDate(html) };
};

const XML_ENTRY_PATTERNS: { kind: DocKind; entries: RegExp }[] = [
  { kind: "xlsx", entries: /^(xl\/sharedStrings\.xml|xl\/worksheets\/[^/]+\.xml)$/ },
  { kind: "docx", entries: /^word\/(document|header\d*|footer\d*)\.xml$/ },
  { kind: "pptx", entries: /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/ },
];

export const officeEntriesOf = (kind: DocKind): RegExp | null =>
  XML_ENTRY_PATTERNS.find((entry) => entry.kind === kind)?.entries ?? null;

// Office 文档 (xlsx/docx/pptx) 都是 zip + XML, 实际的解压与抽取见 office.ts。
export const officeKindOf = (names: string[]): DocKind => {
  for (const { kind, entries } of XML_ENTRY_PATTERNS) {
    if (names.some((name) => entries.test(name))) return kind;
  }
  return "unknown";
};

export const kindFromContentType = (contentType: string, url: string): DocKind => {
  const type = contentType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (type === "application/pdf") return "pdf";
  if (type.includes("spreadsheetml")) return "xlsx";
  if (type.includes("wordprocessingml")) return "docx";
  if (type.includes("presentationml")) return "pptx";
  if (type.startsWith("text/html")) return "html";
  if (type.startsWith("text/plain")) return "text";
  if (type.startsWith("text/xml") || type.includes("xml")) return "text";
  return kindFromUrl(url);
};

const kindFromUrl = (url: string): DocKind => {
  if (url.endsWith(".pdf")) return "pdf";
  if (url.endsWith(".xlsx") || url.endsWith(".xls")) return "xlsx";
  if (url.endsWith(".docx") || url.endsWith(".doc")) return "docx";
  if (url.endsWith(".pptx") || url.endsWith(".ppt")) return "pptx";
  return "html";
};
