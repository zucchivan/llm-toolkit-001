/** Probe: real pi-durable open → faux conversation round-trip on MemoryStorage. */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, defineExtension, defineDoc, section, AssistantEntry } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

const ProbeDocValue = { version: 1, n: 0 } as const;
const ProbeDoc = defineDoc({
	kind: "probe.doc",
	version: 1,
	scope: "session",
	initial: () => ({ version: 1, n: 0 }),
	checkpointWhen: () => true,
});
void ProbeDocValue;

const faux = fauxProvider({
	models: [{ id: "probe-1", name: "Probe", cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } }],
});
faux.setResponses([
	fauxAssistantMessage("planning reply: {\"tasks\":[{\"id\":\"a\"}]}", { stopReason: "stop" }),
]);

const models = createModels();
models.setProvider(faux.provider);

const registry = createRegistry();
registry.install(defineExtension({ name: "noop", sections: [section("noop", () => "Nothing here.", { tag: false })] }));

const harness = await Harness.open(new MemoryStorage(), { models, registry }, BACKGROUND_CONTEXT);
const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: "faux", modelId: "probe-1" }, maxTurns: 10 } });
await root.commit(async (tx) => {
	const doc = await tx.doc(ProbeDoc);
	doc.n = 42;
}, BACKGROUND_CONTEXT);
const snapped = await harness.snapshot(ProbeDoc, undefined, BACKGROUND_CONTEXT);
console.log("probe doc:", JSON.stringify(snapped));

const submission = await root.submit({ type: "input", content: "say hi", requestId: "probe-1" }, BACKGROUND_CONTEXT);
const settled = await submission.wait(BACKGROUND_CONTEXT);
console.log("settled:", settled.status, settled.type, "reason:", "reason" in settled ? settled.reason : "", "detail:", "detail" in settled ? settled.detail : "");
if (settled.status === "done") {
	const answer = await root.commit(async (tx) => {
		return await tx.entry(AssistantEntry, settled.answer);
	}, BACKGROUND_CONTEXT);
	console.log("answer entry kind:", answer?.kind, "model[0]:", JSON.stringify(answer?.model?.[0]));
}

const again = await root.submit({ type: "input", content: "say hi again", requestId: "probe-1" }, BACKGROUND_CONTEXT);
console.log("idempotent sub id:", again.id === submission.id);

const live = await harness.snapshot(ProbeDoc, root.id, BACKGROUND_CONTEXT).catch(() => undefined);
await harness.close(BACKGROUND_CONTEXT);
console.log("closed ok, snapshot misuse rejected cleanly:", live !== undefined);
