
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

const WINDOW_MS = 60_000;
const DEFAULT_LIMIT = 50_000;

export type ReservationResult =
  | {
      allowed: true;
      reservationId: string;
      remainingTokens: number;
    }
  | {
      allowed: false;
      remainingTokens: number;
      retryAfterMs: number;
    };

export class SlidingWindowRateLimiter {
  private db: Database.Database;

  constructor(
    databasePath = "./rate-limiter.sqlite",
    private readonly limit = DEFAULT_LIMIT,
    private readonly windowMs = WINDOW_MS
  ) {
    this.db = new Database(databasePath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_reservations (
        id TEXT PRIMARY KEY,
        tenant_key TEXT NOT NULL,
        tokens INTEGER NOT NULL CHECK(tokens >= 0),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_tenant_time
      ON token_reservations (tenant_key, created_at);
    `);
  }

  reserve(
    tenantKey: string,
    tokens: number,
    now = Date.now()
  ): ReservationResult {
    if (!tenantKey) {
      throw new Error("Tenant key is required");
    }

    if (
      !Number.isSafeInteger(tokens) ||
      tokens <= 0 ||
      tokens > this.limit
    ) {
      throw new Error("Invalid token reservation");
    }

    const transaction = this.db.transaction(() => {
      const cutoff = now - this.windowMs;

      this.db.prepare(`
        DELETE FROM token_reservations
        WHERE created_at <= ?
      `).run(cutoff);

      const used = this.db.prepare(`
        SELECT COALESCE(SUM(tokens), 0) AS used
        FROM token_reservations
        WHERE tenant_key = ?
      `).get(tenantKey) as { used: number };

      const remaining = Math.max(
        0,
        this.limit - used.used
      );

      if (tokens > remaining) {
        const entries = this.db.prepare(`
          SELECT tokens, created_at
          FROM token_reservations
          WHERE tenant_key = ?
          ORDER BY created_at ASC
        `).all(tenantKey) as Array<{
          tokens: number;
          created_at: number;
        }>;

        let reclaimable = 0;
        let retryAfterMs = this.windowMs;

        for (const entry of entries) {
          reclaimable += entry.tokens;

          if (reclaimable >= tokens - remaining) {
            retryAfterMs = Math.max(
              1,
              entry.created_at +
                this.windowMs -
                now
            );
            break;
          }
        }

        return {
          allowed: false as const,
          remainingTokens: remaining,
          retryAfterMs
        };
      }

      const reservationId = randomUUID();

      this.db.prepare(`
        INSERT INTO token_reservations
          (id, tenant_key, tokens, created_at)
        VALUES (?, ?, ?, ?)
      `).run(reservationId, tenantKey, tokens, now);

      return {
        allowed: true as const,
        reservationId,
        remainingTokens: remaining - tokens
      };
    });

    return transaction.immediate();
  }

  release(reservationId: string): void {
    this.db.prepare(`
      DELETE FROM token_reservations
      WHERE id = ?
    `).run(reservationId);
  }
  
reconcile(
  reservationId: string,
  actualTokens: number
): void {
  if (
    !Number.isSafeInteger(actualTokens) ||
    actualTokens < 0
  ) {
    throw new Error("Invalid actual token usage");
  }

  const transaction = this.db.transaction(() => {
    const reservation = this.db.prepare(`
      SELECT tokens
      FROM token_reservations
      WHERE id = ?
    `).get(reservationId) as
      | { tokens: number }
      | undefined;

    if (!reservation) {
      throw new Error("Reservation not found");
    }

    // Never increase a reservation beyond its
    // originally approved token budget.
    const finalTokens = actualTokens;

    this.db.prepare(`
      UPDATE token_reservations
      SET tokens = ?
      WHERE id = ?
    `).run(finalTokens, reservationId);
  });

  transaction.immediate();
}



  getUsage(
    tenantKey: string,
    now = Date.now()
  ): number {
    const cutoff = now - this.windowMs;

    const result = this.db.prepare(`
      SELECT COALESCE(SUM(tokens), 0) AS used
      FROM token_reservations
      WHERE tenant_key = ?
        AND created_at > ?
    `).get(tenantKey, cutoff) as { used: number };

    return result.used;
  }

  close(): void {
    this.db.close();
  }
}
