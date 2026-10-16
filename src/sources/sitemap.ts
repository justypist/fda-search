import { XMLParser } from "fast-xml-parser";
import type { HttpClient } from "../util/http.ts";
import { parseIsoDate } from "../util/time.ts";
import type { Item } from "../types.ts";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === "url" || name === "sitemap",
});

interface RawUrl {
  loc?: unknown;
  lastmod?: unknown;
}

interface RawSitemap {
  urlset?: { url?: RawUrl[] };
  sitemapindex?: { sitemap?: RawUrl[] };
}

export interface SitemapPage {
  loc: string;
  lastModified: string | null;
}

export interface SitemapEntry {
  loc: string;
  lastModified: string | null;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

export interface IndexFetch {
  pages: SitemapPage[];
  lastModified: string | null;
  notModified: boolean;
}

export const fetchIndex = async (client: HttpClient, indexUrl: string, lastModified: string | null = null): Promise<IndexFetch> => {
  const response = await client.fetchText({ url: indexUrl, scope: "fda.gov", conditional: { lastModified } });
  if (response.notModified) {
    return { pages: [], lastModified, notModified: true };
  }
  const parsed = parser.parse(response.body) as RawSitemap;
  const pages = parsed.sitemapindex?.sitemap ?? [];
  return {
    pages: pages.map((page) => ({ loc: textOf(page.loc), lastModified: textOf(page.lastmod) || null })).filter((page) => page.loc.length > 0),
    lastModified: response.headers.get("last-modified"),
    notModified: false,
  };
};

export const fetchPage = async (
  client: HttpClient,
  loc: string,
  lastModified: string | null,
): Promise<{ entries: SitemapEntry[]; lastModified: string | null; notModified: boolean }> => {
  const response = await client.fetchText({
    url: loc,
    scope: "fda.gov",
    conditional: { lastModified },
  });
  if (response.notModified) {
    return { entries: [], lastModified, notModified: true };
  }
  const parsed = parser.parse(response.body) as RawSitemap;
  const urls = parsed.urlset?.url ?? [];
  const entries = urls
    .map((entry) => ({ loc: textOf(entry.loc), lastModified: textOf(entry.lastmod) || null }))
    .filter((entry) => entry.loc.length > 0);
  return { entries, lastModified: response.headers.get("last-modified"), notModified: false };
};

export const matchesFilter = (loc: string, include: string[], exclude: string[]): boolean => {
  if (exclude.some((pattern) => loc.includes(pattern))) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => loc.includes(pattern));
};

export const toSitemapItem = (entry: SitemapEntry, channel: string): Item => {
  const path = safePath(entry.loc);
  return {
    id: `sitemap:${entry.loc}`,
    source: "sitemap",
    channel,
    title: path,
    summary: "",
    url: entry.loc,
    date: entry.lastModified === null ? null : parseIsoDate(entry.lastModified),
    extra: { path, lastmod: entry.lastModified ?? "" },
  };
};

export const safePath = (loc: string): string => {
  try {
    return new URL(loc).pathname;
  } catch {
    return loc;
  }
};
