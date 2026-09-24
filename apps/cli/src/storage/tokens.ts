import { connectionId, grantFromManifest, type Vault } from "@dvd-toy-box/vault";

import type { AccountRole } from "@calsync/engine";

import { CALSYNC_CAPABILITY } from "../capability.js";
import { tokenSlot, type TokenStore } from "./keychain.js";

export class VaultTokenStore implements TokenStore {
  constructor(
    private readonly vault: Vault,
    private readonly legacy?: TokenStore,
    private readonly scopes: readonly string[] = [],
    private readonly tenantId = "default",
  ) {}

  async getRefreshToken(role: AccountRole): Promise<string | null> {
    const fromVault = await this.vault.getSecretFor(
      CALSYNC_CAPABILITY.id,
      connectionId("google", tokenSlot(role, this.tenantId)),
    );
    if (fromVault !== null) {
      return fromVault;
    }
    return this.legacy?.getRefreshToken(role) ?? null;
  }

  async setRefreshToken(role: AccountRole, refreshToken: string): Promise<void> {
    const slot = tokenSlot(role, this.tenantId);
    await this.vault.putSecret({
      provider: "google",
      slot,
      kind: "oauth",
      secret: refreshToken,
      scopes: this.scopes,
    });
    // The manifest declares per-role needs and cannot enumerate tenants ahead
    // of time, so tenant slots inherit the role connection's grant (actions).
    this.vault.putGrant({
      ...grantFromManifest(CALSYNC_CAPABILITY, "google", role),
      connectionId: connectionId("google", slot),
    });
  }

  async deleteRefreshToken(role: AccountRole): Promise<boolean> {
    const vaultDeleted = await this.vault.revoke(
      connectionId("google", tokenSlot(role, this.tenantId)),
    );
    const legacyDeleted = (await this.legacy?.deleteRefreshToken(role)) ?? false;
    return vaultDeleted || legacyDeleted;
  }
}
