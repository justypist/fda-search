import { unzipSync, strFromU8 } from "fflate";
import { extractHtml, kindFromContentType, officeKindOf, xmlPartsToText, normalizeText, type DocKind, type Extracted } from "./extract.ts";
import { extractPdfWithInspector, type OcrEngine, type PdfExtraction } from "./pdf.ts";
import type { VisionClient } from "./vision.ts";

// 文档提取的统一入口。PDF 走 pdf-inspector + 视觉模型 OCR, 其余类型仍是纯文本解析。

export interface DocumentExtraction extends Extracted {
  pdf: PdfExtraction | null;
}

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

export interface ExtractOptions {
  vision?: VisionClient | null;
  ocrMaxPages?: number;
  engine?: OcrEngine;
}

export const extractDocument = async (
  bytes: Uint8Array,
  contentType: string,
  url: string,
  options: ExtractOptions = {},
): Promise<DocumentExtraction> => {
  const kind: DocKind = kindFromContentType(contentType, url);
  if (kind === "pdf") {
    try {
      const pdf = await extractPdfWithInspector(bytes, {
        engine: options.engine ?? "local",
        vision: options.vision ?? null,
        maxOcrPages: options.ocrMaxPages ?? 8,
      });
      return { kind: "pdf", title: pdf.title, text: pdf.text, date: null, pdf };
    } catch {
      // pdf-inspector 遇到损坏文件会抛错; 交给上层按失败落库, 不再用旧解析器兜底,
      // 否则同一份文件会被两套解析器给出不一致的结果。
      return { kind: "pdf", title: "", text: "", date: null, pdf: null };
    }
  }
  if (kind === "xlsx" || kind === "docx" || kind === "pptx") {
    try {
      return { ...extractOffice(bytes), pdf: null };
    } catch {
      return { kind, title: "", text: "", date: null, pdf: null };
    }
  }
  const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  if (kind === "html") return { ...extractHtml(text), pdf: null };
  return { kind: "text", title: "", text: normalizeText(text), date: null, pdf: null };
};
