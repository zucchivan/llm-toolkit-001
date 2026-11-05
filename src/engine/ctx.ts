/** Engine contexts: cancellation scopes for driver loops and CLI turns. */
import { BACKGROUND_CONTEXT, withAbortSignal } from "./kit.ts";
import type { Context } from "./kit.ts";

export { BACKGROUND_CONTEXT };
export type { Context };

/** A Context cancelled by an AbortController — CLI SIGINT, timeouts, driver stops. */
export function cancelableContext(signal: AbortSignal): Context {
	return withAbortSignal(signal, BACKGROUND_CONTEXT) as unknown as Context;
}
