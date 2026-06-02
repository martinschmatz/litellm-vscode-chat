import * as vscode from "vscode";

/**
 * Options controlling the transient-failure retry behavior of {@link fetchWithRetry}.
 */
export interface RetryOptions {
	/** Maximum number of *additional* attempts after the first (0 = no retry). */
	maxRetries: number;
	/** Base backoff delay in milliseconds (exponential per attempt, plus jitter). */
	initialDelayMs: number;
	/** Cancellation token; if cancelled, no further retries are scheduled. */
	token: vscode.CancellationToken;
	/** Diagnostic logger. */
	log: (message: string, data?: unknown) => void;
}

const TRANSIENT_CODES = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|UND_ERR/i;

/**
 * Decide whether a thrown error is a *transient connection-level* failure that is
 * safe to retry.
 *
 * Returns `true` only for bare network/socket failures (e.g. `fetch failed`,
 * `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`). Returns `false` for:
 *  - `AbortError` (request timeout or user cancellation), and
 *  - anything that is not an {@link Error}.
 *
 * HTTP responses (4xx/5xx) never reach this function because `fetch` resolves for
 * them — they are handled by the caller and must not be retried here.
 */
export function isTransientFetchError(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	// AbortError = our own AbortSignal.timeout(...) firing, or user cancellation.
	// Neither should be silently retried.
	if (err.name === "AbortError" || err.name === "TimeoutError") {
		return false;
	}
	const cause = (err as { cause?: { code?: string } }).cause;
	const code = cause?.code ?? "";
	const msg = err.message.toLowerCase();
	return msg.includes("fetch failed") || TRANSIENT_CODES.test(code) || TRANSIENT_CODES.test(msg);
}

/**
 * Cancellation-aware sleep. Resolves after `ms`, or immediately if the token is
 * (or becomes) cancelled during the wait.
 */
export function sleep(ms: number, token: vscode.CancellationToken): Promise<void> {
	return new Promise<void>((resolve) => {
		if (token.isCancellationRequested) {
			resolve();
			return;
		}
		const timer = setTimeout(() => {
			disposable.dispose();
			resolve();
		}, ms);
		const disposable = token.onCancellationRequested(() => {
			clearTimeout(timer);
			disposable.dispose();
			resolve();
		});
	});
}

/**
 * `fetch` wrapper that automatically retries *transient connection-level* failures
 * with exponential backoff and jitter.
 *
 * IMPORTANT contracts:
 *  - This only retries when the `fetch` call itself **throws** a transient error
 *    (see {@link isTransientFetchError}). HTTP error *responses* (4xx/5xx) resolve
 *    normally and are returned to the caller untouched — they are NOT retried.
 *  - It must wrap only the request up to the point where the response body is
 *    consumed. Once streaming begins, retrying could duplicate already-emitted
 *    output, so the streaming step stays OUTSIDE this helper.
 *  - Retries stop immediately if the cancellation token is triggered.
 */
export async function fetchWithRetry(
	url: string,
	init: RequestInit,
	{ maxRetries, initialDelayMs, token, log }: RetryOptions
): Promise<Response> {
	let attempt = 0;
	for (;;) {
		try {
			return await fetch(url, init);
		} catch (err) {
			const canRetry = isTransientFetchError(err) && !token.isCancellationRequested && attempt < maxRetries;
			if (!canRetry) {
				throw err;
			}
			const backoff = initialDelayMs * 2 ** attempt;
			const jitter = Math.floor(Math.random() * 250);
			const delay = backoff + jitter;
			log(`Transient fetch failure (attempt ${attempt + 1}/${maxRetries + 1}); retrying in ${delay}ms`, {
				error: err instanceof Error ? err.message : String(err),
			});
			await sleep(delay, token);
			if (token.isCancellationRequested) {
				throw err;
			}
			attempt++;
		}
	}
}
