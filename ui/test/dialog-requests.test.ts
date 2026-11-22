/**
 * Dialog request builders (ui/PRD.md §7.2/§7.2.1, A.8): the one wording source
 * ActionBar/App/JobList share. Runs capture the exact {planRevision, selected}
 * tuple when the dialog OPENS (M0-P06) and confirm exactly that tuple — no
 * live-selection re-read, no fallthrough to run-all; bare `run` is reserved
 * for the explicit resume. Stop requests name their target: a UI job names its
 * record; the attached terminal-started run is only offered behind its
 * verified identity (pid + command + the Ctrl-C/exit-130 promise); an
 * unverified attachment states the reason and signals nothing.
 */
import { describe, expect, it } from "vitest";
import { actionRequestToBody, describeRunRequest, describeStopTarget, stopAcceptedLine } from "../src/lib/dialog-requests.ts";
import type { JobsPayload } from "../src/lib/api.ts";
import type { AttachedRun } from "../server/jobs.ts";

const REV = "1b08d7ce-1111-4aaa-8bbb-cccccccccccc";

function payload(over: Partial<JobsPayload> & { attached?: AttachedRun }): JobsPayload {
	return { at: Date.now(), jobs: over.jobs ?? [], ...(over.attached !== undefined ? { attached: over.attached } : {}) };
}

describe("describeRunRequest (M0-P06: the tuple is captured at open time)", () => {
	it("run-all captures the revision and EVERY todo id verbatim as the confirmed tuple", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a", "b", "c"], selection: [], quarantinedCount: 0, withTasks: false });
		expect(req.kind).toBe("run-all");
		expect(req.revision).toBe(REV);
		expect(req.tasks).toEqual(["a", "b", "c"]);
		expect(req.title).toBe("Approve & run");
		expect(req.confirmLabel).toBe("Approve & run (3)");
		expect(req.body).toContain("all 3 todo task(s)");
		expect(req.body).toContain(REV); // the revision echo (A.8) names the identity
	});

	it("run-selected captures the CHECKED ids at open time, not the live selection", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a", "b", "c"], selection: ["b", "c"], quarantinedCount: 0, withTasks: true });
		expect(req.kind).toBe("run-selected");
		expect(req.tasks).toEqual(["b", "c"]);
		expect(req.body).toContain("only the selected 2 task(s)");
		expect(req.confirmLabel).toBe("Approve & run (2)");
	});

	it("run-selected narrows to ids still todo at open time (the safe selection guard)", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a", "b", "c"], selection: ["b", "ghost"], quarantinedCount: 0, withTasks: true });
		expect(req.kind).toBe("run-selected");
		expect(req.tasks).toEqual(["b"]);
	});

	it("a checked set equal to all todo is worded as run-all (same tuple either way)", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a", "b"], selection: ["a", "b"], quarantinedCount: 0, withTasks: true });
		expect(req.kind).toBe("run-all");
		expect(req.tasks).toEqual(["a", "b"]);
	});

	it("quarantined tasks say they will NOT run", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a"], selection: [], quarantinedCount: 2, withTasks: false });
		expect(req.title).toMatch(/quarantined/);
		expect(req.body).toContain("2 already-quarantined task(s) will NOT run");
	});

	it("absent review identity throws — no approval without a revision, no fallthrough", () => {
		expect(() => describeRunRequest({ revision: undefined, todoIds: ["a"], selection: [], quarantinedCount: 0, withTasks: false })).toThrow(/no plan revision/);
	});

	it("an empty selection throws — an empty request never becomes run-all", () => {
		expect(() => describeRunRequest({ revision: REV, todoIds: [], selection: [], quarantinedCount: 0, withTasks: false })).toThrow(/selection is empty/);
		expect(() => describeRunRequest({ revision: REV, todoIds: ["a", "b"], selection: ["ghost"], quarantinedCount: 0, withTasks: true })).toThrow(/selection is empty/);
	});
});

describe("actionRequestToBody (M0-P06: confirm exactly the captured tuple)", () => {
	it("a run dialog confirms its own revision + tasks — repeated --tasks per id on the wire", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a", "b", "c"], selection: [], quarantinedCount: 0, withTasks: false });
		expect(actionRequestToBody(req, {})).toEqual({ kind: "run", approve: true, revision: REV, tasks: ["a", "b", "c"] });
	});

	it("the LIVE selection is irrelevant to a run confirmation: a stale snapshot still confirms its own ids", () => {
		const req = describeRunRequest({ revision: REV, todoIds: ["a", "b", "c"], selection: ["a"], quarantinedCount: 0, withTasks: true });
		// a replan/selection change behind the dialog never mutates the request
		expect(actionRequestToBody(req, {})).toEqual({ kind: "run", approve: true, revision: REV, tasks: ["a"] });
	});

	it("an empty or absent tuple is refused at confirm time — never widened to all", () => {
		expect(() => actionRequestToBody({ kind: "run-all", title: "t", body: "b", confirmLabel: "c" }, {})).toThrow(/no plan revision/);
		expect(() => actionRequestToBody({ kind: "run-selected", title: "t", body: "b", confirmLabel: "c", revision: REV, tasks: [] }, {})).toThrow(/selection is empty/);
	});

	it("resume confirms to a bare run body — no approval, no tasks, no revision", () => {
		expect(actionRequestToBody({ kind: "resume", title: "t", body: "b", confirmLabel: "c" }, {})).toEqual({ kind: "run", resume: true });
	});

	it("plan + handoff keep their typed fields; unknown kinds stay impossible", () => {
		expect(actionRequestToBody({ kind: "plan", title: "t", body: "b", confirmLabel: "c", prd: "docs/prd.md" }, { prd: "other.md" })).toEqual({ kind: "plan", prd: "other.md" });
		expect(actionRequestToBody({ kind: "handoff", title: "t", body: "b", confirmLabel: "c", note: "" }, { note: "watch the gate" })).toEqual({ kind: "handoff", note: "watch the gate" });
	});
});

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
		expect(actionRequestToBody(req, {})).toEqual({ kind: "stop" });
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
		expect(actionRequestToBody(req, {})).toEqual({ kind: "stop", target: "attached", pid: 909 });
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
		expect(actionRequestToBody(req, {})).toEqual({ kind: "stop" });
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
