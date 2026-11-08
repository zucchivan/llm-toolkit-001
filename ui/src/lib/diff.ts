/**
 * Unified-diff parsing for the DiffViewer (§7.4 content): file list with
 * per-file insertion/deletion counts (or the engine's stats side-car numbers
 * when available), binary detection, hunk lines colored add/del/context, and
 * the PMD's rendering caps (first 2000 lines per file, drawer handles the rest).
 * Pure text → data; no DOM, unit-testable.
 */

export type DiffLineKind = "ctx" | "add" | "del";

export interface DiffLine {
	kind: DiffLineKind;
	text: string;
}

export interface DiffHunk {
	/** "@@ -1,3 +1,4 @@" plus any trailing function context */
	header: string;
	lines: DiffLine[];
}

/** One parsed `diff --git` block. */
export interface ParsedDiffFile {
	/** path as shown (new path, b-side; the old side differs for deletes) */
	path: string;
	oldPath?: string;
	/** derived from git's a//b paths when no stats side-car is available */
	added: boolean;
	deleted: boolean;
	/** GIT binary patch / "Binary files … differ" — stats only, never content */
	binary: boolean;
	hunks: DiffHunk[];
	/** +/- counted from the parsed hunks (display fallback when stats are absent) */
	insertions: number;
	deletions: number;
	/** parsing hit the stream end mid-hunk (truncated patch) */
	hitEndOfStream: boolean;
}

export interface ParsedDiff {
	files: ParsedDiffFile[];
	/** true when the patch text was cut (the server caps at 5 MiB) */
	truncated: boolean;
}

const BINARY_MARKERS = ["GIT binary patch", "Binary files "];

/** Split a unified patch into per-file data. Tolerant: truncated/cut patches parse to the cut line. */
export function parseUnifiedDiff(text: string): ParsedDiff {
	const files: ParsedDiffFile[] = [];
	let current: ParsedDiffFile | undefined;
	let hunk: DiffHunk | undefined;
	let truncated = false;

	const startFile = (header: string): void => {
		const paths = parseGitHeaderPaths(header);
		current = {
			path: paths.newPath,
			...(paths.oldPath !== undefined ? { oldPath: paths.oldPath } : {}),
			added: false,
			deleted: false,
			binary: false,
			hunks: [],
			insertions: 0,
			deletions: 0,
			hitEndOfStream: false,
		};
		if (current.path !== "/dev/null") files.push(current);
	};

	for (const raw of text.split("\n")) {
		const line = raw.replace(/\r$/, "");
		if (line.startsWith("diff --git ")) {
			startFile(line);
			hunk = undefined;
			continue;
		}
		if (!current) continue;
		// ---/+++ refine the a/b sides: git says /dev/null there for adds/deletes
		// even when the `diff --git` header names both paths.
		if (line.startsWith("--- ") && !hunk) {
			const p = stripSidePrefix(line.slice(4).trim(), "a/");
			if (p === "/dev/null") current.added = true;
			else current.oldPath ??= p;
			continue;
		}
		if (line.startsWith("+++ ") && !hunk) {
			const p = stripSidePrefix(line.slice(4).trim(), "b/");
			if (p === "/dev/null") current.deleted = true;
			current.path = p === "/dev/null" ? current.path : p;
			continue;
		}
		if (BINARY_MARKERS.some((m) => line.startsWith(m))) {
			current.binary = true;
			hunk = undefined;
			continue;
		}
		if (line.startsWith("@@")) {
			hunk = { header: line, lines: [] };
			current.hunks.push(hunk);
			continue;
		}
		if (hunk) {
			// diff body: context / add / del; "\ No newline at end of file" is a marker, not a line.
			if (line.startsWith("\\ No newline")) continue;
			if (line.startsWith("+")) push(current, hunk, "add", line.slice(1));
			else if (line.startsWith("-")) push(current, hunk, "del", line.slice(1));
			else if (line.startsWith(" ")) push(current, hunk, "ctx", line.slice(1));
			else {
				// Unknown line inside a hunk: if another file starts we bail, else treat as end of hunk.
				if (line.startsWith("--- a/") || line.startsWith("+++ b/")) continue;
				hunk = undefined;
			}
		}
		// lines outside hunks (index/mode/metadata) are ignored
	}
	// The server can cap the text mid-hunk; mark the tail so the drawer can say so.
	if (!text.endsWith("\n") && hunk !== undefined) {
		const last = files.at(-1);
		if (last) last.hitEndOfStream = true;
	}
	truncated = files.some((f) => f.hitEndOfStream);
	return { files, truncated };
}

function push(file: ParsedDiffFile, hunk: DiffHunk, kind: DiffLineKind, content: string): void {
	hunk.lines.push({ kind, text: content });
	if (kind === "add") {
		file.insertions += 1;
	} else if (kind === "del") {
		file.deletions += 1;
	}
}

/** "diff --git a/src/x.ts b/src/x.ts" → paths (rename/deletion aware, best effort). */
function parseGitHeaderPaths(header: string): { oldPath?: string; newPath: string } {
	const tail = header.replace(/^diff --git /, "");
	const mid = tail.indexOf(" b/");
	if (mid === -1) return { oldPath: undefined, newPath: tail.replace(/^a\//, "") };
	const a = tail.slice(0, mid);
	const b = tail.slice(mid + 3);
	const oldPath = a === "/dev/null" ? undefined : stripPathPrefix(a);
	const newPath = b === "/dev/null" && oldPath !== undefined ? oldPath : stripPathPrefix(b);
	return { oldPath, newPath };
}

/** Strip the git `a/`/`b/` (and quoted) prefixes on ---/+++ lines. */
function stripSidePrefix(path: string, side: string): string {
	return path.replace(/^"/, "").replace(/"$/, "").replace(new RegExp(`^${side}`), "");
}

/** Strip a git header side prefix (either a/ or b/ for the two header names). */
function stripPathPrefix(path: string): string {
	const unquoted = path.replace(/^"/, "").replace(/"$/, "");
	return unquoted.startsWith("a/") ? unquoted.slice(2) : unquoted.startsWith("b/") ? unquoted.slice(2) : unquoted;
}

/** The drawer cap (PRD §13): first N lines of a file body, then a notice. */
export const DIFF_FILE_LINE_CAP = 2000;

/** §7.4 semantics label: the patch is cumulative since baseline, N waves. */
export function cumulativeLabel(waves: number): string {
	const n = Math.max(1, waves);
	return `task diff (cumulative since baseline, ${n} wave${n === 1 ? "" : "s"})`;
}

export function statusLabel(status: string): string {
	switch (status) {
		case "A": return "added";
		case "D": return "deleted";
		case "M": return "modified";
		default: return status === "?" ? "changed" : status;
	}
}
