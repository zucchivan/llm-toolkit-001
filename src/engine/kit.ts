/**
 * kit.ts — the pinned SDK seam. EVERY `@earendil-works/pi-durable` /
 * `@earendil-works/pi-ai` reference in the kit — value imports, type-only
 * imports, subpaths, faux helpers, and installed-version metadata queries —
 * funnels through this module. No other src/test/ui file may reference those
 * two packages at all; the boundary is enforced mechanically by
 * test/kit-seam.test.ts (a TypeScript AST scan, including literal
 * `require("…")` and dynamic `import("…")`, not a grep).
 *
 * (`@earendil-works/chord` context primitives stay beside the seam: they are
 * the harness's public context types, not the pinned durable/AI surface.)
 */
import { createRequire } from "node:module";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { Context, Draft, JsonValue } from "@earendil-works/chord";
import {
	AssistantEntry,
	CompactionEntry,
	GenerationTask,
	Harness,
	LiveDoc,
	ResetEntry,
	ToolResultEntry,
	ToolTask,
	UsageDoc,
	UserEntry,
	createRegistry,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	defineTool,
	hook,
	runEndTask,
	section,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { createReadTool, createWriteTool, createEditTool, createBashTool, CodingTools, createCodingTools } from "@earendil-works/pi-durable/tools";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type {
	Conversation,
	ConversationDocToken,
	EntryId,
	ConversationId,
	JsonObject,
	SubmissionId,
	Extension,
	Session,
	SessionDocToken,
	ToolRegistration,
	Task,
	SetTimer,
	ConversationRecord,
	EntryRecord,
	Cursor,
	Page,
} from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Models, Provider, Usage } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { FauxProviderHandle, FauxResponseStep } from "@earendil-works/pi-ai/providers/faux";

export {
	AssistantEntry,
	CompactionEntry,
	GenerationTask,
	LiveDoc,
	ResetEntry,
	ToolResultEntry,
	ToolTask,
	UsageDoc,
	UserEntry,
	Harness,
	createRegistry,
	defineDoc,
	defineEntry,
	defineExtension,
	defineTask,
	defineTool,
	hook,
	runEndTask,
	section,
	openNodeSqliteStorage,
	NodeExecutionEnv,
	MemoryStorage,
	CodingTools,
	createCodingTools,
	createReadTool,
	createWriteTool,
	createEditTool,
	createBashTool,
	createModels,
	anthropicProvider,
	openaiProvider,
	openrouterProvider,
	fauxProvider,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
};
export type {
	Task,
	Conversation,
	ConversationDocToken,
	EntryId,
	ConversationId,
	JsonObject,
	SubmissionId,
	Extension,
	Session,
	SessionDocToken,
	ToolRegistration,
	SetTimer,
	ConversationRecord,
	EntryRecord,
	Cursor,
	Page,
	Models,
	Provider,
	Usage,
	AssistantMessage,
	FauxProviderHandle,
	FauxResponseStep,
};
export { BACKGROUND_CONTEXT, withAbortSignal };

/**
 * Installed-version query for the SDK pin. Reading
 * `@earendil-works/pi-durable/package.json` is SDK metadata access, so it
 * lives at the seam — harness.ts asserts the pin, init.ts writes the
 * `.orch/kit-version` provenance marker, and tests read it, all through here.
 */
export function readInstalledPiDurableVersion(): string {
	const require = createRequire(import.meta.url);
	const pkg = require("@earendil-works/pi-durable/package.json") as { version: string };
	return pkg.version;
}

/** Branded numeric ids cross JSON storage as plain numbers; bridge them back in. */
export const convId = (n: number) => n as unknown as ConversationId;
export const entryId = (n: number) => n as unknown as EntryId;
export const subId = (n: number) => n as unknown as SubmissionId;
export const idOfConversation = (c: Conversation | undefined): number => c ? (c.id as unknown as number) : 0;
export type { Context, Draft, JsonValue };
