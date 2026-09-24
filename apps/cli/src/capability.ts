import { readFileSync } from "node:fs";

import { parseCapabilityManifest, type CapabilityManifest } from "@dvd-toy-box/vault";

// Parsed at module load so a malformed manifest fails fast, not at first use.
// Resolves from both src/ (tsx dev) and dist/ (built): each is a sibling of
// capability.json at the package root.
const raw: unknown = JSON.parse(
  readFileSync(new URL("../capability.json", import.meta.url), "utf8"),
);

export const CALSYNC_CAPABILITY: CapabilityManifest = parseCapabilityManifest(raw);

// The app's own words (the manifest's `store` block), read raw so they are
// available whichever @dvd-toy-box/vault version parsed the rest. The store page,
// the gateway's status and the MCP server's instructions all say these.
const rawStore = (raw as { store?: { name?: unknown; tagline?: unknown; description?: unknown } })
  .store;
export const CALSYNC_STORE: { name: string; tagline?: string; description: string } = {
  description:
    typeof rawStore?.description === "string"
      ? rawStore.description
      : 'Mirrors your busy time between a personal and a work Google account as private "Busy" blocks.',
  name: typeof rawStore?.name === "string" ? rawStore.name : "calsync",
  ...(typeof rawStore?.tagline === "string" ? { tagline: rawStore.tagline } : {}),
};
