/** one-off: dump transcripts of the last run's conversations */
import { openProjectHarness } from "../src/engine/harness.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { readFileSync } from "node:fs";

const root = process.argv[2];
const kit = await openProjectHarness(root, "debug-tr");
const inspect = await kit.loop.harness.inspect(BACKGROUND_CONTEXT);
const convIds = new Set<string>();
for (const t of inspect.tasks) if (t.conversationId) convIds.add(String(t.conversationId));
void convIds;
// root conversation + ownerless units — easiest via role conv ids in RunStatusDoc?
const state = await import("../src/engine/state.ts").then((m) => m.readSessionState(kit.loop.harness));
console.log("tasks:", state.router.tasks.map((t) => ({ id: t.id, status: t.status })));
await kit.loop.close();
kit.lock.release();
console.log("skip transcript dump: use sqlite export below");
void readFileSync;
