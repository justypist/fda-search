import { Unzip, UnzipInflate } from "fflate";
import streamJson from "stream-json";
import pickPkg from "stream-json/filters/Pick.js";
import streamArrayPkg from "stream-json/streamers/StreamArray.js";
import { Readable, Writable } from "node:stream";
import type { HttpClient } from "../util/http.ts";
import type { Item, OpenFdaDataset } from "../types.ts";
import { toOpenFdaItem } from "./openfda.ts";

const { parser } = streamJson;
const { pick } = pickPkg;
const { streamArray } = streamArrayPkg;

// openFDA 的官方批量下载通道 (download.open.fda.gov)。它给出的是每个数据集的
// 完整 JSON 打包 (zip 内含一个 .json, 结构同 API 的 {meta, results}),
// 因此字段映射可以直接复用 API 通道的 toOpenFdaItem。
//
// 与 API 通道的区别:
//   - 不受 api.fda.gov 的配额约束 (240 请求/分钟、1000 请求/天), 是给程序批量取的
//   - 一次拿到全量而不是滑动窗口, 所以适合"补历史"; 日常增量仍应走 API
//   - 单文件可达数百 MB, 必须先看 size_mb 再决定要不要下

export interface BulkPartition {
  dataset: string;
  file: string;
  records: number;
  sizeMb: number;
}

interface ManifestPartition {
  file?: unknown;
  records?: unknown;
  size_mb?: unknown;
}

interface Manifest {
  results?: Record<string, Record<string, { partitions?: ManifestPartition[] }>>;
}

 export const MANIFEST_URL = "https://api.fda.gov/download.json";

export const fetchManifest = async (client: HttpClient): Promise<BulkPartition[]> => {
  const manifest = await client.fetchJson<Manifest>({ url: MANIFEST_URL, scope: "api.fda.gov", minDelayMs: 0 });
  const partitions: BulkPartition[] = [];
  for (const [category, datasets] of Object.entries(manifest.results ?? {})) {
    for (const [name, info] of Object.entries(datasets ?? {})) {
      for (const partition of info?.partitions ?? []) {
        const file = typeof partition.file === "string" ? partition.file : "";
        if (file.length === 0) continue;
        partitions.push({
          dataset: `${category}/${name}`,
          file,
          records: Number(partition.records ?? 0),
          sizeMb: Number(partition.size_mb ?? 0),
        });
      }
    }
  }
  return partitions;
};

export interface BulkOptions {
  maxPartitionMb: number;
  // 只取这些数据集; 空表示全部
  datasets: string[];
  // 全量 batch 一次要下 130 GB, 因此按分区总数限制单轮下载量
  maxPartitions: number;
}

export interface BulkResult {
  downloaded: number;
  skipped: number;
  bytes: number;
  records: number;
  failures: { file: string; error: string }[];
}

// 单个分区落库的回调。返回本批新增/命中数, 用于汇总。
export type BulkSink = (items: Item[]) => { inserted: number; alerted: number };

// 单个分区是 {meta, results:[...]}, 且解压后可以很大 —— 实测 device/recall
// 解压 1.4 GB, device/510k 约 1.2 GB。整块读进内存会撞两个硬限制:
//   1. V8 的字符串上限约 512 MB: "Cannot create a string longer than 0x1fffffe8"
//   2. JSON.parse 对大数组爆栈: "Maximum call stack size exceeded"
// 因此这里全程流式: 响应体 -> fflate 流式解压 -> stream-json 逐条解析。
// 内存占用与分区大小无关, 只与单条记录大小有关。
const parsePartition = async (
  body: ReadableStream<Uint8Array>,
  dataset: OpenFdaDataset,
): Promise<{ items: Item[]; bytes: number }> => {
  const items: Item[] = [];
  let bytes = 0;
  let fileName = "";

  await new Promise<void>((resolve, reject) => {
    const unzip = new Unzip();
    unzip.register(UnzipInflate);

    unzip.onfile = (file) => {
      fileName = file.name;
      if (!file.name.endsWith(".json")) return;
      const chunks = Readable.from(
        (async function* () {
          const queue: (Uint8Array | null)[] = [];
          let wake: (() => void) | null = null;
          file.ondata = (err, chunk, final) => {
            if (err) {
              reject(err);
              return;
            }
            if (chunk && chunk.length > 0) {
              bytes += chunk.length;
              queue.push(chunk);
            }
            if (final) queue.push(null);
            wake?.();
          };
          file.start();
          for (;;) {
            while (queue.length === 0) await new Promise<void>((r) => { wake = r; });
            const next = queue.shift();
            if (next === null || next === undefined) return;
            yield next;
          }
        })(),
      );
      chunks
        .pipe(parser())
        // 顶层是 {meta, results}, 只取 results 数组
        .pipe(pick({ filter: "results" }))
        .pipe(streamArray())
        .on("data", (entry: { value: Record<string, unknown> }) => {
          const item = toOpenFdaItem(dataset, entry.value);
          if (item !== null) items.push(item);
        })
        .on("end", () => resolve())
        .on("error", reject);
    };

    Readable.fromWeb(body as never)
      .pipe(
        new Writable({
          write(chunk: Uint8Array, _enc, cb) {
            unzip.push(chunk, false);
            cb();
          },
          final(cb) {
            unzip.push(new Uint8Array(0), true);
            cb();
          },
        }),
      )
      .on("error", reject)
      .on("finish", () => setTimeout(resolve, 500));
  });

  if (fileName.length === 0) throw new Error("zip 内没有 .json");
  return { items, bytes };
};

/**
 * 按分区下载 openFDA 全量数据。
 *
 * 与 API 通道的分工: API 用于日常增量 (滑动窗口 + last_updated 短路), 批量通道
 * 用于一次性补齐历史。两者产出同样的 Item, 靠 instances 主键去重, 因此重叠安全。
 *
 * 每个分区下载完立刻通过 sink 落库, 不在内存里累积 —— 单个数据集可能有上千个分区、
 * 上千万条记录 (实测 animalandveterinary/event 159 个分区, 全攒着会 OOM)。
 */
export const fetchBulk = async (
  client: HttpClient,
  datasets: OpenFdaDataset[],
  options: BulkOptions,
  progress: (message: string) => void,
  sink?: BulkSink,
): Promise<BulkResult> => {
  const byName = new Map(datasets.map((dataset) => [dataset.name, dataset]));
  const wanted = options.datasets.length > 0 ? new Set(options.datasets) : null;
  const manifest = await fetchManifest(client);
  const selected = manifest
    .filter((partition) => byName.has(partition.dataset))
    .filter((partition) => wanted === null || wanted.has(partition.dataset))
    .sort((a, b) => a.file.localeCompare(b.file));

  const result: BulkResult = { downloaded: 0, skipped: 0, bytes: 0, records: 0, failures: [] };
  for (const [index, partition] of selected.entries()) {
    if (result.downloaded >= options.maxPartitions) {
      result.skipped += selected.length - index;
      break;
    }
    if (partition.sizeMb > options.maxPartitionMb) {
      progress(`  ! 跳过 ${partition.dataset} 分区 (${partition.sizeMb.toFixed(1)} MB, 超过上限 ${options.maxPartitionMb} MB)`);
      result.skipped += 1;
      continue;
    }
    const dataset = byName.get(partition.dataset)!;
    try {
      // 批量分区最大 275 MB, 解压后可达 1.4 GB, 因此走流式下载 + 流式解压,
      // 不把响应体收进内存。超时放宽到 10 分钟: 这是整个下载的墙钟上限,
      // 实测 275 MB 分区需约 62 秒, 但网络慢时可能更久。
      const response = await client.fetchStream({
        url: partition.file,
        scope: "download.open.fda.gov",
        minDelayMs: 0,
        timeoutMs: 600_000,
      });
      if (response.body === null) throw new Error("响应无 body");
      const parsed = await parsePartition(response.body, dataset);
      result.bytes += parsed.bytes;
      result.records += parsed.items.length;
      result.downloaded += 1;
      // 立刻落库并释放: 这个分区可能有 17 万条 (device/510k), 攒着会 OOM。
      // 也不能用 push(...items): 15 万+ 个实参会爆栈 ("Maximum call stack size exceeded")。
      sink?.(parsed.items);
      progress(`  + ${partition.dataset} ${partition.file.split("/").pop()} → ${parsed.items.length} 条 (解压 ${(parsed.bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (error) {
      result.failures.push({ file: partition.file, error: (error as Error).message });
      progress(`  ! ${partition.file} 失败: ${(error as Error).message}`);
    }
  }
  return result;
};
