import * as assert from "assert";
import * as vscode from "vscode";
import { isTransientFetchError, sleep, fetchWithRetry } from "../../provider/retry";

const noopLog = () => {};

function fetchFailed(): Error {
	// Mirrors undici's bare connection failure shape.
	const err = new TypeError("fetch failed");
	(err as { cause?: unknown }).cause = { code: "ECONNRESET" };
	return err;
}

function abortError(): Error {
	const err = new Error("The operation was aborted");
	err.name = "AbortError";
	return err;
}

suite("provider/retry", () => {
	suite("isTransientFetchError", () => {
		test("true for bare 'fetch failed'", () => {
			assert.strictEqual(isTransientFetchError(new TypeError("fetch failed")), true);
		});

		test("true for ECONNRESET / ETIMEDOUT / EAI_AGAIN in cause.code", () => {
			for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED"]) {
				const err = new Error("network down");
				(err as { cause?: unknown }).cause = { code };
				assert.strictEqual(isTransientFetchError(err), true, `expected transient for ${code}`);
			}
		});

		test("false for AbortError (timeout or user cancel)", () => {
			assert.strictEqual(isTransientFetchError(abortError()), false);
		});

		test("false for non-Error values", () => {
			assert.strictEqual(isTransientFetchError("fetch failed"), false);
			assert.strictEqual(isTransientFetchError(undefined), false);
			assert.strictEqual(isTransientFetchError(null), false);
		});

		test("false for ordinary errors (e.g. HTTP-error strings)", () => {
			assert.strictEqual(isTransientFetchError(new Error("LiteLLM API error: 400 Bad Request")), false);
		});
	});

	suite("sleep", () => {
		test("resolves after the delay", async () => {
			const cts = new vscode.CancellationTokenSource();
			const start = Date.now();
			await sleep(20, cts.token);
			assert.ok(Date.now() - start >= 15, "should have waited roughly the delay");
			cts.dispose();
		});

		test("resolves immediately if already cancelled", async () => {
			const cts = new vscode.CancellationTokenSource();
			cts.cancel();
			const start = Date.now();
			await sleep(1000, cts.token);
			assert.ok(Date.now() - start < 200, "should not wait when pre-cancelled");
			cts.dispose();
		});
	});

	suite("fetchWithRetry", () => {
		const realFetch = globalThis.fetch;
		teardown(() => {
			globalThis.fetch = realFetch;
		});

		test("retries a transient throw then succeeds", async () => {
			const cts = new vscode.CancellationTokenSource();
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				if (calls === 1) {
					throw fetchFailed();
				}
				return new Response("ok", { status: 200 });
			}) as typeof fetch;

			const res = await fetchWithRetry(
				"http://x",
				{},
				{ maxRetries: 1, initialDelayMs: 1, token: cts.token, log: noopLog }
			);
			assert.strictEqual(calls, 2, "should retry once");
			assert.strictEqual(res.status, 200);
			cts.dispose();
		});

		test("does NOT retry an AbortError", async () => {
			const cts = new vscode.CancellationTokenSource();
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				throw abortError();
			}) as typeof fetch;

			await assert.rejects(
				fetchWithRetry("http://x", {}, { maxRetries: 3, initialDelayMs: 1, token: cts.token, log: noopLog })
			);
			assert.strictEqual(calls, 1, "AbortError must not be retried");
			cts.dispose();
		});

		test("stops after maxRetries and rethrows", async () => {
			const cts = new vscode.CancellationTokenSource();
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				throw fetchFailed();
			}) as typeof fetch;

			await assert.rejects(
				fetchWithRetry("http://x", {}, { maxRetries: 2, initialDelayMs: 1, token: cts.token, log: noopLog })
			);
			assert.strictEqual(calls, 3, "1 initial + 2 retries");
			cts.dispose();
		});

		test("does NOT retry when cancelled", async () => {
			const cts = new vscode.CancellationTokenSource();
			cts.cancel();
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				throw fetchFailed();
			}) as typeof fetch;

			await assert.rejects(
				fetchWithRetry("http://x", {}, { maxRetries: 3, initialDelayMs: 1, token: cts.token, log: noopLog })
			);
			assert.strictEqual(calls, 1, "must not retry once cancelled");
			cts.dispose();
		});

		test("maxRetries=0 disables retry", async () => {
			const cts = new vscode.CancellationTokenSource();
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				throw fetchFailed();
			}) as typeof fetch;

			await assert.rejects(
				fetchWithRetry("http://x", {}, { maxRetries: 0, initialDelayMs: 1, token: cts.token, log: noopLog })
			);
			assert.strictEqual(calls, 1, "no retries when maxRetries is 0");
			cts.dispose();
		});

		test("HTTP error responses are returned (not retried)", async () => {
			const cts = new vscode.CancellationTokenSource();
			let calls = 0;
			globalThis.fetch = (async () => {
				calls++;
				return new Response("bad", { status: 500 });
			}) as typeof fetch;

			const res = await fetchWithRetry(
				"http://x",
				{},
				{ maxRetries: 3, initialDelayMs: 1, token: cts.token, log: noopLog }
			);
			assert.strictEqual(calls, 1, "HTTP errors resolve and must not be retried here");
			assert.strictEqual(res.status, 500);
			cts.dispose();
		});
	});
});
