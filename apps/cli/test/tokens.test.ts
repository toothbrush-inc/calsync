import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GrantError, openVault } from "@dvd-toy-box/vault";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TokenStore } from "../src/storage/keychain.js";
import { VaultTokenStore } from "../src/storage/tokens.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("VaultTokenStore", () => {
  it("writes Google refresh tokens into the shared vault", async () => {
    const vault = fileVault();
    const setRefreshToken = vi.fn(() => Promise.resolve());
    const legacy: TokenStore = {
      getRefreshToken: vi.fn(() => Promise.resolve(null)),
      setRefreshToken,
      deleteRefreshToken: vi.fn(() => Promise.resolve(false)),
    };
    const store = new VaultTokenStore(vault, legacy, ["calendar.events"]);

    await store.setRefreshToken("personal", "1//new-refresh");

    await expect(store.getRefreshToken("personal")).resolves.toBe("1//new-refresh");
    await expect(vault.status("google:personal")).resolves.toMatchObject({
      set: true,
      origin: "vault",
      status: "ok",
      masked: "••••resh",
    });
    expect(setRefreshToken).not.toHaveBeenCalled();
  });

  it("reads a legacy Keychain token when the vault has no secret yet", async () => {
    const vault = fileVault();
    const deleteRefreshToken = vi.fn(() => Promise.resolve(true));
    const legacy: TokenStore = {
      getRefreshToken: vi.fn((role) =>
        Promise.resolve(role === "work" ? "legacy-work-token" : null),
      ),
      setRefreshToken: vi.fn(() => Promise.resolve()),
      deleteRefreshToken,
    };
    const store = new VaultTokenStore(vault, legacy);

    await expect(store.getRefreshToken("work")).resolves.toBe("legacy-work-token");
    await expect(store.deleteRefreshToken("work")).resolves.toBe(true);
    expect(deleteRefreshToken).toHaveBeenCalledWith("work");
  });

  it("registers a calsync grant when a token is stored and removes it on delete", async () => {
    const vault = fileVault();
    const store = new VaultTokenStore(vault);

    await store.setRefreshToken("personal", "1//new-refresh");
    expect(vault.listGrants("calsync")).toMatchObject([
      {
        id: "calsync:google:personal",
        connectionId: "google:personal",
        actions: ["read", "write"],
      },
    ]);

    await store.deleteRefreshToken("personal");
    expect(vault.listGrants("calsync")).toEqual([]);
  });

  it("scopes vault slots and grants by tenant", async () => {
    const vault = fileVault();
    const getRefreshToken = vi.fn(() => Promise.resolve(null));
    const legacy: TokenStore = {
      getRefreshToken,
      setRefreshToken: vi.fn(() => Promise.resolve()),
      deleteRefreshToken: vi.fn(() => Promise.resolve(false)),
    };
    const acme = new VaultTokenStore(vault, legacy, ["calendar.events"], "acme");
    const defaultTenant = new VaultTokenStore(vault);

    await acme.setRefreshToken("personal", "1//acme-refresh");

    await expect(acme.getRefreshToken("personal")).resolves.toBe("1//acme-refresh");
    await expect(vault.status("google:acme_personal")).resolves.toMatchObject({
      set: true,
      status: "ok",
    });
    // The tenant slot inherits the role connection's manifest actions.
    expect(vault.listGrants("calsync")).toMatchObject([
      { connectionId: "google:acme_personal", actions: ["read", "write"] },
    ]);
    // The default tenant sees nothing from acme, and the legacy Keychain
    // fallback still receives the bare role (it scopes internally).
    await expect(defaultTenant.getRefreshToken("personal")).resolves.toBeNull();
    await acme.getRefreshToken("work");
    expect(getRefreshToken).toHaveBeenCalledWith("work");

    await expect(acme.deleteRefreshToken("personal")).resolves.toBe(true);
    expect(vault.listGrants("calsync")).toEqual([]);
  });

  it("requires a grant before reading tokens in explicit mode", async () => {
    const vault = fileVault("explicit");
    await vault.putSecret({
      provider: "google",
      slot: "personal",
      kind: "oauth",
      secret: "1//ungranted",
    });
    const store = new VaultTokenStore(vault);

    await expect(store.getRefreshToken("personal")).rejects.toBeInstanceOf(GrantError);

    await store.setRefreshToken("personal", "1//granted");
    await expect(store.getRefreshToken("personal")).resolves.toBe("1//granted");
  });
});

function fileVault(grantMode?: "auto" | "explicit") {
  const home = mkdtempSync(join(tmpdir(), "calsync-vault-"));
  homes.push(home);
  const options: { home: string; backend: "file"; grantMode?: "auto" | "explicit" } = {
    home,
    backend: "file",
  };
  if (grantMode !== undefined) {
    options.grantMode = grantMode;
  }
  return openVault(options);
}
