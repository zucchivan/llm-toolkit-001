/**
 * Actions + detached-job contract tests (ui/PRD.md §11.2, §15.1, Appendix B/C):
 * allowlist + per-kind validation (400), argv construction (no shell), job
 * spawn/exit/stale via the real detached runner against a stub CLI, lock-busy
 * 409, stuck-reported-stop 409 + terminal hint, cross-origin mutation 403,
 * X-Kit-Token echo, jobs/log routes, and the server-restart sweep.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildArgv, resolveCli, startAction, stopAction, validateAction, configPreflight, ACTION_ROLE_NEEDS } from "../server/actions.ts";
import { jobEnvironment, markStaleRecords, pruneJobs, spawnJob, statusForExit, jobsList, readJobRecord, tailJobLog, jobsViewList } from "../server/jobs.ts";
import { selectInstallation } from "../../src/sandbox/trusted-exec.ts";
import { bake, cleanup, postAction, actionHeaders, trustedNodeFixture, waitFor, spawnSleeper, type Baked } from "./actions-helper.ts";

describe("model preflight (422 before a doomed job spawns)", () => {
	async function rootWithConfig(config: string): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), "ui-preflight-"));
		await mkdir(join(root, ".orch"), { recursive: true });
		await writeFile(join(root, ".orch", "config.toml"), config, "utf8");
		return root;
	}
	const goodConfig = '[roles.planner]\nprovider = "faux"\nmodelId = "kit-planner"\n[roles.implementer]\nprovider = "faux"\nmodelId = "kit-impl"\n[roles.verifier]\nprovider = "faux"\nmodelId = "kit-verifier"\n';

	it("needs exactly the roles the action uses", () => {
		expect(ACTION_ROLE_NEEDS["plan"]).toEqual(["planner"]);
		expect(ACTION_ROLE_NEEDS["run"]).toEqual(["implementer", "verifier"]);
		expect(ACTION_ROLE_NEEDS["verify"]).toEqual(["verifier"]);
	});

	it("a fully configured config passes; no-model and blank-string configs 422 in kind words", async () => {
		const root = await rootWithConfig(goodConfig);
		try {
			expect(await configPreflight(root, { kind: "plan", prd: "docs/prd.md" })).toBeUndefined();
			expect(await configPreflight(root, { kind: "run", approve: true, revision: "0f0f0f0f-0000-4000-8000-000000000000" })).toBeUndefined();
			expect(await configPreflight(root, { kind: "verify", task: "t1" })).toBeUndefined();
			expect(await configPreflight(root, { kind: "export" })).toBeUndefined(); // no models needed
			expect(await configPreflight(root, { kind: "handoff", note: "n" })).toBeUndefined();
		} finally {
			await rm(root, { recursive: true, force: true });
		}

		const noRoles = await rootWithConfig('[engine]\npiDurable = "1.5.0"\n\n[paths]\nprd = "docs/prd.md"\nspecs = "specs/"\n');
		try {
			const plan = await configPreflight(noRoles, { kind: "plan" });
			expect(plan).toMatchObject({ status: 422 });
			expect(plan!.error).toMatch(/plan can't start yet: roles\.planner has no model configured/);
			expect(plan!.error).toMatch(/\.orch\/config\.toml/);
			expect(plan!.error).toMatch(/\[roles\.planner\]/);
			expect(plan!.missing).toEqual(["planner"]);

			// the loader names the first role block it could not validate (planner);
			// fixing it re-runs the preflight, which then names the next gap
			const run = await configPreflight(noRoles, { kind: "run", approve: true, revision: "0f0f0f0f-0000-4000-8000-000000000000" });
			expect(run!.missing).toEqual(["planner"]);
			expect(run!.error).toMatch(/\[roles\.planner\]/);
		} finally {
			await rm(noRoles, { recursive: true, force: true });
		}

		// A REFUSED config (symlink) is reported as a refusal, not as a missing
		// config and not as a model gap (M1-P01 step (g)).
		const refusedRoot = await mkdtemp(join(tmpdir(), "ui-preflight-"));
		const outside = await mkdtemp(join(tmpdir(), "ui-preflight-outside-"));
		try {
			await mkdir(join(refusedRoot, ".orch"), { recursive: true });
			await writeFile(join(outside, "config.toml"), goodConfig, "utf8");
			await symlink(join(outside, "config.toml"), join(refusedRoot, ".orch", "config.toml"));
			const refused = await configPreflight(refusedRoot, { kind: "plan" });
			expect(refused).toMatchObject({ status: 422 });
			expect(refused!.missing).toBeUndefined();
			expect(refused!.configError).toMatch(/config refused: .*\(symlink\)/);
			expect(refused!.error).toMatch(/can't be read/);
		} finally {
			await rm(refusedRoot, { recursive: true, force: true });
			await rm(outside, { recursive: true, force: true });
		}

		const broken = await rootWithConfig("[roles.planner]\nprovider = \"\n"); // invalid TOML
		try {
			const plan = await configPreflight(broken, { kind: "plan" });
			expect(plan).toMatchObject({ status: 422 });
			expect(plan!.configError).toMatch(/not valid TOML/);
			expect(plan!.error).toMatch(/config can't be read/);
		} finally {
			await rm(broken, { recursive: true, force: true });
		}
	});

	it("over HTTP: 422 replaces the doomed 202 — no job record appears — and fixing the config restores the 202", async () => {
		const baked = await bake({ skipJobSweep: false });
		try {
			const configPath = join(baked.root, ".orch", "config.toml");
			const original = await readFile(configPath, "utf8");
			await writeFile(configPath, "[engine]\npiDurable = \"1.5.0\"\n", "utf8"); // roles gone
			const rejected = await postAction(baked.base, baked.cookie, { kind: "plan", prd: "docs/prd.md" }, actionHeaders(baked.csrf));
			expect(rejected.status).toBe(422);
			const body = (await rejected.json()) as { error: string; missing?: string[] };
			expect(body.error).toMatch(/roles\.planner has no model configured/);
			expect(body.missing).toEqual(["planner"]);
			expect((await jobsList(baked.root)).length).toBe(0); // nothing spawned

			await writeFile(configPath, original, "utf8"); // restored: the same POST succeeds
			const accepted = await postAction(baked.base, baked.cookie, { kind: "plan", prd: "docs/prd.md" }, actionHeaders(baked.csrf));
			expect(accepted.status).toBe(202);
		} finally {
			await cleanup(baked);
		}
	});

	it("failed job records carry their reason tail in /api/jobs and SSE payloads", async () => {
		const baked = await bake({ skipJobSweep: false });
		try {
			const accept = await startAction(baked.root, { kind: "export" });
			expect(accept.ok).toBe(true);
			if (accept.ok) {
				const job = (await waitFor(() => readJobRecord(baked.root, accept.job.id), (j) => j !== undefined && j.status !== "running", 8_000))!;
				expect(job.status).toBe("failed");
				const views = await waitFor(async () => jobsViewList(baked.root), (v) => v.length > 0 && (v.find((x) => x.id === accept.job.id)?.tail?.length ?? 0) > 0, 8_000);
				const view = views.find((x) => x.id === accept.job.id)!;
				expect(view.tail?.join("\n")).toMatch(/exported:|went wrong/); // the log's last meaningful lines, ANSI-stripped
				// the same view shape rides the HTTP /api/jobs route (SSE emits this too)
				const httpPayload = (await (await fetch(`${baked.base}/api/jobs`, { headers: { cookie: baked.cookie } })).json()) as { jobs: { id: string; tail?: string[] }[] };
				expect((httpPayload.jobs.find((x) => x.id === accept.job.id)?.tail ?? []).join("\n")).toMatch(/exported:|went wrong/);
			}
		} finally {
			await cleanup(baked);
		}
	});
});

describe("action validation (allowlist, per-kind shapes)", () => {
	it("rejects unknown kinds, unknown fields, non-objects", () => {
		expect(validateAction("nonsense").ok).toBe(false);
		expect(validateAction(null)).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "deploy" })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "deploy" }) as { ok: false; error: string }).error).toMatch(/known: plan, run/);
		expect(validateAction({ kind: "plan", extra: true })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "stop", prd: "x" })).toMatchObject({ ok: false, status: 400 });
	});

	it("run without approve/resume is refused — no silent run", () => {
		expect(validateAction({ kind: "run" })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "run" }) as { error: string }).error).toMatch(/no silent run/);
		expect(validateAction({ kind: "run", approve: true, resume: true })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "run", approve: true, resume: true }) as { error: string }).error).toMatch(/not both/);
		expect(validateAction({ kind: "run", approve: true, resume: true })).toMatchObject({ ok: false, status: 400 });
		// M0-P06: an approval is revision-qualified — the revision-less stamp is
		// refused server-side (fail old clients closed; the CLI would refuse it too)
		expect(validateAction({ kind: "run", approve: true })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "run", approve: true }) as { error: string }).error).toMatch(/needs revision/);
		expect(validateAction({ kind: "run", approve: true, revision: "" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: "   " })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: "two tokens" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: "r".repeat(129) })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: "0f0f0f0f-0000-4000-8000-000000000000" }).ok).toBe(true);
	});

	it("resume is bare: no tasks — the stored grant is never widened (M0-P06)", () => {
		expect(validateAction({ kind: "run", resume: true, tasks: ["t1"] })).toMatchObject({ ok: false, status: 400 });
		expect((validateAction({ kind: "run", resume: true, tasks: ["t1"] }) as { error: string }).error).toMatch(/resume takes no tasks/);
		expect(validateAction({ kind: "run", resume: true }).ok).toBe(true);
	});

	it("run tasks: non-empty unique ids only", () => {
		const rev = "0f0f0f0f-0000-4000-8000-000000000000";
		expect(validateAction({ kind: "run", approve: true, revision: rev, tasks: [] })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: rev, tasks: ["a", "a"] })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: rev, tasks: ["ok id"] })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "run", approve: true, revision: rev, tasks: ["t1", "t2"] }).ok).toBe(true);
	});

	it("handoff notes: non-empty, capped, dash-prefixed is refused (CLI would drop it)", () => {
		expect(validateAction({ kind: "handoff", note: "" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "handoff", note: "-x" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "handoff", note: "x".repeat(2001) })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "handoff", note: "note with  spaces &- but leading-dash refused only" }).ok).toBe(true);
	});

	it("verify + plan shapes", () => {
		expect(validateAction({ kind: "verify", task: "t1" }).ok).toBe(true);
		expect(validateAction({ kind: "verify", task: "" })).toMatchObject({ ok: false, status: 400 });
		expect(validateAction({ kind: "plan" }).ok).toBe(true);
		expect(validateAction({ kind: "plan", prd: "docs/prd.md" }).ok).toBe(true);
		expect(validateAction({ kind: "plan", prd: "a\nb" })).toMatchObject({ ok: false, status: 400 });
	});
});

describe("argv construction: CLI only via argv arrays, never a shell", () => {
	it("maps kinds to the human-typed CLI flags", () => {
		const cli = { argv: ["/kit/dist/cli.js"], via: "test" };
		const rev = "0f0f0f0f-0000-4000-8000-000000000000";
		expect(buildArgv(cli, { kind: "plan" })).toEqual(["/kit/dist/cli.js", "plan"]);
		expect(buildArgv(cli, { kind: "plan", prd: "docs/prd.md" })).toEqual(["/kit/dist/cli.js", "plan", "--prd", "docs/prd.md"]);
		// M0-P06 (A.8): a grant carries --revision plus repeated --tasks per id
		expect(() => buildArgv(cli, { kind: "run", approve: true })).toThrow(/needs revision/); // never degrades to a bare (resume) argv
		expect(buildArgv(cli, { kind: "run", approve: true, revision: rev })).toEqual(["/kit/dist/cli.js", "run", "--approve", "--revision", rev]);
		expect(buildArgv(cli, { kind: "run", approve: true, revision: rev })).toEqual(["/kit/dist/cli.js", "run", "--approve", "--revision", rev]);
		expect(buildArgv(cli, { kind: "run", approve: true, revision: rev, tasks: ["t2", "t3"] })).toEqual(["/kit/dist/cli.js", "run", "--approve", "--revision", rev, "--tasks", "t2", "--tasks", "t3"]);
		// bare `run` is ONLY the explicit resume path
		expect(buildArgv(cli, { kind: "run", resume: true })).toEqual(["/kit/dist/cli.js", "run"]);
		expect(buildArgv(cli, { kind: "verify", task: "t1" })).toEqual(["/kit/dist/cli.js", "verify", "--task", "t1"]);
		expect(buildArgv(cli, { kind: "handoff", note: "keep the gate green" })).toEqual(["/kit/dist/cli.js", "handoff", "keep the gate green"]);
		expect(buildArgv(cli, { kind: "export" })).toEqual(["/kit/dist/cli.js", "export"]);
		expect(buildArgv(cli, { kind: "stop" })).toEqual([]);
	});

	it("resolves the CLI from the host descriptor only — KIT_UI_CLI_BIN, target .bin and PATH cannot win", async () => {
		const project = await mkdtemp(join(tmpdir(), "ui-target-"));
		const pathDir = await mkdtemp(join(tmpdir(), "ui-path-"));
		const trustedDir = await mkdtemp(join(tmpdir(), "ui-trusted-"));
		try {
			// every losing candidate is a real executable: prove none is selected
			await mkdir(join(project, "node_modules", ".bin"), { recursive: true });
			const targetBin = join(project, "node_modules", ".bin", "llm-toolkit-001");
			await writeFile(targetBin, "#!/bin/sh\nexit 0\n", "utf8");
			await chmod(targetBin, 0o755);
			const pathBin = join(pathDir, "llm-toolkit-001");
			await writeFile(pathBin, "#!/bin/sh\nexit 0\n", "utf8");
			await chmod(pathBin, 0o755);
			const trusted = join(trustedDir, "cli.js");
			await writeFile(trusted, "// trusted cli\n", "utf8");
			await chmod(trusted, 0o755);
			const node = await trustedNodeFixture();
			const installation = selectInstallation({
				execPath: node,
				installation: { cli: trusted, node },
			});

			const saved = { KIT_UI_CLI_BIN: process.env["KIT_UI_CLI_BIN"], PATH: process.env["PATH"] };
			process.env["KIT_UI_CLI_BIN"] = pathBin;
			process.env["PATH"] = `${pathDir}:${saved.PATH ?? ""}`;
			try {
				const resolved = await resolveCli(project, installation);
				expect(resolved.argv).toEqual([node, trusted]);
				expect(resolved.via).toMatch(/trusted installation/);
				expect(resolved.argv.join(" ")).not.toContain(targetBin);
				expect(resolved.argv.join(" ")).not.toContain(pathBin);
				expect(resolved.identity).toMatchObject({
					version: 1,
					tool: "cli",
					form: "built",
					node,
					entry: trusted,
					argvPrefix: [node, trusted],
				});
				expect(resolved.identity.descriptorSha256).toMatch(/^[0-9a-f]{64}$/);
				expect(existsSync(targetBin)).toBe(true); // never executed, just never selected
			} finally {
				if (saved.KIT_UI_CLI_BIN === undefined) delete process.env["KIT_UI_CLI_BIN"];
				else process.env["KIT_UI_CLI_BIN"] = saved.KIT_UI_CLI_BIN;
				if (saved.PATH === undefined) delete process.env["PATH"];
				else process.env["PATH"] = saved.PATH;
			}
		} finally {
			await rm(pathDir, { recursive: true, force: true });
			await rm(trustedDir, { recursive: true, force: true });
			await rm(project, { recursive: true, force: true });
		}
	});

	it("refuses an invalid selected entry without falling back to a target/PATH/KIT_UI_CLI_BIN candidate", async () => {
		const project = await mkdtemp(join(tmpdir(), "ui-target-"));
		const later = await mkdtemp(join(tmpdir(), "ui-later-"));
		const marker = join(project, "forbidden-marker.txt");
		try {
			// VALID fallback candidates exist at every legacy source; the selected
			// (invalid) entry must still refuse and none may execute.
			await mkdir(join(project, "node_modules", ".bin"), { recursive: true });
			const targetBin = join(project, "node_modules", ".bin", "llm-toolkit-001");
			await writeFile(targetBin, `#!/bin/sh\ntouch "${marker}"\n`, "utf8");
			await chmod(targetBin, 0o755);
			const envBin = join(later, "env-cli.mjs");
			await writeFile(envBin, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "env");\n`, "utf8");
			const missing = join(later, "missing-cli.js");
			const node = await trustedNodeFixture();
			const installation = selectInstallation({
				execPath: node,
				installation: { cli: missing, node },
			});
			const saved = { KIT_UI_CLI_BIN: process.env["KIT_UI_CLI_BIN"], PATH: process.env["PATH"] };
			process.env["KIT_UI_CLI_BIN"] = envBin;
			process.env["PATH"] = `${later}:${saved.PATH ?? ""}`;
			try {
				await expect(resolveCli(project, installation)).rejects.toMatchObject({ code: "not-found" });
				expect(existsSync(marker)).toBe(false); // zero executions
			} finally {
				if (saved.KIT_UI_CLI_BIN === undefined) delete process.env["KIT_UI_CLI_BIN"];
				else process.env["KIT_UI_CLI_BIN"] = saved.KIT_UI_CLI_BIN;
				if (saved.PATH === undefined) delete process.env["PATH"];
				else process.env["PATH"] = saved.PATH;
			}
		} finally {
			await rm(later, { recursive: true, force: true });
			await rm(project, { recursive: true, force: true });
		}
	});
});

describe("exit-code mapping", () => {
	it("0/42/130 → exited; anything else failed", () => {
		expect(statusForExit(0)).toBe("exited");
		expect(statusForExit(42)).toBe("exited");
		expect(statusForExit(130)).toBe("exited");
		expect(statusForExit(1)).toBe("failed");
		expect(statusForExit(7)).toBe("failed");
	});
});

describe("actions over HTTP: auth + validation + conflict + lifecycle", () => {
	let baked: Baked;

	beforeEach(async () => {
		baked = await bake({ skipJobSweep: false });
	});

	afterEach(async () => {
		await cleanup(baked);
	});

	it("mutations: 401 without cookie; 403 wrong/missing X-Kit-Token; 403 cross-origin", async () => {
		const noCookie = await postAction(baked.base, "", { kind: "plan" });
		expect(noCookie.status).toBe(401);
		expect(((await noCookie.json()) as { error: string }).error).toMatch(/reopen the URL/i);

		const missingHeader = await postAction(baked.base, baked.cookie, { kind: "plan" });
		expect(missingHeader.status).toBe(403);
		expect(((await missingHeader.json()) as { error: string }).error).toMatch(/X-Kit-Token/);

		const wrongHeader = await postAction(baked.base, baked.cookie, { kind: "plan" }, { "x-kit-token": "other" });
		expect(wrongHeader.status).toBe(403);

		const crossOrigin = await postAction(baked.base, baked.cookie, { kind: "plan" }, { ...actionHeaders(baked.csrf), origin: "http://evil.example:80" });
		expect(crossOrigin.status).toBe(403);
		expect(((await crossOrigin.json()) as { error: string }).error).toMatch(/not this server's origin/i);

		// the happy same-origin path (what the SPA sends)
		const sameOrigin = await postAction(baked.base, baked.cookie, { kind: "handoff", note: "probe" }, { ...actionHeaders(baked.csrf), origin: baked.base, "sec-fetch-site": "same-origin" });
		expect(sameOrigin.status).toBe(202);
	});

	it("validation errors surface as 400 with plain words; malformed JSON too", async () => {
		const badKind = await postAction(baked.base, baked.cookie, { kind: "delivery" }, actionHeaders(baked.csrf));
		expect(badKind.status).toBe(400);
		const badField = await postAction(baked.base, baked.cookie, { kind: "plan", referer: "x" }, actionHeaders(baked.csrf));
		expect(badField.status).toBe(400);
		const badJson = await postAction(baked.base, baked.cookie, "{not json", actionHeaders(baked.csrf));
		expect(badJson.status).toBe(400);
	});

	it("plan → detached job record → log tail → exit path (stub CLI)", async () => {
		const accept = await postAction(baked.base, baked.cookie, { kind: "plan", prd: "docs/prd.md" }, actionHeaders(baked.csrf));
		expect(accept.status).toBe(202);
		const { jobId, kind, via } = (await accept.json()) as { jobId: string; kind: string; via: string };
		expect(kind).toBe("plan");
		expect(via).toMatch(/trusted installation/);

		const job = (await waitFor(() => readJobRecord(baked.root, jobId), (j) => j !== undefined && j.status !== "running", 8_000))!;
		expect(job.status).toBe("exited");
		expect(job.exitCode).toBe(0);
		expect(job.endedAt).toBeGreaterThan(job.startedAt);
		expect(job.cwd).toBe(baked.root);
		// record argv is the trusted launch identity prefix + the human-typed flags
		expect(job.argv).toEqual([baked.node, baked.stubCli, "plan", "--prd", "docs/prd.md"]);
		// M1-P01 step (f): the record persists the canonical descriptor/argv identity
		expect(job.identity).toMatchObject({
			version: 1,
			tool: "cli",
			form: "built",
			node: baked.node,
			entry: baked.stubCli,
			argvPrefix: [baked.node, baked.stubCli],
		});
		expect(job.identity!.descriptorSha256).toMatch(/^[0-9a-f]{64}$/);
		expect(job.identity!.installationRoot).toMatch(/^\//);
		expect(job.argv.slice(0, job.identity!.argvPrefix.length)).toEqual(job.identity!.argvPrefix);

		const log = await fetch(`${baked.base}/api/jobs/${jobId}/log?n=5`, { headers: { cookie: baked.cookie } });
		expect(log.status).toBe(200);
		const { lines } = (await log.json()) as { lines: string[] };
		expect(lines.join("\n")).toContain("PLANNED");

		// jobs list route
		const list = await fetch(`${baked.base}/api/jobs`, { headers: { cookie: baked.cookie } });
		const payload = (await list.json()) as { jobs: { id: string }[] };
		expect(payload.jobs.map((j) => j.id)).toContain(jobId);
		expect(existsSync(join(baked.root, ".orch", "ui", "jobs", `${jobId}.json`))).toBe(true);
	});

	it("a failing stub becomes status failed with exitCode; second mutating job while running → 409", async () => {
		const accept = await postAction(baked.base, baked.cookie, { kind: "verify", task: "t1" }, actionHeaders(baked.csrf));
		expect(accept.status).toBe(202);
		await waitFor(async () => (await jobsList(baked.root))[0]!, (j) => j.status !== "running", 8_000);
		// After the successful verify the queue drains; start a die-ing export:
		const die = await startAction(baked.root, { kind: "export" });
		expect(die.ok).toBe(true);
		if (die.ok) {
			const job = (await waitFor(() => readJobRecord(baked.root, die.job.id), (j) => j !== undefined && (j.status === "failed" || j.status === "exited"), 8_000))!;
			expect(job.status).toBe("failed"); // die → exit 7
			expect(job.exitCode).toBe(7);
		}
		// Now hold one open (stub run blocks until SIGINT) and check the one-mutation rule.
		const holder = await startAction(baked.root, { kind: "run", approve: true, revision: "0f0f0f0f-0000-4000-8000-000000000000" });
		expect(holder.ok).toBe(true);
		const second = await postAction(baked.base, baked.cookie, { kind: "plan" }, actionHeaders(baked.csrf));
		expect(second.status).toBe(409);
		const body = (await second.json()) as { error: string; jobId?: string };
		expect(body.error).toMatch(/one mutating job/);
		// stop the holder (SIGINT → 130, recorded)
		const stop = await postAction(baked.base, baked.cookie, { kind: "stop" }, actionHeaders(baked.csrf));
		expect(stop.status).toBe(202);
		if (holder.ok) {
			const holderJob = (await waitFor(() => readJobRecord(baked.root, holder.job.id), (j) => j !== undefined && (j.status === "exited" || j.status === "failed"), 8_000))!;
			expect(holderJob.status).toBe("exited");
			expect(holderJob.exitCode).toBe(130);
		}
	});

	it("handoff is allowed during a run (side-car write, no lock needed)", async () => {
		const run = await startAction(baked.root, { kind: "run", approve: true, revision: "0f0f0f0f-0000-4000-8000-000000000000" });
		expect(run.ok).toBe(true);
		try {
			const accept = await postAction(baked.base, baked.cookie, { kind: "handoff", note: "watch the gate" }, actionHeaders(baked.csrf));
			expect(accept.status).toBe(202);
			const handoffJob = (await waitFor(async () => (await jobsList(baked.root)).find((j) => j.kind === "handoff")!, (j) => j.status !== "running", 8_000))!;
			expect(handoffJob.status).toBe("exited");
			expect(handoffJob.argv[handoffJob.argv.length - 1]).toBe("watch the gate");
			// the note rode the argv (the real CLI writes .orch/pending-handoff.json — see demo e2e)
			const tail = await tailJobLog(handoffJob.logPath, 20);
			expect(tail.join("\n")).toContain("handoff note queued for the next wave: watch the gate");
		} finally {
			if (run.ok) await stopAction(baked.root); // SIGINT the run job
		}
	});

	it("stop with no UI job but a foreign lock holder → 409 with the terminal hint", async () => {
		// fake a live attached run: a real sleeper pid owning .orch/lock (+ a status flush)
		const sleeper = spawnSleeper(6);
		try {
			await writeFile(join(baked.root, ".orch", "lock"), `${sleeper.pid}\n${new Date().toISOString()}\n`, "utf8");
			await writeFile(
				join(baked.root, ".orch", "status.json"),
				JSON.stringify({ lockedByPid: sleeper.pid, phase: "wave-running", ts: Date.now() }),
				"utf8",
			);
			const stop = await postAction(baked.base, baked.cookie, { kind: "stop" }, actionHeaders(baked.csrf));
			expect(stop.status).toBe(409);
			const body = (await stop.json()) as { error: string };
			expect(body.error).toMatch(/from its terminal/);
		} finally {
			sleeper.child.kill("SIGKILL");
		}
	});

	it("stop with nothing running at all → 409 plain", async () => {
		const stop = await postAction(baked.base, baked.cookie, { kind: "stop" }, actionHeaders(baked.csrf));
		expect(stop.status).toBe(409);
		expect(((await stop.json()) as { error: string }).error).toMatch(/nothing is running/);
	});

	it("/api/jobs synthesizes the attached entry from a live status.json pid", async () => {
		const sleeper = spawnSleeper(6);
		try {
			await writeFile(
				join(baked.root, ".orch", "status.json"),
				JSON.stringify({ lockedByPid: sleeper.pid, phase: "wave-running", task: { id: "t1", wave: 2, status: "running" }, ts: Date.now() }),
				"utf8",
			);
			const payload = await waitFor(async () => {
				const res = await fetch(`${baked.base}/api/jobs`, { headers: { cookie: baked.cookie } });
				return (await res.json()) as { attached?: { pid: number; phase: string }; jobs: unknown[] };
			}, (p) => p.attached !== undefined, 4_000);
			expect(payload.attached?.pid).toBe(sleeper.pid);
			expect(payload.attached?.phase).toBe("wave-running");
		} finally {
			sleeper.child.kill("SIGKILL");
		}
	});

	it("a dead-pid running record goes stale on the next server start (the same root, second server)", async () => {
		const first = await bake({ skipJobSweep: false });
		// leave a bogus "running" record with an impossible pid
		const ghostJob = join(first.root, ".orch", "ui", "jobs");
		await mkdir(ghostJob, { recursive: true });
		await writeFile(
			join(ghostJob, "ghost-1.json"),
			JSON.stringify({ id: "ghost-1", kind: "plan", argv: ["x"], cwd: first.root, pid: 2_999_999_999, startedAt: Date.now(), status: "running", logPath: join(ghostJob, "ghost-1.log") }),
			"utf8",
		);
		const marked = await markStaleRecords(first.root);
		expect(marked).toBe(1);
		const record = await readJobRecord(first.root, "ghost-1");
		expect(record?.status).toBe("stale");
		await first.running.shutdown().catch(() => {});
		await rm(first.root, { recursive: true, force: true }).catch(() => {});
	});

	it("prune keeps the newest max and drops old records with their logs", async () => {
		const now = Date.now();
		const ageMs = 14 * 24 * 60 * 60_000;
		const jobDir = join(baked.root, ".orch", "ui", "jobs");
		await mkdir(jobDir, { recursive: true });
		const seeds: Array<[string, number]> = [
			["old-1", now - ageMs - 1],
			["mid-1", now - 3 * 3600_000],
			["new-1", now - 100],
		];
		for (const [id, startedAt] of seeds) {
			const argv = [baked.stubCli, "plan"];
			const argvJson = JSON.stringify(argv);
			await writeFile(
				join(jobDir, `${id}.json`),
				`{"id":${JSON.stringify(id)},"kind":"plan","argv":${argvJson},"cwd":${JSON.stringify(baked.root)},"pid":null,"startedAt":${startedAt},"status":"exited","logPath":${JSON.stringify(join(jobDir, id + ".log"))}}`,
				"utf8",
			);
			await writeFile(join(jobDir, `${id}.log`), `${id} log\n`, "utf8");
		}
		const dropped = await pruneJobs(baked.root, 2, ageMs);
		expect(dropped).toBe(1);
		expect(existsSync(join(jobDir, "old-1.json"))).toBe(false);
		expect(existsSync(join(jobDir, "old-1.log"))).toBe(false);
		expect(existsSync(join(jobDir, "mid-1.json"))).toBe(true);
		expect(existsSync(join(jobDir, "new-1.json"))).toBe(true);
	});
});

describe("trusted launch identity + runner refusal (M1-P01 step (f))", () => {
	const RUNNER = join(import.meta.dirname, "..", "server", "job-runner.mjs");

	/** Run the real detached runner against one record and wait for it to exit. */
	async function runRunner(recordPath: string): Promise<number | null> {
		const child = spawn(process.execPath, [RUNNER, "--record", recordPath], { stdio: "ignore" });
		return await new Promise((done) => child.once("exit", (code) => done(code)));
	}

	it("an invalid selected CLI refuses the action with no job record and no forbidden execution", async () => {
		const baked = await bake({ skipJobSweep: true });
		try {
			const marker = join(baked.root, "target-bin-ran.txt");
			await mkdir(join(baked.root, "node_modules", ".bin"), { recursive: true });
			const targetBin = join(baked.root, "node_modules", ".bin", "llm-toolkit-001");
			await writeFile(targetBin, `#!/bin/sh\ntouch "${marker}"\n`, "utf8");
			await chmod(targetBin, 0o755);
			const invalid = selectInstallation({
				execPath: baked.node,
				installation: { cli: join(baked.stubDir, "missing-cli.js"), node: baked.node },
			});
			const result = await startAction(baked.root, { kind: "plan", prd: "docs/prd.md" }, invalid);
			expect(result.ok).toBe(false);
			if (!result.ok) {
				expect(result.fail.status).toBe(500);
				expect(result.fail.error).toMatch(/trusted CLI entry is refused/);
				expect(result.fail.error).toMatch(/not-found/);
			}
			expect(await jobsList(baked.root)).toHaveLength(0); // zero records ⇒ zero spawns
			expect(existsSync(marker)).toBe(false); // never fell back to the target .bin
		} finally {
			await cleanup(baked);
		}
	});

	it("the runner refuses a tampered, foreign or identity-less record BEFORE any spawn", async () => {
		const baked = await bake({ skipJobSweep: true });
		try {
			const marker = join(baked.root, "runner-spawned.txt");
			const markerStub = join(baked.stubDir, "marker-cli.mjs");
			await writeFile(markerStub, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`, "utf8");
			const launched = await startAction(baked.root, { kind: "plan", prd: "docs/prd.md" });
			expect(launched.ok).toBe(true);
			if (!launched.ok) return;
			const real = (await waitFor(() => readJobRecord(baked.root, launched.job.id), (j) => j !== undefined && j.status !== "running", 8_000))!;
			const identity = JSON.parse(JSON.stringify(real.identity)) as typeof real.identity;
			expect(identity?.argvPrefix?.[1]).toBe(baked.stubCli);

			const dir = join(baked.root, ".orch", "ui", "jobs");
			await mkdir(dir, { recursive: true });
			const cases: { id: string; record: Record<string, unknown> }[] = [
				{
					id: "tampered-1",
					record: { argv: [baked.node, markerStub, "plan"], identity },
				},
				{
					id: "foreign-1",
					record: { argv: [baked.node, baked.stubCli, "plan"], identity: { ...identity!, installationRoot: "/srv/other-kit" } },
				},
				{ id: "naked-1", record: { argv: [baked.node, markerStub, "plan"] } },
			];
			for (const { id, record } of cases) {
				const recordPath = join(dir, `${id}.json`);
				await writeFile(
					recordPath,
					JSON.stringify({ id, kind: "plan", cwd: baked.root, startedAt: Date.now(), status: "running", logPath: join(dir, `${id}.log`), ...record }),
					"utf8",
				);
				expect(await runRunner(recordPath)).toBe(0);
				const after = await readJobRecord(baked.root, id);
				expect(after).toMatchObject({ status: "failed", exitCode: 127 });
				expect(after?.detail).toMatch(/refused/);
				expect(after?.pid).toBeUndefined(); // no CLI child was ever spawned
				expect(existsSync(join(dir, `${id}.log`))).toBe(false); // refused before the log/spawn
			}
			expect(existsSync(marker)).toBe(false); // zero recorded-argv substitutions executed
		} finally {
			await cleanup(baked);
		}
	});

	it("a job env keeps KIT_FAUX*/provider settings and drops every executable selector", async () => {
		expect(
			jobEnvironment({
				KIT_FAUX: "1",
				KIT_FAUX_SCRIPT: "smoke.replay",
				KIT_UI_CLI_BIN: "/target/.bin/llm-toolkit-001",
				KIT_OTHER: "x",
				NODE_OPTIONS: "--require /tmp/evil.cjs",
				LD_PRELOAD: "/tmp/evil.so",
				ANTHROPIC_API_KEY: "key",
				PATH: "/usr/bin:/bin",
			}),
		).toEqual({ KIT_FAUX: "1", KIT_FAUX_SCRIPT: "smoke.replay", ANTHROPIC_API_KEY: "key", PATH: "/usr/bin:/bin" });

		const baked = await bake({ skipJobSweep: true });
		const saved: Record<string, string | undefined> = {};
		for (const name of ["KIT_FAUX", "KIT_FAUX_SCRIPT", "KIT_UI_CLI_BIN", "KIT_OTHER", "NODE_OPTIONS", "LD_PRELOAD"]) saved[name] = process.env[name];
		try {
			Object.assign(process.env, {
				KIT_FAUX: "1",
				KIT_FAUX_SCRIPT: "smoke.replay",
				KIT_UI_CLI_BIN: join(baked.root, "node_modules", ".bin", "llm-toolkit-001"),
				KIT_OTHER: "x",
				NODE_OPTIONS: "--require /tmp/evil.cjs",
				LD_PRELOAD: "/tmp/evil.so",
			});
			const { identity } = await resolveCli(baked.root, baked.installation);
			const names = ["KIT_FAUX", "KIT_FAUX_SCRIPT", "KIT_UI_CLI_BIN", "NODE_OPTIONS", "LD_PRELOAD", "KIT_OTHER"];
			const job = await spawnJob(baked.root, {
				kind: "handoff",
				spawnedArgv: [...identity.argvPrefix, "env", ...names],
				identity,
				cwd: baked.root,
			});
			const finished = (await waitFor(() => readJobRecord(baked.root, job.id), (j) => j !== undefined && j.status !== "running", 8_000))!;
			expect(finished).toMatchObject({ status: "exited", exitCode: 0 });
			const env = JSON.parse((await tailJobLog(finished.logPath, 20)).join("\n")) as Record<string, string | null>;
			expect(env).toEqual({
				KIT_FAUX: "1",
				KIT_FAUX_SCRIPT: "smoke.replay",
				KIT_UI_CLI_BIN: null,
				NODE_OPTIONS: null,
				LD_PRELOAD: null,
				KIT_OTHER: null,
			});
		} finally {
			for (const [name, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
			await cleanup(baked);
		}
	});
});

describe("lock-busy 409 over HTTP", () => {
	it("mutating job refused while a live holder owns .orch/lock", async () => {
		const baked = await bake({ skipJobSweep: true });
		try {
			const sleeper = spawnSleeper(6);
			try {
				await writeFile(
					join(baked.root, ".orch", "lock"),
					`${sleeper.pid}\n${new Date().toISOString()}\n`,
					"utf8",
				);
				const plan = await postAction(baked.base, baked.cookie, { kind: "plan" }, actionHeaders(baked.csrf));
				expect(plan.status).toBe(409);
				const body = (await plan.json()) as { error: string; holderPid?: number; phase?: string };
				expect(body.holderPid).toBe(sleeper.pid);
				expect(body.error).toMatch(/held by pid/);
			} finally {
				sleeper.child.kill("SIGKILL");
			}
		} finally {
			await baked.running.shutdown().catch(() => {});
			await rm(baked.root, { recursive: true, force: true }).catch(() => {});
		}
	});
});
