
import { SlidingWindowRateLimiter } from "./rate-limiter.js";

const limiter = new SlidingWindowRateLimiter(
  "./test-rate-limit.sqlite",
  50_000
);

const tenant = "test-tenant-" + Date.now();
const now = Date.now();

console.log("Testing 50,000 tokens per minute\n");

for (let i = 1; i <= 4; i++) {
  const result = limiter.reserve(
    tenant,
    16_000,
    now
  );

  console.log(
    `Request ${i}: ${result.allowed ? "ALLOWED" : "BLOCKED"}`
  );
}

console.log(
  "\nTokens used:",
  limiter.getUsage(tenant, now)
);

console.log("\nTesting window expiration...");

const afterWindow = now + 60_001;

const result = limiter.reserve(
  tenant,
  16_000,
  afterWindow
);

console.log(
  "After 60 seconds:",
  result.allowed ? "ALLOWED" : "BLOCKED"
);

limiter.close();
