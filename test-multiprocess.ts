
import { SlidingWindowRateLimiter } from "./rate-limiter.js";

const limiter = new SlidingWindowRateLimiter(
  "./test-multiprocess.sqlite",
  50_000
);

const tenant = process.argv[2];

if (!tenant) {
  console.error("Tenant argument required");
  process.exit(1);
}

try {
  const result = limiter.reserve(tenant, 10_000);

  console.log(result.allowed ? "ALLOWED" : "BLOCKED");
} finally {
  limiter.close();
}
