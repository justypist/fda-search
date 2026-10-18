import { extractHtml, kindFromContentType, normalizeText, type DocKind, type Extracted } from "./extract.ts";
import { extractOfficeText } from "./office.ts";
import { extractPdfWithInspector, type OcrEngine, type PdfExtraction } from "./pdf.ts";
import type { VisionClient } from "./vision.ts";

// 文档提取的统一入口。PDF 走 pdf-inspector + 视觉模型 OCR, 其余类型仍是纯文本解析。

export interface DocumentExtraction extends Extracted {
  pdf: PdfExtraction | null;
}

// 单篇正文的字符上限。FDA 的表格附件可达数千万字符 (实测一份 xlsx 解压出
// 4.1 千万), 全量进 FTS 既拖慢索引又没有检索价值, 因此提取时直接截断。
export const DEFAULT_MAX_TEXT_CHARS = 2_000_000;

export interface ExtractOptions {
  vision?: VisionClient | null;
  ocrMaxPages?: number;
  engine?: OcrEngine;
  maxTextChars?: number;
}

const capText = (extracted: Extracted, maxChars: number): Extracted =>
  extracted.text.length <= maxChars
    ? extracted
    : { ...extracted, text: extracted.text.slice(0, maxChars) };

export const extractDocument = async (
  bytes: Uint8Array,
  contentType: string,
  url: string,
  options: ExtractOptions = {},
): Promise<DocumentExtraction> => {
  const kind: DocKind = kindFromContentType(contentType, url);
  const maxChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
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
  return { kind: "text", title: "", text: normalizeText(text).slice(0, maxChars), date: null, pdf: null };
};
