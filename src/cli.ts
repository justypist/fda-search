import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { loadConfig } from "./config.ts";
import { Store } from "./db.ts";
import { HttpClient } from "./util/http.ts";
import { acquireLock } from "./util/lock.ts";
import { runCollect } from "./pipeline.ts";
import { fetchBulk } from "./sources/bulk.ts";
import { serve } from "./server.ts";
import { matchAll } from "./util/keyword.ts";
import { notifierNames } from "./notify/index.ts";  // 该模块内部已引入全部内置通道
import type { Alert } from "./pipeline.ts";
import type { Item, SourceKind } from "./types.ts";

const USAGE = `FDA 变更监听

用法: node src/cli.ts <命令> [选项]

命令:
  collect              拉取各通道并把新条目落库, 命中关键词时输出
  bulk                 走 openFDA 官方批量下载通道补历史 (不受 API 配额限制)
  serve                启动本地搜索界面 (只监听回环地址)
  status               显示运行历史、游标、队列与库内统计
  alerts               列出历史告警
  search <关键词>      在已落库条目中检索
  recall <关键词>      在正文库中全文检索 (FTS5)
  tail [n]             显示最新 n 条已落库条目 (默认 20)

选项:
  -c, --config <路径>  配置文件 (默认 ./monitor.config.json)
      --stage <名称>   仅跑指定通道, 可重复: rss | openfda | sitemap
      --full           忽略条件请求缓存, 强制全量拉取 (sitemap / 正文)
      --max-work <n>   本轮最多处理的队列条数 (默认取配置)
      --dataset <名称> bulk 限定数据集, 可重复 (默认取配置)
      --limit <n>      bulk 单轮最多下多少个分区 / serve 单页结果上限
      --port <n>       serve 监听端口 (默认 8787)
  -v, --verbose        输出每个通道的明细
  -h, --help           显示帮助

提醒: 对 fda.gov 的请求已按 robots.txt 的 Crawl-delay 串行限速, 请勿缩短间隔。
`;

interface CliOptions {
  command: string;
  positional: string[];
  config: string;
  stages: SourceKind[];
  full: boolean;
  maxWork: number | null;
  datasets: string[];
  limit: number | null;
  port: number | null;
  verbose: boolean;
  json: boolean;
}

const STAGES = ["rss", "openfda", "sitemap"] as const;

const parse = (argv: string[]): CliOptions => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "./monitor.config.json" },
      stage: { type: "string", multiple: true, default: [] },
      full: { type: "boolean", default: false },
      "max-work": { type: "string" },
      dataset: { type: "string", multiple: true, default: [] },
      limit: { type: "string" },
      port: { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const maxWork = values["max-work"] === undefined ? null : Number(values["max-work"]);
  if (maxWork !== null && (!Number.isInteger(maxWork) || maxWork <= 0)) {
    throw new Error(`--max-work 需要正整数, 收到 ${values["max-work"]}`);
  }
  const limit = values.limit === undefined ? null : Number(values.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit <= 0)) {
    throw new Error(`--limit 需要正整数, 收到 ${values.limit}`);
  }
  const port = values.port === undefined ? null : Number(values.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`--port 需要 1-65535 的整数, 收到 ${values.port}`);
  }
  // 打错的通道名必须报错。若静默丢弃, stages 会变空, 于是跑起全部通道 ——
  // 与"只跑指定通道"的意图正好相反, 对 fda.gov 意味着多出 20 多分钟的请求。
  const rawStages = values.stage ?? [];
  const invalid = rawStages.filter((s) => !(STAGES as readonly string[]).includes(s));
  if (invalid.length > 0) {
    throw new Error(`未知通道 ${invalid.join(", ")}, 可选值: ${STAGES.join(" | ")}`);
  }
  return {
    command: positionals[0] ?? "help",
    positional: positionals.slice(1),
    config: values.config ?? "./monitor.config.json",
    stages: rawStages.filter((s): s is SourceKind => (STAGES as readonly string[]).includes(s)),
    full: values.full === true,
    maxWork,
    datasets: values.dataset ?? [],
    limit,
    port,
    verbose: values.verbose === true,
    json: values.json === true,
  };
};

const formatAlert = (alert: Alert): string => {
  const matched = alert.matches.map((match) => `${match.field}=${match.term}`).join(",");
  const date = alert.item.date === null ? "?" : alert.item.date.slice(0, 10);
  return [
    `[${alert.rule}] ${date} ${alert.item.channel}`,
    `  ${alert.item.title}`,
    `  命中: ${matched}`,
    `  ${alert.item.url}`,
  ].join("\n");
};

const printItems = (items: Item[], limit: number): void => {
  if (items.length === 0) {
    process.stdout.write("(无结果)\n");
    return;
  }
  for (const item of items.slice(0, limit)) {
    process.stdout.write(
      `${item.date?.slice(0, 10) ?? "?"}  ${item.channel.padEnd(28)}  ${item.title.slice(0, 90)}\n    ${item.url}\n`,
    );
  }
};

const COMMANDS = ["collect", "bulk", "serve", "status", "alerts", "search", "recall", "tail", "help"] as const;
type Command = (typeof COMMANDS)[number];

const isCommand = (value: string): value is Command => (COMMANDS as readonly string[]).includes(value);

const main = async (): Promise<number> => {
  const options = parse(process.argv.slice(2));
  if (!isCommand(options.command)) {
    process.stderr.write(`未知命令: ${options.command}\n\n${USAGE}`);
    return 2;
  }
  if (options.command === "help") {
    process.stdout.write(USAGE);
    return 0;
  }

  const cwd = process.cwd();
  const config = loadConfig(cwd, options.config);
  if (options.stages.length > 0) config.stages = options.stages;
  if (options.maxWork !== null) config.maxWork = options.maxWork;

  const store = new Store(config.dbPath);
  const client = new HttpClient(config.http);
  const progress = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  try {
    switch (options.command) {
      case "collect": {
        const lock = acquireLock(config.dataDir);
        try {
          const startedAt = new Date().toISOString();
          const outcome = await runCollect(config, store, client, startedAt, {
            full: options.full,
            maxWork: config.maxWork,
            progress: options.verbose
              ? progress
              : (message: string): void => {
                  if (message.includes("失败") || message.includes("命中")) progress(message);
                },
          });
          for (const stage of outcome.perStage) {
            process.stdout.write(`${stage.stage}: ${stage.notice}\n`);
          }
          process.stdout.write(
            `处理 ${outcome.processed} 条队列消息, 本轮告警 ${outcome.alerts.length} 条, 队列剩余 ${outcome.pendingLeft} 条${
              outcome.failedTotal > 0 ? `, 累计失败 ${outcome.failedTotal} 条` : ""
            }\n`,
          );
          for (const alert of outcome.alerts) process.stdout.write(`${formatAlert(alert)}\n`);
          process.stdout.write(`通知通道: ${notifierNames().join(", ")}\n`);
          if (outcome.written.length > 0) {
            process.stdout.write(`运行摘要: ${outcome.written.map((path: string) => resolve(cwd, path)).join(", ")}\n`);
          }
        } finally {
          lock.release();
        }
        return 0;
      }
      case "bulk": {
        const lock = acquireLock(config.dataDir);
        try {
          const startedAt = new Date().toISOString();
          const runId = store.startRun(startedAt);
          const bulkOptions = {
            datasets: options.datasets.length > 0 ? options.datasets : config.bulk.datasets,
            maxPartitionMb: config.bulk.maxPartitionMb,
            maxPartitions: options.limit ?? config.bulk.maxPartitions,
          };
          process.stderr.write(`批量下载: 数据集 ${bulkOptions.datasets.length > 0 ? bulkOptions.datasets.join(", ") : "(全部已配置)"}, 上限 ${bulkOptions.maxPartitions} 个分区\n`);
          let inserted = 0;
          let alerted = 0;
          // 每个分区下载完立刻落库, 不在内存累积 (单个数据集可有上千万条记录)。
          const result = await fetchBulk(client, config.openfda, bulkOptions, progress, (items) => {
            const matches = items.flatMap((item) =>
              matchAll(item, config.keywords).map((match) => ({ itemId: item.id, rule: match.rule, field: match.field, term: match.term })),
            );
            const committed = store.commitItems(items, matches, runId, new Date().toISOString());
            inserted += committed.inserted;
            alerted += committed.alerted;
            return committed;
          });
          store.finishRun(runId, new Date().toISOString(), {
            produced: result.records,
            matched: alerted,
            fetched: result.downloaded,
          });
          process.stdout.write(
            `下载 ${result.downloaded} 个分区 (解压 ${(result.bytes / 1024 / 1024).toFixed(1)} MB), 跳过 ${result.skipped}, ` +
              `解析 ${result.records} 条, 新增 ${inserted} 条, 命中 ${alerted} 次\n`,
          );
          if (result.failures.length > 0) {
            process.stdout.write(`失败 ${result.failures.length} 个分区 (可用 --verbose 重跑查看)\n`);
          }
          if (result.skipped > 0) process.stdout.write(`剩余分区下一轮继续 (调大 bulk.maxPartitions 或 --limit 可一次下更多)\n`);
        } finally {
          lock.release();
        }
        return 0;
      }
      case "serve": {
        const port = options.port ?? 8787;
        const server = await serve(store, { port, host: "127.0.0.1", limit: options.limit ?? 50 });
        const counts = store.counts();
        process.stdout.write(`本地搜索界面: http://127.0.0.1:${port}\n`);
        process.stdout.write(
          `索引 ${counts.items} 条元数据, 正文 ${store.documentStats().ok} 篇${store.ftsEnabled ? "" : " (FTS5 不可用)"}\n`,
        );
        process.stdout.write("Ctrl-C 退出\n");
        await new Promise<void>((resolve) => {
          const stop = (): void => {
            server.close(() => resolve());
          };
          process.on("SIGINT", stop);
          process.on("SIGTERM", stop);
        });
        return 0;
      }
      case "status": {
        const counts = store.counts();
        const pending = store.pendingCount();
        const failed = store.failedCount();
        const runs = store.listRuns(10);
        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                counts,
                pending,
                failed,
                runs,
                cursors: store.listCursors(),
                feedStates: store.listFeedStates(),
                datasetStates: store.listDatasetStates(),
              },
              null,
              2,
            )}\n`,
          );
          return 0;
        }
        process.stdout.write(`库内条目 ${counts.items} | 告警 ${counts.alerts} | 运行 ${counts.runs}\n`);
        process.stdout.write(`队列: 待处理 ${pending}, 失败 ${failed}\n`);
        process.stdout.write(`sitemap 分页缓存 ${store.sitemapPageCount()} 页\n`);
        const docs = store.documentStats();
        process.stdout.write(
          `正文库: ${docs.total} 篇 (成功 ${docs.ok} / 失败 ${docs.failed}), ${docs.chars} 字符, 待抓 ${store.pendingDocumentCount()} 个 URL` +
            `${store.ftsEnabled ? ", FTS5 已启用" : ", FTS5 不可用 (降级为 LIKE)"}\n`,
        );
        if (docs.byKind.length > 0) {
          process.stdout.write(`  类型: ${docs.byKind.map((entry) => `${entry.kind} ${entry.n}`).join(", ")}\n`);
        }
        process.stdout.write("最近运行:\n");
        for (const run of runs) {
          process.stdout.write(
            `  #${run.id} ${run.startedAt} -> ${run.finishedAt ?? "(未完成)"} ${run.stats === null ? "" : JSON.stringify(run.stats)}\n`,
          );
        }
        const cursors = store.listCursors();
        if (cursors.length > 0) {
          process.stdout.write("游标:\n");
          for (const cursor of cursors) process.stdout.write(`  ${cursor.channel} = ${cursor.cursor} (${cursor.updatedAt})\n`);
        }
        const datasets = store.listDatasetStates();
        if (datasets.length > 0) {
          process.stdout.write("openFDA 数据集:\n");
          for (const dataset of datasets) {
            process.stdout.write(`  ${dataset.channel} last_updated=${dataset.lastUpdated ?? "?"} 扫描于 ${dataset.scannedAt}\n`);
          }
        }
        return 0;
      }
      case "alerts": {
        const limit = Number(options.positional[0] ?? "50");
        const alerts = store.alerts(Number.isFinite(limit) && limit > 0 ? limit : 50);
        if (options.json) {
          process.stdout.write(`${JSON.stringify(alerts, null, 2)}\n`);
          return 0;
        }
        if (alerts.length === 0) {
          process.stdout.write("(暂无告警)\n");
          return 0;
        }
        for (const alert of alerts) {
          process.stdout.write(
            `[${alert.rule}] ${alert.matchedAt.slice(0, 19)} ${alert.item.date?.slice(0, 10) ?? "?"} ${alert.item.channel}\n  ${alert.item.title}\n  ${alert.item.url}\n`,
          );
        }
        return 0;
      }
      case "search": {
        const query = options.positional.join(" ").trim();
        if (query.length === 0) throw new Error("search 需要一个关键词");
        const items = store.searchItems(query, 100).items;
        if (options.json) {
          process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(`匹配 ${items.length} 条:\n`);
        printItems(items, 100);
        return 0;
      }
      case "recall": {
        const query = options.positional.join(" ").trim();
        if (query.length === 0) throw new Error("recall 需要一个关键词");
        const limit = options.maxWork ?? 30;
        const { hits, mode } = store.searchDocuments(query, limit);
        if (options.json) {
          process.stdout.write(`${JSON.stringify({ mode, count: hits.length, hits }, null, 2)}\n`);
          return 0;
        }
        process.stdout.write(`正文库匹配 ${hits.length} 篇 (${mode}${mode === "like" ? ", FTS5 不可用" : ""}):\n`);
        if (hits.length === 0) return 0;
        for (const hit of hits) {
          process.stdout.write(`\n[${hit.kind}] ${hit.title.slice(0, 110) || hit.url}\n  ${hit.url}\n`);
          if (hit.snippet.length > 0) {
            process.stdout.write(`  …${hit.snippet.replace(/\s+/g, " ").slice(0, 300)}…\n`);
          }
        }
        return 0;
      }
      case "tail": {
        const limit = Number(options.positional[0] ?? "20");
        const items = store.searchItems("", Number.isFinite(limit) && limit > 0 ? limit : 20).items;
        printItems(items, items.length);
        return 0;
      }
    }
  } finally {
    store.close();
  }
};

process.exitCode = await main().catch((error: unknown) => {
  process.stderr.write(`错误: ${(error as Error).message}\n`);
  return 1;
});
