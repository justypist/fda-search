import { extractHtml, kindFromContentType, normalizeText, type DocKind, type Extracted } from "./extract.ts";
import { extractOfficeText } from "./office.ts";
import { extractPdfWithInspector, type OcrEngine, type PdfExtraction } from "./pdf.ts";
import type { VisionClient } from "./vision.ts";

// 文档提取的统一入口。PDF 走 pdf-inspector + 视觉模型 OCR, 其余类型仍是纯文本解析。

export interface DocumentExtraction extends Extracted {
  pdf: PdfExtraction | null;
}

// 正文长度默认不限制: FDA 的表格附件可提取出上亿字符 (实测 1.1 亿),
// SQLite 与 FTS5 都能存。调用方可给 maxTextChars 主动设限来控制库体积。
export interface ExtractOptions {
  vision?: VisionClient | null;
  ocrMaxPages?: number;
  engine?: OcrEngine;
  maxTextChars?: number | null;
}

const capText = (extracted: Extracted, maxChars: number | null): Extracted =>
  maxChars === null || extracted.text.length <= maxChars
    ? extracted
    : { ...extracted, text: extracted.text.slice(0, maxChars) };

export const extractDocument = async (
  bytes: Uint8Array,
  contentType: string,
  url: string,
  options: ExtractOptions = {},
): Promise<DocumentExtraction> => {
  const kind: DocKind = kindFromContentType(contentType, url);
  const maxChars = options.maxTextChars ?? null;
  if (kind === "pdf") {
    try {
      const pdf = await extractPdfWithInspector(bytes, {
        engine: options.engine ?? "local",
        vision: options.vision ?? null,
        maxOcrPages: options.ocrMaxPages ?? 8,
      });
      return { ...capText({ kind: "pdf", title: pdf.title, text: pdf.text, date: null }, maxChars), pdf };
    } catch {
      // pdf-inspector 遇到损坏文件会抛错; 交给上层按失败落库, 不再用旧解析器兜底,
      // 否则同一份文件会被两套解析器给出不一致的结果。
      return { kind: "pdf", title: "", text: "", date: null, pdf: null };
    }
  }
  if (kind === "xlsx" || kind === "docx" || kind === "pptx") {
    try {
      const text = extractOfficeText(bytes, maxChars);
      return { kind, title: "", text, date: null, pdf: null };
    } catch {
      return { kind, title: "", text: "", date: null, pdf: null };
    }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (kind === "html") return { ...capText(extractHtml(text), maxChars), pdf: null };
  return { ...capText({ kind: "text", title: "", text: normalizeText(text), date: null }, maxChars), pdf: null };
};
