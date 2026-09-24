import {
  parseExclusionKeywords,
  parseOpaqueExclusionKey,
  type ExclusionDirection,
} from "@calsync/engine";

import type { AppConfig } from "./config.js";

export type ExclusionKind = "key" | "keyword";
export type ExclusionOrigin = "cli" | "env";

export interface ExclusionItem {
  kind: ExclusionKind;
  value: string;
  direction: ExclusionDirection;
}

export interface ExclusionChangeResult {
  added: ExclusionItem[];
  alreadyPresent: ExclusionItem[];
  removed: ExclusionItem[];
  missing: ExclusionItem[];
}

export interface ExclusionListEntry {
  value: string;
  direction: ExclusionDirection;
  origin: ExclusionOrigin;
}

export interface ExclusionSnapshot {
  keywords: ExclusionListEntry[];
  keys: ExclusionListEntry[];
}

export interface ExclusionStore {
  addExclusionKey(direction: ExclusionDirection, value: string): boolean;
  removeExclusionKey(value: string): boolean;
  addExclusionKeyword(direction: ExclusionDirection, keyword: string): boolean;
  removeExclusionKeyword(direction: ExclusionDirection, keyword: string): boolean;
  listExclusionKeys(): readonly { direction: ExclusionDirection; value: string }[];
  listExclusionKeywords(): readonly { direction: ExclusionDirection; keyword: string }[];
}

export interface ExclusionChangeInput {
  keys?: readonly string[];
  keywords?: readonly string[];
  from?: string | readonly string[];
}

export function changeExclusions(
  action: "add" | "remove",
  state: ExclusionStore,
  input: ExclusionChangeInput,
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
    mergeExclusionChange(result, changeKeywordExclusions(action, state, keywords, fromValues));
  }
  if (hasKeys) {
    if (fromValues.length > 0 && !hasKeywords) {
      throw new Error("--from is only used with --keyword; opaque keys include their direction");
    }
    mergeExclusionChange(result, changeKeyExclusions(action, state, keyValues));
  }
  return result;
}

export function snapshotExclusions(config: AppConfig, state: ExclusionStore): ExclusionSnapshot {
  const storedKeys = new Map(
    state.listExclusionKeys().map((row) => [`${row.direction}\0${row.value}`, row] as const),
  );
  const storedKeywords = new Map(
    state.listExclusionKeywords().map((row) => [`${row.direction}\0${row.keyword}`, row] as const),
  );
  const keywords: ExclusionListEntry[] = [];
  const keys: ExclusionListEntry[] = [];
  for (const direction of ["personalToWork", "workToPersonal"] as const) {
    const envKeywords =
      direction === "personalToWork"
        ? config.exclusions.personalToWorkKeywords
        : config.exclusions.workToPersonalKeywords;
    const envKeys =
      direction === "personalToWork"
        ? config.exclusions.personalToWork
        : config.exclusions.workToPersonal;
    for (const row of storedKeywords.values()) {
      if (row.direction === direction) {
        keywords.push({ value: row.keyword, direction, origin: "cli" });
      }
    }
    for (const keyword of envKeywords) {
      if (!storedKeywords.has(`${direction}\0${keyword}`)) {
        keywords.push({ value: keyword, direction, origin: "env" });
      }
    }
    for (const row of storedKeys.values()) {
      if (row.direction === direction) {
        keys.push({ value: row.value, direction, origin: "cli" });
      }
    }
    for (const value of envKeys) {
      if (!storedKeys.has(`${direction}\0${value}`)) {
        keys.push({ value, direction, origin: "env" });
      }
    }
  }
  return { keywords, keys };
}

export function sourceRoleToDirection(value: string): ExclusionDirection {
  if (value === "personal") {
    return "personalToWork";
  }
  if (value === "work") {
    return "workToPersonal";
  }
  throw new Error(`Invalid --from "${value}"; expected personal or work`);
}

export function emptyExclusionChangeResult(): ExclusionChangeResult {
  return { added: [], alreadyPresent: [], removed: [], missing: [] };
}

function changeKeywordExclusions(
  action: "add" | "remove",
  state: ExclusionStore,
  keywords: readonly string[],
  fromValues: readonly string[],
): ExclusionChangeResult {
  if (keywords.length === 0) {
    throw new Error("Keyword must not be blank");
  }
  const from = fromValues[0];
  if (from === undefined) {
    throw new Error("Use --from personal or --from work with --keyword");
  }
  if (fromValues.length > 1) {
    throw new Error(
      "Use --from once for a keyword batch; personal and work keywords need separate commands",
    );
  }
  const direction = sourceRoleToDirection(from);
  const result = emptyExclusionChangeResult();
  for (const keyword of keywords) {
    const item: ExclusionItem = { kind: "keyword", value: keyword, direction };
    if (action === "add") {
      if (state.addExclusionKeyword(direction, keyword)) {
        result.added.push(item);
      } else {
        result.alreadyPresent.push(item);
      }
    } else if (state.removeExclusionKeyword(direction, keyword)) {
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
): ExclusionChangeResult {
  const result = emptyExclusionChangeResult();
  for (const value of uniqueInOrder(keyValues)) {
    const item: ExclusionItem = {
      kind: "key",
      value,
      direction: parseOpaqueExclusionKey(value),
    };
    if (action === "add") {
      if (state.addExclusionKey(item.direction, value)) {
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
