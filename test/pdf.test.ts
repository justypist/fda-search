import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { Store } from "../src/db.ts";
import { extractDocument } from "../src/content/parse.ts";
import { visionConfigFromEnv, type VisionClient } from "../src/content/vision.ts";
import { extractPdfPageImages } from "../src/content/pdfocr.ts";
import { OCR_PENDING_MARKER } from "../src/sources/content.ts";

// PDF 提取链路的离线用例。测试用的 PDF 由本文件现场拼装:
// 一个纯文本页 (走 pdf-inspector 的 markdown 抽取),
// 一个整页 JPEG 的扫描件 (走视觉模型 OCR)。
// 不引入 pdf 生成库, 避免为一个夹具增加依赖。

interface PdfObject {
  id: number;
  body: Buffer;
}

const assemblePdf = (objects: PdfObject[], rootId: number): Uint8Array => {
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets = new Map<number, number>();
  let length = parts[0]!.length;
  for (const object of objects) {
    offsets.set(object.id, length);
    const head = Buffer.from(`${object.id} 0 obj\n`, "latin1");
    const tail = Buffer.from("\nendobj\n", "latin1");
    const chunk = Buffer.concat([head, object.body, tail]);
    parts.push(chunk);
    length += chunk.length;
  }
  const xrefStart = length;
  const size = Math.max(...objects.map((object) => object.id)) + 1;
  const xref = [
    "xref",
    `0 ${size}`,
    "0000000000 65535 f ",
    ...Array.from({ length: size - 1 }, (_, index) => {
      const offset = offsets.get(index + 1);
      return offset === undefined
        ? "0000000000 65535 f "
        : `${String(offset).padStart(10, "0")} 00000 n `;
    }),
    "trailer",
    `<< /Size ${size} /Root ${rootId} 0 R >>`,
    "startxref",
    String(xrefStart),
    "%%EOF",
    "",
  ].join("\n");
  parts.push(Buffer.from(xref, "latin1"));
  return new Uint8Array(Buffer.concat(parts));
};

const streamObject = (id: number, dictionary: string, data: Buffer): PdfObject => {
  const body = Buffer.concat([
    Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`, "latin1"),
    data,
    Buffer.from("\nendstream", "latin1"),
  ]);
  return { id, body };
};

const makeTextPdf = (): Uint8Array => {
  const content = Buffer.from("BT /F1 18 Tf 72 700 Td (Listeria Outbreak Notice) Tj ET", "latin1");
  return assemblePdf(
    [
      { id: 1, body: Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1") },
      { id: 2, body: Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1") },
      {
        id: 3,
        body: Buffer.from(
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
          "latin1",
        ),
      },
      streamObject(4, "", content),
      { id: 5, body: Buffer.from("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", "latin1") },
    ],
    1,
  );
};

const scannedJpeg = (): { jpeg: Buffer; width: number; height: number } => {
  const width = 612;
  const height = 792;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#000000";
  ctx.font = "28px sans-serif";
  ctx.fillText("Scanned Listeria notice", 48, 120);
  return { jpeg: Buffer.from(canvas.toBuffer("image/jpeg", 0.9)), width, height };
};

const makeScannedPdf = (): Uint8Array => {
  const { jpeg, width, height } = scannedJpeg();
  const content = Buffer.from("q 612 0 0 792 0 0 cm /Im0 Do Q", "latin1");
  return assemblePdf(
    [
      { id: 1, body: Buffer.from("<< /Type /Catalog /Pages 2 0 R >>", "latin1") },
      { id: 2, body: Buffer.from("<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "latin1") },
      {
        id: 3,
        body: Buffer.from(
          "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>",
          "latin1",
        ),
      },
      streamObject(4, "", content),
      streamObject(
        5,
        `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode`,
        jpeg,
      ),
    ],
    1,
  );
};

const stubVision = (text: string): VisionClient & { calls: number } => {
  const client = {
    model: "stub-vision",
    calls: 0,
    transcribe: async (images: Uint8Array[]): Promise<string> => {
      client.calls += 1;
      assert.ok(images.length > 0, "应传入至少一张页面图像");
      assert.ok(images[0]!.byteLength > 0, "图像不应为空");
      return text;
    },
  };
  return client;
};

test("PDF: 文本型走 pdf-inspector 的 markdown 抽取, 不触发 OCR", async () => {
  const vision = stubVision("不应被调用");
  const out = await extractDocument(makeTextPdf(), "application/pdf", "https://www.fda.gov/media/1/download", { engine: "vision", vision });
  assert.equal(out.kind, "pdf");
  assert.equal(out.pdf?.pdfType, "TextBased");
  assert.equal(out.pdf?.ocrPages.length, 0);
  assert.equal(vision.calls, 0, "文本型 PDF 不应调用视觉模型");
  assert.ok(out.text.includes("Listeria Outbreak Notice"), out.text);
});

test("PDF: 扫描件用视觉模型转写, 并覆盖该页正文", async () => {
  const vision = stubVision("# Transcribed\n\nScanned Listeria notice");
  const out = await extractDocument(makeScannedPdf(), "application/pdf", "https://www.fda.gov/media/2/download", { engine: "vision", vision });
  assert.equal(out.pdf?.ocrMissing, false);
  assert.deepEqual(out.pdf?.ocrPages, [0], "整页图像应被分类为需要 OCR");
  assert.equal(out.pdf?.ocrApplied, 1);
  assert.equal(vision.calls, 1);
  assert.ok(out.text.includes("Scanned Listeria notice"), out.text);
});

test("PDF: 未配置视觉模型时全空的扫描件标记 ocrMissing, 不抛错", async () => {
  const out = await extractDocument(makeScannedPdf(), "application/pdf", "https://www.fda.gov/media/3/download", { engine: "vision" });
  assert.equal(out.pdf?.ocrMissing, true);
  assert.equal(out.pdf?.ocrApplied, 0);
  assert.equal(out.text, "", "没有 OCR 就没有正文");
});

test("resetOcrSkipped: 配置好视觉模型后, 之前跳过的扫描件回到待抓队列", () => {
  const dir = mkdtempSync(join(tmpdir(), "fda-search-ocr-reset-"));
  const store = new Store(join(dir, "t.db"));
  try {
    store.saveDocument({
      url: "https://www.fda.gov/media/9/download",
      kind: "pdf",
      title: "",
      text: "",
      bytes: 1234,
      etag: null,
      lastModified: null,
      fetchedAt: "2026-10-17T00:00:00.000Z",
      error: `${OCR_PENDING_MARKER} (Scanned)`,
    });
    assert.equal(store.resetOcrSkipped(), 1);
    assert.equal(store.getDocumentState("https://www.fda.gov/media/9/download"), null, "应可重新排队");
    assert.equal(store.ocrPendingCount(), 0);
    // 普通失败 (404 等) 不受影响
    store.saveDocument({
      url: "https://www.fda.gov/media/10/download",
      kind: "pdf",
      title: "",
      text: "",
      bytes: 0,
      etag: null,
      lastModified: null,
      fetchedAt: "2026-10-17T00:00:00.000Z",
      error: "https://www.fda.gov/media/10/download 返回 HTTP 404",
    });
    assert.equal(store.resetOcrSkipped(), 0, "真正的坏文档不应被重新排队");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PDF: 页面图像抽取按 1 基页号取, 输出 JPEG", async () => {
  const images = await extractPdfPageImages(makeScannedPdf(), [1]);
  assert.equal(images.length, 1);
  assert.equal(images[0]!.page, 1, "页号必须一起返回, 否则缺页时结果会错位");
  const jpeg = images[0]!.data;
  assert.equal(jpeg[0], 0xff, "JPEG SOI 标记");
  assert.equal(jpeg[1], 0xd8);
  assert.ok(jpeg.byteLength > 1000);
});

test("PDF: 本地 PP-OCR 引擎 — 有运行时则转写, 没有则标记 ocrMissing (绝不静默空正文)", async () => {
  const out = await extractDocument(makeScannedPdf(), "application/pdf", "https://www.fda.gov/media/4/download", { engine: "local" });
  assert.equal(out.pdf?.pdfType, "Scanned");
  const hasRuntime = Boolean(process.env.PDFIUM_LIB_PATH && process.env.ORT_DYLIB_PATH);
  if (hasRuntime) {
    assert.equal(out.pdf?.ocrMissing, false);
    assert.ok(out.text.length > 0, `本地 OCR 应产出正文: ${JSON.stringify(out.text.slice(0, 80))}`);
  } else {
    // 缺运行时必须如实上报, 否则扫描件会以"成功但正文为空"落库, 之后再也不会重试。
    assert.equal(out.pdf?.ocrMissing, true);
    assert.equal(out.text, "");
  }
});

test("PDF: 本地引擎不把纯文本页算作 OCR 页, 也不虚报 OCR 失败", async () => {
  const out = await extractDocument(makeTextPdf(), "application/pdf", "https://www.fda.gov/media/5/download", { engine: "local" });
  assert.equal(out.pdf?.ocrPages.length, 0, "文本型 PDF 没有任何页需要 OCR");
  assert.equal(out.pdf?.ocrApplied, 0, "未送去 OCR 就不能报成已 OCR");
  assert.equal(out.pdf?.ocrFailed, 0, "空白 / 文本页不是 OCR 失败");
  assert.ok(out.text.includes("Listeria Outbreak Notice"), out.text);
});

test("视觉模型配置: 三项齐全才启用, 任一缺失即关闭", () => {
  assert.equal(visionConfigFromEnv({}), null);
  assert.equal(visionConfigFromEnv({ LLM_BASE_URL: "http://x", LLM_API_KEY: "k" }), null);
  assert.equal(visionConfigFromEnv({ LLM_BASE_URL: "http://x", LLM_MODEL: "m" }), null);
  assert.deepEqual(
    visionConfigFromEnv({ LLM_BASE_URL: "http://x/v1", LLM_API_KEY: "k", LLM_MODEL: "vision" }, 3),
    { baseUrl: "http://x/v1", apiKey: "k", model: "vision", concurrency: 3 },
  );
});
