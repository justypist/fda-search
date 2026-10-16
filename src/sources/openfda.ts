import type { HttpClient } from "../util/http.ts";
import { fieldText, truncate } from "../util/text.ts";
import { parseIsoDate, toCompactDate, toDashedDate } from "../util/time.ts";
import type { Item, OpenFdaDataset } from "../types.ts";

const PAGE_SIZE = 100;
const MAX_SKIP = 25_000;

interface OpenFdaResponse {
  meta?: { results?: { total?: number; skip?: number; limit?: number }; last_updated?: string };
  results?: Record<string, unknown>[];
  error?: { code?: string; message?: string; details?: string };
}

interface CountEntry {
  time: string;
  count: number;
}

const NOT_FOUND = 404;

// openFDA 在"无匹配结果"时返回 HTTP 404 而不是空的 results 数组, 因此所有请求
// 都容忍 404 并交由调用方解析响应体。
const request = (
  client: HttpClient,
  dataset: OpenFdaDataset,
  params: URLSearchParams,
  apiKey: string | null,
): Promise<OpenFdaResponse> => {
  const query = new URLSearchParams(params);
  if (apiKey !== null && apiKey.length > 0) query.set("api_key", apiKey);
  return client.fetchJson<OpenFdaResponse>({
    url: `https://api.fda.gov/${dataset.name}.json?${query.toString()}`,
    scope: "api.fda.gov",
    minDelayMs: 0,
    tolerateStatuses: [NOT_FOUND],
  });
};

const isNoMatch = (payload: OpenFdaResponse): boolean =>
  payload.error?.code === "NOT_FOUND" || payload.results === undefined;

const fail = (dataset: OpenFdaDataset, context: string, payload: OpenFdaResponse): never => {
  const detail = `${payload.error?.code ?? ""} ${payload.error?.message ?? ""} ${payload.error?.details ?? ""}`.trim();
  throw new Error(`${dataset.name} ${context} 失败: ${detail}`);
};

// openFDA 的 count 聚合无论字段本身是 YYYYMMDD 还是 YYYY-MM-DD, 返回的 time 一律是
// 紧凑的 YYYYMMDD (实测 device/recall 的 event_date_posted 也是如此)。这里统一
// 归一化为带连字符的形式, 后续所有日期运算都在该形式下进行。
const normalizeCountDay = (time: string): string | null => {
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(time);
  if (compact !== null) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(time) ? time : null;
};

const fetchDayCounts = async (
  client: HttpClient,
  dataset: OpenFdaDataset,
  from: string,
  to: string,
  apiKey: string | null,
): Promise<{ days: CountEntry[]; lastUpdated: string | null }> => {
  const params = new URLSearchParams();
  params.set("search", `${dataset.dateField}:[${formatDay(dataset, from)} TO ${formatDay(dataset, to)}]`);
  params.set("count", dataset.dateField);
  const payload = await request(client, dataset, params, apiKey);
  if (payload.error !== undefined && !isNoMatch(payload)) fail(dataset, `统计 ${from}..${to}`, payload);
  const rows = (payload.results ?? []) as unknown as CountEntry[];
  const days = rows
    .map((row) => ({ time: normalizeCountDay(String(row.time)), count: Number(row.count) }))
    .filter((row): row is CountEntry => row.time !== null && Number.isFinite(row.count) && row.count > 0)
    .sort((a, b) => a.time.localeCompare(b.time));
  return { days, lastUpdated: payload.meta?.last_updated ?? null };
};

const fetchPage = async (
  client: HttpClient,
  dataset: OpenFdaDataset,
  day: string,
  skip: number,
  apiKey: string | null,
): Promise<Item[]> => {
  const params = new URLSearchParams();
  params.set("search", `${dataset.dateField}:[${formatDay(dataset, day)} TO ${formatDay(dataset, day)}]`);
  params.set("sort", `${dataset.dateField}:${dataset.sortDesc ? "desc" : "asc"}`);
  params.set("limit", String(PAGE_SIZE));
  if (skip > 0) params.set("skip", String(skip));
  const payload = await request(client, dataset, params, apiKey);
  if (payload.error !== undefined) {
    if (isNoMatch(payload)) return [];
    fail(dataset, `查询 ${day}`, payload);
  }
  const items: Item[] = [];
  for (const record of payload.results ?? []) {
    const item = toOpenFdaItem(dataset, record);
    if (item !== null) items.push(item);
  }
  return items;
};

export interface OpenFdaCursor {
  day: string;
  skip: number;
  windowStart: string;
}

export interface DatasetState {
  lastUpdated: string | null;
  scannedAt: string | null;
}

export interface FetchOptions {
  apiKey?: string | null;
  rescanHours?: number;
}

export interface DatasetFetch {
  items: Item[];
  cursor: string;
  requests: number;
  scanned: boolean;
  skippedReason: string | null;
  lastUpdated: string | null;
  complete: boolean;
  daysWithData: number;
}

const addDays = (day: string, days: number): string => {
  const at = new Date(`${day}T00:00:00.000Z`);
  if (Number.isNaN(at.getTime())) throw new Error(`非法日期 ${day} (游标已损坏, 请用 status 检查 cursors 表并清理)`);
  return toDashedDate(new Date(at.getTime() + days * 86_400_000));
};

export const addDaysChecked = addDays;

export const parseOpenFdaCursor = (cursor: string | null, dataset: OpenFdaDataset, now: Date): OpenFdaCursor => {
  const fallback: OpenFdaCursor = {
    day: toDashedDate(new Date(now.getTime() - dataset.lookbackDays * 86_400_000)),
    skip: 0,
    windowStart: toDashedDate(new Date(now.getTime() - dataset.lookbackDays * 86_400_000)),
  };
  if (cursor === null) return fallback;
  const [day, skip, windowStart] = cursor.split(":");
  if (day === undefined || windowStart === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(day) || !/^\d{4}-\d{2}-\d{2}$/.test(windowStart)) {
    return fallback;
  }
  const parsedSkip = Number(skip ?? "0");
  return { day, skip: Number.isFinite(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0, windowStart };
};

export const formatOpenFdaCursor = (cursor: OpenFdaCursor): string => `${cursor.day}:${cursor.skip}:${cursor.windowStart}`;

export const openFdaChannel = (dataset: OpenFdaDataset): string => `openfda:${dataset.name}`;

const formatDay = (dataset: OpenFdaDataset, day: string): string =>
  dataset.dateFormat === "dashed" ? day : day.replaceAll("-", "");

const renderUrl = (template: string, record: Record<string, unknown>): string =>
  template.replace(/\{([a-zA-Z0-9_.]+)\}/g, (_, key: string) => encodeURIComponent(fieldText(record, key)));

export const toOpenFdaItem = (dataset: OpenFdaDataset, record: Record<string, unknown>): Item | null => {
  const rawId = fieldText(record, dataset.idField);
  if (rawId.length === 0) return null;
  const rawDate = fieldText(record, dataset.dateField);
  const extra: Record<string, string> = { dataset: dataset.name };
  for (const field of dataset.summaryFields) {
    extra[field] = truncate(fieldText(record, field), 500);
  }
  const summary = dataset.summaryFields
    .map((field) => (extra[field] === undefined || extra[field] === "" ? "" : `${field}: ${extra[field]}`))
    .filter((part) => part.length > 0)
    .join(" | ");
  return {
    id: `openfda:${dataset.name}:${rawId}`,
    source: "openfda",
    channel: openFdaChannel(dataset),
    title: truncate(fieldText(record, dataset.titleField) || rawId, 500),
    summary: truncate(summary, 2_000),
    url: renderUrl(dataset.itemUrl, record),
    date: parseIsoDate(rawDate),
    extra,
  };
};

const withinRescanWindow = (state: DatasetState, lastUpdated: string | null, now: Date, rescanHours: number): boolean => {
  if (state.scannedAt === null || state.lastUpdated === null || lastUpdated === null) return false;
  if (state.lastUpdated !== lastUpdated) return false;
  return now.getTime() - Date.parse(state.scannedAt) < rescanHours * 3_600_000;
};

/**
 * 增量拉取一个 openFDA 数据集。
 *
 * openFDA 存在数天的发布延迟, 且历史日期会被陆续补录, 因此每次扫描都是一个
 * 覆盖最近 lookbackDays 的滑动窗口, 而不是"推进过去就不再回看"的严格游标。
 * 重复拉到的条目由 instances / alerts 的主键去重, 不会重复告警。
 *
 * 成本控制: 每轮先用一次 count 聚合拿到窗口内"哪些天有数据", 无数据的日期直接跳过;
 * 若数据集的 meta.last_updated 未变化且距上次扫描不足 rescanHours, 则整轮跳过。
 */
export const fetchDataset = async (
  client: HttpClient,
  dataset: OpenFdaDataset,
  cursor: string | null,
  state: DatasetState,
  now: Date,
  options: FetchOptions = {},
): Promise<DatasetFetch> => {
  const apiKey = options.apiKey ?? null;
  const rescanHours = options.rescanHours ?? 12;
  const today = toDashedDate(now);
  const windowStart = toDashedDate(new Date(now.getTime() - dataset.lookbackDays * 86_400_000));

  const parsed = parseOpenFdaCursor(cursor, dataset, now);
  const resuming = parsed.windowStart === windowStart && parsed.day <= today;
  const scanFrom = resuming ? parsed.day : windowStart;
  const scanSkip = resuming ? parsed.skip : 0;

  const base: Omit<DatasetFetch, "items" | "requests" | "scanned" | "skippedReason" | "complete" | "daysWithData"> = {
    cursor: formatOpenFdaCursor({ day: scanFrom, skip: scanSkip, windowStart }),
    lastUpdated: state.lastUpdated,
  };

  const { days, lastUpdated } = await fetchDayCounts(client, dataset, scanFrom, today, apiKey);
  const requests = 1;

  if (!resuming && withinRescanWindow(state, lastUpdated, now, rescanHours)) {
    return {
      ...base,
      items: [],
      requests,
      scanned: false,
      skippedReason: `last_updated=${lastUpdated} 未变化, 距上次扫描不足 ${rescanHours} 小时`,
      complete: true,
      daysWithData: 0,
    };
  }

  const items: Item[] = [];
  let used = requests;
  let complete = true;
  let day = scanFrom;
  let skip = scanSkip;
  let scanned = 0;

  for (const entry of days) {
    if (entry.time < scanFrom) continue;
    day = entry.time;
    skip = entry.time === scanFrom ? scanSkip : 0;
    scanned += 1;

    while (skip < entry.count) {
      if (used >= dataset.maxRequests) {
        complete = false;
        break;
      }
      if (skip > MAX_SKIP) {
        throw new Error(`${dataset.name} 的 ${day} 有 ${entry.count} 条, 超过 skip 上限 ${MAX_SKIP}, 无法在该日期字段下分页`);
      }
      const page = await fetchPage(client, dataset, day, skip, apiKey);
      used += 1;
      if (page.length === 0) break;
      items.push(...page);
      skip += page.length;
    }

    if (!complete) break;
    day = addDays(entry.time, 1);
    skip = 0;
  }

  // count 聚合覆盖了 scanFrom..today 的整个范围, 因此只要没有因请求上限中断,
  // 就说明该范围内所有有数据的日期都已拉完, 游标可以直接推进到 today 之后。
  // 否则当最后一个有数据的日期早于今天时, 游标会停在中间, 导致每轮重扫整个窗口。
  const exhausted = complete && day <= today;
  const cursorOut = exhausted
    ? { day: addDays(today, 1), skip: 0, windowStart }
    : { day, skip, windowStart };

  return {
    items,
    requests: used,
    scanned: true,
    skippedReason: null,
    cursor: formatOpenFdaCursor(cursorOut),
    complete,
    daysWithData: scanned,
    lastUpdated,
  };
};
