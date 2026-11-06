
import { createServer, type ServerResponse } from "node:http";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

import { SlidingWindowRateLimiter } from "./rate-limiter.js";
import {
  ModelRouter,
  GatewayError,
  type CompletionRequest
} from "./model-router.js";

// --------------------------------------------------
// Configuration
// --------------------------------------------------

const PORT = 4000;
const TOKEN_LIMIT = 50_000;

const limiter = new SlidingWindowRateLimiter(
  "./rate-limiter.sqlite",
  TOKEN_LIMIT
);

const router = new ModelRouter({
  primaryUrl: "http://127.0.0.1:4001/completions",
  backupUrl: "http://127.0.0.1:4002/completions",
  primaryTimeoutMs: 3000,
  backupTimeoutMs: 5000
});

// --------------------------------------------------
// Request validation
// --------------------------------------------------

const requestSchema = z.object({
  model: z.string().optional(),

  messages: z.array(
    z.object({
      role: z.enum(["system", "user", "assistant"]),
      content: z.string()
    })
  ).min(1),

  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(16000)
    .optional()
});

// --------------------------------------------------
// Standardized error responses
// --------------------------------------------------

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
  retryAfterMs?: number
): void {
  if (retryAfterMs !== undefined) {
    res.setHeader(
      "Retry-After",
      Math.ceil(retryAfterMs / 1000)
    );
  }

  res.writeHead(status, {
    "Content-Type": "application/json"
  });

  res.end(
    JSON.stringify({
      error: {
        code,
        message
      }
    })
  );
}

// --------------------------------------------------
// Token counting
// --------------------------------------------------

const tokenizer = getEncoding("cl100k_base");

function estimateTokens(text: string): number {
  return tokenizer.encode(text).length;
}

// --------------------------------------------------
// HTTP gateway
// --------------------------------------------------

const server = createServer(async (req, res) => {
  if (
    req.method !== "POST" ||
    req.url !== "/v1/chat/completions"
  ) {
    sendError(
      res,
      404,
      "NOT_FOUND",
      "Endpoint not found"
    );
    return;
  }

  // ------------------------------------------------
  // Tenant identification
  // ------------------------------------------------

  const apiKey = req.headers["x-api-key"];

  if (
    typeof apiKey !== "string" ||
    !apiKey.trim()
  ) {
    sendError(
      res,
      401,
      "UNAUTHORIZED",
      "A tenant API key is required"
    );
    return;
  }

  let rawBody = "";

  try {
    // ----------------------------------------------
    // Read request body
    // ----------------------------------------------

    for await (const chunk of req) {
      rawBody += chunk.toString();

      if (rawBody.length > 1_000_000) {
        sendError(
          res,
          413,
          "PAYLOAD_TOO_LARGE",
          "Request body is too large"
        );
        return;
      }
    }

    // ----------------------------------------------
    // Parse JSON
    // ----------------------------------------------

    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(rawBody);
    } catch {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid JSON request body"
      );
      return;
    }

    // ----------------------------------------------
    // Validate request
    // ----------------------------------------------

    const validation = requestSchema.safeParse(parsedBody);

    if (!validation.success) {
      sendError(
        res,
        400,
        "INVALID_REQUEST",
        "Invalid completion request"
      );
      return;
    }

    const request: CompletionRequest = validation.data;

    // ----------------------------------------------
    // Calculate token reservation
    // ----------------------------------------------

    const inputText = request.messages
      .map(message => message.content)
      .join("\n");

    const inputTokens =
      estimateTokens(inputText) +
      request.messages.length * 4 +
      3;

    const outputBudget = request.max_tokens ?? 1024;

    const reservedTokens = inputTokens + outputBudget;

    // ----------------------------------------------
    // Reject requests exceeding maximum budget
    // ----------------------------------------------

    if (reservedTokens > TOKEN_LIMIT) {
      sendError(
        res,
        429,
        "RATE_LIMIT_EXCEEDED",
        "Requested token budget exceeds tenant limit",
        60_000
      );
      return;
    }

    // ----------------------------------------------
    // Atomic SQLite token reservation
    // ----------------------------------------------

    const reservation = limiter.reserve(
      apiKey,
      reservedTokens
    );

    if (!reservation.allowed) {
      sendError(
        res,
        429,
        "RATE_LIMIT_EXCEEDED",
        "Tenant token rate limit exceeded",
        reservation.retryAfterMs
      );
      return;
    }

    // ----------------------------------------------
    // Route request to primary or backup model
    // ----------------------------------------------

    try {
      const result = await router.complete(request);

      // --------------------------------------------
      // Reconcile actual token usage
      // --------------------------------------------

      const reportedTokens =
        result.response.usage?.total_tokens;

      if (
        reportedTokens !== undefined &&
        Number.isSafeInteger(reportedTokens) &&
        reportedTokens >= 0
      ) {
        if (reportedTokens > reservedTokens) {
          console.error(
            "Provider token usage exceeded reservation",
            {
              reservedTokens,
              reportedTokens
            }
          );
        }

        limiter.reconcile(
          reservation.reservationId,
          reportedTokens
        );
      }

      // If usage is missing or invalid, retain
      // the original reservation.

      // --------------------------------------------
      // Return successful completion
      // --------------------------------------------

      const remainingTokens = Math.max(
        0,
        TOKEN_LIMIT - limiter.getUsage(apiKey)
      );

      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Model-Provider": result.provider,
        "X-RateLimit-Remaining":
          remainingTokens.toString()
      });

      res.end(JSON.stringify(result.response));

    } catch (error) {
      // --------------------------------------------
      // Release reservation on failed completion
      // --------------------------------------------

      limiter.release(reservation.reservationId);

      if (error instanceof GatewayError) {
        sendError(
          res,
          error.status,
          error.code,
          error.publicMessage
        );
      } else {
        sendError(
          res,
          500,
          "INTERNAL_ERROR",
          "An unexpected gateway error occurred"
        );
      }
    }

  } catch {
    // ----------------------------------------------
    // Sanitize unexpected errors
    // ----------------------------------------------

    if (!res.headersSent) {
      sendError(
        res,
        500,
        "INTERNAL_ERROR",
        "An unexpected gateway error occurred"
      );
    }
  }
});

// --------------------------------------------------
// Start gateway
// --------------------------------------------------

server.listen(PORT, "127.0.0.1", () => {
  console.error(
    `LLM gateway listening at http://127.0.0.1:${PORT}`
  );
});
