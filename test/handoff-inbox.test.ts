/**
 * handoff-inbox (M0-P17): the `handoff` writer's one atomically published note
 * per file (no read-modify-write race), the driver's oldest-(ts,id)-first claim
 * of up to 3,000 chars at each wave boundary bound to the pending wave in one
 * state transaction, unlink-after-commit consume-once semantics (duplicates
 * after a crash are ignored, never lost or redelivered), invalid-note
 * diagnosis, and the one-time legacy pending-handoff.json import.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { mkdir, mkdtemp, readdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishHandoffNote, readHandoffClaim, settleHandoffClaim, discardConsumedHandoffNotes,
	importLegacyHandoff, handoffClaimRows, HANDOFF_NOTE_MAX_CHARS, HandoffNoteTooLongError } from "../src/engine/handoffs.ts";
import { HANDOFF_NOTE_FILE_MAX_BYTES } from "../src/engine/handoffs.ts";
import { projectPaths } from "../src/engine/harness.ts";
import { HandoffDoc } from "../src/engine/infos.ts";
import { readSessionState } from "../src/engine/state.ts";
import { runWaves } from "../src/engine/waves.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { prepareDemoProject, writeConfig, demoConfigToml, gitInit } from "./demo-project.ts";
import { initProject } from "../src/init.ts";
import { atomicWriteJson } from "../src/util/fsx.ts";

const implWrites = (writes: { path: string; content: string }[]) =>
	writes.map((w) => fauxAssistantMessage([fauxToolCall("write", w)], { stopReason: "toolUse" }))
		.concat([fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" })]);
const gateApprove = (gateId: string, notes = "diff satisfies the criterion") =>
	fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: gateId }] }], notes }), { stopReason: "stop" });
const skepticApprove = (gateId: string) => gateApprove(gateId, "adversarial pass: no refutation found");

async function newProject(): Promise<string> {
	const root = await mkdtempRoot();
	await mkdir(join(root, ".orch"), { recursive: true });
	await mkdir(join(root, "evals"), { recursive: true });
	await writeConfig(root, demoConfigToml());
	await writeFile(join(root, "evals", "recipes.toml"), "", "utf8");
	await initProject(root);
	await gitInit(root);
	return root;
}
async function mkdtempRoot(): Promise<string> {
	const { mkdtemp } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	return mkdtemp(join(tmpdir(), "kit-handoff-"));
}

describe("handoff inbox: publish + claim mechanics", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("publishes ONE unique atomically written file per note and refuses over-long notes", async () => {
		const root = await newProject();
		const paths = projectPaths(root);
		const id1 = await publishHandoffNote(paths, "first");
		const id2 = await publishHandoffNote(paths, "second");
		expect(id1).not.toBe(id2);
		const files = (await readdir(paths.handoffInbox)).sort();
		expect(files).toEqual([`${id1}.json`, `${id2}.json`].sort());
		const note = JSON.parse(await readFile(join(paths.handoffInbox, `${id1}.json`), "utf8")) as { id: string; ts: number; note: string };
		expect(note).toMatchObject({ id: id1, note: "first" });
		expect(Number.isFinite(note.ts)).toBe(true);
		// the legacy side-car is never written by the new writer
		expect(existsSync(paths.pendingHandoff)).toBe(false);
		// over-long notes are refused, not truncated
		await expect(publishHandoffNote(paths, "x".repeat(HANDOFF_NOTE_MAX_CHARS + 1))).rejects.toBeInstanceOf(HandoffNoteTooLongError);
		expect((await readdir(paths.handoffInbox)).length).toBe(2);
	});

	it("claims oldest (ts,id) notes within the 3,000-char budget and leaves excess queued", async () => {
		const root = await newProject();
		const paths = projectPaths(root);
		// two notes of 1,600 chars each overflow the 3,000-char claim budget together
		const big1 = await publishHandoffNote(paths, "a".repeat(1600));
		// Ordering is (ts,id): two notes written inside the same millisecond tie on
		// ts and fall back to the (random) id, so give the second note a later ts.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const big2 = await publishHandoffNote(paths, "b".repeat(1600));
		let claim = await readHandoffClaim(paths);
		expect(claim.taken.map((n) => n.id)).toEqual([big1]);
		expect(claim.queued).toBe(1);
		expect(claim.invalid).toEqual([]);
		// two 1,500-char notes both fit the budget
		await rm(join(paths.handoffInbox, `${big1}.json`), { force: true });
		await rm(join(paths.handoffInbox, `${big2}.json`), { force: true });
		const mid1 = await publishHandoffNote(paths, "c".repeat(1500));
		const mid2 = await publishHandoffNote(paths, "d".repeat(1500));
		claim = await readHandoffClaim(paths);
		expect(claim.taken.map((n) => n.id).sort()).toEqual([mid1, mid2].sort());
		expect(claim.queued).toBe(0);
	});

	it("orders by (ts,id), excludes already-consumed ids as duplicates, and never redelivers them", async () => {
		const root = await newProject();
		const paths = projectPaths(root);
		const noteA = { id: "aaaaaaaa-1111-2222-3333-444444444444", ts: 200, note: "later ts" };
		const noteB = { id: "bbbbbbbb-1111-2222-3333-444444444444", ts: 100, note: "earlier ts" };
		await atomicWriteJson(join(paths.handoffInbox, `${noteA.id}.json`), noteA);
		await atomicWriteJson(join(paths.handoffInbox, `${noteB.id}.json`), noteB);
		// notes arriving after the current wave's claim: the next claim excludes
		// the consumed ids (they apply to a later wave, never redelivered)
		let claim = await readHandoffClaim(paths, { excludeIds: [noteB.id] });
		expect(claim.taken.map((n) => n.id)).toEqual([noteA.id]);
		expect(claim.duplicates.map((n) => n.id)).toEqual([noteB.id]);
		claim = await readHandoffClaim(paths, { excludeIds: [noteA.id, noteB.id] });
		expect(claim.taken).toEqual([]);
		expect(claim.duplicates.map((n) => n.id).sort()).toEqual([noteA.id, noteB.id].sort());
		// settling unlinks duplicates: the note was consumed once, its text is durable
		await settleHandoffClaim(paths, claim);
		expect(await readdir(paths.handoffInbox)).toEqual([]);
	});

	it("diagnoses invalid notes (bad JSON, missing/mismatched id, oversized) and settles them aside", async () => {
		const root = await newProject();
		const paths = projectPaths(root);
		await mkdir(paths.handoffInbox, { recursive: true });
		await writeFile(join(paths.handoffInbox, "broken.json"), "{not json", "utf8");
		await atomicWriteJson(join(paths.handoffInbox, "noid.json"), { ts: 1, note: "x" });
		await atomicWriteJson(join(paths.handoffInbox, "mismatch.json"), { id: "other", ts: 1, note: "x" });
		await atomicWriteJson(join(paths.handoffInbox, "big.json"), { id: "big", ts: 1, note: "x".repeat(HANDOFF_NOTE_MAX_CHARS + 1) });
		const good = await publishHandoffNote(paths, "valid note");
		const claim = await readHandoffClaim(paths);
		expect(claim.taken.map((n) => n.id)).toEqual([good]);
		expect(claim.invalid.map((i) => i.file).sort()).toEqual(["big.json", "broken.json", "mismatch.json", "noid.json"]);
		// rows carry one ingestion + one diagnosis row each, plus the queued marker
		const rows = handoffClaimRows(claim, 1);
		expect(rows.filter((r) => r.verb === "handoff-ingested")).toHaveLength(1);
		expect(rows.filter((r) => r.verb === "handoff-invalid")).toHaveLength(4);
		await settleHandoffClaim(paths, claim);
		// invalid notes are quarantined under .orch/handoffs/invalid/, not dropped
		expect(await readdir(paths.handoffInbox)).toEqual([]);
		expect((await readdir(paths.handoffInvalid)).sort()).toEqual(["big.json", "broken.json", "mismatch.json", "noid.json"].sort());
	});

	it("unlinks exactly the bound note files on resume cleanup (duplicates after a crash)", async () => {
		const root = await newProject();
		const paths = projectPaths(root);
		const id1 = await publishHandoffNote(paths, "bound");
		const id2 = await publishHandoffNote(paths, "unbound");
		await discardConsumedHandoffNotes(paths, [id1]);
		expect(existsSync(join(paths.handoffInbox, `${id1}.json`))).toBe(false);
		expect(existsSync(join(paths.handoffInbox, `${id2}.json`))).toBe(true);
	});
});

describe("handoff inbox: driver claims at wave boundaries", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("claims queued notes at wave 1 and binds consumed ids + text to the pending wave in one transaction", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await mkdir(join(project.root, "bin"), { recursive: true });
		await writeFile(join(project.root, "eval-gate.cjs"), "process.exit(0);\n", "utf8");
		await writeFile(join(project.root, "evals", "recipes.toml"), "[never-fails]\ncmd = \"node eval-gate.cjs\"\n", "utf8");
		await initProject(project.root);
		await gitInit(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "one", spec: "write src/one.ts", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			gateApprove("never-fails", "executed gate proves the criterion"),
			skepticApprove("never-fails"),
		]);

		const kit = await (await import("../src/engine/harness.ts")).openProjectHarness(project.root, "test", { modelsOverride: models });
		const paths = kit.loop.paths;
		const id1 = await publishHandoffNote(paths, "keep tree clean");
		const id2 = await publishHandoffNote(paths, "also watch the gate output");
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		const planOutcome = await runPlan(kit, "docs/prd.md", await loadPrd(kit));

		const summary = await runWaves(kit, { approve: { planRevision: planOutcome.planRevision }, tasksFilter: [] });
		expect(summary.exit).toBe("plan-complete");

		const state = await readSessionState(kit.loop.harness);
		const ingested = state.rows.filter((r) => r.kind === "handoff" && r.verb === "handoff-ingested");
		expect(ingested.map((r) => r.detail).join("\n")).toContain("keep tree clean");
		expect(ingested.map((r) => r.detail).join("\n")).toContain("also watch the gate output");
		expect(ingested.every((r) => r.wave === 1)).toBe(true);
		// the binding committed with the wave-start transaction: ids AND text
		const handoffs = await kit.loop.harness.snapshot(HandoffDoc, BACKGROUND_CONTEXT);
		expect(handoffs?.bindings).toHaveLength(1);
		expect(handoffs?.bindings[0]).toMatchObject({ planRevision: planOutcome.planRevision, taskId: "t1", wave: 1 });
		expect(handoffs?.bindings[0]?.noteIds.sort()).toEqual([id1, id2].sort());
		expect(handoffs?.bindings[0]?.notes.join(" | ")).toContain("keep tree clean");
		expect(handoffs?.consumedIds.sort()).toEqual([id1, id2].sort());
		await kit.loop.close();
		kit.lock.release();
		// consume-once: every note file is unlinked after the binding commit
		expect(await readdir(join(project.root, ".orch", "handoffs", "inbox"))).toEqual([]);
	});

	it("a claim-budget overflow stays queued and the NEXT wave claims it once (bounded take)", async () => {
		const project = await prepareDemoProject();
		await writeConfig(project.root, demoConfigToml());
		await mkdir(join(project.root, "bin"), { recursive: true });
		await writeFile(join(project.root, "eval-gate.cjs"), `const fs = require("node:fs");\nprocess.exit(fs.existsSync("src/marker.txt") ? 0 : 1);\n`, "utf8");
		await writeFile(join(project.root, "evals", "recipes.toml"), "[marker]\ncmd = \"node eval-gate.cjs\"\n", "utf8");
		await initProject(project.root);
		await gitInit(project.root);

		const { models, faux } = buildFauxModels([]);
		faux.setResponses([
			fauxAssistantMessage(JSON.stringify({ tasks: [{ id: "t1", title: "two waves", spec: "write src/one.ts, then src/marker.txt on the retry", dependsOn: [], acceptance: ["crit"], targetPaths: ["src/"], priority: 1 }] }), { stopReason: "stop" }),
			// wave 1: writes only one.ts → the marker gate fails → retry
			...implWrites([{ path: "src/one.ts", content: "export const one = 1;\n" }]),
			// wave 2: the repair
			...implWrites([{ path: "src/marker.txt", content: "go\n" }]),
			gateApprove("marker", "wave 2 executed the marker gate"),
			skepticApprove("marker"),
		]);

		const kit = await (await import("../src/engine/harness.ts")).openProjectHarness(project.root, "test", { modelsOverride: models });
		const paths = kit.loop.paths;
		const noteA = await publishHandoffNote(paths, "a".repeat(1600));
		// Fixture determinism (M1-P01 step g): the claim orders by (ts,id), so
		// two notes published in the same millisecond are ordered by random id.
		// Give the "oldest" note a distinct timestamp so the intent — wave 1 takes
		// the OLDEST note, wave 2 the overflow — is what the assertions test.
		await new Promise((resolve) => setTimeout(resolve, 5));
		const noteB = await publishHandoffNote(paths, "b".repeat(1600));
		const { loadPrd, runPlan } = await import("../src/engine/planner.ts");
		const planOutcome = await runPlan(kit, "docs/prd.md", await loadPrd(kit));

		const summary = await runWaves(kit, { approve: { planRevision: planOutcome.planRevision }, tasksFilter: [] });
		expect(summary.exit).toBe("plan-complete");
		expect(summary.complete).toBe(true);

		const state = await readSessionState(kit.loop.harness);
		const task = state.router.tasks.find((t) => t.id === "t1");
		expect(task?.waveCount).toBe(2);
		const ingested = state.rows.filter((r) => r.kind === "handoff" && r.verb === "handoff-ingested");
		// wave 1 took exactly the oldest note; wave 2 received the overflow once
		expect(ingested.filter((r) => r.wave === 1).map((r) => r.detail)).toEqual(["a".repeat(1600)]);
		expect(ingested.filter((r) => r.wave === 2).map((r) => r.detail)).toEqual(["b".repeat(1600)]);
		expect(state.rows.some((r) => r.kind === "handoff" && r.verb === "handoff-queued" && r.wave === 1)).toBe(true);
		const handoffs = await kit.loop.harness.snapshot(HandoffDoc, BACKGROUND_CONTEXT);
		expect(handoffs?.bindings.map((b) => [b.wave, b.noteIds])).toEqual([[1, [noteA]], [2, [noteB]]]);
		expect(handoffs?.consumedIds).toHaveLength(2);
		await kit.loop.close();
		kit.lock.release();
		expect(await readdir(join(project.root, ".orch", "handoffs", "inbox"))).toEqual([]);
	});
});

describe("handoff inbox: host-read refusals (M1-P01 step g)", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("a symlinked note (or a symlinked inbox) refuses the claim instead of importing outside bytes", async () => {
		const root = await newProject();
		const paths = projectPaths(root);
		await mkdir(paths.handoffInbox, { recursive: true });
		const outside = await mkdtemp(join(tmpdir(), "kit-handoff-outside-"));
		try {
			const secret = join(outside, "secret.json");
			await writeFile(secret, JSON.stringify({ id: "attacker", ts: 1, note: "OUTSIDE NOTE BYTES" }), "utf8");
			await symlink(secret, join(paths.handoffInbox, "attacker.json"));

			const error = await readHandoffClaim(paths).catch((err: unknown) => err);
			expect(error).toMatchObject({ name: "SafeReadRefusalError", code: "symlink" });
			expect(JSON.stringify((error as Error).message)).not.toContain("OUTSIDE NOTE BYTES");
			// Forbidden effect: no note was selected/bound at all.
			expect(error).not.toHaveProperty("taken");

			// The inbox DIRECTORY itself as a link refuses too (ancestor escape).
			const linkRoot = await newProject();
			const linkPaths = projectPaths(linkRoot);
			await rm(linkPaths.handoffInbox, { recursive: true, force: true });
			await mkdir(join(linkRoot, ".orch", "handoffs"), { recursive: true });
			await writeFile(join(outside, "note.json"), JSON.stringify({ id: "n", ts: 1, note: "OUTSIDE NOTE BYTES" }), "utf8");
			await symlink(outside, linkPaths.handoffInbox);
			const ancestor = await readHandoffClaim(linkPaths).catch((err: unknown) => err);
			expect(ancestor).toMatchObject({ name: "SafeReadRefusalError", code: "symlink" });
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
	});

	it("an unreadable or over-cap note is a refusal, not a diagnosed import", async () => {
		if (typeof process.getuid === "function" && process.getuid() !== 0) {
			const root = await newProject();
			const paths = projectPaths(root);
			await mkdir(paths.handoffInbox, { recursive: true });
			const locked = join(paths.handoffInbox, "locked.json");
			await writeFile(locked, JSON.stringify({ id: "locked", ts: 1, note: "n" }), "utf8");
			const { chmod } = await import("node:fs/promises");
			await chmod(locked, 0o000);
			const error = await readHandoffClaim(paths).catch((err: unknown) => err);
			expect(error).toMatchObject({ name: "SafeReadRefusalError", code: "unreadable" });
		}

		// A note FILE past the per-file cap is refused (the claim is never truncated).
		const capRoot = await newProject();
		const capPaths = projectPaths(capRoot);
		await mkdir(capPaths.handoffInbox, { recursive: true });
		await writeFile(
			join(capPaths.handoffInbox, "huge.json"),
			JSON.stringify({ id: "huge", ts: 1, note: "x".repeat(HANDOFF_NOTE_FILE_MAX_BYTES) }),
			"utf8",
		);
		const capped = await readHandoffClaim(capPaths).catch((err: unknown) => err);
		expect(capped).toMatchObject({ name: "SafeReadRefusalError", code: "too-large" });
	});

	it("a symlinked pending-handoff.json refuses the import: no inbox note, no import receipt", async () => {
		const root = await newProject();
		const { openProjectHarness } = await import("../src/engine/harness.ts");
		const kit = await openProjectHarness(root, "test", { modelsOverride: buildFauxModels([]).models });
		const paths = kit.loop.paths;
		const outside = await mkdtemp(join(tmpdir(), "kit-handoff-outside-"));
		try {
			const secret = join(outside, "pending.json");
			await writeFile(secret, JSON.stringify({ ts: 1, notes: ["OUTSIDE LEGACY NOTE"] }), "utf8");
			await symlink(secret, paths.pendingHandoff);

			const error = await importLegacyHandoff(kit).catch((err: unknown) => err);
			expect(error).toMatchObject({ name: "SafeReadRefusalError", code: "symlink" });
			expect(JSON.stringify((error as Error).message)).not.toContain("OUTSIDE LEGACY NOTE");

			// Forbidden effects: nothing imported, the hash never recorded, the link untouched.
			expect(existsSync(paths.handoffInbox) ? await readdir(paths.handoffInbox) : []).toEqual([]);
			expect((await readSessionState(kit.loop.harness)).runStatus.handoffImportedSha256 ?? []).toEqual([]);
			expect(existsSync(paths.pendingHandoff)).toBe(true);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}
		await kit.loop.close();
		kit.lock.release();
	});
});

describe("legacy pending-handoff.json import (once, under the owner lock)", () => {
	beforeEach(() => {
		process.env["NO_COLOR"] = "1";
	});

	it("imports each note once with content-hash ids, records the hash, and unlinks the side-car", async () => {
		const root = await newProject();
		const { openProjectHarness } = await import("../src/engine/harness.ts");
		const kit = await openProjectHarness(root, "test", { modelsOverride: buildFauxModels([]).models });
		const paths = kit.loop.paths;
		await atomicWriteJson(paths.pendingHandoff, { ts: 1_700_000_000_000, notes: ["first legacy", "second legacy"] });

		await importLegacyHandoff(kit);
		const inbox = (await readdir(paths.handoffInbox)).sort();
		expect(inbox).toHaveLength(2);
		expect(inbox.every((f) => f.startsWith("legacy-") && f.endsWith(".json"))).toBe(true);
		const first = JSON.parse(await readFile(join(paths.handoffInbox, inbox[0]!), "utf8")) as { id: string; ts: number; note: string };
		expect(first.note).toBe("first legacy");
		expect(first.ts).toBe(1_700_000_000_000);
		const state = await readSessionState(kit.loop.harness);
		expect(state.runStatus.handoffImportedSha256).toHaveLength(1);
		expect(state.rows.some((r) => r.kind === "handoff" && r.verb === "handoff-imported" && (r.detail ?? "").includes("2 note(s)"))).toBe(true);
		expect(existsSync(paths.pendingHandoff)).toBe(false);

		// a crash that re-created the same side-car does NOT duplicate the import
		await atomicWriteJson(paths.pendingHandoff, { ts: 1_700_000_000_000, notes: ["first legacy", "second legacy"] });
		await importLegacyHandoff(kit);
		expect((await readdir(paths.handoffInbox)).sort()).toEqual(inbox);
		expect(existsSync(paths.pendingHandoff)).toBe(false);

		// a DIFFERENT later drop (new content) imports as new notes
		await atomicWriteJson(paths.pendingHandoff, { ts: 1_700_000_000_001, notes: ["third legacy"] });
		await importLegacyHandoff(kit);
		expect((await readdir(paths.handoffInbox))).toHaveLength(3);
		expect((await readSessionState(kit.loop.harness)).runStatus.handoffImportedSha256).toHaveLength(2);

		await kit.loop.close();
		kit.lock.release();
	});

	it("truncates over-long legacy notes (cap) and quarantines malformed files (diagnose)", async () => {
		const root = await newProject();
		const { openProjectHarness } = await import("../src/engine/harness.ts");
		const kit = await openProjectHarness(root, "test", { modelsOverride: buildFauxModels([]).models });
		const paths = kit.loop.paths;
		await atomicWriteJson(paths.pendingHandoff, { ts: 1, notes: ["x".repeat(HANDOFF_NOTE_MAX_CHARS + 5)] });
		await importLegacyHandoff(kit);
		const inbox = await readdir(paths.handoffInbox);
		expect(inbox).toHaveLength(1);
		const note = JSON.parse(await readFile(join(paths.handoffInbox, inbox[0]!), "utf8")) as { note: string };
		expect(note.note).toHaveLength(HANDOFF_NOTE_MAX_CHARS);
		expect((await readSessionState(kit.loop.harness)).rows.some((r) => (r.detail ?? "").includes("truncated"))).toBe(true);
		expect(existsSync(paths.pendingHandoff)).toBe(false);

		// malformed: diagnosed and moved aside, the hash still records the once
		await writeFile(paths.pendingHandoff, "not json at all", "utf8");
		await importLegacyHandoff(kit);
		expect(existsSync(paths.pendingHandoff)).toBe(false);
		expect((await readdir(paths.handoffInvalid)).some((f) => f.startsWith("pending-handoff-"))).toBe(true);
		expect((await readSessionState(kit.loop.harness)).rows.some((r) => r.verb === "handoff-import-invalid")).toBe(true);

		await kit.loop.close();
		kit.lock.release();
	});
});
