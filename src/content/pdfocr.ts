import { createCanvas, ImageData } from "@napi-rs/canvas";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// 纯图像 PDF 的 OCR 前处理: 把每页内嵌的整页图抽出来, 转成 JPEG 交给视觉模型。
//
// 不走 page.render(): pdfjs 4.10 的渲染路径在 Node + @napi-rs/canvas 下会段错误
// (实测两种 canvas 版本均崩溃), 而扫描件每页本身就是一张完整的位图,
// 直接从操作符列表取 paintImageXObject 既避开了该缺陷, 也省掉一次栅格化。

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

const encodeJpeg = (image: PdfImage): Uint8Array => {
  const scale = Math.min(1, OCR_MAX_WIDTH / image.width);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  const source = createCanvas(image.width, image.height);
  source.getContext("2d").putImageData(new ImageData(toRgba(image), image.width, image.height), 0, 0);
  if (width === image.width && height === image.height) {
    return new Uint8Array(source.toBuffer("image/jpeg", OCR_JPEG_QUALITY));
  }
  const target = createCanvas(width, height);
  const ctx = target.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  return new Uint8Array(target.toBuffer("image/jpeg", OCR_JPEG_QUALITY));
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
      // 找不到位图的页面不占位: 调用方按页号对回结果, 不会因缺页而错位。
      if (largest !== undefined) images.push({ page: n, data: encodeJpeg(largest), mediaType: "image/jpeg" });
      page.cleanup();
    }
    return images;
  } finally {
    await doc.destroy();
  }
};
