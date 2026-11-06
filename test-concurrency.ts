
import { SlidingWindowRateLimiter } from "./rate-limiter.js";

const limiter = new SlidingWindowRateLimiter(
  "./test-concurrency.sqlite",
  50_000
);

const tenant = "concurrent-tenant-" + Date.now();
const now = Date.now();

async function sendRequest(requestNumber: number) {
  await Promise.resolve();

  const result = limiter.reserve(
    tenant,
    10_000,
    now
  );

  return {
    requestNumber,
    allowed: result.allowed
  };
}

async function main() {
  const requests = Array.from(
    { length: 10 },
    (_, index) => sendRequest(index + 1)
  );

  const results = await Promise.all(requests);

  for (const result of results) {
    console.log(
      `Request ${result.requestNumber}: ${
        result.allowed ? "ALLOWED" : "BLOCKED"
      }`
    );
  }

  const allowed = results.filter(
    result => result.allowed
  ).length;

  const blocked = results.length - allowed;

  console.log("\nAllowed:", allowed);
  console.log("Blocked:", blocked);
  console.log(
    "Total tokens reserved:",
    limiter.getUsage(tenant, now)
  );

  console.log(
    "Result:",
    allowed === 5 && blocked === 5
      ? "PASS"
      : "FAIL"
  );

  limiter.close();
}

main().catch(console.error);

