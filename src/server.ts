import { createServer, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Store } from "./db.ts";

export type SearchMode = "web" | "content";

export interface SearchHit {
  title: string;
  url: string;
  source: string;
  channel: string;
  date: string | null;
  kind: string;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  mode: SearchMode;
  count: number;
  limit: number;
  elapsedMs: number;
  note: string;
  hits: SearchHit[];
}

export interface StatsResponse {
  instances: number;
  documents: number;
  documentsWithText: number;
  ftsEnabled: boolean;
  bySource: { source: string; count: number }[];
  byKind: { kind: string; count: number }[];
}

export interface ServeOptions {
  port: number;
  host: string;
  limit: number;
}

const PAGE_PATH = fileURLToPath(new URL("./web/index.html", import.meta.url));

const asMode = (value: string | null): SearchMode => (value === "content" ? "content" : "web");

const asLimit = (value: string | null, fallback: number): number => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), 200);
};

// 两种索引统一成同一个 hit 结构, 前端不必区分来源。
const fromInstances = (store: Store, query: string, limit: number): SearchHit[] =>
  store.searchItems(query, limit).map((item) => ({
    title: item.title.length > 0 ? item.title : item.url,
    url: item.url,
    source: item.source,
    channel: item.channel,
    date: item.date,
    kind: "page",
    snippet: item.summary,
  }));

const fromDocuments = (store: Store, query: string, limit: number): SearchHit[] =>
  store.searchDocuments(query, limit).hits.map((hit) => ({
    title: hit.title.length > 0 ? hit.title : hit.url,
    url: hit.url,
    source: "content",
    channel: "content:fda.gov",
    date: null,
    kind: hit.kind,
    snippet: hit.snippet,
  }));

export const buildSearch = (store: Store, query: string, mode: SearchMode, limit: number): SearchResponse => {
  const started = performance.now();
  const hits = query.trim().length === 0 ? [] : mode === "content" ? fromDocuments(store, query, limit) : fromInstances(store, query, limit);
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  const note =
    mode === "content"
      ? store.ftsEnabled
        ? "全文索引 (FTS5)"
        : "全文索引不可用, 已降级为 LIKE 扫描"
      : "标题 / 摘要 / URL";
  return { query, mode, count: hits.length, limit, elapsedMs, note, hits };
};

export const buildStats = (store: Store): StatsResponse => {
  const counts = store.counts();
  const docs = store.documentStats();
  return {
    instances: counts.items,
    documents: docs.total,
    documentsWithText: docs.ok,
    ftsEnabled: store.ftsEnabled,
    bySource: store.countBySource(),
    byKind: docs.byKind.map((entry) => ({ kind: entry.kind, count: entry.n })),
  };
};

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
};

const sendText = (res: ServerResponse, status: number, body: string, type: string): void => {
  res.writeHead(status, { "content-type": type, "content-length": Buffer.byteLength(body), "cache-control": "no-store" });
  res.end(body);
};

/**
 * 本地搜索界面。
 *
 * 存在的理由: FDA 的站内搜索已不可用 (fda.gov/search 被 WAF 拦成挑战页,
 * Search.gov 的 affiliate=fda 结果页显示 "turned off"), 因此需要一个能查本地
 * 索引的界面, 用来看"我们索引到了什么"。
 *
 * 只监听回环地址: 数据在本地 SQLite 里, 没有对外的必要, 也不该暴露。
 */
export const serve = (store: Store, options: ServeOptions): Promise<Server> =>
  new Promise((resolve, reject) => {
    const page = readFileSync(PAGE_PATH, "utf8");
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${options.host}:${options.port}`);
        if (url.pathname === "/api/stats") {
          sendJson(res, 200, buildStats(store));
          return;
        }
        if (url.pathname === "/api/search") {
          const query = url.searchParams.get("q") ?? "";
          sendJson(res, 200, buildSearch(store, query, asMode(url.searchParams.get("mode")), asLimit(url.searchParams.get("limit"), options.limit)));
          return;
        }
        if (url.pathname === "/" || url.pathname === "/index.html") {
          sendText(res, 200, page, "text/html; charset=utf-8");
          return;
        }
        // 内联一个空 favicon, 免得浏览器每次请求都产生一条 404 噪音
        if (url.pathname === "/favicon.ico") {
          res.writeHead(204, { "cache-control": "max-age=86400" });
          res.end();
          return;
        }
        sendJson(res, 404, { error: "not found" });
      } catch (error) {
        sendJson(res, 500, { error: (error as Error).message });
      }
    });
    server.on("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
