import type { ContentConfig, Item } from "../types.ts";
import type { Store } from "../db.ts";
import type { HttpClient } from "../util/http.ts";
import { extractDocument } from "../content/parse.ts";
import { truncate } from "../util/text.ts";

// 正文通道不是"采集 -> 入队 -> 匹配"三段式的一环: 它消费的是 sitemap 通道已经
// 落库的 URL, 抓完正文直接写进 documents 表。因此它不进队列, 也不产生新条目。
//
// 之所以要分批: 全量 86,699 个 URL 在 robots.txt 的 Crawl-delay: 30 下要跑一个多月,
// 只能是长期后台任务。每轮按 batchSize 抓一小批, 下一轮接着上次的位置。

export const CONTENT_CHANNEL = "content:fda.gov";

const isMedia = (url: string): boolean => url.includes("/media/");

const skippedByConfig = (url: string, config: ContentConfig): boolean => {
  if (isMedia(url)) {
    const lower = url.toLowerCase();
    const looksPdf = lower.endsWith(".pdf");
    const looksOffice = /\.(xlsx?|docx?|pptx?)$/.test(lower);
    if (looksPdf && !config.pdf) return true;
    if (looksOffice && !config.office) return true;
  }
  return false;
};

export interface ContentStat {
  fetched: number;
  skipped: number;
  failed: number;
  chars: number;
  remaining: number;
  kinds: Record<string, number>;
}

// 从 instances 里取"还没抓过正文"的 sitemap URL。过滤条件整体下推到 SQL,
// 见 Store.pendingDocumentUrls 的注释。
export const pendingContentUrls = (store: Store, config: ContentConfig, limit: number): string[] => {
  const candidates = store.pendingDocumentUrls({ include: config.include, exclude: config.exclude }, limit * 2);
  const picked: string[] = [];
  for (const url of candidates) {
    if (picked.length >= limit) break;
    if (skippedByConfig(url, config)) continue;
    picked.push(url);
  }
  return picked;
};

export const collectContent = async (
  config: ContentConfig,
  store: Store,
  client: HttpClient,
  now: string,
  progress: (message: string) => void,
  limits: { batchSize: number; httpMaxBytes: number },
): Promise<ContentStat> => {
  const urls = pendingContentUrls(store, config, limits.batchSize);
  const stat: ContentStat = { fetched: 0, skipped: 0, failed: 0, chars: 0, remaining: 0, kinds: {} };
  if (urls.length === 0) {
    stat.remaining = 0;
    return stat;
  }

  for (const [index, url] of urls.entries()) {
    if (index > 0 && index % 25 === 0) {
      progress(`  … 正文已抓 ${index}/${urls.length} (本批累计 ${stat.fetched + stat.failed})`);
    }
    const previous = store.getDocumentState(url);
    try {
      const response = await client.fetchBytes({
        url,
        scope: "fda.gov",
        maxBytes: Math.min(config.maxBytes, limits.httpMaxBytes),
        conditional: { lastModified: previous?.lastModified ?? null },
      });
      if (response.notModified) {
        stat.skipped += 1;
        // 304 也要刷新 fetchedAt, 否则它永远排在待抓队列最前面。
        store.touchDocument(url, previous?.etag ?? null, response.headers.get("etag"), now);
        continue;
      }
      const contentType = response.headers.get("content-type") ?? "";
      // 重定向后的 URL 才是内容的真实地址。sitemap 里存量旧 URL 会 301 到新地址,
      // 若不记录, 同一份内容会被反复当成两条抓。
      if (response.finalUrl !== url && response.finalUrl.length > 0) {
        store.aliasDocument(url, response.finalUrl, now);
      }
      const extracted = await extractDocument(response.bytes, contentType, url);
      const title = extracted.title.length > 0 ? extracted.title : store.documentTitle(url);
      store.saveDocument({
        url,
        kind: extracted.kind,
        title: truncate(title, 300),
        text: extracted.text,
        bytes: response.bytes.byteLength,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        fetchedAt: now,
        error: null,
      });
      stat.fetched += 1;
      stat.chars += extracted.text.length;
      stat.kinds[extracted.kind] = (stat.kinds[extracted.kind] ?? 0) + 1;
      if (extracted.text.length === 0) progress(`  ! ${url} 提取到 0 字符 (${extracted.kind})`);
    } catch (error) {
      stat.failed += 1;
      // 失败也要落一行: 否则每一轮都会重试同一批坏 URL, 永远推进不下去。
      store.saveDocument({
        url,
        kind: isMedia(url) ? "media" : "html",
        title: store.documentTitle(url),
        text: "",
        bytes: 0,
        etag: null,
        lastModified: null,
        fetchedAt: now,
        error: (error as Error).message.slice(0, 300),
      });
      progress(`  ! ${url} 失败: ${(error as Error).message.slice(0, 120)}`);
    }
  }

  stat.remaining = store.pendingDocumentCount();
  return stat;
};

export const contentItem = (url: string, title: string, text: string, kind: string, date: string | null): Item => ({
  id: `content:${url}`,
  source: "sitemap",
  channel: CONTENT_CHANNEL,
  title,
  summary: truncate(text, 500),
  url,
  date,
  extra: { kind },
});
