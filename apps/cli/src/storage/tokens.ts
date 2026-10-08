import { connectionId, grantFromManifest, type Vault } from "@dvd-toy-box/vault";

import { CALSYNC_CAPABILITY } from "../capability.js";
import { tokenSlot, type TokenStore } from "./keychain.js";

export class VaultTokenStore implements TokenStore {
  constructor(
    private readonly vault: Vault,
    private readonly legacy?: TokenStore,
    private readonly scopes: readonly string[] = [],
    private readonly tenantId = "default",
  ) {}

  async getRefreshToken(slot: string): Promise<string | null> {
    const fromVault = await this.vault.getSecretFor(
      CALSYNC_CAPABILITY.id,
      connectionId("google", tokenSlot(slot, this.tenantId)),
    );
    if (fromVault !== null) {
      return fromVault;
    }
    return this.legacy?.getRefreshToken(slot) ?? null;
  }

  async setRefreshToken(account: string, refreshToken: string): Promise<void> {
    const slot = tokenSlot(account, this.tenantId);
    await this.vault.putSecret({
      provider: "google",
      slot,
      kind: "oauth",
      secret: refreshToken,
      scopes: this.scopes,
    });
    // The manifest declares each sign-in slot and cannot enumerate tenants
    // ahead of time, so tenant slots inherit the slot's grant (actions).
    this.vault.putGrant({
      ...grantFromManifest(CALSYNC_CAPABILITY, "google", account),
      connectionId: connectionId("google", slot),
    });
  }

  async deleteRefreshToken(slot: string): Promise<boolean> {
    const vaultDeleted = await this.vault.revoke(
      connectionId("google", tokenSlot(slot, this.tenantId)),
    );
    const legacyDeleted = (await this.legacy?.deleteRefreshToken(slot)) ?? false;
    return vaultDeleted || legacyDeleted;
  }
}
