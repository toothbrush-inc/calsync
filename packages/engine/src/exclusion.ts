import { createHash } from "node:crypto";

import type { AccountRole, ExclusionDirection, ExclusionSource, SyncConfig } from "./types.js";
import type { NormalizedSourceEvent } from "./normalize.js";

export type SourceExclusionScope = "occurrence" | "series" | "legacy";

export interface SourceExclusionKeys {
  occurrence: string;
  series: string;
}

const KEY_NAMESPACE = "calsync-exclude";
const KEY_VERSION = "v1";
const OPAQUE_KEY_PATTERN =
  /^calsync-exclude:v1:(?<direction>p2w|w2p):(?<scope>occ|series):[A-Za-z0-9_-]+$/u;

/**
 * Derives non-reversible, direction-bound keys without storing any additional
 * event data. The visible prefix makes the namespace, version, direction, and
 * scope explicit; the digest conceals the source identity.
 */
export function sourceExclusionKeys(
  sourceRole: AccountRole,
  source: NormalizedSourceEvent,
): SourceExclusionKeys {
  return {
    occurrence: deriveKey(sourceRole, "occurrence", source.occurrenceKey),
    series: deriveKey(sourceRole, "series", source.seriesKey),
  };
}

export function matchingSourceExclusion(
  exclusions: readonly string[],
  sourceRole: AccountRole,
  source: NormalizedSourceEvent,
): SourceExclusionScope | undefined {
  const configured = new Set(exclusions);
  const keys = sourceExclusionKeys(sourceRole, source);
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

export function parseOpaqueExclusionKey(value: string): ExclusionDirection {
  const trimmed = value.trim();
  const match = OPAQUE_KEY_PATTERN.exec(trimmed);
  if (match?.groups?.["direction"] === undefined) {
    throw new Error(
      `Invalid exclusion key "${trimmed}"; copy an opaque occurrence or series key from a detailed dry run`,
    );
  }
  return match.groups["direction"] === "p2w" ? "personalToWork" : "workToPersonal";
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
  const keys = groupedValues(source.listExclusionKeys());
  const keywords = groupedValues(
    source.listExclusionKeywords().map((row) => ({
      direction: row.direction,
      value: row.keyword,
    })),
  );
  return {
    ...config,
    exclusions: {
      personalToWork: unique([...config.exclusions.personalToWork, ...keys.personalToWork]),
      workToPersonal: unique([...config.exclusions.workToPersonal, ...keys.workToPersonal]),
      personalToWorkKeywords: unique([
        ...config.exclusions.personalToWorkKeywords,
        ...keywords.personalToWork,
      ]),
      workToPersonalKeywords: unique([
        ...config.exclusions.workToPersonalKeywords,
        ...keywords.workToPersonal,
      ]),
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
  sourceRole: AccountRole,
  scope: Exclude<SourceExclusionScope, "legacy">,
  identity: string,
): string {
  const direction = sourceRole === "personal" ? "p2w" : "w2p";
  const scopeCode = scope === "occurrence" ? "occ" : "series";
  const digest = createHash("sha256")
    .update(`${KEY_NAMESPACE}\0${KEY_VERSION}\0${direction}\0${scopeCode}\0${identity}`)
    .digest("base64url");
  return `${KEY_NAMESPACE}:${KEY_VERSION}:${direction}:${scopeCode}:${digest}`;
}

function groupedValues(
  rows: readonly { direction: ExclusionDirection; value: string }[],
): Record<ExclusionDirection, string[]> {
  const grouped: Record<ExclusionDirection, string[]> = {
    personalToWork: [],
    workToPersonal: [],
  };
  for (const row of rows) {
    grouped[row.direction].push(row.value);
  }
  return grouped;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
