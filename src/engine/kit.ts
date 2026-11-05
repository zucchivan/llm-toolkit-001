/**
 * kit.ts — the durable-API bridge. Every pi-durable / pi-ai import used by the
 * engine funnels through here (brief §3.10: never import pi-durable outside
 * src/engine/, and each engine module calls it only through this seam).
 */
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
import { MemoryStorage as PdMemoryStorage } from "@earendil-works/pi-durable";
import type {
	Conversation,
	ConversationDocToken,
	EntryId,
	ConversationId,
	SubmissionId,
	Extension,
	Session,
	ToolRegistration,
} from "@earendil-works/pi-durable";

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
	PdMemoryStorage,
	CodingTools,
	createCodingTools,
};
export { createReadTool, createWriteTool, createEditTool, createBashTool };
export type {
	Conversation,
	ConversationDocToken,
	EntryId,
	ConversationId,
	SubmissionId,
	Extension,
	Session,
	ToolRegistration,
};
export { BACKGROUND_CONTEXT, withAbortSignal };

/** Branded numeric ids cross JSON storage as plain numbers; bridge them back in. */
export const convId = (n: number) => n as unknown as ConversationId;
export const entryId = (n: number) => n as unknown as EntryId;
export const subId = (n: number) => n as unknown as SubmissionId;
export const idOfConversation = (c: Conversation | undefined): number => c ? (c.id as unknown as number) : 0;
export type { Context, Draft, JsonValue };
