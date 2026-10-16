const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// 字面固定偏移, 不做夏令时推断: EST/EDT 分别按 UTC-5 / UTC-4 解释。
// FDA 的 feed 生成器本身会按夏令时正确切换缩写, 因此两者对真实数据一致。
const ZONE_MINUTES: Record<string, number> = {
  UT: 0, GMT: 0, UTC: 0, Z: 0,
  EST: -300, EDT: -240,
  CST: -360, CDT: -300,
  MST: -420, MDT: -360,
  PST: -480, PDT: -420,
};

const RFC822 = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})$/;

// 少数 feed 会省略时区。此时不能交给 new Date() 用服务器本地时区解释
// (本机为 Asia/Shanghai, 会整体偏移 8 小时), 统一按 UTC 处理。
const RFC822_NO_ZONE = /^(?:[A-Za-z]{3},\s*)?(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?$/;

const zoneMinutes = (zone: string): number | null => {
  if (/^[+-]\d{4}$/.test(zone)) {
    const sign = zone.startsWith("-") ? -1 : 1;
    return sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
  }
  return ZONE_MINUTES[zone.toUpperCase()] ?? null;
};

export const parseRfc822 = (value: string): string | null => {
  const trimmed = value.trim();
  const match = RFC822.exec(trimmed);
  if (match === null) {
    const noZone = RFC822_NO_ZONE.exec(trimmed);
    if (noZone === null) return null;
    const [, day, month, year, hour, minute, second] = noZone;
    const monthIndex = MONTHS[month!.toLowerCase()];
    if (monthIndex === undefined) return null;
    return new Date(Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second ?? 0))).toISOString();
  }
  const [, day, month, year, hour, minute, second, zone] = match;
  const monthIndex = MONTHS[month!.toLowerCase()];
  if (monthIndex === undefined) return null;
  const offset = zoneMinutes(zone!);
  if (offset === null) return null;
  const wallClock = Date.UTC(Number(year), monthIndex, Number(day), Number(hour), Number(minute), Number(second ?? 0));
  return new Date(wallClock - offset * 60_000).toISOString();
};

export const parseIsoDate = (value: string): string | null => {
  const trimmed = value.trim();
  const compact = /^(\d{4})(\d{2})(\d{2})$/.exec(trimmed);
  if (compact !== null) return `${compact[1]}-${compact[2]}-${compact[3]}T00:00:00.000Z`;
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};

const pad = (value: number): string => String(value).padStart(2, "0");

export const toCompactDate = (at: Date): string => `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;

export const toDashedDate = (at: Date): string => `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;
