
import { createServer, type Server } from "node:http";
import { ModelRouter } from "./model-router.js";

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

function startProvider(
  delayMs: number,
  name: string
): Promise<{
  server: Server;
  url: string;
}> {
  return new Promise(resolve => {
    const server = createServer(async (_req, res) => {
      await sleep(delayMs);

      if (res.destroyed) return;

      res.writeHead(200, {
        "Content-Type": "application/json"
      });

      res.end(JSON.stringify({
        id: name,
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: name
          }
        }]
      }));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();

      if (!address || typeof address === "string") {
        throw new Error("Unable to start provider");
      }

      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`
      });
    });
  });
}

async function runTest(
  primaryDelay: number,
  expectedProvider: "primary" | "backup"
) {
  const primary = await startProvider(
    primaryDelay,
    "primary"
  );

  const backup = await startProvider(
    10,
    "backup"
  );

  try {
    const router = new ModelRouter({
      primaryUrl: primary.url,
      backupUrl: backup.url,
      primaryTimeoutMs: 3000,
      backupTimeoutMs: 1000
    });

    const start = performance.now();

    const result = await router.complete({
      messages: [{
        role: "user",
        content: "Test timeout boundary"
      }]
    });

    const elapsed = Math.round(
      performance.now() - start
    );

    const passed = result.provider === expectedProvider;

    console.log(
      `Primary delay: ${primaryDelay}ms | ` +
      `Selected: ${result.provider} | ` +
      `Elapsed: ${elapsed}ms | ` +
      `${passed ? "PASS" : "FAIL"}`
    );

    if (!passed) {
      throw new Error("Unexpected provider selected");
    }
  } finally {
    primary.server.closeAllConnections();
    backup.server.closeAllConnections();

    await Promise.all([
      new Promise<void>(resolve =>
        primary.server.close(() => resolve())
      ),
      new Promise<void>(resolve =>
        backup.server.close(() => resolve())
      )
    ]);
  }
}

async function main() {
  await runTest(100, "primary");
  await runTest(2500, "primary");
  await runTest(3500, "backup");

  console.log("\nAll timeout-boundary tests passed.");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
