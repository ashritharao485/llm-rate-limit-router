# LLM Gateway — Rate Limiting & Model Fallback Router

A TypeScript-based LLM gateway that implements token-aware rate limiting, automatic model-provider fallback, SQLite persistence, and standardized error handling.

## Features

- Token-aware sliding-window rate limiting of 50,000 tokens per minute per tenant
- On-disk SQLite database with WAL mode
- Atomic token reservations using SQLite transactions
- Automatic eviction of expired token reservations
- Token estimation using js-tiktoken
- Reconciliation using actual provider-reported token usage
- Automatic fallback to a backup model when the primary returns HTTP 429
- Automatic fallback when the primary exceeds a 3,000 ms timeout
- Standardized JSON error responses without exposing upstream stack traces
- Support for concurrent requests and cross-process SQLite access
- Mock LLM providers for local testing

## Technology Stack

- TypeScript
- Node.js
- SQLite (better-sqlite3)
- Zod
- js-tiktoken
- tsx

## Architecture

The gateway processes requests through the following components:

1. **HTTP Gateway:** Accepts completion requests and identifies tenants using API keys.
2. **Request Validation:** Validates incoming requests using Zod.
3. **Token Estimation:** Estimates input tokens using js-tiktoken and adds the maximum output-token budget.
4. **SQLite Rate Limiter:** Atomically reserves tokens and enforces the per-tenant sliding-window limit.
5. **Model Router:** Sends requests to the primary model provider.
6. **Fallback Mechanism:** Automatically routes requests to the backup provider when the primary returns HTTP 429 or exceeds the timeout.
7. **Token Reconciliation:** Updates SQLite reservations using valid provider-reported token usage.
8. **Error Handler:** Returns standardized errors without leaking upstream implementation details.

## Installation

Requirements:

- Node.js
- npm

Install project dependencies:

`npm install`

Validate TypeScript:

`npx tsc --noEmit`

On Windows PowerShell, use `npm.cmd` and `npx.cmd` if script execution is restricted.

## Running the Gateway

Open two terminals.

**Terminal 1 — Start the mock providers**

`npx tsx mock-providers.ts`

This starts:

- Primary provider: http://127.0.0.1:4001
- Backup provider: http://127.0.0.1:4002

**Terminal 2 — Start the gateway**

`npx tsx gateway.ts`

The gateway runs at:

http://127.0.0.1:4000

## API Endpoint

**POST /v1/chat/completions**

Required headers:

- Content-Type: application/json
- x-api-key: your-tenant-key

Example JSON request:

`{"messages":[{"role":"user","content":"Hello LLM"}],"max_tokens":100}`

A successful response contains the model completion and provider-reported token usage.

Response headers include:

- X-Model-Provider: Indicates whether the primary or backup provider handled the request.
- X-RateLimit-Remaining: Indicates the remaining token budget based on SQLite accounting.

## Sliding-Window Rate Limiting

Each tenant is allocated 50,000 tokens within a rolling 60-second window.

Before processing a request, the gateway estimates input tokens and adds the requested output-token budget.

The SQLite rate limiter checks the tenant's current usage and atomically reserves the required tokens.

If the request exceeds the available budget, the gateway returns HTTP 429.

Expired reservations are removed during subsequent reservation attempts.

Successful requests are reconciled using valid provider-reported token usage. Failed completion requests release their reservations.

SQLite WAL mode and immediate transactions help prevent concurrent requests from exceeding the available reservation budget.

## Automatic Model Fallback

The gateway first sends completion requests to the primary model provider.

Fallback occurs when:

- The primary provider returns HTTP 429 Too Many Requests.
- The primary provider exceeds