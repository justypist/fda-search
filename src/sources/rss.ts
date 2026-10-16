import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../util/http.ts";
import { stripTags, truncate, sha1 } from "../util/text.ts";
import { parseRfc822 } from "../util/time.ts";
import type { Item } from "../types.ts";

export interface FeedFetch {
  items: Item[];
  lastModified: string | null;
  notModified: boolean;
  feedTitle: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === "item",
});

interface RawItem {
  title?: unknown;
  link?: unknown;
  description?: unknown;
  pubDate?: unknown;
  guid?: unknown;
  "dc:creator"?: unknown;
}

interface RawFeed {
  rss?: { channel?: { title?: unknown; item?: RawItem[] } };
  feed?: { title?: unknown; entry?: RawItem[] };
}

const textOf = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["#text"] ?? "").trim();
  }
  return "";
};

export const fetchFeed = async (
  client: HttpClient,
  url: string,
  channel: string,
  lastModified: string | null,
): Promise<FeedFetch> => {
  const response = await client.fetchText({
    url,
    scope: "fda.gov",
    conditional: { lastModified },
  });
  if (response.notModified) {
    return { items: [], lastModified, notModified: true, feedTitle: "" };
  }

  const parsed = parser.parse(response.body) as RawFeed;
  const channelNode = parsed.rss?.channel;
  const entries = channelNode?.item ?? parsed.feed?.entry ?? [];
  const feedTitle = textOf(channelNode?.title ?? parsed.feed?.title);

  const items: Item[] = [];
  for (const entry of entries) {
    const title = stripTags(textOf(entry.title));
    const link = textOf(entry.link);
    const guid = textOf(entry.guid);
    const summary = truncate(stripTags(textOf(entry.description)), 2_000);
    const rawDate = textOf(entry.pubDate);
    const date = parseRfc822(rawDate);
    if (title.length === 0 && link.length === 0) continue;
    // 去重主键不带 channel 前缀: FDA 会把同一篇文章同时放进多个 feed
    // (例如一次食品召回既在 recalls 也在 food-safety-recalls), 若把通道并入
    // 主键, 同一条内容会被当成两条独立条目, 从而重复告警。这里用 guid, 回退到
    // link, 最后才用标题哈希。
    const identity = guid.length > 0 ? guid : link.length > 0 ? link : `${channel}:${sha1(title)}`;
    items.push({
      id: `rss:${identity}`,
      source: "rss",
      channel,
      title,
      summary,
      url: link,
      date,
      extra: { creator: stripTags(textOf(entry["dc:creator"])) },
    });
  }

  return {
    items,
    lastModified: response.headers.get("last-modified"),
    notModified: false,
    feedTitle,
  };
};
