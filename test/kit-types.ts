/**
 * Shared kit-facing re-exports for the tests (engine-encapsulation seam):
 * the ONLY test-side window into the pinned SDK. Tests never import
 * `@earendil-works/pi-durable` / `@earendil-works/pi-ai` directly — not
 * values, not types, not the faux subpath, not package metadata — and never
 * run an SDK `require()`/`import()` themselves (enforced mechanically by
 * test/kit-seam.test.ts).
 */
export type { FauxProviderHandle, FauxResponseStep, Models, Session, SetTimer } from "../src/engine/kit.ts";
export { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, MemoryStorage } from "../src/engine/kit.ts";
export type { LoopAndLock } from "../src/engine/harness.ts";
