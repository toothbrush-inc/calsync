import { describe, expect, it, vi } from "vitest";

import {
  type CommandRunner,
  KeychainError,
  MacOsKeychainTokenStore,
} from "../src/storage/keychain.js";

describe("MacOsKeychainTokenStore", () => {
  it("stores roles as separate generic-password accounts", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "" });
    const store = new MacOsKeychainTokenStore("test.calsync", run, "darwin");

    await store.setRefreshToken("personal", "personal-refresh-token");
    await store.setRefreshToken("work", "work-refresh-token");

    expect(run).toHaveBeenNthCalledWith(1, "security", [
      "add-generic-password",
      "-U",
      "-a",
      "personal",
      "-s",
      "test.calsync",
      "-w",
      "personal-refresh-token",
    ]);
    expect(run).toHaveBeenNthCalledWith(
      2,
      "security",
      expect.arrayContaining(["-a", "work", "work-refresh-token"]),
    );
  });

  it("scopes Keychain accounts by tenant while the default keeps bare roles", async () => {
    const run = vi.fn<CommandRunner>().mockResolvedValue({ stdout: "", stderr: "" });
    const store = new MacOsKeychainTokenStore("test.calsync", run, "darwin", "acme");

    await store.setRefreshToken("personal", "acme-refresh-token");

    expect(run).toHaveBeenCalledWith(
      "security",
      expect.arrayContaining(["-a", "acme_personal", "acme-refresh-token"]),
    );
  });

  it("treats a missing Keychain item as unauthenticated", async () => {
    const error = Object.assign(new Error("missing"), {
      code: 44,
      stderr: "security: SecKeychainSearchCopyNext: The specified item could not be found.",
    });
    const run = vi.fn<CommandRunner>().mockRejectedValue(error);
    const store = new MacOsKeychainTokenStore("test.calsync", run, "darwin");

    await expect(store.getRefreshToken("personal")).resolves.toBeNull();
    await expect(store.deleteRefreshToken("personal")).resolves.toBe(false);
  });

  it("rejects unsupported platforms and empty secrets", async () => {
    expect(() => new MacOsKeychainTokenStore("test.calsync", vi.fn(), "linux")).toThrow(
      KeychainError,
    );

    const store = new MacOsKeychainTokenStore("test.calsync", vi.fn<CommandRunner>(), "darwin");
    await expect(store.setRefreshToken("work", " ")).rejects.toThrow("empty refresh token");
  });
});
