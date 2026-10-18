import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { runCollect } from "../src/pipeline.ts";
import { HttpError } from "../src/util/http.ts";
import { OPENFDA_DATASETS } from "../src/defaults.ts";
import "../src/notify/index.ts";
import type { Config, Item } from "../src/types.ts";

// 这一组测试不联网: 用桩 HttpClient 喂入固定样本, 验证采集 -> 队列 -> 匹配 ->
// 告警 -> 通知的完整链路, 重点是幂等性 (重复采集不重复告警) 与条件请求短路。

const RSS_BODY = `<?xml version="1.0" encoding="utf-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0"><channel>
<title>Test Feed</title>
<item>
  <title>Cheese recalled for Listeria monocytogenes</title>
  <link>http://www.fda.gov/safety/recalls/cheese-listeria</link>
  <description>Possible contamination with Listeria.</description>
  <pubDate>Thu, 15 Oct 2026 16:04:00 EDT</pubDate>
  <guid isPermaLink="true">http://www.fda.gov/safety/recalls/cheese-listeria</guid>
</item>
<item>
  <title>Unrelated notice about labeling</title>
  <link>http://www.fda.gov/news-events/unrelated</link>
  <description>No pathogen named here.</description>
  <pubDate>Thu, 15 Oct 2026 09:00:00 EDT</pubDate>
  <guid isPermaLink="true">http://www.fda.gov/news-events/unrelated</guid>
</item>
</channel></rss>`;

const SITEMAP_INDEX = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>https://www.fda.gov/sitemap.xml?page=1</loc><lastmod>2026-10-16T01:30:27-04:00</lastmod></sitemap>
</sitemapindex>`;

const SITEMAP_PAGE = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="https://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://www.fda.gov/media/69866/download</loc><lastmod>2024-04-09T11:20:31-04:00</lastmod></url>
<url><loc>https://www.fda.gov/safety/recalls/listeria-outbreak-2026</loc><lastmod>2026-10-15T08:16:49-04:00</lastmod></url>
</urlset>`;

const PAGE_LAST_MODIFIED = "Fri, 16 Oct 2026 06:44:36 GMT";

const PAGE_HTML = `<!doctype html><html><head><title>Listeria Outbreak 2026 | FDA</title>
<script type="application/ld+json">{"@type":"Article","datePublished":"Thu, 10/15/2026 - 08:00"}</script>
</head><body><nav>导航不该进正文</nav>
<article id="main-content"><h1>Listeria Outbreak 2026</h1>
<p>The FDA is investigating a multistate outbreak of Listeria monocytogenes infections linked to soft cheese.</p>
<script>var x = "脚本不该进正文";</script>
</article><footer>页脚不该进正文</footer></body></html>`;

interface Harness {
  config: Config;
  dir: string;
  store: Store;
  stub: {
    fetchText: (request: { url: string; conditional?: { lastModified: string | null } }) => Promise<unknown>;
    fetchJson: (request: { url: string }) => Promise<unknown>;
    fetchBytesDirect: (request: { url: string; conditional?: { lastModified: string | null } }) => Promise<unknown>;
  };
  setLastUpdated: (value: string) => void;
  setBytesResponse: (response: (request: { url: string; conditional?: { lastModified: string | null } }) => Promise<unknown>) => void;
  counts: () => { text: number; json: number };
}

const makeHarness = (): Harness => {
  const dir = mkdtempSync(join(tmpdir(), "fda-search-e2e-"));
  let lastUpdated = "2026-10-07";
  let bytesOverride: ((request: { url: string; conditional?: { lastModified: string | null } }) => Promise<unknown>) | null = null;
  const counts = { text: 0, json: 0 };
  const dataset = OPENFDA_DATASETS.find((d) => d.name === "drug/enforcement")!;

  const config: Config = {
    dataDir: dir,
    dbPath: join(dir, "test.db"),
    feeds: ["https://www.fda.gov/about-fda/contact-fda/stay-informed/rss-feeds/recalls/rss.xml"],
    openfda: [dataset],
    openfdaApiKey: null,
    openfdaRescanHours: 12,
    sitemap: { indexUrl: "https://www.fda.gov/sitemap.xml", include: ["/safety/"], exclude: ["/media/"] },
    content: {
      enabled: false,
      batchSize: 100,
      concurrency: 1,
      minIntervalMs: 0,
      backoffMs: 0,
      include: [],
      exclude: [],
      pdf: true,
      office: true,
      maxBytes: 1e7,
      maxTextChars: null,
      ocr: false,
      ocrMaxPages: 8,
      ocrConcurrency: 4,
      match: false,
    },
    bulk: { datasets: [], maxPartitionMb: 400, maxPartitions: 4 },
    keywords: [
      {
        name: "listeria",
        any: ["listeria"],
        all: [],
        none: [],
        regex: [],
        caseSensitive: false,
        sources: ["rss", "openfda", "sitemap"],
      },
    ],
    notify: ["jsonl"],
    stages: [],
    maxWork: 1000,
    http: { userAgent: "test", timeoutMs: 1000, retries: 0, minDelayMs: 0, fdaDelayMs: 0, maxBytes: 1e7 },
  };

  return {
    config,
    dir,
    store: new Store(config.dbPath),
    counts: () => ({ ...counts }),
    setLastUpdated: (value: string) => {
      lastUpdated = value;
    },
    setBytesResponse: (response: (request: { url: string; conditional?: { lastModified: string | null } }) => Promise<unknown>) => {
      bytesOverride = response;
    },
    stub: {
      // 与真实服务端一致: 仅当 If-Modified-Since 等于该资源当前 Last-Modified 时返回 304
      fetchText: async ({ url, conditional }) => {
        counts.text += 1;
        if (url.includes("/rss-feeds/")) {
          const lastModified = "Thu, 15 Oct 2026 22:35:30 GMT";
          if (conditional?.lastModified === lastModified) return { status: 304, body: "", headers: new Headers({ "last-modified": lastModified }), notModified: true };
          return { status: 200, body: RSS_BODY, headers: new Headers({ "last-modified": lastModified }), notModified: false };
        }
        const isPage = url.includes("page=");
        const lastModified = isPage ? "Fri, 16 Oct 2026 06:44:36 GMT" : "Fri, 16 Oct 2026 01:30:27 GMT";
        if (conditional?.lastModified === lastModified) return { status: 304, body: "", headers: new Headers({ "last-modified": lastModified }), notModified: true };
        return { status: 200, body: isPage ? SITEMAP_PAGE : SITEMAP_INDEX, headers: new Headers({ "last-modified": lastModified }), notModified: false };
      },
      fetchJson: async ({ url }) => {
        counts.json += 1;
        const params = new URL(url).searchParams;
        // count 聚合: openFDA 无论字段格式一律返回紧凑 YYYYMMDD
        if (params.has("count")) {
          return { meta: { last_updated: lastUpdated, results: { total: 1 } }, results: [{ time: "20261010", count: 1 }] };
        }
        const record = {
          recall_number: "D-0001-2026",
          report_date: "20261010",
          product_description: "Listeria contaminated salad kit",
          reason_for_recall: "possible Listeria monocytogenes contamination",
          recalling_firm: "Test Foods",
          classification: "Class I",
          event_id: "12345",
        };
        return { meta: { last_updated: lastUpdated, results: { total: 1 } }, results: [record] };
      },
      // 正文通道走字节流: 用一段带 <article id="main-content"> 的 HTML 验证
      // 正文抽取、字符数与 304 刷新路径。
      fetchBytesDirect: async (request: { url: string; conditional?: { lastModified: string | null } }) => {
        if (bytesOverride !== null) return bytesOverride(request);
        const { url, conditional } = request;
        const etag = '"v1"';
        if (conditional?.lastModified === PAGE_LAST_MODIFIED) {
          return { status: 304, bytes: new Uint8Array(0), headers: new Headers({ etag }), notModified: true, finalUrl: url };
        }
        const bytes = new TextEncoder().encode(PAGE_HTML);
        return {
          status: 200,
          bytes,
          headers: new Headers({ "content-type": "text/html; charset=utf-8", "last-modified": PAGE_LAST_MODIFIED, etag }),
          notModified: false,
          finalUrl: url,
        };
      },
    },
  };
};

const cleanup: (() => void)[] = [];
after(() => {
  for (const fn of cleanup) fn();
});

test("端到端: 采集 -> 匹配 -> 告警, 且重复运行不重复告警", async () => {
  const h = makeHarness();
  cleanup.push(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  const run1 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T00:00:00.000Z", {
    full: false,
    maxWork: 1000,
    progress: () => {},
  });

  assert.equal(run1.perStage.map((s) => s.stage).join(","), "rss,openfda,sitemap");
  // 条目一律先落库 (不命中的也留存以便检索): rss 2 条 + openfda 1 条 + sitemap 1 条 (media 被 exclude)
  assert.equal(h.store.counts().items, 4, "应落库 4 条: 2 rss + 1 openfda + 1 sitemap");
  // rss 命中 title、openfda 命中 title、sitemap 命中路径
  assert.equal(run1.alerts.length, 3, "三条都应命中 listeria");
  // 告警在每采集完一个通道后就投递, 因此 jsonl 里应能看到全部 3 条
  assert.ok(existsSync(join(h.dir, "alerts.jsonl")), "jsonl 通知应写出告警流");
  const lines = readFileSync(join(h.dir, "alerts.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const parsed = JSON.parse(lines[0]!) as { rule: string; item: Item; notified_at: string };
  assert.equal(parsed.rule, "listeria");
  assert.ok(parsed.notified_at.length > 0, "应记录投递时间");
  assert.equal(h.store.pendingCount(), 0);
  assert.equal(h.store.failedCount(), 0);

  // 第二轮: 条件请求全部 304, openFDA 因 last_updated 未变而跳过
  const run2 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T01:00:00.000Z", {
    full: false,
    maxWork: 1000,
    progress: () => {},
  });
  assert.equal(run2.alerts.length, 0, "第二轮不应产生新告警");
  assert.equal(h.store.counts().items, 4, "条目数不应变化");
  assert.ok(run2.perStage.find((s) => s.stage === "rss")!.notice.includes("0/1"), "rss 应走 304");
  assert.ok(run2.perStage.find((s) => s.stage === "openfda")!.notice.includes("因数据未更新跳过"), "openfda 应短路");
  assert.ok(run2.perStage.find((s) => s.stage === "sitemap")!.notice.includes("索引 304"), "sitemap 索引应 304");

  // 第三轮: 数据更新后重扫, 仍不得重复告警 (去重靠主键)
  h.setLastUpdated("2026-10-14");
  const run3 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T20:00:00.000Z", {
    full: false,
    maxWork: 1000,
    progress: () => {},
  });
  assert.equal(run3.alerts.length, 0, "重扫同一批条目不得重复告警");
  assert.equal(h.store.alerts(100).length, 3, "告警表不应增长");
});

test("回归: RSS 响应头不稳定时靠内容指纹避免重复入队", async () => {
  const h = makeHarness();
  cleanup.push(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  // 第一次: 正常采集
  const run1 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T00:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.ok(run1.perStage.find((s) => s.stage === "rss")!.produced > 0);
  const state1 = h.store.getFeedState("rss:recalls");
  assert.ok(state1?.fingerprint !== null && state1?.fingerprint !== undefined, "应记录内容指纹");

  // 第二次: 内容完全相同, 但 Last-Modified 变了 (模拟 FDA 的不稳定响应头)
  const stub = {
    fetchText: async (request: { url: string; conditional?: { lastModified: string | null } }) => {
      if (request.url.includes("/rss-feeds/")) {
        return {
          status: 200,
          body: RSS_BODY,
          headers: new Headers({ "last-modified": "Sat, 17 Oct 2026 03:00:00 GMT" }),
          notModified: false,
        };
      }
      return h.stub.fetchText(request);
    },
    fetchJson: h.stub.fetchJson,
  };
  const before = h.store.counts().items;
  const run2 = await runCollect(h.config, h.store, stub as never, "2026-10-16T01:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.equal(run2.perStage.find((s) => s.stage === "rss")!.produced, 0, "内容未变则不应入队");
  assert.ok(run2.perStage.find((s) => s.stage === "rss")!.notice.includes("0/1"), run2.perStage.find((s) => s.stage === "rss")!.notice);
  assert.equal(h.store.counts().items, before, "条目数不应变化");
  assert.equal(run2.alerts.length, 0, "不应产生新告警");
});

test("端到端: feed 更新后新增条目被识别并告警一次", async () => {
  const h = makeHarness();
  cleanup.push(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  const run1 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T00:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.equal(run1.alerts.length, 3);
  assert.equal(h.store.counts().items, 4);

  // 第二条原先不含关键词, 现替换为一条新的 listeria 命中; feed 的 Last-Modified 也随之前进,
  // 因此条件请求不再返回 304, 新条目应被采集并恰好告警一次。
  // 注意 link 与 guid 都要换: 去重主键优先用 guid, 只改 link 会被判定为同一条目
  const updatedFeed = RSS_BODY
    .replace("<title>Unrelated notice about labeling</title>", "<title>Second recall due to Listeria</title>")
    .replaceAll("http://www.fda.gov/news-events/unrelated", "http://www.fda.gov/news-events/second-listeria");
  const stub = {
    fetchText: async (request: { url: string; conditional?: { lastModified: string | null } }) => {
      if (request.url.includes("/rss-feeds/")) {
        return { status: 200, body: updatedFeed, headers: new Headers({ "last-modified": "Fri, 16 Oct 2026 10:00:00 GMT" }), notModified: false };
      }
      return h.stub.fetchText(request);
    },
    fetchJson: h.stub.fetchJson,
  };

  const run2 = await runCollect(h.config, h.store, stub as never, "2026-10-16T02:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.equal(h.store.counts().items, 5, "新条目应落库");
  assert.equal(run2.alerts.length, 1, "本轮应恰好 1 条新告警");
  assert.ok(run2.alerts[0]!.item.title.includes("Second recall"));
  assert.equal(h.store.alerts(100).length, 4, "历史告警累计 4 条");
});

test("正文通道: 抓取落库、抽取正文、FTS 可检索, 且重复运行不重抓", async () => {
  const h = makeHarness();
  cleanup.push(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  // 先跑一轮 sitemap 让 URL 落进 instances, 正文通道消费的是它的产物
  await runCollect(h.config, h.store, h.stub as never, "2026-10-16T00:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.equal(h.store.pendingDocumentCount(), 1, "只有 1 条非 /media/ 的 URL 待抓 (media 被 exclude)");

  h.config.content.enabled = true;
  const run2 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T01:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  const notice = run2.perStage.at(-1)!.notice;
  assert.ok(notice.includes("抓取 1 篇"), notice);
  assert.ok(notice.includes("html 1"), notice);

  const doc = h.store.searchDocuments("listeria", 10);
  assert.equal(doc.hits.length, 1, "正文应可被检索到");
  assert.equal(doc.mode, "fts", "FTS5 应可用");
  // 标题取自 <h1>, 正文取自 <article id="main-content">, 且不含导航/脚本/页脚
  assert.equal(doc.hits[0]!.title, "Listeria Outbreak 2026");
  assert.ok(doc.hits[0]!.snippet.includes("Listeria"), "应给出命中片段");
  const stored = h.store.searchDocuments("outbreak", 10).hits[0]!;
  assert.ok(stored.chars > 0);
  assert.equal(h.store.pendingDocumentCount(), 0, "抓完就不应再待抓");

  // 第二轮: 同一个 URL 已被抓过, 不应重复抓取
  const run3 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T02:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.ok(run3.perStage.at(-1)!.notice.includes("抓取 0 篇"), run3.perStage.at(-1)!.notice);
});

test("正文通道: 过滤条件下推到 SQL, 窄 include 也能推进 (回归)", async () => {
  const h = makeHarness();
  cleanup.push(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  // 只抓 /media/, 而 instances 里 /media/ 已被 sitemap 的 exclude 挡掉:
  // 若不把过滤下推到 SQL, 内存过滤会永远看到列表最前的不匹配项而一篇都抓不到。
  h.config.sitemap.exclude = [];
  h.config.sitemap.include = [];
  await runCollect(h.config, h.store, h.stub as never, "2026-10-16T00:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.ok(h.store.pendingDocumentCount() >= 2, "media 与内容页都应入库");

  h.config.content.enabled = true;
  h.config.content.include = ["/media/"];
  h.config.content.batchSize = 5;
  const run = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T01:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  const notice = run.perStage.at(-1)!.notice;
  assert.ok(notice.includes("抓取 1 篇"), `应抓到 media 那条而不是空转: ${notice}`);
  const rows = h.store.searchDocuments("", 10).hits;
  assert.ok(rows.every((row) => row.url.includes("/media/")), "只应抓 include 命中的 URL");
});

test("正文通道: 被限流时该 URL 不落库, 保持待抓而不是记成失败", async () => {
  const h = makeHarness();
  cleanup.push(() => {
    h.store.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  await runCollect(h.config, h.store, h.stub as never, "2026-10-16T00:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.equal(h.store.pendingDocumentCount(), 1);

  // FDA 的限流页: 403 + excessive-requests-apology (见 HttpError 的 body 保留逻辑)
  h.setBytesResponse(async () => {
    throw new HttpError("https://www.fda.gov/safety/x 返回 HTTP 403", 403, "fda.gov", "excessive-requests-apology");
  });
  h.config.content.enabled = true;

  const run = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T01:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  const notice = run.perStage.at(-1)!.notice;
  assert.ok(notice.includes("限流推迟 1"), notice);
  assert.ok(notice.includes("失败 0"), `限流不应计为失败: ${notice}`);
  assert.equal(h.store.pendingDocumentCount(), 1, "被限流的 URL 必须保持待抓");
  assert.equal(h.store.documentStats().total, 0, "被限流的 URL 不应留下错误行");

  // 限流解除后同一 URL 能被正常抓到
  h.setBytesResponse(async () => {
    const bytes = new TextEncoder().encode(PAGE_HTML);
    return {
      status: 200,
      bytes,
      headers: new Headers({ "content-type": "text/html; charset=utf-8", "last-modified": PAGE_LAST_MODIFIED, etag: '"v1"' }),
      notModified: false,
      finalUrl: "https://www.fda.gov/safety/recalls/listeria-outbreak-2026",
    };
  });
  const run2 = await runCollect(h.config, h.store, h.stub as never, "2026-10-16T02:00:00.000Z", { full: false, maxWork: 1000, progress: () => {} });
  assert.ok(run2.perStage.at(-1)!.notice.includes("抓取 1 篇"), run2.perStage.at(-1)!.notice);
  assert.equal(h.store.pendingDocumentCount(), 0);
});

test("reset: 只清假失败 (403/429/超体积), 真的坏文档保留", () => {
  const dir = mkdtempSync(join(tmpdir(), "fda-search-reset-"));
  const store = new Store(join(dir, "t.db"));
  try {
    const save = (url: string, error: string | null): void => {
      store.saveDocument({
        url, kind: "html", title: "", text: "", bytes: 0,
        etag: null, lastModified: null, fetchedAt: "2026-10-16T00:00:00.000Z", error,
      });
    };
    save("https://www.fda.gov/a", "https://www.fda.gov/a 返回 HTTP 403");
    save("https://www.fda.gov/b", "https://www.fda.gov/b 返回 HTTP 429");
    save("https://www.fda.gov/c", "https://www.fda.gov/c 体积 5000 字节超过上限 1000");
    save("https://www.fda.gov/d", "https://www.fda.gov/d 返回 HTTP 404");
    save("https://www.fda.gov/e", null);

    assert.equal(store.resetDocumentFailures(), 3, "只应删掉 403 / 429 / 超体积三条");
    assert.equal(store.documentStats().total, 2, "404 与成功记录应保留");
    assert.ok(store.getDocumentState("https://www.fda.gov/d")?.error?.includes("404"), "坏文档的记录仍在");
    assert.equal(store.getDocumentState("https://www.fda.gov/a"), null, "假失败应已删除");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
