import type { UserId } from '@jooevents/kernel';

interface Delivery {
  readonly secret: string;
  readonly ownerUserId: UserId;
  readonly expiresAtMs: number;
}

/**
 * Process-local, single-use secret delivery. A restart before consumption makes
 * the plaintext unavailable; the durable key can then be rotated from Settings.
 */
export class ApiKeySecretDeliveryVault {
  readonly #deliveries = new Map<string, Delivery>();

  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly ttlMs = 5 * 60_000
  ) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 15 * 60_000) {
      throw new TypeError('api_key_secret_delivery_ttl_invalid');
    }
  }

  deposit(input: { readonly handle: string; readonly secret: string; readonly ownerUserId: UserId }): void {
    this.#purge();
    if (this.#deliveries.has(input.handle)) throw new TypeError('api_key_secret_delivery_duplicate');
    this.#deliveries.set(input.handle, {
      secret: input.secret,
      ownerUserId: input.ownerUserId,
      expiresAtMs: this.now() + this.ttlMs
    });
  }

  consume(handle: string, ownerUserId: UserId): string | undefined {
    this.#purge();
    const delivery = this.#deliveries.get(handle);
    if (!delivery || delivery.ownerUserId !== ownerUserId) return undefined;
    this.#deliveries.delete(handle);
    return delivery.secret;
  }

  #purge(): void {
    const now = this.now();
    for (const [handle, delivery] of this.#deliveries) {
      if (delivery.expiresAtMs <= now) this.#deliveries.delete(handle);
    }
  }
}
