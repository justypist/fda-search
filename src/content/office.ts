import { Unzip, UnzipInflate } from "fflate";
import { decodeEntities, normalizeText, officeKindOf } from "./extract.ts";

// Office 文档是 zip + XML。不能用 unzipSync 一次性解压: FDA 的 xlsx 附件里
// 单个 sheet1.xml 解压后可达 358 MB (57 MB 的 xlsx), 整块进堆会直接 OOM。
// 这里按 1 MB 分块喂给 fflate 的流式解压, 边解压边剥标签, 内存与文档大小无关。
//
// 文本量另设上限: 这类附件动辄数百万行, 全量进 FTS 既无检索价值又拖慢索引。
// xlsx 的 sharedStrings 优先保留, 保证被截断时留下的是文字标签而不是单元格索引。

const ZIP_CHUNK = 1 << 20;
const BLOCK_END = /<\/(w:p|w:tr|a:p|row|c)>/gi;
const BREAK = /<(w:br|w:tab|a:br)\b[^>]*\/?>/gi;
// 单个标签 (含属性) 的长度上限。真实的 Office XML 标签都远小于它; 超过说明
// 这不是标签而是嵌在文本里的 "<", 按文本处理才不会整段丢掉。
const TAG_MAX = 4096;

// 预算按"读入的原始 XML 字符数"计: 标签与属性占绝大多数, 剥完文字只剩一小部分
// (实测 150 MB 的 sharedStrings 抽出 4,400 万字符, 约 1/3.4)。用系数把
// "想要的正文长度" 换算成可读的原始 XML 量, 保证最终截断前文本量足够。
const RAW_FACTOR = 4;

interface Budget {
  remaining: number;
}

const ENTITY_TAIL = /&[a-zA-Z#0-9]{0,10}$/;

// 流式 XML 文本抽取: 只保留标签之外的文字, 块级边界补换行, 与 xmlPartsToText 同义。
class PartSink {
  readonly #decoder = new TextDecoder("utf-8", { fatal: false });
  readonly #budget: Budget;
  readonly #parts: string[] = [];
  #carry = "";

  constructor(budget: Budget) {
    this.#budget = budget;
  }

  get full(): boolean {
    return this.#budget.remaining <= 0;
  }

  text(): string {
    return this.#parts.join("");
  }

  // 切分点严格保持在标签边界上: 文本里可能合法地出现裸 "<" (未转义), 盲目按
  // lastIndexOf(">") 切会把 "<" 当标签开头, 连带丢掉后面整段正文。因此只把
  // "尚未闭合的标签" 或 "可能是实体前缀的尾部" 留到下一块。
  push(chunk: Uint8Array): void {
    if (this.full) return;
    const combined = this.#carry + this.#decoder.decode(chunk, { stream: true });
    const open = combined.lastIndexOf("<");
    if (open >= 0) {
      const close = combined.indexOf(">", open);
      if (close >= 0 && close - open <= TAG_MAX) {
        this.#carry = combined.slice(close + 1);
        this.#append(combined.slice(0, close + 1));
        return;
      }
      // 末尾有未闭合的标签: 整段留到下一块, 避免标签被切成两半后漏出属性文本。
      if (close < 0 && combined.length - open <= TAG_MAX) {
        this.#carry = combined.slice(open);
        this.#append(combined.slice(0, open));
        return;
      }
    }
    const entity = ENTITY_TAIL.exec(combined);
    const keep = entity === null ? 0 : entity[0].length;
    this.#carry = combined.slice(combined.length - keep);
    this.#append(combined.slice(0, combined.length - keep));
  }

  #append(body: string): void {
    // 预算按"读入的原始 XML"扣减, 与实际产出的文字量无关: 截断点因此落在
    // 原始流的固定位置, 且总量由 maxChars * RAW_FACTOR 兜住。
    const raw = Math.min(body.length, this.#budget.remaining);
    this.#budget.remaining -= raw;
    const plain = decodeEntities(body.slice(0, raw).replace(BLOCK_END, "\n").replace(BREAK, "\n").replace(/<[^>]*>/g, " "));
    if (plain.length > 0) this.#parts.push(plain);
  }
}

// 解压并按部件名把文本收进对应的 sink。三种 Office 格式的部件路径互不重叠,
// 因此一次解压就能同时处理, 不必先探测格式再解压第二遍。
const streamParts = (bytes: Uint8Array, accept: (name: string) => Budget | null, sinks: Map<string, PartSink>): string[] => {
  const names: string[] = [];
  const unzip = new Unzip((file) => {
    names.push(file.name);
    const budget = accept(file.name);
    if (budget === null) {
      // 不关心的部件: 不调用 start(), fflate 会直接跳过它, 不产生解压开销。
      return;
    }
    const sink = new PartSink(budget);
    sinks.set(file.name, sink);
    file.ondata = (error, chunk) => {
      if (error === null) sink.push(chunk);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += ZIP_CHUNK) {
    unzip.push(bytes.subarray(offset, Math.min(offset + ZIP_CHUNK, bytes.length)), offset + ZIP_CHUNK >= bytes.length);
  }
  return names;
};

export const extractOfficeText = (bytes: Uint8Array, maxChars: number): string => {
  const limit = Math.max(1, Math.floor(maxChars));
  const raw = Math.max(1, Math.floor(limit * RAW_FACTOR));
  // xlsx 的 sharedStrings 与 worksheets 分开预算, 不能共用: zip 内部件顺序不保证
  // (实测 sheet 在前), 若共用, 先到的 sheet 会把预算吃光, 后到的 sharedStrings
  // 被整个丢掉 —— 而没有它, 单元格里只剩索引数字。
  const strings: Budget = { remaining: raw };
  const sheets: Budget = { remaining: Math.max(1, Math.floor(raw / 2)) };
  const other: Budget = { remaining: raw };

  const sinks = new Map<string, PartSink>();
  const names = streamParts(
    bytes,
    (name) => {
      if (name === "xl/sharedStrings.xml") return strings;
      if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) return sheets;
      if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) return other;
      if (/^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(name)) return other;
      return null;
    },
    sinks,
  );

  // 部件名才是格式的真相: content-type 可能是通用的 octet-stream, 甚至是错的。
  const actual = officeKindOf(names);
  if (actual !== "xlsx" && actual !== "docx" && actual !== "pptx") return "";
  const prefix = actual === "xlsx" ? "xl/" : actual === "docx" ? "word/" : "ppt/";
  const wanted = [...sinks.entries()].filter(([name]) => name.startsWith(prefix));
  // sharedStrings 排在最前: 文字都在那里, 截断时优先留下可检索的内容。
  wanted.sort(([a], [b]) => (a === "xl/sharedStrings.xml" ? -1 : b === "xl/sharedStrings.xml" ? 1 : 0));
  return normalizeText(wanted.map(([, sink]) => sink.text()).join("\n")).slice(0, limit);
};
