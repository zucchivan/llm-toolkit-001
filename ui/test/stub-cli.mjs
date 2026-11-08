#!/usr/bin/env node
// Stub CLI for job-runner tests: no llm-toolkit-001 needed. Behaviors keyed by argv:
//   plan                → prints "PLANNED — 3 task(s)" and exits 0 (after a configurable delay)
//   run --approve …     → prints a wave of output, optionally blocks (SIGINT → exit 130)
//   verify --task id    → prints a verdict JSON, exits 0
//   export              → prints "exported", exits 0
//   handoff note        → prints "queued", exits 0
//   die                 → exits 7 (failed mapping)
//   sleep <sec>         → sleeps that long, then exits 0 (runner-liveness tests)
const args = process.argv.slice(2);
const cmd = args[0] ?? "";
const sleepFor = (ms) => new Promise((done) => setTimeout(done, ms));

if (cmd === "die") {
	console.error("stub: something went wrong");
	process.exit(7);
}
if (cmd === "sleep") {
	await sleepFor(Number(args[1] ?? "1") * 1000);
	console.log(`stub: slept ${args[1]}s`);
	process.exit(0);
}
if (cmd === "verify") {
	console.log(JSON.stringify({ verdict: "approve", criteria: [{ id: "1", status: "pass" }], notes: "stub" }, null, 2));
	process.exit(0);
}
if (cmd === "export") {
	console.log("exported: .orch/artifacts/report.json\n          .orch/artifacts/report.html");
	// the stub exits non-zero on export so the failed-status mapping is testable
	process.exit(7);
}
if (cmd === "handoff") {
	console.log(`handoff note queued for the next wave: ${args[1] ?? ""}`);
	process.exit(0);
}
if (cmd === "run") {
	console.log("▶ wave start: stub-task #w1");
	// interruptible block: SIGINT → the CLI's clean path (exit 130)
	process.on("SIGINT", () => {
		console.log("interrupted — durable state closed cleanly; rerun to resume");
		process.exit(130);
	});
	await sleepFor(30_000); // the test will stop it
	process.exit(0);
}
// plan (with optional delay)
const delayIndex = args.indexOf("--delay");
if (delayIndex >= 0) await sleepFor(Number(args[delayIndex + 1] ?? "0"));
console.log("PLANNED — 3 task(s) written to router.md");
console.log("review the graph, then: run --approve");
process.exit(0);
