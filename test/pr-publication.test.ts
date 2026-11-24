import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acceptCandidate, integrateAcceptedCandidate, publishPullRequest, RecoveryRequiredError, TrustedGitRemoteTransport } from "../src/engine/delivery.ts";
import type { LoopAndLock } from "../src/engine/harness.ts";
import { buildFauxModels, fauxAssistantMessage } from "./fixtures.ts";
import { bakeProject, scripted } from "./fixtures2.ts";
import { demoConfigToml } from "./demo-project.ts";
import { gateReceiptEvent, passReceiptEvent, ReceiptsDoc } from "../src/engine/receipts.ts";
import type { PullRequestHost, RemoteGitTransport, RemotePullRequest, PullRequestIdentity } from "../src/engine/delivery.ts";
import type { WaveKey } from "../src/engine/receipts.ts";
import { commitState, readSessionState } from "../src/engine/state.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { loadPrd, runPlan } from "../src/engine/planner.ts";
import { approveGrant } from "../src/engine/waves.ts";
import { exec } from "../src/util/exec.ts";
import { hashBlob, resolveTree, writeTreeFromChanges } from "../src/util/git-objects.ts";

const roots: string[] = [];
const openKits: LoopAndLock[] = [];
const ORIGIN = "https://github.com/acme/widget.git";
const TASKS = [
	{
		id: "stack-a",
		title: "First stacked change",
		spec: "Publish the first reviewed candidate against the reviewed base.",
		dependsOn: [],
		acceptance: ["When task A is accepted, its PR shall target the reviewed base."],
		targetPaths: ["src/"],
		priority: 1,
	},
	{
		id: "stack-b",
		title: "Second stacked change",
		spec: "Publish the second reviewed candidate on top of task A.",
		dependsOn: ["stack-a"],
		acceptance: ["When task B is accepted, its PR shall target task A's branch."],
		targetPaths: ["src/"],
		priority: 2,
	},
];

async function run(argv: string[], cwd: string): Promise<string> {
	const result = await exec(argv, { cwd, timeoutMs: 20_000 });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `${argv.join(" ")} failed`);
	return result.stdout.trim();
}

class BareRemote implements RemoteGitTransport {
	pushCalls = 0;
	readCalls = 0;
	loseAfterCreate = false;
	constructor(readonly origin: string, readonly bare: string, private readonly cwd: string) {}

	private checkOrigin(origin: string): void {
		if (origin !== this.origin) throw new Error(`unexpected/unapproved transport destination ${origin}`);
	}

	async readRemoteRef(origin: string, ref: string): Promise<string | undefined> {
		this.checkOrigin(origin);
		this.readCalls += 1;
		const result = await exec(["git", "--git-dir", this.bare, "for-each-ref", "--format=%(refname)%00%(objectname)", ref], { cwd: this.cwd, timeoutMs: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr || "bare remote query failed");
		const row = result.stdout.trim();
		if (!row) return undefined;
		const [name, oid] = row.split("\0");
		if (name !== ref || !oid) throw new Error(`unexpected bare remote ref row for ${ref}`);
		return oid;
	}

	async createRemoteRef(origin: string, ref: string, oid: string): Promise<void> {
		this.checkOrigin(origin);
		this.pushCalls += 1;
		// Exercise Git's empty-expected-value lease against the local bare remote.
		const result = await exec(["git", "-c", "core.hooksPath=/dev/null", "push", "--porcelain", `--force-with-lease=${ref}:`, this.bare, `${oid}:${ref}`], {
			cwd: this.cwd, timeoutMs: 20_000,
		});
		if (result.code !== 0) throw new Error(result.stderr || "bare create-only push failed");
		if (this.loseAfterCreate) {
			this.loseAfterCreate = false;
			throw new Error("simulated lost push response after remote ref creation");
		}
	}

	async seed(ref: string, oid: string, expectedOld: string | null = null): Promise<void> {
		const objectRef = `refs/heads/fixture-objects/${oid}`;
		await run(["git", "push", this.bare, `${oid}:${objectRef}`], this.cwd);
		const expected = expectedOld ?? "0".repeat(oid.length);
		await run(["git", "--git-dir", this.bare, "update-ref", ref, oid, expected], this.cwd);
	}

	async remove(ref: string): Promise<void> {
		await run(["git", "--git-dir", this.bare, "update-ref", "-d", ref], this.cwd);
	}
}

class FakePullRequestHost implements PullRequestHost {
	readonly records: RemotePullRequest[] = [];
	createCalls = 0;
	/** Simulates a successful create whose reply and first lookup are lost/delayed. */
	loseFirstCreateReply = false;
	private hiddenReads = 0;

	async findForHead(identity: PullRequestIdentity): Promise<RemotePullRequest[]> {
		if (this.hiddenReads > 0) {
			this.hiddenReads -= 1;
			return [];
		}
		return this.records.filter((record) => record.repository === identity.repository && record.headRef === identity.headRef);
	}

	async create(identity: PullRequestIdentity & { title: string; body: string }): Promise<void> {
		this.createCalls += 1;
		this.records.push({
			repository: identity.repository,
			number: this.createCalls,
			url: `https://github.com/${identity.repository}/pull/${this.createCalls}`,
			baseRef: identity.baseRef,
			baseOid: identity.baseOid,
			headRef: identity.headRef,
			headOid: identity.headOid,
			state: "open",
		});
		if (this.loseFirstCreateReply) {
			this.loseFirstCreateReply = false;
			this.hiddenReads = 1;
			throw new Error("simulated lost gh response after server created the PR");
		}
	}
}

async function fixture(options: { deliveryMode?: "pr" | "none" } = {}): Promise<{
	root: string;
	bare: string;
	profilePath: string;
	baseCommit: string;
	baseBranch: string;
	kit: LoopAndLock;
	waves: WaveKey[];
	remote: BareRemote;
	host: FakePullRequestHost;
}> {
	const toml = demoConfigToml().replace('mode = "none"', `mode = "${options.deliveryMode ?? "pr"}"`);
	const baked = await bakeProject({ buildFauxModels, configToml: toml });
	roots.push(baked.project.root);
	openKits.push(baked.kit);
	const bare = await mkdtemp(join(tmpdir(), "kit-pr-remote-"));
	roots.push(bare);
	await run(["git", "init", "--bare", bare], baked.project.root);
	const baseCommit = (await exec(["git", "rev-parse", "HEAD"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();
	const baseBranch = (await exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();
	const baseRef = `refs/heads/${baseBranch}`;
	await run(["git", "push", bare, `${baseCommit}:${baseRef}`], baked.project.root);

	const profileDir = await mkdtemp(join(tmpdir(), "kit-pr-profile-"));
	roots.push(profileDir);
	const profilePath = join(profileDir, "host-v1.json");
	await writeFile(profilePath, JSON.stringify({
		version: 1,
		projects: [{ root: await realpath(baked.project.root), deliveryOrigin: ORIGIN }],
		toolchains: {},
	}), "utf8");
	await chmod(profilePath, 0o600);

	await scripted(baked.kit, [fauxAssistantMessage(JSON.stringify({ tasks: TASKS }), { stopReason: "stop" })], baked.models.faux);
	const plan = await runPlan(baked.kit, "docs/prd.md", await loadPrd(baked.kit));
	await approveGrant(baked.kit, { planRevision: plan.planRevision });
	const remote = new BareRemote(ORIGIN, bare, baked.project.root);
	return {
		root: baked.project.root, bare, profilePath, baseCommit, baseBranch, kit: baked.kit,
		waves: TASKS.map((task) => ({ planRevision: plan.planRevision, taskId: task.id, wave: 1 })),
		remote, host: new FakePullRequestHost(),
	};
}

async function acceptAndIntegrate(kit: LoopAndLock, wave: WaveKey, parent: string, candidateTree?: string): Promise<string> {
	const tree = candidateTree ?? await resolveTree(kit.loop.paths.root, parent);
	const gate = gateReceiptEvent(wave, {
		tree,
		checks: [
			{ id: "scope", kind: "scope", outcome: "pass", exit: null, ms: 0 },
			{ id: "stack-check", kind: "recipe", outcome: "pass", exit: 0, ms: 1 },
		],
	});
	const primary = passReceiptEvent(wave, {
		tree, gateId: gate.value.id, policy: "always",
		review: { pass: "primary", verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "stack-check" }] }], notes: "checked candidate" },
	});
	const skeptic = passReceiptEvent(wave, {
		tree, gateId: gate.value.id, policy: "always",
		review: { pass: "skeptic", verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "gate", id: "stack-check" }] }], notes: "independent check" },
	});
	await commitState(kit, { receipts: [gate, primary, skeptic] });
	await acceptCandidate(kit, { ...wave, parent, tree, policy: "always", required: ["primary", "skeptic"] });
	const integrated = await integrateAcceptedCandidate(kit, wave);
	return integrated.receipt.commit;
}

async function receiptEvents(kit: LoopAndLock) {
	return (await kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT))?.events ?? [];
}

async function remoteRef(remote: BareRemote, ref: string): Promise<string | undefined> {
	return remote.readRemoteRef(ORIGIN, ref);
}

afterEach(async () => {
	await Promise.all(openKits.splice(0).map(async (kit) => {
		await kit.loop.close().catch(() => {});
		kit.lock.release();
	}));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("verified stacked PR publication against a fake remote", () => {
	it("publishes A against the reviewed base and B against A's verified branch", async () => {
		const data = await fixture();
		const state = await readSessionState(data.kit.loop.harness);
		const baseRef = `refs/heads/${data.baseBranch}`;
		const aCommit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const aBranch = `refs/heads/kit/${data.waves[0]!.planRevision}/stack-a`;
		const aResult = await publishPullRequest(data.kit, data.waves[0]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
		});
		expect(aResult.receipt).toMatchObject({ state: "published", ref: aBranch, baseRef, commit: aCommit, prNumber: 1 });
		expect(await remoteRef(data.remote, aBranch)).toBe(aCommit);
		expect(data.host.records[0]).toMatchObject({ baseRef: data.baseBranch, baseOid: data.baseCommit, headRef: aBranch.slice("refs/heads/".length), headOid: aCommit });

		const bCommit = await acceptAndIntegrate(data.kit, data.waves[1]!, aCommit);
		const bBranch = `refs/heads/kit/${data.waves[1]!.planRevision}/stack-b`;
		const bResult = await publishPullRequest(data.kit, data.waves[1]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
		});
		expect(bResult.receipt).toMatchObject({
			state: "published", ref: bBranch, baseRef: aBranch, commit: bCommit, prNumber: 2,
		});
		expect(await remoteRef(data.remote, bBranch)).toBe(bCommit);
		expect(data.host.records[1]).toMatchObject({
			baseRef: aBranch.slice("refs/heads/".length), baseOid: aCommit,
			headRef: bBranch.slice("refs/heads/".length), headOid: bCommit,
		});
		const aCommitData = await (await import("../src/util/git-objects.ts")).readCommit(data.root, aCommit);
		const bCommitData = await (await import("../src/util/git-objects.ts")).readCommit(data.root, bCommit);
		expect(aCommitData.parents).toEqual([data.baseCommit]);
		expect(bCommitData.parents).toEqual([aCommit]);
		expect(state.runStatus.approvedSelected).toEqual(["stack-a", "stack-b"]);
	});

	it("reconciles a lost create-only ref response from exact remote readback", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		data.remote.loseAfterCreate = true;
		const result = await publishPullRequest(data.kit, data.waves[0]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
		});
		expect(result.receipt).toMatchObject({ state: "published", commit });
		expect(data.remote.pushCalls).toBe(1);
		expect(data.host.createCalls).toBe(1);
	});

	it("uses the trusted Git transport's empty-expected lease against a local bare repository", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const transport = new TrustedGitRemoteTransport(data.root);
		const baseRef = `refs/heads/${data.baseBranch}`;
		expect(await transport.readRemoteRef(data.bare, baseRef)).toBe(data.baseCommit);
		const headRef = `refs/heads/kit/${data.waves[0]!.planRevision}/transport-check`;
		await transport.createRemoteRef(data.bare, headRef, commit);
		expect(await transport.readRemoteRef(data.bare, headRef)).toBe(commit);
		await expect(transport.createRemoteRef(data.bare, headRef, data.baseCommit)).rejects.toThrow(/create-only git push failed/);
		expect(await transport.readRemoteRef(data.bare, headRef)).toBe(commit);
	});

	it("observes an exact pre-existing remote head without pushing it again", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const headRef = `refs/heads/kit/${data.waves[0]!.planRevision}/stack-a`;
		await data.remote.seed(headRef, commit);
		const result = await publishPullRequest(data.kit, data.waves[0]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
		});
		expect(result.receipt).toMatchObject({ state: "published", commit, ref: headRef });
		expect(data.remote.pushCalls).toBe(0);
		expect(data.host.createCalls).toBe(1);
	});

	it("recovers a durable remote intent that crashed before any push attempt", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const options = { deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host };
		await expect(publishPullRequest(data.kit, data.waves[0]!, {
			...options,
			faultInjector(point) { if (point === "delivery-intent:after-commit") throw new Error("crash before push"); },
		})).rejects.toThrow("crash before push");
		expect(data.remote.pushCalls).toBe(0);
		const result = await publishPullRequest(data.kit, data.waves[0]!, options);
		expect(result.receipt).toMatchObject({ state: "published", commit });
		expect(data.remote.pushCalls).toBe(1);
	});

	it("does not recreate a remote ref removed after publication", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const options = { deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host };
		await publishPullRequest(data.kit, data.waves[0]!, options);
		const headRef = `refs/heads/kit/${data.waves[0]!.planRevision}/stack-a`;
		await data.remote.remove(headRef);
		const pushes = data.remote.pushCalls;
		await expect(publishPullRequest(data.kit, data.waves[0]!, options)).rejects.toThrow(/refusing to recreate or repair it/);
		expect(await remoteRef(data.remote, headRef)).toBeUndefined();
		expect(data.remote.pushCalls).toBe(pushes);
		expect((await receiptEvents(data.kit)).some((event) => event.kind === "delivery" && event.value.commit === commit && event.value.state === "published")).toBe(true);
	});

	it("reconciles a lost PR-create response by exact identity and never creates a duplicate", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		data.host.loseFirstCreateReply = true;
		const options = { deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host };
		await expect(publishPullRequest(data.kit, data.waves[0]!, options)).rejects.toBeInstanceOf(RecoveryRequiredError);
		const firstHistory = (await receiptEvents(data.kit)).filter((event) => event.kind === "delivery");
		expect(firstHistory.at(-1)?.kind === "delivery" ? firstHistory.at(-1)!.value : undefined).toMatchObject({ state: "unknown", code: "pr-create-uncertain", commit });
		const retry = await publishPullRequest(data.kit, data.waves[0]!, options);
		expect(retry.receipt).toMatchObject({ state: "published", commit, prNumber: 1 });
		expect(data.host.createCalls).toBe(1);
		const events = (await receiptEvents(data.kit)).filter((event) => event.kind === "delivery");
		expect(events.some((event) => event.kind === "delivery" && event.value.state === "published")).toBe(true);
	});

	it("refuses a non-GitHub or non-canonical host-profile origin before remote effects", async () => {
		const data = await fixture();
		await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		await writeFile(data.profilePath, JSON.stringify({
			version: 1,
			projects: [{ root: await realpath(data.root), deliveryOrigin: "https://github.com.evil/acme/widget.git" }],
			toolchains: {},
		}), "utf8");
		await chmod(data.profilePath, 0o600);
		await expect(publishPullRequest(data.kit, data.waves[0]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
		})).rejects.toThrow(/HTTPS github.com repository URL/);
		expect(data.remote.readCalls).toBe(0);
		expect(data.remote.pushCalls).toBe(0);
		expect(data.host.createCalls).toBe(0);
		expect((await receiptEvents(data.kit)).some((event) => event.kind === "delivery")).toBe(false);
	});

	it("refuses a conflicting pre-existing remote head without overwriting it", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const headRef = `refs/heads/kit/${data.waves[0]!.planRevision}/stack-a`;
		await data.remote.seed(headRef, data.baseCommit);
		const pushes = data.remote.pushCalls;
		await expect(publishPullRequest(data.kit, data.waves[0]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
		})).rejects.toThrow(/conflicting existing remote head/);
		expect(await remoteRef(data.remote, headRef)).toBe(data.baseCommit);
		expect(data.remote.pushCalls).toBe(pushes);
		expect(data.host.createCalls).toBe(0);
		expect((await receiptEvents(data.kit)).some((event) => event.kind === "delivery" && event.value.commit === commit && event.value.state === "published")).toBe(false);
	});

	it("refuses publication without explicit consent or when the approved base moved", async () => {
		const noConsent = await fixture();
		await acceptAndIntegrate(noConsent.kit, noConsent.waves[0]!, noConsent.baseCommit);
		await expect(publishPullRequest(noConsent.kit, noConsent.waves[0]!, {
			deliverExplicit: false, profilePath: noConsent.profilePath, gitTransport: noConsent.remote, prHost: noConsent.host,
		})).rejects.toThrow(/explicit --deliver/);
		expect(noConsent.remote.pushCalls).toBe(0);
		expect(noConsent.host.createCalls).toBe(0);

		const moved = await fixture();
		await acceptAndIntegrate(moved.kit, moved.waves[0]!, moved.baseCommit);
		const movedBase = await run(["git", "--git-dir", moved.bare, "rev-parse", `refs/heads/${moved.baseBranch}`], moved.root);
		expect(movedBase).toBe(moved.baseCommit);
		const remoteBaseRef = `refs/heads/${moved.baseBranch}`;
		const alternate = (await exec(["git", "rev-parse", "HEAD"], { cwd: moved.root, timeoutMs: 10_000 })).stdout.trim();
		// Create a distinct valid commit object locally, then move only the bare base ref.
		const foreign = await (await import("../src/util/git-objects.ts")).createCommitObject(moved.root,
			await resolveTree(moved.root, alternate), moved.baseCommit, "moved remote base");
		await moved.remote.seed(remoteBaseRef, foreign, moved.baseCommit);
		await expect(publishPullRequest(moved.kit, moved.waves[0]!, {
			deliverExplicit: true, profilePath: moved.profilePath, gitTransport: moved.remote, prHost: moved.host,
		})).rejects.toThrow(/expected reviewed parent/);
		expect(moved.remote.pushCalls).toBe(0);
		expect(moved.host.createCalls).toBe(0);
	});

	it("refuses tracked private runtime and §2 secret paths before remote publication", async () => {
		for (const privatePath of [".orch/durable.sqlite", "src/.env.local"]) {
			const data = await fixture();
			const parentTree = await resolveTree(data.root, data.baseCommit);
			const blob = await hashBlob(data.root, Buffer.from("fixture-only secret marker\\n"));
			const privateTree = await writeTreeFromChanges(data.root, parentTree, [{ path: privatePath, mode: "100644", oid: blob }]);
			await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit, privateTree);
			await expect(publishPullRequest(data.kit, data.waves[0]!, {
				deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: data.host,
			})).rejects.toThrow(/refusing public PR delivery/);
			expect(data.remote.pushCalls).toBe(0);
			expect(data.host.createCalls).toBe(0);
		}
	});

	it("requires a unique PR-host identity; mismatched reported head SHA stays unpublished", async () => {
		const data = await fixture();
		const commit = await acceptAndIntegrate(data.kit, data.waves[0]!, data.baseCommit);
		const baseHost = data.host;
		const badHost: PullRequestHost = {
			findForHead: (identity) => baseHost.findForHead(identity),
			async create(identity) {
				baseHost.createCalls += 1;
				baseHost.records.push({
					repository: identity.repository, number: 9, url: `https://github.com/${identity.repository}/pull/9`,
					baseRef: identity.baseRef, baseOid: identity.baseOid, headRef: identity.headRef,
					headOid: "f".repeat(commit.length), state: "open",
				});
			},
		};
		await expect(publishPullRequest(data.kit, data.waves[0]!, {
			deliverExplicit: true, profilePath: data.profilePath, gitTransport: data.remote, prHost: badHost,
		})).rejects.toBeInstanceOf(RecoveryRequiredError);
		const events = (await receiptEvents(data.kit)).filter((event) => event.kind === "delivery");
		expect(events.at(-1)?.kind === "delivery" ? events.at(-1)!.value : undefined).toMatchObject({ state: "unknown", code: "pr-identity-conflict" });
		expect(events.some((event) => event.kind === "delivery" && event.value.commit === commit && event.value.state === "published")).toBe(false);
	});
});
