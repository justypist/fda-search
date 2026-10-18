import { createCanvas, ImageData, type Canvas } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// 纯图像 PDF 的 OCR 前处理: 把页面位图抽出来, 转成 JPEG 交给视觉模型。
//
// 优先直接取页面内嵌的整页图: 扫描件每页本身就是一张完整的位图, 从操作符列表
// 取 paintImageXObject 既省掉一次栅格化, 也不受渲染路径影响。只有页面没有内嵌
// 位图 (纯矢量 / 文字路径) 时才退回 page.render()。pdfjs 4.10 的渲染路径在
// Node + @napi-rs/canvas 下曾段错误, 但目标页恰恰是本地 OCR 读不出文字的那些,
// 不渲染就没有图像可用, 因此这里先渲染、失败时由调用方按 OCR 失败处理。

// 1600px 宽足够看清 10pt 印刷体, 再大只是浪费 token 与上传带宽。
const OCR_MAX_WIDTH = 1600;
const OCR_JPEG_QUALITY = 0.82;

// 我们只取页面里的位图, 不做文字排版, 但 pdfjs 解析时仍会尝试加载标准字体;
// 不提供路径就会为每份文档打印一次警告。路径必须是文件系统目录 (legacy 构建走 fs.readFile)。
let assetPaths: { standardFontDataUrl: string; cMapUrl: string } | null = null;
const pdfAssets = (): { standardFontDataUrl: string; cMapUrl: string } => {
  if (assetPaths !== null) return assetPaths;
  const require = createRequire(import.meta.url);
  const root = dirname(require.resolve("pdfjs-dist/package.json"));
  assetPaths = {
    standardFontDataUrl: `${join(root, "standard_fonts")}/`,
    cMapUrl: `${join(root, "cmaps")}/`,
  };
  return assetPaths;
};
export interface PageImage {
  // 1 基页号, 与 pdfjs 的 getPage 一致; 调用方用它把 OCR 结果对回 pdf-inspector 的页。
  page: number;
  data: Uint8Array;
  mediaType: "image/jpeg";
  // 整页没有任何非白像素。这种页送去做视觉转写只会得到空结果, 白花一次 API 调用。
  blank: boolean;
}

interface PdfImage {
  width: number;
  height: number;
  kind: number;
  data: Uint8Array;
}

const toRgba = (image: PdfImage): Uint8ClampedArray => {
  const { width, height, kind, data } = image;
  const rgba = new Uint8ClampedArray(width * height * 4);
  if (kind === 3) {
    rgba.set(data.subarray(0, rgba.length));
    return rgba;
  }
  if (kind === 2) {
    for (let i = 0, j = 0; i + 2 < data.length && j + 3 < rgba.length; i += 3, j += 4) {
      rgba[j] = data[i]!;
      rgba[j + 1] = data[i + 1]!;
      rgba[j + 2] = data[i + 2]!;
      rgba[j + 3] = 255;
    }
    return rgba;
  }
  // GRAYSCALE_1BPP: 每字节 8 个像素, 高位在前; 0 = 黑, 1 = 白。
  const rowBytes = (width + 7) >> 3;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x += 1) {
      const bit = (data[rowStart + (x >> 3)]! >> (7 - (x & 7))) & 1;
      const value = bit === 1 ? 255 : 0;
      const offset = (y * width + x) * 4;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
};

// 整页是否没有任何非白像素。扫描件的空白页很常见, 直接送视觉模型只会换来一句
// "Empty response." —— 既费一次调用, 又可能被当成正文写进库里。
const isBlank = (canvas: Canvas): boolean => {
  const { data } = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! < 250 || data[i + 1]! < 250 || data[i + 2]! < 250) return false;
  }
  return true;
};

// 有些页没有内嵌位图 (纯矢量图形或文字路径), 但恰恰是本地 OCR 读不出来的那些。
// 这时退回整页栅格化: 页面能被 PDFium 渲染, 视觉模型就有图可读。
const renderPage = async (page: pdfjs.PDFPageProxy): Promise<{ data: Uint8Array; blank: boolean }> => {
  const scale = OCR_MAX_WIDTH / 612;
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, viewport.width, viewport.height);
  await page.render({ canvasContext: ctx as never, viewport }).promise;
  return { data: new Uint8Array(canvas.toBuffer("image/jpeg", OCR_JPEG_QUALITY)), blank: isBlank(canvas) };
};

const encodeJpeg = (image: PdfImage): { data: Uint8Array; blank: boolean } => {
  const scale = Math.min(1, OCR_MAX_WIDTH / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const source = createCanvas(image.width, image.height);
  source.getContext("2d").putImageData(new ImageData(toRgba(image), image.width, image.height), 0, 0);
  if (width === image.width && height === image.height) {
    return { data: new Uint8Array(source.toBuffer("image/jpeg", OCR_JPEG_QUALITY)), blank: isBlank(source) };
  }
  const target = createCanvas(width, height);
  const ctx = target.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return { data: new Uint8Array(target.toBuffer("image/jpeg", OCR_JPEG_QUALITY)), blank: isBlank(target) };
};

const pageImages = async (page: pdfjs.PDFPageProxy): Promise<PdfImage[]> => {
  const ops = await page.getOperatorList();
  const ids: string[] = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    if (ops.fnArray[i] === pdfjs.OPS.paintImageXObject) ids.push(String(ops.argsArray[i]?.[0] ?? ""));
  }
  const resolved = await Promise.all(
    ids
      .filter((id) => id.length > 0)
      .map((id) => new Promise<PdfImage | null>((resolve) => page.objs.get(id, resolve))),
  );
  return resolved.filter((image): image is PdfImage => image !== null && image.width > 0 && image.height > 0);
};

export const extractPdfPageImages = async (bytes: Uint8Array, pageNumbers: number[]): Promise<PageImage[]> => {
  if (pageNumbers.length === 0) return [];
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    isEvalSupported: false,
    disableFontFace: true,
    ...pdfAssets(),
  }).promise;
  try {
    const images: PageImage[] = [];
    for (const n of pageNumbers) {
      if (n < 1 || n > doc.numPages) continue;
      const page = await doc.getPage(n);
      // 一页可能有多个图像 (页眉 logo、印章等), 取面积最大的那张作为正文页。
      const candidates = await pageImages(page);
      const largest = candidates.sort((a, b) => b.width * b.height - a.width * a.height)[0];
      // 找不到位图时整页栅格化, 而不是跳过: 调用方正是为了这些页才需要图像。
      const image = largest !== undefined ? encodeJpeg(largest) : await renderPage(page);
      images.push({ page: n, data: image.data, mediaType: "image/jpeg", blank: image.blank });
      page.cleanup();
    }
    return images;
  } finally {
    await doc.destroy();
  }
};
