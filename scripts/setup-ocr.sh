#!/usr/bin/env bash
# 下载 pdf-inspector 本地 OCR 所需的共享库到 vendor/ocr。
# 模型 (~30 MB) 由库在首次 OCR 时自动下载到 ~/.cache/pdf-inspector。
set -euo pipefail

cd "$(dirname "$0")/.."
DEST=vendor/ocr
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)  PDFIUM=firecrawl-pdfium-linux-x64.tgz; ORT=onnxruntime-linux-x64-1.27.0.tgz; ORT_DIR=onnxruntime-linux-x64-1.27.0 ;;
  Linux-aarch64) PDFIUM=firecrawl-pdfium-linux-arm64.tgz; ORT=onnxruntime-linux-aarch64-1.27.0.tgz; ORT_DIR=onnxruntime-linux-aarch64-1.27.0 ;;
  Darwin-arm64)  PDFIUM=firecrawl-pdfium-mac-arm64.tgz; ORT=onnxruntime-osx-arm64-1.27.0.tgz; ORT_DIR=onnxruntime-osx-arm64-1.27.0 ;;
  *) echo "不支持的平台: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

mkdir -p "$DEST"
echo "下载 PDFium ($PDFIUM)"
curl -fsSL -o "$TMP/pdfium.tgz" "https://github.com/firecrawl/pdfium-rs/releases/download/native-v7988/$PDFIUM"
echo "下载 ONNX Runtime ($ORT)"
curl -fsSL -o "$TMP/ort.tgz" "https://github.com/microsoft/onnxruntime/releases/download/v1.27.0/$ORT"

tar xzf "$TMP/pdfium.tgz" -C "$TMP"
tar xzf "$TMP/ort.tgz" -C "$TMP"

find "$TMP/lib" -maxdepth 1 -name 'libpdfium.*' -exec cp {} "$DEST/" \;
find "$TMP/$ORT_DIR/lib" -maxdepth 1 -name 'libonnxruntime.*' -exec cp -P {} "$DEST/" \;

echo "已安装到 $DEST:"
ls -la "$DEST"
echo "首次 OCR 会自动下载 PP-OCRv6 模型到 ~/.cache/pdf-inspector"
