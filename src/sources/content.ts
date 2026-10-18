import type { ContentConfig, Item } from "../types.ts";
import type { Store } from "../db.ts";
import { HttpError, type HttpClient } from "../util/http.ts";
import { extractDocument } from "../content/parse.ts";
import { createVisionFromEnv, type VisionClient } from "../content/vision.ts";
import { truncate } from "../util/text.ts";

// 正文通道不是"采集 -> 入队 -> 匹配"三段式的一环: 它消费的是 sitemap 通道已经
// 落库的 URL, 抓完正文直接写进 documents 表。因此它不进队列, 也不产生新条目。
//
// 全量 8.6 万个 URL 需要长期后台运行。并发与请求间隔共同决定对 FDA 的压力:
// concurrency 控制同时在飞的请求数, minIntervalMs 控制请求起点的平均速率。

export const CONTENT_CHANNEL = "content:fda.gov";
export const CONTENT_TIMEOUT_MS = 120_000;
// 写入 documents.error 的标记。db.resetOcrSkipped 按它清理。
export const OCR_PENDING_MARKER = "OCR 未配置";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

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
  deferred: number;
  ocr: number;
  ocrPending: number;
  ocrFailed: number;
  chars: number;
  remaining: number;
  kinds: Record<string, number>;
  aborted: boolean;
}

export interface GateOptions {
  minIntervalMs: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxStrikes: number;
}

export const GATE_DEFAULTS: GateOptions = {
  minIntervalMs: 1_000,
  baseBackoffMs: 60_000,
  maxBackoffMs: 30 * 60_000,
  maxStrikes: 4,
};

// 全局请求闸门。两个职责:
//
// 1. 限速: 所有工人共享一个"下一个可发请求的时刻", 请求起点间隔不小于
//    minIntervalMs。并发数只决定同时在飞多少, 平均速率由这个间隔决定。
// 2. 限流退避: FDA 在请求过量时返回 403 + excessive-requests-apology。
//    一个工人撞上后, 全体工人一起暂停, 退避时间逐次翻倍; 连续多轮仍被挡
//    就中止本轮 —— 继续发只会延长封禁, 未抓的 URL 保持待抓状态, 下轮再来。
export class RequestGate {
  #nextSlot = 0;
  #until = 0;
  #strikes = 0;
  #successes = 0;
  #aborted = false;
  readonly #options: GateOptions;

  constructor(options: Partial<GateOptions> = {}) {
    this.#options = { ...GATE_DEFAULTS, ...options };
  }

  get aborted(): boolean {
    return this.#aborted;
  }

  get strikes(): number {
    return this.#strikes;
  }

  // 等到本请求的发送时刻。返回 false 表示本轮已中止, 调用方不应再发请求。
  async acquire(): Promise<boolean> {
    if (this.#aborted) return false;
    const now = Date.now();
    const slot = Math.max(now, this.#nextSlot, this.#until);
    this.#nextSlot = slot + this.#options.minIntervalMs;
    if (slot > now) await sleep(slot - now);
    return !this.#aborted;
  }

  noteSuccess(): void {
    this.#successes += 1;
    if (this.#successes < 200) return;
    this.#successes = 0;
    this.#strikes = 0;
  }

  // 返回 false 表示达到上限, 本轮应中止。
  async penalize(retryAfterMs: number | null): Promise<boolean> {
    if (this.#aborted) return false;
    this.#successes = 0;
    // 已经在退避窗口内: 并发工人同时撞上 403 时不能各记一层,
    // 否则一次突发就会把层数推满而误中止。等同一个窗口结束即可。
    if (Date.now() < this.#until) {
      await sleep(this.#until - Date.now());
      return !this.#aborted;
    }
    this.#strikes += 1;
    const backoff = Math.min(
      retryAfterMs ?? this.#options.baseBackoffMs * 2 ** (this.#strikes - 1),
      this.#options.maxBackoffMs,
    );
    this.#until = Date.now() + backoff;
    if (this.#strikes >= this.#options.maxStrikes) this.#aborted = true;
    await sleep(Math.max(0, this.#until - Date.now()));
    return !this.#aborted;
  }
}

const isRateLimited = (error: unknown): boolean =>
  error instanceof HttpError &&
  (error.status === 429 ||
    (error.status === 403 && /apology|excessive|too many requests/i.test(error.body)) ||
    error.status === 503);

const retryAfterOf = (error: unknown): number | null =>
  error instanceof HttpError && error.retryAfterMs > 0 ? error.retryAfterMs : null;

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

interface FetchContext {
  config: ContentConfig;
  store: Store;
  client: HttpClient;
  gate: RequestGate;
  vision: VisionClient | null;
  now: string;
  stat: ContentStat;
  progress: (message: string) => void;
}

// 单个 URL 的抓取与落库。被限流时既不落库也不计失败: 该 URL 保持待抓,
// 下一轮会重新排队。其余失败 (体积超限、坏文档) 照旧落一行, 避免每轮重试。
//
// 时间戳用每篇自己的完成时刻, 而不是本轮开始时间: 扫描件 OCR 可能一篇就要几分钟,
// 若整批共用 startedAt, 从库里完全看不出处理速度。
const fetchOne = async (url: string, ctx: FetchContext): Promise<void> => {
  const { config, store, client, gate, vision, stat, progress } = ctx;
  const previous = store.getDocumentState(url);

  for (let attempt = 1; ; attempt += 1) {
    if (!(await gate.acquire())) {
      stat.deferred += 1;
      return;
    }
    try {
      const response = await client.fetchBytesDirect({
        url,
        scope: "fda.gov",
        maxBytes: config.maxBytes,
        timeoutMs: CONTENT_TIMEOUT_MS,
        conditional: { lastModified: previous?.lastModified ?? null },
      });
      if (response.notModified) {
        stat.skipped += 1;
        // 304 也要刷新 fetchedAt, 否则它永远排在待抓队列最前面。
        store.touchDocument(url, previous?.etag ?? null, response.headers.get("etag"), new Date().toISOString());
        gate.noteSuccess();
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      // 重定向后的 URL 才是内容的真实地址。sitemap 里存量旧 URL 会 301 到新地址,
      // 若不记录, 同一份内容会被反复当成两条抓。
      if (response.finalUrl !== url && response.finalUrl.length > 0) {
        store.aliasDocument(url, response.finalUrl, new Date().toISOString());
      }
      const engine = !config.ocr ? "off" : config.ocrEngine;
      const extracted = await extractDocument(response.bytes, contentType, url, {
        engine,
        vision: engine === "vision" ? vision : null,
        ocrMaxPages: config.ocrMaxPages,
        maxTextChars: config.maxTextChars,
      });
      // 扫描件但 OCR 不可用 (引擎关闭 / 视觉模型未配置): 落成功行会把它标成
      // "已抓完且正文为空", 之后配好 OCR 也不会再重试。改记一条专门的错误行 ——
      // 它仍会被判为已抓(避免每轮重抓), 但配置就绪后由 resetOcrSkipped 自动清掉并重新排队。
      //
      // 只有"完全没有正文"时才这样做: Mixed 型 PDF 通常已有部分页面可提取,
      // 丢掉那部分文本不划算, 照常落库 (剩余页留给之后的整篇重跑)。
      if (extracted.pdf?.ocrMissing === true && extracted.text.length === 0) {
        stat.ocrPending += 1;
        store.saveDocument({
          url,
          kind: "pdf",
          title: store.documentTitle(url),
          text: "",
          bytes: response.bytes.byteLength,
          etag: response.headers.get("etag"),
          lastModified: response.headers.get("last-modified"),
          fetchedAt: new Date().toISOString(),
          error: `${OCR_PENDING_MARKER} (${extracted.pdf.pdfType})`,
        });
        progress(`  · ${url} 是扫描件但 OCR 不可用, 已标记待 OCR 重跑`);
        gate.noteSuccess();
        return;
      }
      const title = extracted.title.length > 0 ? extracted.title : store.documentTitle(url);
      store.saveDocument({
        url,
        kind: extracted.kind,
        title: truncate(title, 300),
        text: extracted.text,
        bytes: response.bytes.byteLength,
        etag: response.headers.get("etag"),
        lastModified: response.headers.get("last-modified"),
        fetchedAt: new Date().toISOString(),
        error: null,
      });
      stat.fetched += 1;
      stat.chars += extracted.text.length;
      stat.kinds[extracted.kind] = (stat.kinds[extracted.kind] ?? 0) + 1;
      if (extracted.pdf !== null && extracted.pdf.ocrApplied > 0 && engine !== "local") {
        // 本地 OCR 每篇都会命中 (它直接返回带正文的分页结果), 逐篇打日志只会淹没输出。
        stat.ocr += extracted.pdf.ocrApplied;
        progress(`  + ${url} OCR ${extracted.pdf.ocrApplied}/${extracted.pdf.ocrPages.length} 页 (${extracted.pdf.pdfType})`);
      } else if (extracted.pdf !== null && extracted.pdf.ocrApplied > 0) {
        stat.ocr += extracted.pdf.ocrApplied;
      }
      if (extracted.pdf !== null && extracted.pdf.ocrFailed > 0) {
        stat.ocrFailed += extracted.pdf.ocrFailed;
        // 本地引擎不给每页错误文本, 此时 ocrErrors 为空, 别打出悬空的分号。
        const detail = extracted.pdf.ocrErrors.length > 0 ? `: ${extracted.pdf.ocrErrors.join("; ")}` : " (该页无文本)";
        progress(`  ! ${url} ${extracted.pdf.ocrFailed} 页 OCR 未产出文本${detail}`);
      }
      if (extracted.text.length === 0) progress(`  ! ${url} 提取到 0 字符 (${extracted.kind})`);
      // maxTextChars 默认为 null (不限制)。设了上限且正好触顶时提示, 否则内容的
      // 截断会悄悄发生, 而检索不到后半部分这件事很难被发现。
      else if (config.maxTextChars !== null && extracted.text.length >= config.maxTextChars) {
        progress(`  ! ${url} 正文达到上限 ${config.maxTextChars} 字符, 后续内容已丢弃 (${extracted.kind})`);
      }
      gate.noteSuccess();
      return;
    } catch (error) {
      if (isRateLimited(error)) {
        const keepGoing = await gate.penalize(retryAfterOf(error));
        progress(`  ! 限流暂停后重试 ${url} (第 ${attempt} 次)`);
        if (keepGoing && attempt < 3) continue;
        stat.deferred += 1;
        return;
      }
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
        fetchedAt: new Date().toISOString(),
        error: (error as Error).message.slice(0, 300),
      });
      progress(`  ! ${url} 失败: ${(error as Error).message.slice(0, 120)}`);
      return;
    }
  }
};

export const collectContent = async (
  config: ContentConfig,
  store: Store,
  client: HttpClient,
  now: string,
  progress: (message: string) => void,
  limits: { batchSize: number; gate?: RequestGate; vision?: VisionClient | null },
): Promise<ContentStat> => {
  // 只有视觉引擎需要模型客户端; 本地 PP-OCR 不读 .env。
  const vision = limits.vision !== undefined
    ? limits.vision
    : config.ocrEngine === "vision"
      ? createVisionFromEnv(process.env, config.ocrConcurrency)
      : null;
  const engine = !config.ocr ? "off" : config.ocrEngine;
  if (engine === "vision" && vision !== null) {
    // 只在 OCR 真的可用时才重排: 否则会"删除 -> 重抓 -> 又标回待 OCR"无限循环。
    const requeued = store.resetOcrSkipped();
    if (requeued > 0) progress(`  ~ OCR 已就绪, 重新排队 ${requeued} 个此前跳过的扫描件`);
  } else if (engine === "local") {
    // 本地引擎同样能让此前跳过 (或视觉模型超时) 的扫描件重新排队。
    const requeued = store.resetOcrSkipped();
    if (requeued > 0) progress(`  ~ 本地 OCR 已就绪, 重新排队 ${requeued} 个此前跳过的扫描件`);
  }

  const urls = pendingContentUrls(store, config, limits.batchSize);
  const stat: ContentStat = {
    fetched: 0, skipped: 0, failed: 0, deferred: 0, ocr: 0, ocrPending: 0, ocrFailed: 0, chars: 0, remaining: 0, kinds: {}, aborted: false,
  };
  if (urls.length === 0) {
    stat.remaining = store.pendingDocumentCount();
    return stat;
  }

  const concurrency = Math.max(1, Math.floor(config.concurrency ?? 1));
  const gate = limits.gate ?? new RequestGate({
    minIntervalMs: config.minIntervalMs,
    baseBackoffMs: config.backoffMs,
  });
  let cursor = 0;
  let done = 0;
  let lastProgressAt = Date.now();

  // 每 25 篇或每 60 秒报一次进度。扫描件走 OCR 时一篇要几分钟, 只按条数
  // 报告会让长时间没有输出, 看起来像卡死。
  const report = (): void => {
    progress(
      `  … 正文已抓 ${done}/${urls.length} (成功 ${stat.fetched} / 跳过 ${stat.skipped} / 失败 ${stat.failed} / 限流推迟 ${stat.deferred} / OCR ${stat.ocr} 页 / 待 OCR ${stat.ocrPending})`,
    );
    lastProgressAt = Date.now();
  };

  // 固定 N 个工人从同一个队列游标取任务, 请求速率由 gate 统一控制。
  const worker = async (): Promise<void> => {
    for (;;) {
      if (gate.aborted) return;
      const index = cursor;
      cursor += 1;
      const url = urls[index];
      if (url === undefined) return;
      await fetchOne(url, { config, store, client, gate, vision, now, stat, progress });
      done += 1;
      if (done % 25 === 0 || Date.now() - lastProgressAt > 60_000) report();
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker));
  stat.aborted = gate.aborted;
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
