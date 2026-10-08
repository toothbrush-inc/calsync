import { KeychainError, KeychainSecretStore, type CommandRunner } from "@dvd-toy-box/vault";

const DEFAULT_SERVICE = "com.local.calsync.oauth";

/** Refresh tokens by sign-in slot: "personal", "work", or account1..account6. */
export interface TokenStore {
  getRefreshToken(slot: string): Promise<string | null>;
  setRefreshToken(slot: string, refreshToken: string): Promise<void>;
  deleteRefreshToken(slot: string): Promise<boolean>;
}

export type { CommandRunner };
export { KeychainError };

/**
 * Storage slot for one account's refresh token. The default tenant keeps the
 * bare slot so existing installs retain their credentials; other tenants get
 * "<tenant>_<slot>", which is unambiguous because tenant ids cannot contain
 * underscores and must satisfy the vault's slot charset.
 */
export function tokenSlot(slot: string, tenantId = "default"): string {
  return tenantId === "default" ? slot : `${tenantId}_${slot}`;
}

export class MacOsKeychainTokenStore implements TokenStore {
  private readonly secrets: KeychainSecretStore;

  constructor(
    service = DEFAULT_SERVICE,
    run?: CommandRunner,
    platform: NodeJS.Platform = process.platform,
    private readonly tenantId = "default",
  ) {
    this.secrets = new KeychainSecretStore({
      service,
      platform,
      ...(run === undefined ? {} : { run }),
    });
  }

  async getRefreshToken(slot: string): Promise<string | null> {
    return this.secrets.get(tokenSlot(slot, this.tenantId));
  }

  async setRefreshToken(slot: string, refreshToken: string): Promise<void> {
    if (refreshToken.trim() === "") {
      throw new KeychainError("Refusing to store an empty refresh token");
    }
    await this.secrets.set(tokenSlot(slot, this.tenantId), refreshToken);
  }

  async deleteRefreshToken(slot: string): Promise<boolean> {
    return this.secrets.delete(tokenSlot(slot, this.tenantId));
  }
}
