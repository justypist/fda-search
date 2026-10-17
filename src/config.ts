import { readFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { BulkConfig, Config, ContentConfig, HttpConfig, KeywordRule, OpenFdaDataset } from "./types.ts";
import { FEEDS, OPENFDA_DATASETS, KEYWORDS, RSS_BASE, SITEMAP_DEFAULT_INCLUDE, SITEMAP_DEFAULT_EXCLUDE } from "./defaults.ts";

const HTTP_DEFAULTS: HttpConfig = {
  userAgent: "fda-search-monitor/1.0 (+https://www.fda.gov/robots.txt; crawl-delay respected)",
  timeoutMs: 30_000,
  retries: 3,
  minDelayMs: 1_000,
  fdaDelayMs: 30_000,
  maxBytes: 16 * 1024 * 1024,
};

const CONTENT_DEFAULTS: ContentConfig = {
  enabled: false,
  batchSize: 200,
  concurrency: 1,
  minIntervalMs: 500,
  backoffMs: 60_000,
  include: [...SITEMAP_DEFAULT_INCLUDE, "/media/"],
  exclude: [],
  pdf: true,
  office: true,
  maxBytes: 64 * 1024 * 1024,
  ocr: true,
  ocrEngine: "local",
  ocrMaxPages: 8,
  ocrConcurrency: 1,
  match: false,
};

const BULK_DEFAULTS: BulkConfig = {
  datasets: [],
  maxPartitionMb: 400,
  maxPartitions: 4,
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`无法解析配置文件 ${path}: ${(error as Error).message}`);
  }
};

const asArray = (value: unknown): unknown[] | null => (Array.isArray(value) ? value : null);

const pickObject = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});

const HTTP_KEYS = ["userAgent", "timeoutMs", "retries", "minDelayMs", "fdaDelayMs", "maxBytes"] as const;

const mergeHttp = (raw: unknown): HttpConfig => {
  const o = pickObject(raw);
  const merged: HttpConfig = { ...HTTP_DEFAULTS };
  for (const key of HTTP_KEYS) {
    const value = o[key];
    if (typeof value === typeof HTTP_DEFAULTS[key]) {
      Object.assign(merged, { [key]: value });
    }
  }
  return merged;
};

const mergeKeyword = (raw: unknown): KeywordRule | null => {
  const o = pickObject(raw);
  if (typeof o.name !== "string" || o.name.length === 0) return null;
  const strArray = (value: unknown): string[] => asArray(value)?.filter((v): v is string => typeof v === "string") ?? [];
  return {
    name: o.name,
    any: strArray(o.any),
    all: strArray(o.all),
    none: strArray(o.none),
    regex: strArray(o.regex),
    caseSensitive: o.caseSensitive === true,
    sources: strArray(o.sources).length > 0 ? (strArray(o.sources) as KeywordRule["sources"]) : ["rss", "openfda", "sitemap"],
  };
};

const mergeDataset = (raw: unknown, fallback: OpenFdaDataset | undefined): OpenFdaDataset | null => {
  const o = pickObject(raw);
  if (fallback === undefined && (typeof o.name !== "string" || typeof o.dateField !== "string")) return null;
  const base = fallback ?? {
    name: String(o.name),
    dateField: String(o.dateField),
    idField: "id",
    titleField: "id",
    summaryFields: [],
    dateFormat: "compact" as const,
    sortDesc: true,
    lookbackDays: 90,
    maxRequests: 20,
    itemUrl: "https://open.fda.gov/",
  };
  const dateFormat = o.dateFormat === "dashed" || o.dateFormat === "compact" ? o.dateFormat : base.dateFormat;
  return {
    name: typeof o.name === "string" ? o.name : base.name,
    dateField: typeof o.dateField === "string" ? o.dateField : base.dateField,
    idField: typeof o.idField === "string" ? o.idField : base.idField,
    titleField: typeof o.titleField === "string" ? o.titleField : base.titleField,
    summaryFields: asArray(o.summaryFields)?.filter((v): v is string => typeof v === "string") ?? base.summaryFields,
    dateFormat,
    sortDesc: typeof o.sortDesc === "boolean" ? o.sortDesc : base.sortDesc,
    lookbackDays: typeof o.lookbackDays === "number" ? o.lookbackDays : base.lookbackDays,
    maxRequests: typeof o.maxRequests === "number" ? o.maxRequests : base.maxRequests,
    itemUrl: typeof o.itemUrl === "string" ? o.itemUrl : base.itemUrl,
  };
};

export const loadConfig = (cwd: string, configPath: string): Config => {
  const path = resolve(cwd, configPath);
  const raw = readJson(path) ?? {};

  const dataDir = resolve(cwd, typeof raw.dataDir === "string" ? raw.dataDir : "./data");
  mkdirSync(dataDir, { recursive: true });

  const feeds = asArray(raw.feeds)?.filter((v): v is string => typeof v === "string") ?? [...FEEDS];
  const feedBase = typeof raw.feedBase === "string" ? raw.feedBase : RSS_BASE;

  const openfdaObj = pickObject(raw.openfda);
  const rawDatasets = asArray(openfdaObj.datasets);
  const openfda: OpenFdaDataset[] = rawDatasets === null
    ? [...OPENFDA_DATASETS]
    : rawDatasets
        .map((entry) => {
          const name = pickObject(entry).name;
          const fallback = OPENFDA_DATASETS.find((dataset) => dataset.name === name);
          return mergeDataset(entry, fallback);
        })
        .filter((d): d is OpenFdaDataset => d !== null);

  const sitemapObj = pickObject(raw.sitemap);
  const sitemap = {
    indexUrl: typeof sitemapObj.indexUrl === "string" ? sitemapObj.indexUrl : "https://www.fda.gov/sitemap.xml",
    include: asArray(sitemapObj.include)?.filter((v): v is string => typeof v === "string") ?? [...SITEMAP_DEFAULT_INCLUDE],
    exclude: asArray(sitemapObj.exclude)?.filter((v): v is string => typeof v === "string") ?? [...SITEMAP_DEFAULT_EXCLUDE],
  };

  const rawKeywords = asArray(raw.keywords);
  const keywords: KeywordRule[] = rawKeywords === null
    ? (KEYWORDS as KeywordRule[])
    : rawKeywords.map(mergeKeyword).filter((k): k is KeywordRule => k !== null);

  if (keywords.length === 0) {
    throw new Error(`配置 ${path} 未定义任何有效关键词`);
  }

  const contentObj = pickObject(raw.content);
  const content: ContentConfig = {
    enabled: typeof contentObj.enabled === "boolean" ? contentObj.enabled : CONTENT_DEFAULTS.enabled,
    batchSize: typeof contentObj.batchSize === "number" ? contentObj.batchSize : CONTENT_DEFAULTS.batchSize,
    concurrency: typeof contentObj.concurrency === "number" && contentObj.concurrency >= 1
      ? Math.floor(contentObj.concurrency)
      : CONTENT_DEFAULTS.concurrency,
    minIntervalMs: typeof contentObj.minIntervalMs === "number" && contentObj.minIntervalMs >= 0
      ? Math.floor(contentObj.minIntervalMs)
      : CONTENT_DEFAULTS.minIntervalMs,
    backoffMs: typeof contentObj.backoffMs === "number" && contentObj.backoffMs >= 0
      ? Math.floor(contentObj.backoffMs)
      : CONTENT_DEFAULTS.backoffMs,
    include: asArray(contentObj.include)?.filter((v): v is string => typeof v === "string") ?? [...CONTENT_DEFAULTS.include],
    exclude: asArray(contentObj.exclude)?.filter((v): v is string => typeof v === "string") ?? [...CONTENT_DEFAULTS.exclude],
    pdf: typeof contentObj.pdf === "boolean" ? contentObj.pdf : CONTENT_DEFAULTS.pdf,
    office: typeof contentObj.office === "boolean" ? contentObj.office : CONTENT_DEFAULTS.office,
    maxBytes: typeof contentObj.maxBytes === "number" ? contentObj.maxBytes : CONTENT_DEFAULTS.maxBytes,
    ocr: typeof contentObj.ocr === "boolean" ? contentObj.ocr : CONTENT_DEFAULTS.ocr,
    ocrEngine: contentObj.ocrEngine === "vision" || contentObj.ocrEngine === "off" || contentObj.ocrEngine === "local"
      ? contentObj.ocrEngine
      : CONTENT_DEFAULTS.ocrEngine,
    ocrMaxPages: typeof contentObj.ocrMaxPages === "number" && contentObj.ocrMaxPages >= 1
      ? Math.floor(contentObj.ocrMaxPages)
      : CONTENT_DEFAULTS.ocrMaxPages,
    ocrConcurrency: typeof contentObj.ocrConcurrency === "number" && contentObj.ocrConcurrency >= 1
      ? Math.floor(contentObj.ocrConcurrency)
      : CONTENT_DEFAULTS.ocrConcurrency,
    match: typeof contentObj.match === "boolean" ? contentObj.match : CONTENT_DEFAULTS.match,
  };

  const bulkObj = pickObject(raw.bulk);
  const bulk: BulkConfig = {
    datasets: asArray(bulkObj.datasets)?.filter((v): v is string => typeof v === "string") ?? [...BULK_DEFAULTS.datasets],
    maxPartitionMb: typeof bulkObj.maxPartitionMb === "number" ? bulkObj.maxPartitionMb : BULK_DEFAULTS.maxPartitionMb,
    maxPartitions: typeof bulkObj.maxPartitions === "number" ? bulkObj.maxPartitions : BULK_DEFAULTS.maxPartitions,
  };

  return {
    dataDir,
    dbPath: resolve(dataDir, "fda-monitor.db"),
    feeds: feeds.map((f) => (f.startsWith("http") ? f : `${feedBase}/${f}/rss.xml`)),
    openfda,
    openfdaApiKey: typeof openfdaObj.apiKey === "string" && openfdaObj.apiKey.length > 0
      ? openfdaObj.apiKey
      : process.env.OPENFDA_API_KEY ?? null,
    openfdaRescanHours: typeof openfdaObj.rescanHours === "number" ? openfdaObj.rescanHours : 12,
    sitemap,
    content,
    bulk,
    keywords,
    notify: asArray(raw.notify)?.filter((v): v is string => typeof v === "string") ?? ["jsonl"],
    stages: (asArray(raw.stages)?.filter((v): v is string => typeof v === "string") ?? []).filter(isStageName),
    maxWork: typeof raw.maxWork === "number" ? raw.maxWork : 2_000,
    http: mergeHttp(raw.http),
  };
};

const isStageName = (value: string): value is Config["stages"][number] =>
  value === "rss" || value === "openfda" || value === "sitemap" || value === "content";
