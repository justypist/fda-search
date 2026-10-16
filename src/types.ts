export type SourceKind = "rss" | "openfda" | "sitemap";

export interface Item {
  id: string;
  source: SourceKind;
  channel: string;
  title: string;
  summary: string;
  url: string;
  date: string | null;
  extra: Record<string, string>;
}

export interface KeywordRule {
  name: string;
  any: string[];
  all: string[];
  none: string[];
  regex: string[];
  caseSensitive: boolean;
  sources: SourceKind[];
}

export interface HttpConfig {
  userAgent: string;
  timeoutMs: number;
  retries: number;
  minDelayMs: number;
  fdaDelayMs: number;
  maxBytes: number;
}

export interface OpenFdaDataset {
  name: string;
  dateField: string;
  idField: string;
  titleField: string;
  summaryFields: string[];
  dateFormat: "compact" | "dashed";
  sortDesc: boolean;
  lookbackDays: number;
  maxRequests: number;
  itemUrl: string;
}

export interface DatasetState {
  channel: string;
  lastUpdated: string | null;
  scannedAt: string | null;
}

export interface SitemapConfig {
  indexUrl: string;
  include: string[];
  exclude: string[];
}

export interface ContentConfig {
  enabled: boolean;
  // 每轮最多抓多少个正文。默认远小于一轮 sitemap 的变更量, 因为这是
  // 长期后台追赶任务: 34,595 个内容页 + 52,104 个附件在 30 秒 crawl-delay
  // 下需要数十天, 只能慢慢补, 不能阻塞主流程。
  batchSize: number;
  include: string[];
  exclude: string[];
  pdf: boolean;
  office: boolean;
  maxBytes: number;
  // 正文入队后是否参与关键词匹配。默认关闭, 避免补历史时一次性爆出大量告警。
  match: boolean;
}

export interface BulkConfig {
  // 只取这些数据集 (openFDA 名称, 形如 drug/enforcement); 空表示全部已配置数据集
  datasets: string[];
  // 单个分区大小上限 (MB)。device/udi 单分区可达 300 MB, 默认不拦但可调低
  maxPartitionMb: number;
  // 单轮最多下多少个分区。全量 130 GB 不可能一轮下完, 用这个分批
  maxPartitions: number;
}

export interface Config {
  dataDir: string;
  dbPath: string;
  feeds: string[];
  openfda: OpenFdaDataset[];
  openfdaApiKey: string | null;
  openfdaRescanHours: number;
  sitemap: SitemapConfig;
  content: ContentConfig;
  bulk: BulkConfig;
  keywords: KeywordRule[];
  notify: string[];
  stages: SourceKind[];
  maxWork: number;
  http: HttpConfig;
}

export interface QueueMessage {
  source: SourceKind;
  channel: string;
  cursor: string;
  payload: unknown;
  runId: number;
}

export type QueueState = "pending" | "inflight" | "done" | "failed";

export interface QueueRow {
  id: number;
  source: SourceKind;
  channel: string;
  cursor: string;
  payload: string;
  state: QueueState;
  attempts: number;
  runId: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Cursor {
  channel: string;
  cursor: string;
  updatedAt: string;
}

export interface FeedState {
  channel: string;
  lastModified: string | null;
  fingerprint: string | null;
  fetchedAt: string;
}

