
import { SlidingWindowRateLimiter } from "./rate-limiter.js";

const limiter = new SlidingWindowRateLimiter(
  "./test-token-overage.sqlite",
  50_000
);

const tenant = `overage-test-${Date.now()}`;
const now = Date.now();

// Reserve 1,000 tokens.
const reservation = limiter.reserve(tenant, 1000, now);

if (!reservation.allowed) {
  throw new Error("Initial reservation failed");
}

console.log("Before reconciliation:", limiter.getUsage(tenant, now));

// Provider actually consumed 1,200 tokens.
limiter.reconcile(reservation.reservationId, 1200);

const actualUsage = limiter.getUsage(tenant, now);

console.log("After reconciliation:", actualUsage);
console.log("Expected usage:", 1200);

// Attempt to reserve another 49,000 tokens.
const nextRequest = limiter.reserve(tenant, 49_000, now);

console.log(
  "Next request:",
  nextRequest.allowed ? "ALLOWED" : "BLOCKED"
);

const passed =
  actualUsage === 1200 &&
  !nextRequest.allowed;

console.log("Result:", passed ? "PASS" : "FAIL");

limiter.close();

if (!passed) {
  process.exitCode = 1;
}

