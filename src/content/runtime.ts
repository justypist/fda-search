import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// pdf-inspector 的本地 OCR 需要两个共享库 (PDFium 与 ONNX Runtime) 和一套
// PP-OCRv6 模型。库默认从 vendor/ocr 读取, 也可以用环境变量覆盖;
// 模型由库在首次使用时下载到 ~/.cache/pdf-inspector (约 30 MB), 之后离线可用。

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const libName = (base: string): string =>
  process.platform === "darwin" ? `lib${base}.dylib` : process.platform === "win32" ? `${base}.dll` : `lib${base}.so`;

export interface OcrRuntime {
  pdfium: string;
  onnx: string;
}

// 返回 null 表示运行时不可用, 调用方应把扫描件记为"待 OCR"而不是空正文。
export const resolveOcrRuntime = (env: NodeJS.ProcessEnv = process.env): OcrRuntime | null => {
  const pdfium = env.PDFIUM_LIB_PATH?.trim() || join(ROOT, "vendor", "ocr", libName("pdfium"));
  const onnx = env.ORT_DYLIB_PATH?.trim() || join(ROOT, "vendor", "ocr", libName("onnxruntime"));
  if (!existsSync(pdfium) || !existsSync(onnx)) return null;
  return { pdfium, onnx };
};

// 必须在任何 pdf-inspector OCR 调用之前设置: 原生模块在初始化时读取这两个变量。
export const applyOcrRuntime = (env: NodeJS.ProcessEnv = process.env): boolean => {
  const runtime = resolveOcrRuntime(env);
  if (runtime === null) return false;
  env.PDFIUM_LIB_PATH = runtime.pdfium;
  env.ORT_DYLIB_PATH = runtime.onnx;
  return true;
};
