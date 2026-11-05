/**
 * Delivery (§4.6): wave-to-repo permanence, OFF by default.
 * `none`   — waves stay in the working tree, isolated via baselineTreeSha.
 * `commit` — one git commit per approved task (working tree + HEAD move).
 * `pr`     — branch per task + `gh pr create --fill` (requires --deliver);
 *            the session returns to the previous branch afterwards.
 */
import { exec } from "../util/exec.ts";
import type { LoopAndLock } from "./harness.ts";
import { commitState } from "./state.ts";
import type { WaveRow } from "./infos.ts";

export interface DeliveryOutcome {
	mode: string;
	performed: boolean;
	ref?: string;
	detail?: string;
}

export async function runDelivery(
	kit: LoopAndLock,
	taskId: string,
	wave: number,
	options: { deliverExplicit?: boolean } = {},
): Promise<DeliveryOutcome> {
	const mode = kit.loop.config.delivery.mode;
	if (mode === "none") return { mode, performed: false };

	if (mode === "pr" && !options.deliverExplicit) {
		await commitState(kit, {
			rows: [
				{ ts: Date.now(), kind: "delivery", task: taskId, verb: "pr-skip", detail: 'delivery.mode="pr" requires the --deliver flag on the run command' },
			],
		});
		return { mode, performed: false, detail: "needs --deliver" };
	}

	if (mode === "commit") {
		return commitMode(kit, taskId, wave);
	}

	// mode === "pr"
	return prMode(kit, taskId, wave);
}

async function commitMode(kit: LoopAndLock, taskId: string, wave: number): Promise<DeliveryOutcome> {
	const root = kit.loop.paths.root;
	const message = `${projectName(kit)}: ${taskId} (wave ${wave})`;
	const add = await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 30_000 });
	if (add.code !== 0) {
		await commitState(kit, { rows: rows(kit, taskId, "commit-failed", add.stderr.slice(0, 200)) });
		return { mode: "commit", performed: false, detail: "git add failed" };
	}
	const commit = await exec(["git", "commit", "-m", message], { cwd: root, timeoutMs: 60_000 });
	if (commit.code !== 0) {
		await commitState(kit, { rows: rows(kit, taskId, "commit-failed", commit.stderr.slice(0, 200)) });
		return { mode: "commit", performed: false, detail: "git commit failed (nothing to commit?)" };
	}
	return finish(kit, taskId, undefined, `committed: ${message}`);
}

async function prMode(kit: LoopAndLock, taskId: string, wave: number): Promise<DeliveryOutcome> {
	const root = kit.loop.paths.root;
	const branch = `kit/${taskId}-w${wave}`;
	const message = `${projectName(kit)}: ${taskId} (wave ${wave})`;

	const head = await exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, timeoutMs: 15_000 });
	const previous = (head.stdout || "main").trim();
	const checkout = await exec(["git", "checkout", "-b", branch], { cwd: root, timeoutMs: 30_000 }); // keeps working tree
	if (checkout.code !== 0) {
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", checkout.stderr.slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "branch creation failed" };
	}
	await exec(["git", "add", "-A"], { cwd: root, timeoutMs: 30_000 });
	const commit = await exec(["git", "commit", "-m", message], { cwd: root, timeoutMs: 60_000 });
	if (commit.code !== 0) {
		await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", commit.stderr.slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "commit failed" };
	}
	const push = await exec(["git", "push", "-u", "origin", branch], { cwd: root, timeoutMs: 120_000 });
	if (push.code !== 0) {
		await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", push.stderr.slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "push failed" };
	}
	const pr = await exec(["gh", "pr", "create", "--fill", "--head", branch], { cwd: root, timeoutMs: 60_000 });
	if (pr.code !== 0) {
		await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
		await commitState(kit, { rows: rows(kit, taskId, "pr-failed", (pr.stderr || pr.stdout).slice(0, 200)) });
		return { mode: "pr", performed: false, detail: "gh pr create failed" };
	}
	const ref = (pr.stdout || "").trim();
	await exec(["git", "checkout", previous], { cwd: root, timeoutMs: 30_000 });
	return finish(kit, taskId, branch, `${ref} (back on ${previous})`);
}

async function finish(kit: LoopAndLock, taskId: string, branch: string | undefined, detail: string): Promise<DeliveryOutcome> {
	await commitState(kit, {
		rows: [{ ts: Date.now(), kind: "delivery", task: taskId, verb: "delivered", detail }],
	});
	return { mode: kit.loop.config.delivery.mode, performed: true, ref: branch, detail };
}

function rows(kit: LoopAndLock, taskId: string, verb: string, detail: string): WaveRow[] {
	return [{ ts: Date.now(), kind: "delivery", task: taskId, verb, detail }];
}

/** Use the project name recorded at init (package.json / cwd basename). */
function projectName(kit: LoopAndLock): string {
	const name = (kit.loop.config as unknown as { name?: string }).name;
	if (name) return name;
	return basename(kit.loop.paths.root);
}

function basename(path: string): string {
	const parts = path.split("/");
	return parts[parts.length - 1] ?? path;
}
