import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openProjectHarness, type LoopAndLock } from "../src/engine/harness.ts";
import { runWaves } from "../src/engine/waves.ts";
import { conversationEntries } from "../src/engine/inspector.ts";
import { ReceiptsDoc } from "../src/engine/receipts.ts";
import type { PullRequestHost, PullRequestIdentity, RemoteGitTransport, RemotePullRequest } from "../src/engine/delivery.ts";
import { BACKGROUND_CONTEXT } from "../src/engine/kit.ts";
import { readSessionState } from "../src/engine/state.ts";
import { readCommit, readRef, resolveTree } from "../src/util/git-objects.ts";
import { exec } from "../src/util/exec.ts";
import { installTrustedInstallationForTests, runningInstallationFrom, selectInstallation } from "../src/sandbox/trusted-exec.ts";
import { buildFauxModels, fauxAssistantMessage, fauxToolCall } from "./fixtures.ts";
import { accomplish, bakeProject, scripted } from "./fixtures2.ts";
import { demoConfigToml } from "./demo-project.ts";

const roots: string[] = [];
const openKits: LoopAndLock[] = [];
const ORIGIN = "https://github.com/acme/serial-lineage.git";
const A_BYTES = "A-integrated-bytes\n";
const TASKS = {
	tasks: [
		{
			id: "task-a",
			title: "Create A's module",
			spec: "Write src/a.txt with the exact integration marker.",
			dependsOn: [],
			acceptance: ["When task A is accepted, src/a.txt shall contain the integration marker."],
			targetPaths: ["src/a.txt"],
			priority: 2,
		},
		{
			id: "task-b",
			title: "Read A's integrated bytes",
			spec: "Read src/a.txt from the current accepted parent, then write src/b.txt.",
			dependsOn: ["task-a"],
			acceptance: ["When task B is accepted, src/b.txt shall record the marker read from A."],
			targetPaths: ["src/b.txt"],
			priority: 1,
		},
	],
};

async function closeKit(kit: LoopAndLock): Promise<void> {
	const index = openKits.indexOf(kit);
	if (index >= 0) openKits.splice(index, 1);
	await kit.loop.close().catch(() => {});
	kit.lock.release();
}

afterEach(async () => {
	installTrustedInstallationForTests(undefined);
	await Promise.all(openKits.splice(0).map(closeKit));
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const approval = (file: string) => fauxAssistantMessage(JSON.stringify({
	verdict: "approve",
	criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: file, line: 1 }] }],
	notes: "candidate contains the exact behavior",
}), { stopReason: "stop" });

async function run(argv: string[], cwd: string): Promise<string> {
	const result = await exec(argv, { cwd, timeoutMs: 20_000 });
	if (result.code !== 0) throw new Error(result.stderr || result.stdout || `${argv.join(" ")} failed`);
	return result.stdout.trim();
}

class BareRemote implements RemoteGitTransport {
	constructor(private readonly approvedOrigin: string, private readonly bare: string, private readonly cwd: string) {}

	private check(origin: string): void {
		if (origin !== this.approvedOrigin) throw new Error(`unexpected publication origin ${origin}`);
	}

	async readRemoteRef(origin: string, ref: string): Promise<string | undefined> {
		this.check(origin);
		const result = await exec(["git", "--git-dir", this.bare, "for-each-ref", "--format=%(refname)%00%(objectname)", ref], { cwd: this.cwd, timeoutMs: 10_000 });
		if (result.code !== 0) throw new Error(result.stderr || "bare ref query failed");
		const row = result.stdout.trim();
		if (!row) return undefined;
		const [name, oid] = row.split("\0");
		if (name !== ref || !oid) throw new Error(`unexpected bare ref row for ${ref}`);
		return oid;
	}

	async createRemoteRef(origin: string, ref: string, oid: string): Promise<void> {
		this.check(origin);
		const result = await exec(["git", "push", "--porcelain", `--force-with-lease=${ref}:`, this.bare, `${oid}:${ref}`], { cwd: this.cwd, timeoutMs: 20_000 });
		if (result.code !== 0) throw new Error(result.stderr || "bare create-only push failed");
	}
}

class FakePullRequests implements PullRequestHost {
	readonly rows: RemotePullRequest[] = [];

	async findForHead(identity: PullRequestIdentity): Promise<RemotePullRequest[]> {
		return this.rows.filter((row) => row.repository === identity.repository && row.headRef === identity.headRef);
	}

	async create(identity: PullRequestIdentity & { title: string; body: string }): Promise<void> {
		const number = this.rows.length + 1;
		this.rows.push({
			repository: identity.repository,
			number,
			url: `https://github.com/${identity.repository}/pull/${number}`,
			baseRef: identity.baseRef,
			baseOid: identity.baseOid,
			headRef: identity.headRef,
			headOid: identity.headOid,
			state: "open",
		});
	}
}

async function addLineageGate(root: string): Promise<void> {
	await writeFile(join(root, "evals", "lineage-check.cjs"), `const fs = require("node:fs");
const expected = ${JSON.stringify(A_BYTES)};
const actual = fs.readFileSync("src/a.txt", "utf8");
if (actual !== expected) {
	console.error("task B did not receive A's exact accepted bytes");
	process.exit(1);
}
process.stdout.write(actual);
`, "utf8");
	await writeFile(join(root, "evals", "recipes.toml"), `[lineage-check]\ncmd = "node evals/lineage-check.cjs"\n`, "utf8");
}

async function provisionPrRemote(kit: LoopAndLock, profilePath: string): Promise<{
	bare: string;
	remote: BareRemote;
	host: FakePullRequests;
	baseCommit: string;
	baseBranch: string;
}> {
	const state = await readSessionState(kit.loop.harness);
	const baseCommit = state.router.identity!.baseCommit!;
	const baseBranch = state.router.identity!.baseBranch!;
	const bare = await mkdtemp(join(tmpdir(), "kit-lineage-bare-"));
	roots.push(bare);
	await run(["git", "init", "--bare", bare], kit.loop.paths.root);
	await run(["git", "push", bare, `${baseCommit}:refs/heads/${baseBranch}`], kit.loop.paths.root);
	await writeFile(profilePath, JSON.stringify({
		version: 1,
		projects: [{ root: await realpath(kit.loop.paths.root), deliveryOrigin: ORIGIN }],
		toolchains: {},
	}), "utf8");
	await chmod(profilePath, 0o600);
	return { bare, remote: new BareRemote(ORIGIN, bare, kit.loop.paths.root), host: new FakePullRequests(), baseCommit, baseBranch };
}

describe.each(["none", "commit", "pr"] as const)("serial accepted lineage (%s mode)", (mode) => {
	it("gives B A's exact integrated bytes and publishes only the accepted lineage", async () => {
		const config = demoConfigToml().replace('mode = "none"', `mode = "${mode}"`);
		const baked = await bakeProject({ buildFauxModels, configToml: config });
		roots.push(baked.project.root);
		openKits.push(baked.kit);
		// Host-owned installation injection: Git resolves to the fixed validated
		// default, while `gh` is selected INSIDE the project (invalid). Delivery
		// `none`/`commit` must never resolve it, and the injected PR seam never
		// touches the real gh host either.
		installTrustedInstallationForTests(selectInstallation({
			platform: "linux",
			running: runningInstallationFrom("file:///srv/kit/src/sandbox/trusted-exec.ts", "linux"),
			execPath: process.execPath,
			installation: { gh: join(baked.project.root, ".bin", "gh") },
		}));
		await addLineageGate(baked.project.root);

		const { faux, models } = baked.models;
		await scripted(baked.kit, [
			fauxAssistantMessage(JSON.stringify(TASKS), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/a.txt", content: A_BYTES })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			approval("src/a.txt"),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/a.txt", line: 1 }] }], notes: "independently checked A" }), { stopReason: "stop" }),
			fauxAssistantMessage([fauxToolCall("read", { path: "src/a.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("write", { path: "src/b.txt", content: "B saw A-integrated-bytes\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("STATUS: COMPLETE", { stopReason: "stop" }),
			approval("src/b.txt"),
			fauxAssistantMessage(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass", evidence: [{ kind: "line", path: "src/b.txt", line: 1 }] }], notes: "independently checked B" }), { stopReason: "stop" }),
		], faux);
		const revision = await accomplish(baked.kit);
		const stateBefore = await readSessionState(baked.kit.loop.harness);
		const operatorHead = (await exec(["git", "rev-parse", "HEAD"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();
		const operatorIndex = (await exec(["git", "write-tree"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim();

		const profileDir = await mkdtemp(join(tmpdir(), "kit-lineage-profile-"));
		roots.push(profileDir);
		const profilePath = join(profileDir, "host-v1.json");
		let prPublication: { profilePath: string; gitTransport: RemoteGitTransport; prHost: PullRequestHost } | undefined;
		let bare: string | undefined;
		let host: FakePullRequests | undefined;
		if (mode === "pr") {
			const provisioned = await provisionPrRemote(baked.kit, profilePath);
			bare = provisioned.bare;
			host = provisioned.host;
			prPublication = { profilePath, gitTransport: provisioned.remote, prHost: provisioned.host };
		}
		const summary = await runWaves(baked.kit, {
			prPublication,
			deliverExplicit: mode === "pr",
		});
		expect(summary.exit).toBe("plan-complete");
		expect(summary.complete).toBe(true);

		const state = await readSessionState(baked.kit.loop.harness);
		const taskA = state.router.tasks.find((task) => task.id === "task-a")!;
		const taskB = state.router.tasks.find((task) => task.id === "task-b")!;
		expect(taskA.status).toBe("done");
		expect(taskB.status).toBe("done");
		const receipts = await baked.kit.loop.harness.snapshot(ReceiptsDoc, BACKGROUND_CONTEXT);
		const integratedA = receipts?.events.filter((event) => event.kind === "integrate" && event.value.taskId === "task-a" && event.value.state === "integrated").at(-1);
		const integratedB = receipts?.events.filter((event) => event.kind === "integrate" && event.value.taskId === "task-b" && event.value.state === "integrated").at(-1);
		expect(integratedA?.kind).toBe("integrate");
		expect(integratedB?.kind).toBe("integrate");
		if (!integratedA || integratedA.kind !== "integrate" || !integratedB || integratedB.kind !== "integrate") throw new Error("missing integrated receipts");
		const commitA = await readCommit(baked.project.root, integratedA.value.commit);
		const commitB = await readCommit(baked.project.root, integratedB.value.commit);
		expect(commitA.parents).toEqual([stateBefore.router.identity!.baseCommit]);
		expect(commitB.parents).toEqual([integratedA.value.commit]);
		const bCheckpoint = receipts?.events.filter((event) => event.kind === "checkpoint" && event.value.taskId === "task-b" && event.value.stage === "terminal").at(-1);
		expect(bCheckpoint?.kind === "checkpoint" ? bCheckpoint.value.startTree : undefined).toBe(await resolveTree(baked.project.root, integratedA.value.commit));

		const transcript = await conversationEntries(baked.kit, taskB.convId!);
		expect(transcript?.entries.some((entry) => entry.kind === "pi.tool-result" && entry.text.includes(A_BYTES.trim()))).toBe(true);
		const finalTree = await resolveTree(baked.project.root, integratedB.value.commit);
		const finalEntries = await (await import("../src/util/git-objects.ts")).readTreeEntries(baked.project.root, finalTree);
		const aEntry = finalEntries.find((entry) => entry.path === "src/a.txt");
		const bEntry = finalEntries.find((entry) => entry.path === "src/b.txt");
		expect(aEntry).toBeTruthy();
		expect(bEntry).toBeTruthy();
		if (!aEntry || !bEntry) throw new Error("accepted tree is missing a task output");
		const objects = await import("../src/util/git-objects.ts");
		expect((await objects.readBlob(baked.project.root, aEntry.oid)).toString("utf8")).toBe(A_BYTES);
		expect((await objects.readBlob(baked.project.root, bEntry.oid)).toString("utf8")).toBe("B saw A-integrated-bytes\n");

		if (mode === "none") {
			expect(await readRef(baked.project.root, `refs/heads/kit/${revision}/result`)).toBeUndefined();
			expect(receipts?.events.some((event) => event.kind === "delivery" && event.value.mode === "none" && event.value.state === "not_requested")).toBe(true);
		} else if (mode === "commit") {
			expect(await readRef(baked.project.root, `refs/heads/kit/${revision}/result`)).toBe(integratedB.value.commit);
		} else {
			const aRemote = await (prPublication!.gitTransport.readRemoteRef(ORIGIN, `refs/heads/kit/${revision}/task-a`));
			const bRemote = await (prPublication!.gitTransport.readRemoteRef(ORIGIN, `refs/heads/kit/${revision}/task-b`));
			expect(aRemote).toBe(integratedA.value.commit);
			expect(bRemote).toBe(integratedB.value.commit);
			expect(host?.rows.map((row) => [row.baseRef, row.headRef])).toEqual([
				[initialBaseBranch(stateBefore.router.identity!.baseBranch!), `kit/${revision}/task-a`],
				[`kit/${revision}/task-a`, `kit/${revision}/task-b`],
			]);
			expect(bare).toBeTruthy();
		}
		expect((await exec(["git", "rev-parse", "HEAD"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim()).toBe(operatorHead);
		expect((await exec(["git", "write-tree"], { cwd: baked.project.root, timeoutMs: 10_000 })).stdout.trim()).toBe(operatorIndex);
		await closeKit(baked.kit);
	});
});

function initialBaseBranch(branch: string | null): string {
	if (!branch) throw new Error("serial PR fixture requires an attached reviewed base branch");
	return branch;
}
