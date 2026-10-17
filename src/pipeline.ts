import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config, Item, SourceKind, StageName } from "./types.ts";
import type { Store } from "./db.ts";
import type { HttpClient } from "./util/http.ts";
import { matchAll, type Match } from "./util/keyword.ts";
import { sha1, truncate } from "./util/text.ts";
import { dispatch } from "./notify/index.ts";
import { fetchFeed } from "./sources/rss.ts";
import { fetchDataset, openFdaChannel } from "./sources/openfda.ts";
import { fetchIndex, fetchPage, matchesFilter, toSitemapItem } from "./sources/sitemap.ts";
import { collectContent, RequestGate, type ContentStat } from "./sources/content.ts";
import { createVisionFromEnv } from "./content/vision.ts";

export const SITEMAP_CHANNEL = "sitemap:fda.gov";
const INDEX_STATE_CHANNEL = "sitemap:index";

export interface StageStat {
  stage: StageName;
  produced: number;
  notice: string;
}

export interface Alert {
  item: Item;
  rule: string;
  matches: Match[];
}

export interface RunOutcome {
  runId: number;
  staged: number;
  processed: number;
  pendingLeft: number;
  failedTotal: number;
  alerts: Alert[];
  perStage: StageStat[];
  written: string[];
}

export type Progress = (message: string) => void;

const feedChannel = (url: string): string => {
  const match = /rss-feeds\/([^/]+)\/rss\.xml$/.exec(url);
  return `rss:${match?.[1] ?? url}`;
};

interface Staged {
  channel: string;
  cursor: string;
  payload: unknown;
}

// 队列唯一键是 (source, channel, cursor)。轮询类通道的游标可能重复出现
// (例如 openFDA 的全窗口重扫会再次算出同一个终态游标), 若只用游标做键,
// 内容不同的新批次会被 INSERT OR IGNORE 静默丢弃。因此把批次内容的哈希
// 也并入键: 同一批内容重复入队仍会被去重, 内容不同则不会碰撞。
export const batchKeyOf = (cursor: string, payload: unknown): string => {
  const items = (Array.isArray(payload) ? payload : [payload]) as Item[];
  const fingerprint = items.map((item) => item?.id ?? "").join(",");
  return `${cursor}#${sha1(fingerprint).slice(0, 16)}`;
};

const stage = (store: Store, source: SourceKind, staged: Staged[], runId: number, now: string): number =>
  store.enqueue(
    staged.map((entry) => ({
      source,
      channel: entry.channel,
      cursor: batchKeyOf(entry.cursor, entry.payload),
      payload: entry.payload,
      runId,
    })),
    now,
  );

// 状态 (feed_state / cursor / sitemap_pages) 必须在条目入队成功之后才写入。
// 否则进程在两者之间中断时, 下一轮条件请求会返回 304 而跳过该窗口, 条目永久丢失。
export const collectRss = async (
  config: Config,
  store: Store,
  client: HttpClient,
  runId: number,
  now: string,
  progress: Progress,
): Promise<StageStat> => {
  const staged: Staged[] = [];
  const commits: (() => void)[] = [];
  let reachable = 0;

  for (const url of config.feeds) {
    const channel = feedChannel(url);
    const previous = store.getFeedState(channel);
    try {
      const result = await fetchFeed(client, url, channel, previous?.lastModified ?? null);
      if (result.notModified) {
        progress(`  = ${channel} 未变化 (304)`);
        continue;
      }
      // FDA 的 RSS Last-Modified 响应头不稳定 (实测每次请求都可能变化, 甚至倒退),
      // 因此不能靠它判断"内容是否变化"。这里用条目主键序列的内容指纹做游标:
      // 内容相同则队列键相同 (入队时去重), 内容变化才产生新批次。
      const fingerprint = sha1(result.items.map((item) => item.id).join(",")).slice(0, 16);
      if (previous?.fingerprint === fingerprint) {
        progress(`  = ${channel} 内容未变 (${result.items.length} 条)`);
        commits.push(() => store.setFeedState(channel, result.lastModified, now, fingerprint));
        continue;
      }
      reachable += 1;
      staged.push({ channel, cursor: fingerprint, payload: result.items });
      commits.push(() => store.setFeedState(channel, result.lastModified, now, fingerprint));
      progress(`  + ${channel} 解析出 ${result.items.length} 条`);
    } catch (error) {
      progress(`  ! ${channel} 失败: ${(error as Error).message}`);
    }
  }

  const produced = stage(store, "rss", staged, runId, now);
  for (const commit of commits) commit();
  const itemCount = staged.reduce((sum, entry) => sum + (entry.payload as Item[]).length, 0);
  return {
    stage: "rss",
    produced,
    notice: `${reachable}/${config.feeds.length} 个 feed 有更新, 共 ${itemCount} 条, 入队 ${produced} 批`,
  };
};

export const collectOpenFda = async (
  config: Config,
  store: Store,
  client: HttpClient,
  runId: number,
  now: string,
  progress: Progress,
): Promise<StageStat> => {
  const staged: Staged[] = [];
  const commits: (() => void)[] = [];
  let requests = 0;
  let items = 0;
  const skipped: string[] = [];

  for (const dataset of config.openfda) {
    const channel = openFdaChannel(dataset);
    try {
      const result = await fetchDataset(client, dataset, store.getCursor(channel), store.getDatasetState(channel), new Date(now), {
        apiKey: config.openfdaApiKey,
        rescanHours: config.openfdaRescanHours,
      });
      requests += result.requests;
      if (result.skippedReason !== null) {
        skipped.push(dataset.name);
        progress(`  = ${dataset.name} 跳过 (${result.skippedReason})`);
        continue;
      }
      items += result.items.length;
      staged.push({ channel, cursor: result.cursor, payload: result.items });
      commits.push(() => {
        store.setCursor(channel, result.cursor, now);
        store.setDatasetState(channel, result.lastUpdated, now);
      });
      progress(
        `  + ${dataset.name} 拉取 ${result.items.length} 条 (${result.requests} 次请求, ${result.daysWithData} 个有数据的日期${
          result.complete ? "" : ", 未扫完"
        })`,
      );
    } catch (error) {
      progress(`  ! ${dataset.name} 失败: ${(error as Error).message}`);
    }
  }

  const produced = stage(store, "openfda", staged, runId, now);
  for (const commit of commits) commit();
  const skipNote = skipped.length > 0 ? `, ${skipped.length} 个因数据未更新跳过` : "";
  return {
    stage: "openfda",
    produced,
    notice: `${staged.length}/${config.openfda.length} 个数据集可取, 共 ${items} 条, ${requests} 次请求${skipNote}, 入队 ${produced} 批`,
  };
};

export const collectSitemap = async (
  config: Config,
  store: Store,
  client: HttpClient,
  runId: number,
  now: string,
  progress: Progress,
  full: boolean,
): Promise<StageStat> => {
  const indexState = store.getSitemapPage(INDEX_STATE_CHANNEL);
  const index = await fetchIndex(client, config.sitemap.indexUrl, full ? null : indexState?.lastModified ?? null);
  if (index.notModified) {
    return { stage: "sitemap", produced: 0, notice: `索引 304, ${indexState?.fetchedAt ?? "?"} 以来未变化` };
  }

  const entries: { loc: string; lastModified: string | null }[] = [];
  const commits: (() => void)[] = [() => store.setSitemapPage(INDEX_STATE_CHANNEL, index.lastModified, now)];
  let changed = 0;
  let unchanged = 0;
  let failed = 0;

  for (const page of index.pages) {
    const cached = store.getSitemapPage(page.loc);
    try {
      // 首轮 44 页 × 30 秒 crawl-delay 需约 22 分钟, 期间必须给出行进反馈,
      // 否则用户会以为进程卡死。每 10 页报一次进度。
      if ((changed + unchanged) % 10 === 0 && (changed + unchanged) > 0) {
        progress(`  … sitemap 已处理 ${changed + unchanged}/${index.pages.length} 页`);
      }
      const result = await fetchPage(client, page.loc, full ? null : cached?.lastModified ?? null);
      if (result.notModified) {
        unchanged += 1;
        continue;
      }
      changed += 1;
      commits.push(() => store.setSitemapPage(page.loc, result.lastModified, now));
      for (const entry of result.entries) {
        if (matchesFilter(entry.loc, config.sitemap.include, config.sitemap.exclude)) entries.push(entry);
      }
    } catch (error) {
      failed += 1;
      progress(`  ! sitemap 分页 ${page.loc} 失败: ${(error as Error).message}`);
    }
  }

  const items = entries.map((entry) => toSitemapItem(entry, SITEMAP_CHANNEL));
  const produced = stage(store, "sitemap", [{ channel: SITEMAP_CHANNEL, cursor: `${now}:${items.length}`, payload: items }], runId, now);
  for (const commit of commits) commit();
  return {
    stage: "sitemap",
    produced,
    notice: `${index.pages.length} 个分页: ${changed} 页变更 / ${unchanged} 页 304 / ${failed} 页失败, 过滤后 ${items.length} 条 URL`,
  };
};

const drainQueue = (config: Config, store: Store, maxWork: number, progress: Progress): number => {
  let processed = 0;
  for (const channel of store.topPendingChannels(500)) {
    while (processed < maxWork) {
      const row = store.claimNext(channel, new Date().toISOString());
      if (row === null) break;
      try {
        const payload = JSON.parse(row.payload) as unknown;
        const items = (Array.isArray(payload) ? payload : [payload]) as Item[];
        const matches = items.flatMap((item) =>
          matchAll(item, config.keywords).map((match) => ({ itemId: item.id, rule: match.rule, field: match.field, term: match.term })),
        );
        const result = store.commitItems(items, matches, row.runId, new Date().toISOString());
        store.finish(row.id, "done", null, new Date().toISOString());
        if (result.alerted > 0) progress(`  * ${row.channel} 新增 ${result.inserted} 条, 命中 ${result.alerted} 次`);
      } catch (error) {
        store.finish(row.id, "failed", (error as Error).message, new Date().toISOString());
        progress(`  ! ${row.channel} 处理失败: ${(error as Error).message}`);
      }
      processed += 1;
    }
    if (processed >= maxWork) break;
  }
  return processed;
};

const writeRunSummary = (
  config: Config,
  runId: number,
  startedAt: string,
  alerts: Alert[],
  perStage: StageStat[],
): string => {
  const dir = join(config.dataDir, "runs");
  mkdirSync(dir, { recursive: true });
  const summary = join(dir, `${startedAt.replace(/[:.]/g, "-")}.json`);
  writeFileSync(
    summary,
    `${JSON.stringify(
      {
        run_id: runId,
        started_at: startedAt,
        stages: perStage,
        alert_count: alerts.length,
        alerts: alerts.map((alert) => ({
          rule: alert.rule,
          matched: alert.matches.map((match) => `${match.field}:${match.term}`),
          title: truncate(alert.item.title, 300),
          url: alert.item.url,
          date: alert.item.date,
          channel: alert.item.channel,
        })),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return summary;
};

export const runCollect = async (
  config: Config,
  store: Store,
  client: HttpClient,
  startedAt: string,
  options: { full: boolean; maxWork: number; progress: Progress },
): Promise<RunOutcome> => {
  const runId = store.startRun(startedAt);
  const perStage: StageStat[] = [];
  let processed = 0;

  const seenAlerts = new Set<string>();
  const alerts: Alert[] = [];

  // 每处理完一个通道就投递该通道新产生的告警, 而不是等所有通道跑完。
  // RSS 约 8 分钟、sitemap 首轮约 22 分钟, 若统一在末尾投递, 一次召回要在
  // 采集开始 30 分钟后才会被报出来。注意只投递本轮之前未见过的告警,
  // 否则同一个 run 内先跑的通道的告警会被后续每个 settleStage 重复投递。
  const settleStage = async (): Promise<void> => {
    const stale = store.requeueStale(new Date().toISOString());
    if (stale > 0) options.progress(`  ~ 重新入队 ${stale} 条中断任务`);
    processed += drainQueue(config, store, options.maxWork - processed, options.progress);

    const fresh: Alert[] = [];
    for (const alert of store.alertsForRun(runId)) {
      const key = `${alert.item.id}|${alert.rule}`;
      if (seenAlerts.has(key)) continue;
      seenAlerts.add(key);
      const matches = matchAll(alert.item, config.keywords).filter((match) => match.rule === alert.rule);
      const enriched: Alert = { item: alert.item, rule: alert.rule, matches };
      fresh.push(enriched);
      alerts.push(enriched);
    }
    await dispatch({ config, runId, alerts: fresh });
  };

  if (config.stages.length === 0 || config.stages.includes("rss")) {
    perStage.push(await collectRss(config, store, client, runId, startedAt, options.progress));
    await settleStage();
  }
  if (config.stages.length === 0 || config.stages.includes("openfda")) {
    perStage.push(await collectOpenFda(config, store, client, runId, startedAt, options.progress));
    await settleStage();
  }
  if (config.stages.length === 0 || config.stages.includes("sitemap")) {
    perStage.push(await collectSitemap(config, store, client, runId, startedAt, options.progress, options.full));
    await settleStage();
  }
  // 正文抓取消费的是 sitemap 刚落库的 URL, 因此排在 sitemap 之后。
  // 它也可以单独跑 (--stage content), 此时不会重扫 sitemap, 只消费库里的存量;
  // 显式指定该阶段时忽略 content.enabled, 否则使用者无从临时开跑。
  const wantContent = config.stages.length === 0 ? config.content.enabled : config.stages.includes("content");
  if (wantContent) {
    // --full 表示"这一轮尽量抓完", 但仍然分批循环而不是一次取 8.6 万个:
    // 每批抓完就落库, 进程中断只损失当前批, 重启能接着上次的位置继续。
    const batchSize = Math.min(config.content.batchSize, 5000);
    const maxBatches = options.full ? Math.ceil(86_700 / batchSize) : 1;
    // 闸门跨批次共享: 被限流后退避的历史必须延续到下一批, 否则批量循环会立刻重置退避。
    const gate = new RequestGate({ minIntervalMs: config.content.minIntervalMs, baseBackoffMs: config.content.backoffMs });
    const total: ContentStat = {
      fetched: 0, skipped: 0, failed: 0, deferred: 0, ocr: 0, ocrPending: 0, ocrFailed: 0, chars: 0, remaining: 0, kinds: {}, aborted: false,
    };
    let batches = 0;
    // OCR 引擎为本地 PP-OCR 时不需要视觉模型, 也就不必去读 .env。
    const vision = config.content.ocrEngine === "vision"
      ? createVisionFromEnv(process.env, config.content.ocrConcurrency)
      : null;
    const engine = !config.content.ocr ? "off" : config.content.ocrEngine;
    options.progress(
      engine === "local"
        ? "  · OCR 引擎: 本地 PP-OCRv6 (无需 API)"
        : engine === "vision"
          ? vision === null
            ? "  · 未配置视觉模型 (LLM_BASE_URL / LLM_API_KEY / LLM_MODEL): 扫描件 PDF 会被标记待 OCR 并跳过"
            : `  · OCR 引擎: 视觉模型 ${vision.model}`
          : "  · OCR 已关闭: 扫描件 PDF 会被标记待 OCR 并跳过",
    );
    for (let i = 0; i < maxBatches; i += 1) {
      const stat = await collectContent(config.content, store, client, startedAt, options.progress, {
        batchSize,
        gate,
        vision,
      });
      total.fetched += stat.fetched;
      total.skipped += stat.skipped;
      total.failed += stat.failed;
      total.deferred += stat.deferred;
      total.ocr += stat.ocr;
      total.ocrPending += stat.ocrPending;
      total.ocrFailed += stat.ocrFailed;
      total.chars += stat.chars;
      total.remaining = stat.remaining;
      for (const [kind, n] of Object.entries(stat.kinds)) total.kinds[kind] = (total.kinds[kind] ?? 0) + n;
      batches += 1;
      if (stat.aborted || stat.remaining === 0) break;
      if (stat.fetched + stat.skipped + stat.failed + stat.deferred + stat.ocrPending === 0) break;
      options.progress(
        `  … 正文累计 ${total.fetched} 篇 / 跳过 ${total.skipped} / 失败 ${total.failed} / 限流推迟 ${total.deferred} / OCR ${total.ocr} 页, 待抓 ${stat.remaining} (第 ${batches} 批)`,
      );
    }
    const kinds = Object.entries(total.kinds).map(([kind, n]) => `${kind} ${n}`).join(" / ");
    perStage.push({
      stage: "content",
      produced: 0,
      notice:
        `正文 ${batches} 批${total.aborted ? " (触发限流, 本轮中止)" : ""}: 抓取 ${total.fetched} 篇 / 跳过 ${total.skipped} / ` +
        `失败 ${total.failed} / 限流推迟 ${total.deferred} / OCR ${total.ocr} 页 / OCR 失败 ${total.ocrFailed} 页 / 待 OCR ${total.ocrPending} 篇, ` +
        `新增 ${total.chars} 字符${kinds.length > 0 ? ` (${kinds})` : ""}, 待抓 ${total.remaining}`,
    });
  }

  const pruned = store.pruneQueue(7, 200, startedAt);
  if (pruned > 0) options.progress(`  ~ 清理 ${pruned} 条已完成队列记录`);

  const written = [writeRunSummary(config, runId, startedAt, alerts, perStage)];
  const pendingLeft = store.pendingCount();

  store.finishRun(runId, new Date().toISOString(), {
    produced: perStage.reduce((sum, item) => sum + item.produced, 0),
    matched: alerts.length,
    fetched: processed,
  });
  store.vacuum();

  return {
    runId,
    staged: perStage.reduce((sum, item) => sum + item.produced, 0),
    processed,
    pendingLeft,
    failedTotal: store.failedCount(),
    alerts,
    perStage,
    written,
  };
};
