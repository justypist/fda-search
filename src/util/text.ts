import { createHash } from "node:crypto";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

export const sha1 = (value: string): string => createHash("sha1").update(value).digest("hex");

export const collapseWhitespace = (value: string): string => value.replace(/\s+/g, " ").trim();

export const stripTags = (value: string): string => collapseWhitespace(value.replace(/<[^>]*>/g, " "));

export const appendJsonl = (path: string, records: unknown[]): void => {
  if (records.length === 0) return;
  const target = resolve(path);
  mkdirSync(dirname(target), { recursive: true });
  appendFileSync(target, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
};

export const pick = (value: unknown, path: string): unknown => {
  let current: unknown = value;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const head = /^\d+$/.test(segment) ? current[Number(segment)] : (current[0] as Record<string, unknown> | undefined)?.[segment];
      current = head;
      continue;
    }
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  const seen = new Set<unknown>();
  let node: unknown = current;
  while (Array.isArray(node) && !seen.has(node)) {
    seen.add(node);
    node = node[0];
  }
  return node;
};

export const flatten = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return collapseWhitespace(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return collapseWhitespace(value.map(flatten).filter((part) => part.length > 0).join(", "));
  return collapseWhitespace(Object.values(value as Record<string, unknown>).map(flatten).filter((part) => part.length > 0).join(" "));
};

export const fieldText = (record: Record<string, unknown>, path: string): string => flatten(pick(record, path));
