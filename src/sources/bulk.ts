import { unzipSync, strFromU8 } from "fflate";
import type { HttpClient } from "../util/http.ts";
import type { Item, OpenFdaDataset } from "../types.ts";
import { toOpenFdaItem } from "./openfda.ts";

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
  items: Item[];
  downloaded: number;
  skipped: number;
  bytes: number;
  failures: { file: string; error: string }[];
}

// 单个分区解出来的 JSON 就是 {meta, results}, 与 API 响应同构。
const parsePartition = (bytes: Uint8Array, dataset: OpenFdaDataset): { items: Item[]; bytes: number } => {
  const files = unzipSync(bytes);
  const name = Object.keys(files).find((entry) => entry.endsWith(".json"));
  if (name === undefined) throw new Error("zip 内没有 .json");
  const payload = JSON.parse(strFromU8(files[name]!)) as { results?: Record<string, unknown>[] };
  const items: Item[] = [];
  for (const record of payload.results ?? []) {
    const item = toOpenFdaItem(dataset, record);
    if (item !== null) items.push(item);
  }
  return { items, bytes: bytes.byteLength };
};

/**
 * 按分区下载 openFDA 全量数据。
 *
 * 与 API 通道的分工: API 用于日常增量 (滑动窗口 + last_updated 短路), 批量通道
 * 用于一次性补齐历史。两者产出同样的 Item, 靠 instances 主键去重, 因此重叠安全。
 */
export const fetchBulk = async (
  client: HttpClient,
  datasets: OpenFdaDataset[],
  options: BulkOptions,
  progress: (message: string) => void,
): Promise<BulkResult> => {
  const byName = new Map(datasets.map((dataset) => [dataset.name, dataset]));
  const wanted = options.datasets.length > 0 ? new Set(options.datasets) : null;
  const manifest = await fetchManifest(client);
  const selected = manifest
    .filter((partition) => byName.has(partition.dataset))
    .filter((partition) => wanted === null || wanted.has(partition.dataset))
    .sort((a, b) => a.file.localeCompare(b.file));

  const result: BulkResult = { items: [], downloaded: 0, skipped: 0, bytes: 0, failures: [] };
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
      // 批量文件很大, 用 fetchBytes 并按分区实际大小放宽上限 (再留 20% 余量)
      const response = await client.fetchBytes({
        url: partition.file,
        scope: "download.open.fda.gov",
        minDelayMs: 0,
        maxBytes: Math.ceil(partition.sizeMb * 1.2 * 1024 * 1024) + 4 * 1024 * 1024,
      });
      const parsed = parsePartition(response.bytes, dataset);
      result.items.push(...parsed.items);
      result.bytes += parsed.bytes;
      result.downloaded += 1;
      progress(`  + ${partition.dataset} ${partition.file.split("/").pop()} → ${parsed.items.length} 条 (${(parsed.bytes / 1024 / 1024).toFixed(1)} MB)`);
    } catch (error) {
      result.failures.push({ file: partition.file, error: (error as Error).message });
      progress(`  ! ${partition.file} 失败: ${(error as Error).message}`);
    }
  }
  return result;
};
