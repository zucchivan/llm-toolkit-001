/**
 * Stop-dialog request builders (M5-slice-3, ui/PRD.md §7.2/§7.2.1): the one
 * wording source ActionBar/App/JobList share. A UI job names its record; the
 * attached terminal-started run is only offered behind its verified identity
 * (pid + command + the Ctrl-C/exit-130 promise); an unverified attachment
 * states the reason and signals nothing.
 */
import { describe, expect, it } from "vitest";
import { actionRequestToBody, describeStopTarget, stopAcceptedLine } from "../src/lib/dialog-requests.ts";
import type { JobsPayload } from "../src/lib/api.ts";
import type { AttachedRun } from "../server/jobs.ts";

function payload(over: Partial<JobsPayload> & { attached?: AttachedRun }): JobsPayload {
	return { at: Date.now(), jobs: over.jobs ?? [], ...(over.attached !== undefined ? { attached: over.attached } : {}) };
}

describe("describeStopTarget", () => {
	it("a running UI job wins and names its record (unchanged path)", () => {
		const jobs = payload({
			jobs: [
				{ id: "j1", kind: "run", argv: [], cwd: ".", pid: 4242, startedAt: 20, status: "running", logPath: "x" },
				{ id: "j0", kind: "run", argv: [], cwd: ".", pid: 1, startedAt: 2, status: "running", logPath: "x" },
			],
		});
		const req = describeStopTarget(jobs);
		expect(req.kind).toBe("stop");
		expect(req.title).toBe("Stop");
		expect(req.confirmLabel).toBe("Stop job");
		expect(req.body).toContain("job j1");
		expect(req.body).toContain("pid 4242");
		expect(req.target).toBeUndefined();
		expect(actionRequestToBody(req, {}, [])).toEqual({ kind: "stop" });
	});

	it("an attached run with a verified identity names pid + command + the SIGINT promise", () => {
		const jobs = payload({
			attached: { pid: 909, phase: "wave-running", startedAt: 1, ts: 1, stop: { ok: true, pid: 909, command: "node /repo/bin run --approve" } },
		});
		const req = describeStopTarget(jobs);
		expect(req.kind).toBe("stop");
		expect(req.title).toMatch(/verified/);
		expect(req.body).toContain("pid 909");
		expect(req.body).toContain("node /repo/bin run --approve");
		expect(req.body).toMatch(/Ctrl-C \(SIGINT\) once/);
		expect(req.body).toMatch(/resumable \(exit 130\)/);
		expect(req.target).toBe("attached");
		expect(req.pid).toBe(909);
		expect(actionRequestToBody(req, {}, [])).toEqual({ kind: "stop", target: "attached", pid: 909 });
	});

	it("an unverified attachment states the reason; the confirmed body stays the safe default", () => {
		const jobs = payload({
			attached: {
				pid: 77,
				phase: "wave-running",
				ts: 1,
				stop: { ok: false, pid: 77, reason: "pid 77 is alive but its working directory is /elsewhere, not this project — nothing was signalled" },
			},
		});
		const req = describeStopTarget(jobs);
		expect(req.title).toMatch(/terminal-started/);
		expect(req.body).toContain("pid 77");
		expect(req.body).toContain("nothing will be signalled");
		expect(req.target).toBeUndefined(); // no verified identity → no attached POST possible
		expect(actionRequestToBody(req, {}, [])).toEqual({ kind: "stop" });
	});

	it("no holder at all: the honest nothing variant", () => {
		const req = describeStopTarget(payload({}));
		expect(req.body).toMatch(/no UI job and no live lock holder/);
	});
});

describe("stopAcceptedLine", () => {
	it("UI jobs keep the record line; attached stops name the signalled pid", () => {
		expect(stopAcceptedLine({ kind: "stop", jobId: "j9", pid: 10 })).toBe("stop accepted — job j9");
		expect(stopAcceptedLine({ kind: "stop", pid: 91, target: "attached" })).toBe("stop accepted — SIGINT sent to pid 91");
		expect(stopAcceptedLine({ kind: "run", jobId: "j2" })).toBe("run accepted — job j2");
	});
});
