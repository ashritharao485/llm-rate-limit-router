
import { SlidingWindowRateLimiter } from "./rate-limiter.js";

const limiter = new SlidingWindowRateLimiter(
  "./rate-limiter.sqlite",
  50_000
);


const tenant = "tenant-immediate-test";

console.log("Tenant:", tenant);
console.log("Tokens used:", limiter.getUsage(tenant));
console.log("Token limit:", 50_000);
console.log(
  "Tokens remaining:",
  50_000 - limiter.getUsage(tenant)
);

limiter.close();
