import { unzipSync, strFromU8 } from "fflate";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { extractHtml, kindFromContentType, officeKindOf, xmlPartsToText, normalizeText, type DocKind, type Extracted } from "./extract.ts";

// pdfjs 的 legacy 构建面向 Node, 不需要 DOM; 这里延迟加载, 因为它体积较大,
// 而绝大多数页面是 HTML (只有 /media/ 下的附件才需要它)。
const loadPdfjs = async (): Promise<typeof import("pdfjs-dist/legacy/build/pdf.mjs")> =>
  import("pdfjs-dist/legacy/build/pdf.mjs");

// pdfjs 需要标准字体与 CMap 的磁盘路径来解析 PDF 里未内嵌的字体。不提供时
// 每次都会打印 "Ensure that the standardFontDataUrl API parameter is provided"
// 警告, 且部分 PDF 的文字会提取失败。注意 legacy 构建在 Node 下走 fs.readFile,
// 只认文件系统路径 —— 传 file:// URL 会报 "Unable to load font data"。
let assetUrls: { standardFontDataUrl: string; cMapUrl: string } | null = null;

const pdfAssets = (): { standardFontDataUrl: string; cMapUrl: string } => {
  if (assetUrls !== null) return assetUrls;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  assetUrls = {
    standardFontDataUrl: `${join(root, "standard_fonts")}/`,
    cMapUrl: `${join(root, "cmaps")}/`,
  };
  return assetUrls;
};

const PDF_MAX_PAGES = 400;
const PDF_TEXT_CAP = 4_000_000;

const extractPdf = async (bytes: Uint8Array): Promise<Extracted> => {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    // 复制一份: pdfjs 会接管并清空传入的 buffer。
    data: bytes.slice(),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    ...pdfAssets(),
  }).promise;
  const pages = Math.min(doc.numPages, PDF_MAX_PAGES);
  const parts: string[] = [];
  let total = 0;
  for (let i = 1; i <= pages; i += 1) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const line = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    parts.push(line);
    total += line.length;
    page.cleanup();
    if (total > PDF_TEXT_CAP) break;
  }
  await doc.destroy();
  const text = normalizeText(parts.join("\n"));
  // PDF 没有可靠的标题字段, 用首行 (通常是标题) 作为标题, 但要去掉只有页码/水印的首行。
  const firstLine = (parts[0] ?? "").trim();
  const title = firstLine.length >= 8 ? normalizeText(firstLine).slice(0, 300) : "";
  return { kind: "pdf", title, text, date: null };
};

const extractOffice = (bytes: Uint8Array): Extracted => {
  const files = unzipSync(bytes);
  const names = Object.keys(files);
  const kind = officeKindOf(names);
  const wanted = names.filter((name) => {
    if (kind === "xlsx") return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/[^/]+\.xml$/.test(name);
    if (kind === "docx") return /^word\/(document|header\d*|footer\d*)\.xml$/.test(name);
    if (kind === "pptx") return /^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(name);
    return false;
  });
  // sharedStrings 要排在最前: xlsx 的单元格只存索引, 文本全在这张表里。
  wanted.sort((a, b) => (a === "xl/sharedStrings.xml" ? -1 : b === "xl/sharedStrings.xml" ? 1 : a.localeCompare(b)));
  const texts = wanted.map((name) => strFromU8(files[name]!));
  const text = xmlPartsToText(texts);
  return { kind: kind === "unknown" ? "unknown" : kind, title: "", text, date: null };
};

export const extractDocument = async (
  bytes: Uint8Array,
  contentType: string,
  url: string,
): Promise<Extracted> => {
  const kind: DocKind = kindFromContentType(contentType, url);
  if (kind === "pdf") return extractPdf(bytes);
  if (kind === "xlsx" || kind === "docx" || kind === "pptx") {
    try {
      return extractOffice(bytes);
    } catch {
      return { kind, title: "", text: "", date: null };
    }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (kind === "html") return extractHtml(text);
  return { kind: "text", title: "", text: normalizeText(text), date: null };
};
