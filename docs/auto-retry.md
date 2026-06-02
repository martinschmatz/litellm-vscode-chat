# Auto-Retry on Transient `fetch failed`

The provider automatically retries chat requests that fail with a **transient
connection-level error** (e.g. `fetch failed`, `ECONNRESET`, `ETIMEDOUT`,
`EAI_AGAIN`) before surfacing the error to the user.

## Motivation

Connection-level blips to the LiteLLM gateway occasionally cause a bare
`TypeError: fetch failed` from Node's HTTP layer. These are nearly always
transient — re-sending the identical request a moment later succeeds. Previously
the user had to manually click "try again"; now the extension does it once
automatically.

## What is (and isn't) retried

Only the **connection attempt** is retried, and only when `fetch` itself *throws*:

| Outcome | Retried? | Why |
| --- | --- | --- |
| `fetch` throws a connection error (`fetch failed`, `ECONNRESET`, …) | ✅ yes | transient, request never reached the model |
| HTTP error response (4xx / 5xx) | ❌ no | a real server response; retrying repeats the same error |
| Failure **after** streaming started | ❌ no | tokens may already be shown — retrying would duplicate output |
| `AbortError` (request timeout or user cancellation) | ❌ no | intentional stop |

Because retries happen **before** the response body is consumed, the retried
request produces no duplicate output and is safe (chat-completion with the same
body is idempotent on the gateway).

## Backoff

Exponential backoff with jitter: `initialDelayMs * 2^attempt + random(0..250)ms`.
The wait is cancellation-aware — if the user cancels during the delay, no further
attempt is made.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `litellm-vscode-chat.retry.maxRetries` | `1` | additional attempts after the first; `0` disables auto-retry |
| `litellm-vscode-chat.retry.initialDelayMs` | `1000` | base backoff (ms); grows exponentially, plus jitter |

## Implementation

- `src/provider/retry.ts` — `isTransientFetchError`, cancellation-aware `sleep`,
  and `fetchWithRetry` (wraps only the `fetch` call, returns the `Response` for the
  caller to handle HTTP status + streaming).
- `src/provider/client.ts` — reads the two settings and calls `fetchWithRetry`
  instead of `fetch`. The `!response.ok` check and the streaming step remain
  **outside** the retry loop.
- Tests: `src/test/provider/retry.test.ts`.
