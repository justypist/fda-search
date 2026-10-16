import type { Item, KeywordRule } from "../types.ts";

export interface MatchField {
  label: string;
  value: string;
}

export interface Match {
  rule: string;
  field: string;
  term: string;
}

export const textFields = (item: Item): MatchField[] => {
  const base: MatchField[] = [
    { label: "title", value: item.title },
    { label: "summary", value: item.summary },
    { label: "url", value: item.url },
    { label: "channel", value: item.channel },
  ];
  for (const [key, value] of Object.entries(item.extra)) {
    base.push({ label: `extra.${key}`, value });
  }
  return base.filter((field) => field.value.length > 0);
};

const contains = (haystack: string, needle: string, caseSensitive: boolean): boolean =>
  caseSensitive ? haystack.includes(needle) : haystack.toLowerCase().includes(needle.toLowerCase());

const locate = (fields: MatchField[], term: string, caseSensitive: boolean): string =>
  fields.find((field) => contains(field.value, term, caseSensitive))?.label ?? "any";

export const matchItem = (item: Item, rule: KeywordRule): Match[] => {
  if (!rule.sources.includes(item.source)) return [];
  const hasPositiveTerm = rule.any.length > 0 || rule.all.length > 0 || rule.regex.length > 0;
  if (!hasPositiveTerm) return [];

  const fields = textFields(item);
  const haystack = fields.map((field) => field.value).join("\n");
  const { caseSensitive } = rule;

  const anyHits = rule.any.filter((term) => contains(haystack, term, caseSensitive));
  if (rule.any.length > 0 && anyHits.length === 0) return [];
  if (rule.all.some((term) => !contains(haystack, term, caseSensitive))) return [];
  if (rule.none.some((term) => contains(haystack, term, caseSensitive))) return [];

  const matches: Match[] = anyHits.map((term) => ({ rule: rule.name, field: locate(fields, term, caseSensitive), term }));

  const flags = caseSensitive ? "" : "i";
  for (const pattern of rule.regex) {
    const expression = new RegExp(pattern, flags);
    const hit = fields.find((field) => expression.test(field.value));
    if (hit === undefined) return [];
    matches.push({ rule: rule.name, field: hit.label, term: pattern });
  }

  if (matches.length === 0) {
    matches.push({ rule: rule.name, field: "all", term: rule.all.join(" + ") });
  }
  return matches;
};

export const matchAll = (item: Item, rules: KeywordRule[]): Match[] => rules.flatMap((rule) => matchItem(item, rule));
