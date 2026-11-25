/**
 * Read-only project sources (M5-a + M5-b, ui/PRD.md §5 + §18): the config,
 * PRD, PROMPT.md and gate recipes viewers' data — raw file text plus a
 * best-effort verdict, never a write. All four are STATIC project files (like
 * `.orch/status.json` and the wave log), not the lock-owned storage: A.6
 * already established reading `.orch/config.toml` without the lock, and the
 * PRD is the same class of file the plan dialog reads. Works in both snapshot
 * modes — a live run does not rewrite any of them (the engine only READS
 * PROMPT.md and evals/recipes.toml; the harness blocks agents from writing
 * them), so viewing them needs no harness window and no lock.
 *
 * There is deliberately NO mutation here (§5 non-goal, unchanged by M4-b's
 * decisions D3/D5): the UI never writes `.orch/config.toml`, the PRD,
 * PROMPT.md or `evals/recipes.toml` — editing happens in the human's editor
 * and the CLI stays the only mutation path.
 */
import { join } from "node:path";
import { DEFAULT_CONFIG, missingConfigMessage, parseConfig } from "../../src/config.ts";
import { loadRecipesSafe } from "../../src/engine/gates.ts";
import { resolveCanonicalProjectRoot } from "../../src/sandbox/host-profile.ts";
import { SafeReadBudget, openSafeFile, readSafeText } from "../../src/util/safe-read.ts";
import { projectPaths } from "../../src/engine/harness.ts";
import type { StatusPayloads } from "../../src/engine/harness.ts";

/** §11.4 discipline: text responses are capped; larger files say so. */
export const SOURCE_TEXT_CAP_BYTES = 5 * 1024 * 1024;

/** One static project source as the viewer renders it (plain JSON-able). */
export interface SourceFileView {
	/** The file's configured path, project-relative as written (e.g. "docs/prd.md"). */
	path: string;
	exists: boolean;
	/** Real byte size when it exists; 0 when missing. */
	bytes: number;
	/** Raw text, capped at SOURCE_TEXT_CAP_BYTES (truncated → see it in your editor for the rest). */
	text?: string;
	/** The cap cut this file's text; the bytes count is the file's truth. */
	truncated?: boolean;
	/** NUL bytes present (binary content): labeled, not shown as text. */
	binary?: boolean;
	/**
	 * M1-P01: the host read boundary refused this path (symlink, escape,
	 * non-regular file, permissions, unsupported explicit primitive, §2 cap).
	 * No bytes were read: `exists` is false because nothing is readable through
	 * the trusted root, and `text` is never populated. This is NOT absence.
	 */
	refused?: { code: string; message: string };
}

export interface ProjectSourcesPayload {
	at: number;
	/** `.orch/config.toml`, raw text + a best-effort loader verdict (read-only). */
	config: SourceFileView & { parseError?: string };
	/** The PRD at the resolved path (status.json's last flush → config → engine default). */
	prd: SourceFileView;
	/** PROMPT.md at the project root — the per-wave discipline doc every wave input embeds (fixed path, engine-read). */
	prompt: SourceFileView;
	/** `evals/recipes.toml`, raw text + the gate loader's verdict. */
	recipes: SourceFileView & { parseError?: string };
}

/**
 * One read of all four sources. Config: raw text always (even when the TOML
 * is broken — showing the text is how you fix it), parse verdict via the
 * CLI's own parser in the same plain words. PRD: status.json's last-flushed
 * path (A.1) wins, then the config's, then the engine default; a broken
 * config degrades that resolution instead of failing the whole response.
 * PROMPT.md: the fixed root path the engine reads (missing = waves assemble
 * without it — a warn, not an error). Recipes: the gate loader's own verdict
 * (`ENOENT` = empty gates, a defined state; anything else is the plain-words
 * error the next wave's gate step would throw).
 *
 * M1-P01 step (c): the root is canonicalized once and every read is
 * root-relative through the no-follow, capped host reader under one shared
 * budget. A symlinked/escaping/oversized source is REFUSED (`refused`) with no
 * text, never served from the link target and never reported as absent.
 */
export async function readProjectSources(rootInput: string): Promise<ProjectSourcesPayload> {
	const at = Date.now();
	let root: string;
	try {
		root = await resolveCanonicalProjectRoot(rootInput);
	} catch (error) {
		const refused = { code: "unsafe-root", message: (error as Error).message };
		const blank = (path: string): SourceFileView & { parseError?: string } => ({ path, exists: false, bytes: 0, refused });
		const config = blank(".orch/config.toml");
		config.parseError = refused.message;
		return { at, config, prd: blank(DEFAULT_CONFIG.paths.prd), prompt: blank("PROMPT.md"), recipes: blank("evals/recipes.toml") };
	}
	const budget = new SafeReadBudget();
	const configPath = ".orch/config.toml";
	const configRead = await readSourceFile(root, configPath, configPath, budget);
	const config: SourceFileView & { parseError?: string } = { ...configRead };

	// Best-effort loader verdict, exactly the CLI's plain words (ConfigError —
	// including "no config at …" when the whole file is absent). The parse also
	// discovers the PRD path when the config parses.
	let prdFromConfig: string | undefined;
	if (configRead.text !== undefined) {
		try {
			prdFromConfig = parseConfig(configRead.text, root).paths.prd;
		} catch (err) {
			config.parseError = (err as Error).message;
		}
	} else if (configRead.refused) {
		config.parseError = `config refused: ${configRead.refused.message} (${configRead.refused.code})`;
	} else if (configRead.binary) {
		config.parseError = `config at ${join(root, ".orch", "config.toml")} is binary data — fix it in your editor`;
	} else {
		config.parseError = missingConfigMessage(join(root, ".orch", "config.toml"));
	}

	const prdPath = await resolvePrdPath(root, prdFromConfig, budget);
	const prd = await readSourceFile(root, prdPath, prdPath, budget);
	const prompt = await readSourceFile(root, "PROMPT.md", "PROMPT.md", budget);

	// The recipes verdict comes from the engine's own no-follow gate loader (same
	// parser, same message a failed gate step would print): absent file ⇒
	// defined empty-gates state (no parseError); present-but-broken or refused ⇒
	// the "unreadable/invalid" error verbatim, with the raw text still served
	// when it could be read safely.
	const recipes: SourceFileView & { parseError?: string } = await readSourceFile(root, "evals/recipes.toml", "evals/recipes.toml", budget);
	try {
		await loadRecipesSafe(projectPaths(root), root);
	} catch (err) {
		recipes.parseError = (err as Error).message;
	}

	return { at, config, prd, prompt, recipes };
}

/**
 * PRD path resolution order (mirrors the readout's `prdPath` extra in
 * ui/server/readout.ts): the engine's last status.json flush first (A.1 — the
 * freshest fact), then the parsed config's `[paths] prd`, then the engine's
 * default. Undefined config (broken/missing) degrades to status + default.
 * The side-car itself is read through the same no-follow boundary.
 */
async function resolvePrdPath(root: string, prdFromConfig: string | undefined, budget: SafeReadBudget): Promise<string> {
	const read = await readSafeText({ root, path: ".orch/status.json", budget });
	let payload: StatusPayloads | undefined;
	if (read.kind === "ok") {
		try { payload = JSON.parse(read.value) as StatusPayloads; } catch { payload = undefined; }
	}
	return payload?.prdPath ?? prdFromConfig ?? DEFAULT_CONFIG.paths.prd;
}

/** Raw read of one source file with the §11.4-style cap + binary labeling. */
async function readSourceFile(root: string, path: string, rel: string, budget: SafeReadBudget): Promise<SourceFileView> {
	const opened = await openSafeFile({ root, path });
	if (opened.kind === "absent") return { path: rel, exists: false, bytes: 0 };
	if (opened.kind === "refused") {
		return { path: rel, exists: false, bytes: 0, refused: { code: opened.code, message: opened.message } };
	}
	try {
		const size = opened.value.size;
		const read = await opened.value.readBytes({ budget });
		if (read.kind !== "ok") {
			const refused = read.kind === "refused" ? { code: read.code, message: read.message } : { code: "changed", message: `${rel} vanished while being read` };
			return { path: rel, exists: false, bytes: 0, refused };
		}
		const buf = read.value;
		if (buf.includes(0)) return { path: rel, exists: true, bytes: size, binary: true };
		const truncated = buf.length > SOURCE_TEXT_CAP_BYTES;
		const text = truncated ? buf.subarray(0, SOURCE_TEXT_CAP_BYTES).toString("utf8") : buf.toString("utf8");
		return { path: rel, exists: true, bytes: size, text, ...(truncated ? { truncated: true } : {}) };
	} finally {
		await opened.value.close();
	}
}
