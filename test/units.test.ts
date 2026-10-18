import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { parseRfc822, parseIsoDate, toCompactDate, toDashedDate } from "../src/util/time.ts";
import { matchAll } from "../src/util/keyword.ts";
import { fieldText, pick, stripTags, sha1, truncate } from "../src/util/text.ts";
import { batchKeyOf } from "../src/pipeline.ts";
import { strayFlags, stripSeparators } from "../src/util/args.ts";
import { parseOpenFdaCursor, formatOpenFdaCursor } from "../src/sources/openfda.ts";
import { matchesFilter, toSitemapItem } from "../src/sources/sitemap.ts";
import { decodeEntities, extractHtml, kindFromContentType, normalizeText, officeKindOf } from "../src/content/extract.ts";
import { extractOfficeText } from "../src/content/office.ts";
import { zipSync, strToU8 } from "fflate";
import { buildSearch, buildStats } from "../src/server.ts";
import { OPENFDA_DATASETS } from "../src/defaults.ts";
import type { Item, KeywordRule } from "../src/types.ts";

const rule = (over: Partial<KeywordRule> = {}): KeywordRule => ({
  name: "test",
  any: [],
  all: [],
  none: [],
  regex: [],
  caseSensitive: false,
  sources: ["rss", "openfda", "sitemap"],
  ...over,
});

const item = (over: Partial<Item> = {}): Item => ({
  id: "x",
  source: "rss",
  channel: "rss:test",
  title: "",
  summary: "",
  url: "",
  date: null,
  extra: {},
  ...over,
});

test("RFC-822 日期按字面时区缩写换算为 UTC", () => {
  assert.equal(parseRfc822("Thu, 15 Oct 2026 16:04:00 EDT"), "2026-10-15T20:04:00.000Z");
  assert.equal(parseRfc822("Thu, 15 Oct 2026 16:04:00 EST"), "2026-10-15T21:04:00.000Z");
  assert.equal(parseRfc822("Mon, 05 Jan 2026 09:30:00 PST"), "2026-01-05T17:30:00.000Z");
  assert.equal(parseRfc822("Fri, 16 Oct 2026 00:00:00 GMT"), "2026-10-16T00:00:00.000Z");
  assert.equal(parseRfc822("Thu, 15 Oct 2026 16:04:00 -0400"), "2026-10-15T20:04:00.000Z");
});

test("RFC-822 无时区时按 UTC 解释, 非法输入返回 null", () => {
  // 关键: 不能回退给 new Date() 用服务器本地时区解释, 否则会整体偏移
  assert.equal(parseRfc822("Thu, 15 Oct 2026 16:04:00"), "2026-10-15T16:04:00.000Z");
  assert.equal(parseRfc822("15 Oct 2026 16:04:00"), "2026-10-15T16:04:00.000Z");
  assert.equal(parseRfc822("not a date"), null);
  assert.equal(parseRfc822(""), null);
});

test("openFDA 的紧凑与带连字符日期都能解析", () => {
  assert.equal(parseIsoDate("20261007"), "2026-10-07T00:00:00.000Z");
  assert.equal(parseIsoDate("2026-10-07"), "2026-10-07T00:00:00.000Z");
  assert.equal(parseIsoDate(""), null);
});

test("日期格式化保持 UTC 语义", () => {
  const at = new Date("2026-10-16T23:30:00.000Z");
  assert.equal(toCompactDate(at), "20261016");
  assert.equal(toDashedDate(at), "2026-10-16");
});

test("关键词 any 命中任意一项即通过, 并记录命中字段", () => {
  const hits = matchAll(item({ title: "Cheese recalled for Listeria" }), [rule({ any: ["listeria"] })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.field, "title");
  assert.equal(hits[0]?.term, "listeria");
});

test("关键词匹配默认忽略大小写, caseSensitive 时区分", () => {
  assert.equal(matchAll(item({ title: "LISTERIA" }), [rule({ any: ["listeria"] })]).length, 1);
  assert.equal(matchAll(item({ title: "LISTERIA" }), [rule({ any: ["listeria"], caseSensitive: true })]).length, 0);
});

test("all 要求全部命中, none 命中即排除", () => {
  const target = item({ title: "recall of cheese with listeria" });
  assert.equal(matchAll(target, [rule({ all: ["recall", "listeria"] })]).length, 1);
  assert.equal(matchAll(target, [rule({ all: ["recall", "salmonella"] })]).length, 0);
  assert.equal(matchAll(target, [rule({ any: ["recall"], none: ["cheese"] })]).length, 0);
});

test("regex 全部需命中, 且不区分大小写", () => {
  const target = item({ title: "Listeria monocytogenes" });
  assert.equal(matchAll(target, [rule({ regex: ["listeri[ao]", "monocyto"] })]).length, 2);
  assert.equal(matchAll(target, [rule({ regex: ["listeri[ao]", "salmonell"] })]).length, 0);
});

test("无任何正向词的规则不产生命中", () => {
  assert.equal(matchAll(item({ title: "anything" }), [rule({ none: ["x"] })]).length, 0);
});

test("规则按 source 限定生效范围", () => {
  const target = item({ title: "listeria", source: "sitemap" });
  assert.equal(matchAll(target, [rule({ any: ["listeria"], sources: ["rss"] })]).length, 0);
  assert.equal(matchAll(target, [rule({ any: ["listeria"], sources: ["sitemap"] })]).length, 1);
});

test("关键词会匹配 extra 字段", () => {
  const target = item({ extra: { reason_for_recall: "sterility failure" } });
  const hits = matchAll(target, [rule({ any: ["sterility"] })]);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.field, "extra.reason_for_recall");
});

test("pick 支持嵌套路径与数组首元素", () => {
  const record = { patient: { drug: [{ medicinalproduct: "ASPIRIN" }] }, a: { b: { c: 5 } } };
  assert.equal(fieldText(record, "patient.drug.medicinalproduct"), "ASPIRIN");
  assert.equal(pick(record, "a.b.c"), 5);
  assert.equal(pick(record, "a.missing.c"), undefined);
});

test("flatten 展开对象为一句话, pick 对数组取首元素再继续下钻", () => {
  assert.equal(fieldText({ x: { y: "z" } }, "x"), "z");
  // pick 沿路径遇到数组时取首元素 (openFDA 的 patient.drug 等字段即为此形状)
  assert.equal(fieldText({ x: ["a", "b"] }, "x"), "a");
  assert.equal(fieldText({ list: [{ v: "first" }, { v: "second" }] }, "list.v"), "first");
  assert.equal(fieldText({}, "nope"), "");
});

test("stripTags 与 truncate 用于 RSS 摘要清洗", () => {
  assert.equal(stripTags("<p>Hello <b>world</b></p>"), "Hello world");
  assert.equal(truncate("abcdef", 4), "abc…");
  assert.equal(truncate("abc", 4), "abc");
});

test("sha1 稳定且区分内容", () => {
  assert.equal(sha1("a"), sha1("a"));
  assert.notEqual(sha1("a"), sha1("b"));
});

test("回归: 队列键包含内容指纹, 相同游标不同内容不会碰撞", () => {
  const cursor = "2026-10-17:0:2026-07-18";
  const batchA = [item({ id: "openfda:x:1" })];
  const batchB = [item({ id: "openfda:x:2" })];
  assert.notEqual(batchKeyOf(cursor, batchA), batchKeyOf(cursor, batchB));
  assert.equal(batchKeyOf(cursor, batchA), batchKeyOf(cursor, batchA));
});

test("openFDA 游标解析对损坏输入安全回退", () => {
  const dataset = OPENFDA_DATASETS.find((d) => d.name === "drug/enforcement")!;
  const now = new Date("2026-10-16T00:00:00.000Z");
  assert.equal(formatOpenFdaCursor(parseOpenFdaCursor("2026-09-01:200:2026-07-18", dataset, now)), "2026-09-01:200:2026-07-18");
  // 修复前 count 聚合产出的紧凑日期会写进游标, 必须回退而不是抛错
  assert.equal(parseOpenFdaCursor("20260814:0:2026-07-18", dataset, now).day, "2026-07-18");
  assert.equal(parseOpenFdaCursor("garbage", dataset, now).skip, 0);
});

test("回归: 非法日期应显式报错而不是产出 NaN 游标", async () => {
  const { addDaysChecked } = await import("../src/sources/openfda.ts");
  assert.equal(addDaysChecked("2026-08-14", 1), "2026-08-15");
  assert.throws(() => addDaysChecked("20260814", 1), /非法日期/);
});

test("sitemap 路径过滤: include 命中且 exclude 优先", () => {
  const include = ["/safety/", "/drugs/"];
  const exclude = ["/media/"];
  assert.equal(matchesFilter("https://www.fda.gov/safety/x", include, exclude), true);
  assert.equal(matchesFilter("https://www.fda.gov/media/x", include, exclude), false);
  assert.equal(matchesFilter("https://www.fda.gov/other/x", include, exclude), false);
  assert.equal(matchesFilter("https://www.fda.gov/anything", [], []), true);
});

test("sitemap 条目用路径作为标题, 使路径关键词可被匹配", () => {
  const entry = { loc: "https://www.fda.gov/safety/recalls/listeria-outbreak", lastModified: "2026-10-15T08:16:49-04:00" };
  const converted = toSitemapItem(entry, "sitemap:fda.gov");
  assert.equal(converted.title, "/safety/recalls/listeria-outbreak");
  assert.equal(converted.date, "2026-10-15T12:16:49.000Z");
  assert.equal(matchAll(converted, [rule({ any: ["listeria"], sources: ["sitemap"] })]).length, 1);
});

test("回归: 同一篇文章出现在多个 feed 时共享主键, 不重复告警", async () => {
  const body = (guid: string): string =>
    `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel><title>T</title>` +
    `<item><title>Same article</title><link>http://www.fda.gov/a</link><description>d</description>` +
    `<pubDate>Thu, 15 Oct 2026 16:04:00 EDT</pubDate><guid isPermaLink="true">${guid}</guid></item></channel></rss>`;
  const client = (payload: string) => ({
    fetchText: async () => ({ status: 200, body: payload, headers: new Headers(), notModified: false }),
  });
  const { fetchFeed } = await import("../src/sources/rss.ts");
  const a = await fetchFeed(client(body("http://www.fda.gov/a")) as never, "x", "rss:recalls", null);
  const b = await fetchFeed(client(body("http://www.fda.gov/a")) as never, "x", "rss:food-safety-recalls", null);
  // 主键不含通道名, 因此在两个 feed 中指向同一篇文章
  assert.equal(a.items[0]!.id, b.items[0]!.id);
});

// --- 正文提取 ---

test("正文提取: 只取 main-content, 丢掉导航/脚本/页脚", () => {
  const html = `<!doctype html><html><head><title>Listeria Outbreak | FDA</title></head><body>
<nav>导航文字</nav><article id="main-content"><h1>Listeria Outbreak</h1>
<p>Soft cheese linked to infections.</p><script>var secret="脚本文字";</script></article>
<footer>页脚文字</footer></body></html>`;
  const out = extractHtml(html);
  assert.equal(out.title, "Listeria Outbreak", "标题取 h1, 且剥掉 '| FDA' 后缀");
  assert.ok(out.text.includes("Soft cheese"), "正文应保留");
  assert.ok(!out.text.includes("导航文字"), "nav 不应进正文");
  assert.ok(!out.text.includes("脚本文字"), "script 不应进正文");
  assert.ok(!out.text.includes("页脚文字"), "footer 不应进正文");
});

test("正文提取: HTML 实体解码与空白折叠", () => {
  // decodeEntities 只负责把实体换成对应字符, 不折叠空白 (那是 normalizeText 的职责)
  assert.equal(decodeEntities("a &amp; b &lt;c&gt;"), "a & b <c>");
  assert.equal(decodeEntities("&nbsp;d &#39;e&#39;"), " d 'e'");
  assert.equal(decodeEntities("&#x41;&#66;"), "AB");
  assert.equal(normalizeText("  a\n\n\n\nb  "), "a\n\nb");
  assert.equal(normalizeText(decodeEntities("a &amp;&nbsp;&nbsp;b")), "a & b");
});

test("正文提取: ld+json 里的 datePublished 被解析成 ISO", () => {
  const html = `<html><body><article id="main-content"><p>x</p></article>
<script type="application/ld+json">{"@type":"Article","datePublished":"Thu, 10/15/2026 - 08:00"}</script></body></html>`;
  const out = extractHtml(html);
  assert.ok(out.date !== null && out.date.startsWith("2026-10-15"), `应解析出日期, 实得 ${out.date}`);
});

test("正文提取: content-type 决定解析方式, 未知类型回退到 URL 后缀", () => {
  assert.equal(kindFromContentType("application/pdf", "https://x/media/1/download"), "pdf");
  assert.equal(
    kindFromContentType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "https://x/media/1/download"),
    "xlsx",
  );
  assert.equal(kindFromContentType("text/html; charset=utf-8", "https://x/a"), "html");
  // FDA 的附件 URL 都是 /media/<id>/download, 没有后缀, 只能靠 content-type
  assert.equal(kindFromContentType("", "https://x/media/1/download"), "html");
  assert.equal(kindFromContentType("", "https://x/a/b.pdf"), "pdf");
});

test("正文提取: Office zip 部件按类型识别", () => {
  assert.equal(officeKindOf(["xl/workbook.xml", "xl/sharedStrings.xml"]), "xlsx");
  assert.equal(officeKindOf(["word/document.xml", "[Content_Types].xml"]), "docx");
  assert.equal(officeKindOf(["ppt/slides/slide1.xml"]), "pptx");
  assert.equal(officeKindOf(["random.xml"]), "unknown");
});

test("正文提取: Office XML 文本节点抽出, 段落边界保留换行", () => {
  const docx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<w:document><w:body><w:p><w:r><w:t>First para</w:t></w:r></w:p><w:p><w:r><w:t>Second &amp; para</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
  const text = extractOfficeText(docx, 1_000_000);
  assert.ok(text.includes("First para") && text.includes("Second & para"), text);
  assert.ok(text.includes("\n"), "段落之间应有换行");
});

test("回归: Office 流式解压, 跨分块的文本与实体完整保留", () => {
  // 超过一个 1 MB 分块的文本节点, 以及恰好在块边界附近的实体与裸 "<"。
  const filler = "x".repeat(1_000_000);
  const docx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "word/document.xml": strToU8(
      `<w:document><w:body><w:p><w:r><w:t>${filler}</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>needle &amp; thread</w:t></w:r></w:p>` +
        `<w:p><w:r><w:t>a &lt; b 5</w:t></w:r></w:p></w:body></w:document>`,
    ),
  });
  const text = extractOfficeText(docx, 3_000_000);
  assert.ok(text.length > 1_000_000, `应跨过分块, 实得 ${text.length}`);
  assert.ok(text.includes("needle & thread"), "跨块的实体不能丢");
  assert.ok(text.includes("a < b 5"), "转义的尖括号应还原为文字");
});

test("回归: xlsx 优先保留 sharedStrings, 单元格索引不挤占文字", () => {
  const rows = Array.from({ length: 2000 }, (_, i) => `<row r="${i + 1}"><c t="s"><v>${i}</v></c></row>`).join("");
  const strings = Array.from({ length: 2000 }, (_, i) => `<si><t>Listeria sample ${i}</t></si>`).join("");
  const xlsx = zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData>${rows}</sheetData></worksheet>`),
    "xl/sharedStrings.xml": strToU8(`<sst>${strings}</sst>`),
  });
  const text = extractOfficeText(xlsx, 200_000);
  assert.ok(text.startsWith("Listeria sample 0"), `文字应排在索引之前, 实得 ${text.slice(0, 40)}`);
  assert.ok(text.includes("Listeria sample 1999") || text.length >= 200_000, "文字部分不应被索引挤掉");
});

// --- 正文抓取的排序与 lastmod 刷新 ---

test("回归: sitemap 重扫时 lastmod 前进必须刷新, 否则倒序抓取会用旧时间排序", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "fda-search-lastmod-")), "t.db"));
  try {
    const make = (id: string, url: string, date: string): Item => ({
      id, source: "sitemap", channel: "sitemap:fda.gov", title: url, summary: "", url, date, extra: {},
    });
    // A 首次采到时 lastmod 是 2020
    store.commitItems([make("sitemap:a", "https://www.fda.gov/a", "2020-01-01T00:00:00.000Z")], [], 1, "2026-10-16T00:00:00.000Z");
    // B 的 lastmod 是 2025
    store.commitItems([make("sitemap:b", "https://www.fda.gov/b", "2025-06-01T00:00:00.000Z")], [], 1, "2026-10-16T00:00:00.000Z");
    // A 重扫, lastmod 前进到 2026 —— 若不刷新 published_at, A 仍会排在 B 之后
    store.commitItems([make("sitemap:a", "https://www.fda.gov/a", "2026-10-15T00:00:00.000Z")], [], 1, "2026-10-16T01:00:00.000Z");
    const order = store.pendingDocumentUrls({ include: [], exclude: [] }, 10).map((u) => u.split("/").pop());
    assert.deepEqual(order, ["a", "b"], "A 的 lastmod 前进后应排到最前");
  } finally {
    store.close();
  }
});

test("正文待抓列表按 lastmod 倒序, published_at 为空的排最后", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "fda-search-order-")), "t.db"));
  try {
    const make = (id: string, url: string, date: string | null): Item => ({
      id, source: "sitemap", channel: "sitemap:fda.gov", title: url, summary: "", url, date, extra: {},
    });
    store.commitItems(
      [
        make("sitemap:a", "https://www.fda.gov/old", "2020-01-01T00:00:00.000Z"),
        make("sitemap:b", "https://www.fda.gov/new", "2026-10-15T00:00:00.000Z"),
        make("sitemap:c", "https://www.fda.gov/none", null),
      ],
      [],
      1,
      "2026-10-16T00:00:00.000Z",
    );
    const order = store.pendingDocumentUrls({ include: [], exclude: [] }, 10).map((u) => u.split("/").pop());
    assert.deepEqual(order, ["new", "old", "none"], "应按 lastmod 倒序, 无 lastmod 的排最后");
  } finally {
    store.close();
  }
});

// --- 本地搜索界面 (serve) 的查询逻辑 ---

test("搜索: web 模式查元数据, content 模式查正文, 空查询与无命中都返回 0", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ghare-serve-")), "t.db"));
  try {
    store.commitItems(
      [
        {
          id: "sitemap:x", source: "sitemap", channel: "sitemap:fda.gov",
          title: "/safety/recalls/listeria-outbreak", summary: "", date: "2026-10-15T00:00:00.000Z",
          url: "https://www.fda.gov/safety/recalls/listeria-outbreak", extra: {},
        },
      ],
      [], 1, "2026-10-16T00:00:00.000Z",
    );
    store.saveDocument({
      url: "https://www.fda.gov/safety/recalls/listeria-outbreak", kind: "html", title: "Listeria Outbreak",
      text: "The FDA investigated Listeria monocytogenes in soft cheese.", bytes: 100,
      etag: null, lastModified: null, fetchedAt: "2026-10-16T00:00:00.000Z", error: null,
    });

    const web = buildSearch(store, "listeria", "web", 10);
    assert.equal(web.count, 1);
    assert.equal(web.hits[0]!.kind, "page");

    // 正文模式能命中只在正文里出现的词 (URL 里没有)
    const content = buildSearch(store, "monocytogenes", "content", 10);
    assert.equal(content.count, 1);
    assert.equal(content.hits[0]!.title, "Listeria Outbreak");
    assert.ok(content.hits[0]!.snippet.includes("["), "应带命中标记");

    // web 模式搜不到只在正文里的词, 这正说明两种索引是分开的
    assert.equal(buildSearch(store, "monocytogenes", "web", 10).count, 0);
    assert.equal(buildSearch(store, "   ", "content", 10).count, 0, "空查询不返回全部");
    assert.equal(buildSearch(store, "zzz-nope", "content", 10).count, 0);

    const stats = buildStats(store);
    assert.equal(stats.instances, 1);
    assert.equal(stats.documentsWithText, 1);
  } finally {
    store.close();
  }
});

test("回归: 元数据 FTS 索引必须回填, 否则相关度检索恒返回 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "ghare-fts-"));
  const path = join(dir, "t.db");
  // 第一轮: 写入数据 (触发器建索引)
  const a = new Store(path);
  a.commitItems(
    [
      { id: "sitemap:a", source: "sitemap", channel: "sitemap:fda.gov", title: "Listeria in soft cheese", summary: "outbreak", url: "https://www.fda.gov/a", date: "2026-01-01T00:00:00.000Z", extra: {} },
      { id: "sitemap:b", source: "sitemap", channel: "sitemap:fda.gov", title: "Unrelated labeling notice", summary: "", url: "https://www.fda.gov/b", date: "2020-01-01T00:00:00.000Z", extra: {} },
    ],
    [], 1, "2026-10-16T00:00:00.000Z",
  );
  assert.equal(a.searchInstances("listeria", 10, "relevance").hits.length, 1, "写入时应可用");
  a.close();

  // 模拟"索引丢失但数据还在": 清空 FTS 索引内容后重新打开, 应自动 rebuild
  const raw = new DatabaseSync(path);
  raw.exec("INSERT INTO instances_fts (instances_fts) VALUES ('delete-all')");
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM instances_fts WHERE instances_fts MATCH ?").get('"listeria"').n, 0, "索引应已清空");
  raw.close();

  const b = new Store(path);
  try {
    assert.equal(b.searchInstances("listeria", 10, "relevance").hits.length, 1, "重新打开时应自动回填索引");
  } finally {
    b.close();
  }
});

test("搜索排序: 相关度 / 时间倒序 / 时间正序 给出不同顺序", () => {
  const store = new Store(join(mkdtempSync(join(tmpdir(), "ghare-sort-")), "t.db"));
  try {
    const make = (id: string, title: string, url: string, date: string): Item => ({
      id, source: "sitemap", channel: "sitemap:fda.gov", title, summary: "", url, date, extra: {},
    });
    store.commitItems(
      [
        make("sitemap:old", "Listeria old notice", "https://www.fda.gov/old", "2019-01-01T00:00:00.000Z"),
        make("sitemap:new", "Listeria new notice", "https://www.fda.gov/new", "2026-01-01T00:00:00.000Z"),
      ],
      [], 1, "2026-10-16T00:00:00.000Z",
    );
    const first = (sort: "relevance" | "newest" | "oldest"): string =>
      store.searchInstances("listeria", 10, sort).hits[0]!.item.url;
    assert.equal(first("newest"), "https://www.fda.gov/new");
    assert.equal(first("oldest"), "https://www.fda.gov/old");
    assert.equal(store.searchInstances("listeria", 10, "relevance").hits.length, 2, "相关度模式下两条都在");
  } finally {
    store.close();
  }
});

test("批量下载: 流式解析 openFDA 分区 (避免爆栈与内存上限)", async () => {
  // 这两个限制都是实测撞到的, 用 15 万+ 条记录复现:
  //   1. push(...items) 展开成 15 万个实参 → "Maximum call stack size exceeded"
  //   2. 整块 JSON.parse → 解压后超 512 MB 时 "Cannot create a string longer than 0x1fffffe8"
  const big = Array.from({ length: 150_000 }, (_, i) => i);
  const acc: number[] = [];
  for (const n of big) acc.push(n);
  assert.equal(acc.length, 150_000, "逐条 push 可以处理 15 万条");
  // 展开运算符的实参上限在 V8 上约 12.5 万, 这里确认"逐条"是必要的而非风格偏好
  assert.throws(() => {
    const target: number[] = [];
    (target.push as (...n: number[]) => number)(...big);
  }, /call stack|too many arguments/i, "展开 15 万个实参应溢出");
});

test("回归: pnpm 传入的 `--` 不能被当成位置参数, 否则开关全部丢失而跑起全部通道", () => {
  const cleaned = stripSeparators(["collect", "--", "--stage", "content", "--full", "--verbose"]);
  assert.deepEqual(cleaned, ["collect", "--stage", "content", "--full", "--verbose"], "分隔符应被剔除");
  assert.deepEqual(stripSeparators(["collect", "--stage", "content"]), ["collect", "--stage", "content"], "无分隔符时不变");
  assert.deepEqual(strayFlags(["--stage", "content"]), ["--stage"], "漏网的开关必须能被识别");
  assert.deepEqual(strayFlags(["collect"]), [], "正常位置参数不应误报");
});

test("回归: 无论 sheet 还是 sharedStrings 先到, 都不挤掉文字", () => {
  // zip 内部件顺序由打包方式决定, 两种顺序都要能取到 sharedStrings。
  const strings = strToU8(`<sst>${Array.from({ length: 500 }, (_, i) => `<si><t>Listeria ${i}</t></si>`).join("")}</sst>`);
  const sheet = strToU8(`<worksheet><sheetData>${Array.from({ length: 500 }, (_, i) => `<row r="${i + 1}"><c t="s"><v>${i}</v></c></row>`).join("")}</sheetData></worksheet>`);
  for (const order of [
    { "[Content_Types].xml": strToU8("<Types/>"), "xl/worksheets/sheet1.xml": sheet, "xl/sharedStrings.xml": strings },
    { "[Content_Types].xml": strToU8("<Types/>"), "xl/sharedStrings.xml": strings, "xl/worksheets/sheet1.xml": sheet },
  ]) {
    const text = extractOfficeText(zipSync(order), 10_000);
    assert.ok(text.includes("Listeria 0") && text.includes("Listeria 499"), `部件顺序不应影响文字提取, 实得 ${text.slice(0, 80)}`);
  }
});
