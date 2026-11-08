/**
 * Diff parser unit tests (PRD §15.1): hunks w/ kind coloring data, binary
 * entries, per-file +/- counts, rename-less paths, truncation tolerance — plus
 * the PRD's "task diff (cumulative since baseline, N waves)" label.
 */
import { describe, expect, it } from "vitest";
import { parseUnifiedDiff, cumulativeLabel, statusLabel, DIFF_FILE_LINE_CAP, type DiffHunk } from "../src/lib/diff.ts";

const SIMPLE = `diff --git a/src/list.ts b/src/list.ts
index 1111111..2222222 100644
--- a/src/list.ts
+++ b/src/list.ts
@@ -1,3 +1,4 @@
 export function parseList(s: string): string[] {
-  return s.split("/");
+  return s.split("/").filter(Boolean);
+  // tidy
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const NEW = 1;
+export const TWO = 2;
diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-export const OLD = 1;
`;

describe("parseUnifiedDiff", () => {
	it("splits files; context/add/del lines counted per file", () => {
		const parsed = parseUnifiedDiff(SIMPLE);
		expect(parsed.files.map((f) => f.path)).toEqual(["src/list.ts", "src/new.ts", "src/gone.ts"]);
		const list = parsed.files[0]!;
		expect(list.hunks).toHaveLength(1);
		const kinds = list.hunks[0]!.lines.map((l) => l.kind);
		expect(kinds).toEqual(["ctx", "del", "add", "add", "ctx"]);
		expect(list.insertions).toBe(2);
		expect(list.deletions).toBe(1);

		const added = parsed.files[1]!;
		expect(added.added).toBe(true);
		expect(added.hunks[0]!.lines.every((l) => l.kind === "add")).toBe(true);
		expect(added.insertions).toBe(2);

		const gone = parsed.files[2]!;
		expect(gone.deleted).toBe(true);
		expect(gone.deletions).toBe(1);
		expect(gone.hunks[0]!.lines[0]).toEqual({ kind: "del", text: "export const OLD = 1;" });
	});

	it("adds keep their + prefix stripped from line text; kind coloring data intact", () => {
		const parsed = parseUnifiedDiff(SIMPLE);
		const lines = parsed.files[0]!.hunks[0]!.lines;
		expect(lines[1]).toEqual({ kind: "del", text: '  return s.split("/");' });
		expect(lines[2]).toEqual({ kind: "add", text: '  return s.split("/").filter(Boolean);' });
	});

	it("labels binary files (GIT binary patch) with no hunks", () => {
		const binary = `diff --git a/asset/logo.png b/asset/logo.png
index 0000000..abcdf123 100644
Binary files a/asset/logo.png and b/asset/logo.png differ
`;
		const parsed = parseUnifiedDiff(binary);
		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0]!.binary).toBe(true);
		expect(parsed.files[0]!.hunks).toHaveLength(0);
	});

	it("labels binary files (GIT binary patch) with no hunks", () => {
		const binary = `diff --git a/asset/logo.png b/asset/logo.png
index 0000000..abcdf123 100644
GIT binary patch
literal 10
YmluYXJ5*data
`;
		const parsed = parseUnifiedDiff(binary);
		expect(parsed.files).toHaveLength(1);
		expect(parsed.files[0]!.binary).toBe(true);
		expect(parsed.files[0]!.hunks).toHaveLength(0);
	});

	it("parses a truncated patch (cut mid-hunk) without throwing; flags the tail", () => {
		const head = SIMPLE.slice(0, Math.floor(SIMPLE.length * 0.35));
		const parsed = parseUnifiedDiff(head);
		expect(parsed.files.length).toBeGreaterThan(0);
		expect(parsed.truncated).toBe(true);
	});

	it("empty/empty-ish input parses to no files", () => {
		expect(parseUnifiedDiff("").files).toEqual([]);
		expect(parseUnifiedDiff("nothing useful\n").files).toEqual([]);
	});
});

describe("labels + caps", () => {
	it("the cumulative-since-baseline label reports waves", () => {
		expect(cumulativeLabel(1)).toBe("task diff (cumulative since baseline, 1 wave)");
		expect(cumulativeLabel(2)).toBe("task diff (cumulative since baseline, 2 waves)");
		expect(cumulativeLabel(0)).toBe("task diff (cumulative since baseline, 1 wave)");
	});

	it("status letters label plainly", () => {
		expect(statusLabel("A")).toBe("added");
		expect(statusLabel("M")).toBe("modified");
		expect(statusLabel("D")).toBe("deleted");
	});

	it("the per-file render cap is the PRD's 2,000 lines", () => {
		expect(DIFF_FILE_LINE_CAP).toBe(2000);
	});

	it("a long hunk renders capped (viewer contract via parsed data)", () => {
		const many = Array.from({ length: 2500 }, (_, i) => `+filler ${i}`).join("\n");
		const patch = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -0,0 +1,2500 @@
${many}`;
		const parsed = parseUnifiedDiff(patch);
		const file = parsed.files[0]!;
		const hunk: DiffHunk = file.hunks[0]!;
		expect(file.insertions).toBe(2500);
		expect(hunk.lines).toHaveLength(2500); // parser keeps data; the VIEWER caps rendering
	});
});
