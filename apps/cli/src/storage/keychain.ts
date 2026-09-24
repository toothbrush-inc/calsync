import { KeychainError, KeychainSecretStore, type CommandRunner } from "@dvd-toy-box/vault";

import type { AccountRole } from "@calsync/engine";

const DEFAULT_SERVICE = "com.local.calsync.oauth";

export interface TokenStore {
  getRefreshToken(role: AccountRole): Promise<string | null>;
  setRefreshToken(role: AccountRole, refreshToken: string): Promise<void>;
  deleteRefreshToken(role: AccountRole): Promise<boolean>;
}

export type { CommandRunner };
export { KeychainError };

/**
 * Storage slot for one account's refresh token. The default tenant keeps the
 * bare role so existing installs retain their credentials; other tenants get
 * "<tenant>_<role>", which is unambiguous because tenant ids cannot contain
 * underscores and must satisfy the vault's slot charset.
 */
export function tokenSlot(role: AccountRole, tenantId = "default"): string {
  return tenantId === "default" ? role : `${tenantId}_${role}`;
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

  async getRefreshToken(role: AccountRole): Promise<string | null> {
    return this.secrets.get(tokenSlot(role, this.tenantId));
  }

  async setRefreshToken(role: AccountRole, refreshToken: string): Promise<void> {
    if (refreshToken.trim() === "") {
      throw new KeychainError("Refusing to store an empty refresh token");
    }
    await this.secrets.set(tokenSlot(role, this.tenantId), refreshToken);
  }

  async deleteRefreshToken(role: AccountRole): Promise<boolean> {
    return this.secrets.delete(tokenSlot(role, this.tenantId));
  }
}
