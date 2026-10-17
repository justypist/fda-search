import { detectPdf, extractPagesMarkdownAsync, processPdfWithOcr } from "@firecrawl/pdf-inspector";
import { applyOcrRuntime } from "./runtime.ts";
import { extractPdfPageImages } from "./pdfocr.ts";
import type { VisionClient } from "./vision.ts";
import type { Extracted } from "./extract.ts";

// pdf-inspector 的本地 OCR 在初始化原生模块时读取这两个环境变量, 因此要在模块加载阶段
// 就把 vendor/ocr 的路径填好; 缺库时 applyOcrRuntime 返回 false, 扫描件会记为待 OCR。
const LOCAL_OCR_READY = applyOcrRuntime();

// PDF 提取走 pdf-inspector (Rust): 自带 text-based / scanned / mixed 分类、
// 版面感知的阅读顺序与 markdown 输出, 比 pdfjs 逐页取文本更完整 (表格、标题层级)。
//
// 扫描页的 OCR 有两个引擎:
//   local  — pdf-inspector 内置的 PP-OCRv6 (ONNX), 纯本地 CPU, 实测 2 页 2.8 秒;
//   vision — 视觉模型 (需 .env), 质量更高但单页要 20-90 秒且按 token 计费。
// 默认 local: 快一到两个数量级, 对扫描件这种版式固定的文档质量已足够。

export type OcrEngine = "local" | "vision" | "off";

export interface PdfExtraction extends Extracted {
  pdfType: string;
  ocrPages: number[];
  ocrApplied: number;
  ocrFailed: number;
  ocrErrors: string[];
  // 有页面需要 OCR 但引擎不可用 (缺 PDFium/ONNX, 或未配置视觉模型)。
  // 上层据此把文档标记为"待 OCR", 而不是当作已抓完的空正文。
  ocrMissing: boolean;
  pageCount: number;
}

const firstHeading = (markdown: string): string => {
  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    // 跳过围栏与空行: 视觉模型常把整页包在 ```text 里。
    if (trimmed.length === 0 || trimmed.startsWith("```")) continue;
    const heading = /^#{1,2}\s+(.+)$/.exec(trimmed);
    if (heading?.[1] !== undefined) return heading[1].trim();
    return trimmed.slice(0, 300);
  }
  return "";
};

// 扫描件的首行常是数字签名 ("Digitally signed by ..."), 不是内容标题。
const SIGNATURE = /digitally signed|signature|^date:\s*\d{4}\.\d{2}\.\d{2}/i;

const titleFromPages = (pages: { markdown: string }[], fallback: string): string => {
  for (const page of pages) {
    for (const line of page.markdown.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length < 8 || trimmed.startsWith("```") || SIGNATURE.test(trimmed)) continue;
      const heading = /^#{1,3}\s+(.+)$/.exec(trimmed);
      return (heading?.[1] ?? trimmed).slice(0, 300);
    }
  }
  return fallback;
};

export interface PdfExtractionOptions {
  engine: OcrEngine;
  vision: VisionClient | null;
  maxOcrPages: number;
}

// 视觉模型有时会把整页包进代码围栏, 围栏本身没有检索价值。
const stripFences = (markdown: string): string => markdown.replace(/^\s*```[\w-]*\s*$/gm, "").trim();

interface PageText {
  page: number;
  markdown: string;
  needsOcr: boolean;
}

const applyVision = async (
  bytes: Uint8Array,
  pages: PageText[],
  vision: VisionClient,
  maxOcrPages: number,
): Promise<{ text: Map<number, string>; failed: number; errors: string[] }> => {
  const ocrPages = pages.filter((page) => page.needsOcr).map((page) => page.page);
  const text = new Map<number, string>();
  const errors: string[] = [];
  let failed = 0;
  if (ocrPages.length === 0) return { text, failed, errors };

  // 只 OCR 前 N 页: 扫描件常有几十页, 全量转写的成本远超检索收益。
  const targets = ocrPages.slice(0, Math.max(1, maxOcrPages));
  // pdf-inspector 的页号是 0 基, pdfjs 的 getPage 是 1 基。
  const images = await extractPdfPageImages(bytes, targets.map((page) => page + 1));
  const results = await Promise.all(
    images
      .filter((image) => targets.includes(image.page - 1))
      .map(async (image) => {
        try {
          return { page: image.page - 1, text: await vision.transcribe([image.data]), error: null };
        } catch (error) {
          return { page: image.page - 1, text: "", error: (error as Error).message.slice(0, 200) };
        }
      }),
  );
  for (const result of results) {
    if (result.text.length > 0) text.set(result.page, result.text);
    else {
      failed += 1;
      if (result.error !== null) errors.push(`p${result.page + 1}: ${result.error}`);
    }
  }
  return { text, failed, errors };
};

interface LocalOcrOutput {
  pages: PageText[];
  pageCount: number;
  pdfType: string;
  unavailable: boolean;
  // 实际交给 OCR 的页 (0 基)。只有这些页的成败才该计入 ocrApplied / ocrFailed,
  // 文本型 PDF 若不区分, 会被当成"OCR 了所有页"。
  ocrPages: number[];
}

const localOcr = async (buffer: Buffer, maxOcrPages: number): Promise<LocalOcrOutput> => {
  // 先用原生抽取拿到每页是否需要 OCR, 只把前 N 页交给本地 OCR 引擎。
  const info = detectPdf(buffer);
  const native = await extractPagesMarkdownAsync(buffer);
  const keep = (unavailable: boolean, ocrPages: number[]): LocalOcrOutput => ({
    pages: native.pages.map((page) => ({ page: page.page, markdown: page.markdown, needsOcr: page.needsOcr })),
    pageCount: info.pageCount,
    pdfType: info.pdfType,
    unavailable,
    ocrPages,
  });
  const need = native.pages.filter((page) => page.needsOcr).map((page) => page.page);
  const selected = need.slice(0, Math.max(1, maxOcrPages));
  if (selected.length === 0) return keep(false, []);
  if (!LOCAL_OCR_READY) return keep(true, selected);

  let result: Awaited<ReturnType<typeof processPdfWithOcr>>;
  try {
    // mode 默认就是 Auto (只 OCR 原生抽取被判不可靠的页); OcrMode 是 const enum,
    // 在 verbatimModuleSyntax 下不可导入, 传字面量也不合法, 故省略。
    result = await processPdfWithOcr(buffer, { pageNumbers: selected.map((page) => page + 1) });
  } catch {
    // 缺 PDFium / ONNX Runtime 时本地 OCR 不可用。必须如实上报, 否则扫描件会被
    // 当成"成功但正文为空"落库, 之后配好运行时也不会重试。
    return keep(true, selected);
  }

  // 本地 OCR 的输出是整篇 markdown; 分页结果在 result.pages 里 (1 基页号)。
  const byPage = new Map(result.pages.map((page) => [page.pageNumber - 1, page.markdown]));
  return {
    ...keep(false, selected),
    pages: native.pages.map((page) => ({
      page: page.page,
      markdown: byPage.get(page.page) ?? page.markdown,
      needsOcr: false,
    })),
    pageCount: result.pageCount,
  };
};

export const extractPdfWithInspector = async (bytes: Uint8Array, options: PdfExtractionOptions): Promise<PdfExtraction> => {
  const buffer = Buffer.from(bytes);

  if (options.engine === "local") {
    const out = await localOcr(buffer, options.maxOcrPages);
    const ordered = out.pages.map((page) => ({ page: page.page, markdown: stripFences(page.markdown) }));
    const markdown = ordered.map((page) => page.markdown).filter((part) => part.length > 0).join("\n\n").trim();
    // 只统计真正送去 OCR 的页。文本型 PDF 的 out.ocrPages 为空, 若按"非空页数"
    // 计算, 会把纯文本页虚报成 OCR 页, 也会把空白页误报成 OCR 失败。
    const ocrPages = out.unavailable ? [] : out.ocrPages;
    const filled = ordered.filter((page) => ocrPages.includes(page.page) && page.markdown.length > 0).length;
    return {
      kind: "pdf",
      title: titleFromPages(ordered, firstHeading(markdown)),
      text: markdown,
      date: null,
      pdfType: out.pdfType,
      pageCount: out.pageCount,
      ocrPages,
      ocrApplied: filled,
      ocrFailed: ocrPages.length - filled,
      ocrErrors: [],
      ocrMissing: out.unavailable,
    };
  }

  // detectPdf 只解析分类与文档信息字典, 不做文本抽取, 开销很小。
  const info = detectPdf(buffer);
  const { pages } = await extractPagesMarkdownAsync(buffer);
  const ocrPages = pages.filter((page) => page.needsOcr).map((page) => page.page);
  const ocrMissing = ocrPages.length > 0 && options.vision === null;

  const visionResult = options.vision !== null && ocrPages.length > 0
    ? await applyVision(bytes, pages, options.vision, options.maxOcrPages)
    : { text: new Map<number, string>(), failed: 0, errors: [] };

  const cleaned = pages.map((page) => ({
    page: page.page,
    markdown: stripFences(visionResult.text.get(page.page) ?? page.markdown),
  }));
  const markdown = cleaned.map((page) => page.markdown).filter((part) => part.length > 0).join("\n\n").trim();

  return {
    kind: "pdf",
    title: info.title ?? titleFromPages(cleaned, firstHeading(markdown)),
    text: markdown,
    date: null,
    pdfType: info.pdfType,
    pageCount: info.pageCount,
    ocrPages,
    ocrApplied: visionResult.text.size,
    ocrFailed: visionResult.failed,
    ocrErrors: visionResult.errors,
    ocrMissing,
  };
};
