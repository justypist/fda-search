export type SourceKind = "rss" | "openfda" | "sitemap";

// 流水线阶段。content 不是采集通道 (它消费 sitemap 已落库的 URL),
// 但同样需要能单独跑, 因此与三个采集通道并列。
export type StageName = SourceKind | "content";

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
  // 并发工人数。只决定"同时在飞"的请求数, 不决定速率 —— 速率由
  // minIntervalMs 控制。1 = 严格串行。
  // 注意: 实测并发 20 (约 13 请求/秒) 在 100-150 个请求后就触发 FDA 的
  // 403 excessive-requests-apology, 因此高并发不可用; 当前默认取保守值。
  concurrency: number;
  // 全局请求起点的最小间隔 (毫秒)。并发数决定"同时在飞"的请求数,
  // 这个值决定平均速率; 两者共同决定对 FDA 的压力。
  minIntervalMs: number;
  // 被限流 (403/429) 后的首次退避时长 (毫秒), 之后逐次翻倍, 上限 30 分钟。
  // 连续 4 次仍被限流就中止本轮, 未抓的 URL 保持待抓。
  backoffMs: number;
  include: string[];
  exclude: string[];
  pdf: boolean;
  office: boolean;
  maxBytes: number;
  // 单篇正文最多保留多少字符, null 表示不限制 (默认)。FDA 的表格附件可提取出
  // 上亿字符; 默认全部保留, 需要控制库体积或内存时再设上限。
  maxTextChars: number | null;
  // 扫描页的 OCR 引擎:
  //   local  — pdf-inspector 内置 PP-OCRv6 (ONNX, 纯本地 CPU), 实测 2 页约 2.8 秒;
  //   vision — 视觉模型 (.env 的 LLM_*), 单页 20-90 秒且按 token 计费;
  //   off    — 不做 OCR。
  ocr: boolean;
  ocrEngine: "local" | "vision" | "off";
  // 单个 PDF 最多 OCR 多少页。扫描件动辄几十页, 全量 OCR 成本高;
  // 只取前 N 页已足够让文档可被检索。
  ocrMaxPages: number;
  // 同时在跑的视觉请求数上限。单页转写约 20-30 秒, 这个值决定 OCR 的吞吐,
  // 与抓取并发 (content.concurrency) 无关。
  ocrConcurrency: number;
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
  stages: StageName[];
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

