import { createHash } from "node:crypto";

import type { CalendarKey, ExclusionSource, SyncConfig } from "./types.js";
import type { NormalizedSourceEvent } from "./normalize.js";

export type SourceExclusionScope = "occurrence" | "series" | "legacy";

export interface SourceExclusionKeys {
  occurrence: string;
  series: string;
}

const KEY_NAMESPACE = "calsync-exclude";
const OPAQUE_KEY_PATTERN =
  /^calsync-exclude:(?:v1:(?<direction>p2w|w2p)|v2:(?<tag>[A-Za-z0-9_-]{11})):(?<scope>occ|series):[A-Za-z0-9_-]+$/u;

/**
 * v1 keys predate calendar keys and name a direction; each direction had one
 * source, so they now name that source. They stay in use for those two keys,
 * so every stored exclusion keeps matching.
 */
const LEGACY_DIRECTIONS: Readonly<Record<string, "p2w" | "w2p">> = { personal: "p2w", work: "w2p" };

/**
 * Derives non-reversible, source-bound keys without storing any additional
 * event data. The visible prefix makes the namespace, version, source, and
 * scope explicit; the digest conceals the source identity.
 */
export function sourceExclusionKeys(
  sourceKey: CalendarKey,
  source: NormalizedSourceEvent,
): SourceExclusionKeys {
  return {
    occurrence: deriveKey(sourceKey, "occurrence", source.occurrenceKey),
    series: deriveKey(sourceKey, "series", source.seriesKey),
  };
}

export function matchingSourceExclusion(
  exclusions: readonly string[],
  sourceKey: CalendarKey,
  source: NormalizedSourceEvent,
): SourceExclusionScope | undefined {
  const configured = new Set(exclusions);
  const keys = sourceExclusionKeys(sourceKey, source);
  if (configured.has(keys.occurrence)) {
    return "occurrence";
  }
  if (configured.has(keys.series)) {
    return "series";
  }
  if (configured.has(source.id) || configured.has(source.occurrenceKey)) {
    return "legacy";
  }
  return undefined;
}

/** The connected source calendar an opaque key belongs to. */
export function parseOpaqueExclusionKey(
  value: string,
  calendarKeys: readonly CalendarKey[],
): CalendarKey {
  const trimmed = value.trim();
  const groups = OPAQUE_KEY_PATTERN.exec(trimmed)?.groups;
  if (groups === undefined) {
    throw new Error(
      `Invalid exclusion key "${trimmed}"; copy an opaque occurrence or series key from a detailed dry run`,
    );
  }
  const sourceKey = calendarKeys.find((key) =>
    groups["direction"] === undefined
      ? calendarTag(key) === groups["tag"]
      : LEGACY_DIRECTIONS[key] === groups["direction"],
  );
  if (sourceKey === undefined) {
    throw new Error(`Exclusion key "${trimmed}" belongs to a calendar that is not connected`);
  }
  return sourceKey;
}

export function normalizeExclusionKeyword(value: string): string {
  const keyword = value.trim().toLowerCase();
  if (keyword.length === 0) {
    throw new Error("Keyword must not be blank");
  }
  return keyword;
}

export function parseExclusionKeywords(values: readonly string[]): string[] {
  const keywords: string[] = [];
  for (const value of values) {
    for (const part of value.split(",")) {
      const keyword = part.trim();
      if (keyword.length === 0) {
        continue;
      }
      keywords.push(normalizeExclusionKeyword(keyword));
    }
  }
  return unique(keywords);
}

export function applyStoredExclusions<T extends SyncConfig>(config: T, source: ExclusionSource): T {
  return {
    ...config,
    exclusions: {
      keys: mergeBySource(
        config.exclusions.keys,
        source.listExclusionKeys().map((row) => ({ sourceKey: row.sourceKey, value: row.value })),
      ),
      keywords: mergeBySource(
        config.exclusions.keywords,
        source
          .listExclusionKeywords()
          .map((row) => ({ sourceKey: row.sourceKey, value: row.keyword })),
      ),
    },
  };
}

export function isTitleExcludedByKeyword(
  title: string | undefined,
  keywords: readonly string[],
): boolean {
  if (title === undefined) {
    return false;
  }
  const normalizedTitle = title.toLowerCase();
  return keywords.some((keyword) => {
    const normalizedKeyword = keyword.trim().toLowerCase();
    return normalizedKeyword.length > 0 && normalizedTitle.includes(normalizedKeyword);
  });
}

function deriveKey(
  sourceKey: CalendarKey,
  scope: Exclude<SourceExclusionScope, "legacy">,
  identity: string,
): string {
  const scopeCode = scope === "occurrence" ? "occ" : "series";
  const direction = LEGACY_DIRECTIONS[sourceKey];
  const [version, label] =
    direction === undefined ? ["v2", calendarTag(sourceKey)] : ["v1", direction];
  const digest = createHash("sha256")
    .update(`${KEY_NAMESPACE}\0${version}\0${label}\0${scopeCode}\0${identity}`)
    .digest("base64url");
  return `${KEY_NAMESPACE}:${version}:${label}:${scopeCode}:${digest}`;
}

/** Short, fixed-width tag naming a source calendar inside a v2 key. */
function calendarTag(key: CalendarKey): string {
  return createHash("sha256").update(`calsync-calendar\0${key}`).digest("base64url").slice(0, 11);
}

function mergeBySource(
  configured: Readonly<Record<CalendarKey, readonly string[]>>,
  stored: readonly { sourceKey: CalendarKey; value: string }[],
): Record<CalendarKey, string[]> {
  const merged: Record<CalendarKey, string[]> = {};
  for (const [key, values] of Object.entries(configured)) {
    merged[key] = [...values];
  }
  for (const row of stored) {
    (merged[row.sourceKey] ??= []).push(row.value);
  }
  for (const [key, values] of Object.entries(merged)) {
    merged[key] = unique(values);
  }
  return merged;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
