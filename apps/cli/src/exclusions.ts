import { parseExclusionKeywords, parseOpaqueExclusionKey, type CalendarKey } from "@calsync/engine";

import type { AppConfig } from "./config.js";

export type ExclusionKind = "key" | "keyword";
export type ExclusionOrigin = "cli" | "env";

export interface ExclusionItem {
  kind: ExclusionKind;
  value: string;
  /** The calendar whose events it holds back. */
  source: CalendarKey;
}

export interface ExclusionChangeResult {
  added: ExclusionItem[];
  alreadyPresent: ExclusionItem[];
  removed: ExclusionItem[];
  missing: ExclusionItem[];
}

export interface ExclusionListEntry {
  value: string;
  source: CalendarKey;
  origin: ExclusionOrigin;
}

export interface ExclusionSnapshot {
  keywords: ExclusionListEntry[];
  keys: ExclusionListEntry[];
}

export interface ExclusionStore {
  addExclusionKey(sourceKey: CalendarKey, value: string): boolean;
  removeExclusionKey(value: string): boolean;
  addExclusionKeyword(sourceKey: CalendarKey, keyword: string): boolean;
  removeExclusionKeyword(sourceKey: CalendarKey, keyword: string): boolean;
  listExclusionKeys(): readonly { sourceKey: CalendarKey; value: string }[];
  listExclusionKeywords(): readonly { sourceKey: CalendarKey; keyword: string }[];
}

export interface ExclusionChangeInput {
  keys?: readonly string[];
  keywords?: readonly string[];
  from?: string | readonly string[];
}

/**
 * Adds or removes exclusions. `sources` are the calendars whose events can
 * be excluded: a keyword names one with `from`, an opaque key carries its own.
 */
export function changeExclusions(
  action: "add" | "remove",
  state: ExclusionStore,
  input: ExclusionChangeInput,
  sources: readonly CalendarKey[],
  options: { allowMix?: boolean } = {},
): ExclusionChangeResult {
  const keyValues = asList(input.keys).map((key) => key.trim());
  if (keyValues.some((key) => key.length === 0)) {
    throw new Error("Opaque exclusion keys must not be blank");
  }
  const rawKeywords = asList(input.keywords);
  const keywords = parseExclusionKeywords(rawKeywords);
  const fromValues = uniqueInOrder(asList(input.from));
  const hasKeys = keyValues.length > 0;
  const hasKeywords = rawKeywords.length > 0;
  if (hasKeys && hasKeywords && options.allowMix !== true) {
    throw new Error("Provide either opaque exclusion keys or --keyword, not both");
  }
  if (!hasKeys && !hasKeywords) {
    throw new Error("Provide opaque exclusion keys or --keyword");
  }

  const result = emptyExclusionChangeResult();
  if (hasKeywords) {
    mergeExclusionChange(
      result,
      changeKeywordExclusions(action, state, keywords, fromValues, sources),
    );
  }
  if (hasKeys) {
    if (fromValues.length > 0 && !hasKeywords) {
      throw new Error("--from is only used with --keyword; opaque keys include their calendar");
    }
    mergeExclusionChange(result, changeKeyExclusions(action, state, keyValues, sources));
  }
  return result;
}

export function snapshotExclusions(config: AppConfig, state: ExclusionStore): ExclusionSnapshot {
  const storedKeys = new Map(
    state.listExclusionKeys().map((row) => [`${row.sourceKey}\0${row.value}`, row] as const),
  );
  const storedKeywords = new Map(
    state.listExclusionKeywords().map((row) => [`${row.sourceKey}\0${row.keyword}`, row] as const),
  );
  const keywords: ExclusionListEntry[] = [];
  const keys: ExclusionListEntry[] = [];
  for (const { key: source } of config.calendars.filter((calendar) => calendar.source)) {
    for (const row of storedKeywords.values()) {
      if (row.sourceKey === source) {
        keywords.push({ value: row.keyword, source, origin: "cli" });
      }
    }
    for (const keyword of config.exclusions.keywords[source] ?? []) {
      if (!storedKeywords.has(`${source}\0${keyword}`)) {
        keywords.push({ value: keyword, source, origin: "env" });
      }
    }
    for (const row of storedKeys.values()) {
      if (row.sourceKey === source) {
        keys.push({ value: row.value, source, origin: "cli" });
      }
    }
    for (const value of config.exclusions.keys[source] ?? []) {
      if (!storedKeys.has(`${source}\0${value}`)) {
        keys.push({ value, source, origin: "env" });
      }
    }
  }
  return { keywords, keys };
}

/** The source calendars of a config, the only ones an exclusion can name. */
export function exclusionSources(config: AppConfig): CalendarKey[] {
  return config.calendars.filter((calendar) => calendar.source).map((calendar) => calendar.key);
}

export function emptyExclusionChangeResult(): ExclusionChangeResult {
  return { added: [], alreadyPresent: [], removed: [], missing: [] };
}

function changeKeywordExclusions(
  action: "add" | "remove",
  state: ExclusionStore,
  keywords: readonly string[],
  fromValues: readonly string[],
  sources: readonly CalendarKey[],
): ExclusionChangeResult {
  if (keywords.length === 0) {
    throw new Error("Keyword must not be blank");
  }
  const choices = sources.map((key) => `--from ${key}`).join(" or ");
  const source = fromValues[0];
  if (source === undefined) {
    throw new Error(`Use ${choices} with --keyword`);
  }
  if (fromValues.length > 1) {
    throw new Error(
      "Use --from once for a keyword batch; each calendar's keywords need a separate command",
    );
  }
  if (!sources.includes(source)) {
    throw new Error(`Invalid --from "${source}"; expected ${sources.join(" or ")}`);
  }
  const result = emptyExclusionChangeResult();
  for (const keyword of keywords) {
    const item: ExclusionItem = { kind: "keyword", value: keyword, source };
    if (action === "add") {
      if (state.addExclusionKeyword(source, keyword)) {
        result.added.push(item);
      } else {
        result.alreadyPresent.push(item);
      }
    } else if (state.removeExclusionKeyword(source, keyword)) {
      result.removed.push(item);
    } else {
      result.missing.push(item);
    }
  }
  return result;
}

function changeKeyExclusions(
  action: "add" | "remove",
  state: ExclusionStore,
  keyValues: readonly string[],
  sources: readonly CalendarKey[],
): ExclusionChangeResult {
  const result = emptyExclusionChangeResult();
  for (const value of uniqueInOrder(keyValues)) {
    const item: ExclusionItem = {
      kind: "key",
      value,
      source: parseOpaqueExclusionKey(value, sources),
    };
    if (action === "add") {
      if (state.addExclusionKey(item.source, value)) {
        result.added.push(item);
      } else {
        result.alreadyPresent.push(item);
      }
    } else if (state.removeExclusionKey(value)) {
      result.removed.push(item);
    } else {
      result.missing.push(item);
    }
  }
  return result;
}

function mergeExclusionChange(target: ExclusionChangeResult, source: ExclusionChangeResult): void {
  target.added.push(...source.added);
  target.alreadyPresent.push(...source.alreadyPresent);
  target.removed.push(...source.removed);
  target.missing.push(...source.missing);
}

function asList(value: string | readonly string[] | undefined): string[] {
  if (value === undefined) {
    return [];
  }
  return typeof value === "string" ? [value] : [...value];
}

function uniqueInOrder(values: readonly string[]): string[] {
  return [...new Set(values)];
}
