
import { createServer } from "node:http";

type Mode = "success" | "rate-limit" | "timeout" | "error";

const delay = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

function createMockProvider(
  name: "primary" | "backup",
  port: number
) {
  const server = createServer(async (req, res) => {
    if (
      req.method !== "POST" ||
      req.url !== "/completions"
    ) {
      res.writeHead(404).end("Not found");
      return;
    }

    const mode = (
      name === "primary"
        ? process.env.PRIMARY_MODE ?? "success"
        : process.env.BACKUP_MODE ?? "success"
    ) as Mode;

    // Read request body.
    let body = "";

    for await (const chunk of req) {
      body += chunk.toString();
    }

    if (mode === "rate-limit") {
      res.writeHead(429, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: "Provider rate limit exceeded"
      }));
      return;
    }

    if (mode === "timeout") {
      await delay(3500);
    }

    if (mode === "error") {
      res.writeHead(500, {
        "Content-Type": "application/json"
      });
      res.end(JSON.stringify({
        error: "Internal provider stack trace"
      }));
      return;
    }

    let request: {
      messages?: Array<{ content: string }>;
    };

    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400).end("Invalid JSON");
      return;
    }

    const content =
      `${name} model response: ` +
      (request.messages?.at(-1)?.content ?? "");

    const promptTokens = Math.ceil(body.length / 4);
    const completionTokens = Math.ceil(content.length / 4);

    res.writeHead(200, {
      "Content-Type": "application/json"
    });

    res.end(JSON.stringify({
      id: `${name}-completion`,
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content
        },
        finish_reason: "stop"
      }],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens
      }
    }));
  });

  server.listen(port, "127.0.0.1", () => {
    console.error(
      `${name} mock provider running on port ${port}`
    );
  });
}

createMockProvider("primary", 4001);
createMockProvider("backup", 4002);
