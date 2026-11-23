/**
 * Wave-addressed handoff notes (M0-P17).
 *
 * The `handoff` CLI publishes ONE atomically written note file per invocation
 * under `.orch/handoffs/inbox/<uuid>.json` — no read-modify-write race between
 * concurrent writers, and no shared queue file to corrupt. The serial driver
 * claims the oldest (ts,id) notes up to 3,000 chars in total at each wave
 * boundary, binds the consumed ids AND text to that pending wave in one state
 * transaction (HandoffDoc), and unlinks the files only after the commit lands.
 * A crash between commit and unlink leaves the files behind; the durable
 * binding makes the resume ignore them as duplicates instead of losing or
 * redelivering the note. Notes arriving after a wave's claim simply wait for
 * the next claim. The pre-P17 side-car `.orch/pending-handoff.json` imports
 * once per unique content hash under the owner lock (a crash re-import writes
 * the same content-hash filenames, so it cannot duplicate a note).
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteJson, readJson } from "../util/fsx.ts";
import { shasum } from "../util/git.ts";
import { readSessionState, commitState } from "./state.ts";
import type { WaveRow } from "./infos.ts";
import type { LoopAndLock, ProjectPaths } from "./harness.ts";

/** Hard per-note cap enforced at publish time (the CLI refuses longer notes). */
export const HANDOFF_NOTE_MAX_CHARS = 2_000;
/** Per-claim budget at each wave boundary: oldest (ts,id) notes until this
 *  many chars of note text are bound; excess stays queued for later waves. */
export const HANDOFF_CLAIM_MAX_CHARS = 3_000;

export class HandoffNoteTooLongError extends Error {
	constructor() {
		super(`handoff note exceeds the ${HANDOFF_NOTE_MAX_CHARS} character limit — shorten it (the wave claim carries at most ${HANDOFF_CLAIM_MAX_CHARS} chars across notes)`);
		this.name = "HandoffNoteTooLongError";
	}
}

/** One durable note: the inbox filename is `<id>.json` — the id IS the name. */
export interface HandoffNote {
	id: string;
	ts: number;
	note: string;
}

export interface HandoffClaim {
	/** Notes selected for THIS wave (oldest first, within the char budget). */
	taken: HandoffNote[];
	/** Valid notes left queued (budget overflow or already-consumed ids). */
	queued: number;
	/** Notes whose inbox file arrived before this claim and whose id is already
	 *  durably consumed — duplicates after a crash; they are unlinked at settle. */
	duplicates: HandoffNote[];
	/** Unreadable/mismatched/oversized notes: diagnosed, then quarantined under
	 *  `.orch/handoffs/invalid/` at settle time. */
	invalid: { file: string; reason: string }[];
}

interface NoteFile {
	id?: unknown;
	ts?: unknown;
	note?: unknown;
}

/** Publish one note (the CLI's entire write path). Unique file, atomic rename. */
export async function publishHandoffNote(paths: ProjectPaths, text: string): Promise<string> {
	if (text.length > HANDOFF_NOTE_MAX_CHARS) throw new HandoffNoteTooLongError();
	const note: HandoffNote = { id: randomUUID(), ts: Date.now(), note: text };
	await atomicWriteJson(join(paths.handoffInbox, `${note.id}.json`), note);
	return note.id;
}

/**
 * Read + select the next wave's claim: valid inbox notes oldest (ts,id) first
 * while they fit the claim budget; already-consumed ids are duplicates (not
 * taken); unparseable/mismatched/oversized files are invalid. Pure filesystem
 * read — the binding transaction is the caller's commitState.
 */
export async function readHandoffClaim(paths: ProjectPaths, opts: { excludeIds?: readonly string[] } = {}): Promise<HandoffClaim> {
	const claim: HandoffClaim = { taken: [], queued: 0, duplicates: [], invalid: [] };
	const excluded = new Set(opts.excludeIds ?? []);
	let entries: string[];
	try {
		entries = (await readdir(paths.handoffInbox, { withFileTypes: true }))
			.filter((e) => e.isFile() && e.name.endsWith(".json"))
			.map((e) => e.name)
			.sort();
	} catch {
		return claim; // no inbox yet — nothing to claim
	}
	const valid: HandoffNote[] = [];
	for (const name of entries) {
		const file = join(paths.handoffInbox, name);
		const parsed = await readJson<NoteFile>(file);
		if (!parsed || typeof parsed !== "object") {
			claim.invalid.push({ file: name, reason: "note file is not a JSON object" });
			continue;
		}
		const id = typeof parsed.id === "string" ? parsed.id : "";
		const ts = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : NaN;
		const note = typeof parsed.note === "string" ? parsed.note : undefined;
		if (!id || id !== name.slice(0, -".json".length)) {
			claim.invalid.push({ file: name, reason: "note id is missing or does not match the file name" });
			continue;
		}
		if (!Number.isFinite(ts)) {
			claim.invalid.push({ file: name, reason: "note ts is missing or not a number" });
			continue;
		}
		if (note === undefined) {
			claim.invalid.push({ file: name, reason: "note text is missing" });
			continue;
		}
		if (note.length > HANDOFF_NOTE_MAX_CHARS) {
			claim.invalid.push({ file: name, reason: `note exceeds ${HANDOFF_NOTE_MAX_CHARS} characters` });
			continue;
		}
		const record: HandoffNote = { id, ts, note };
		if (excluded.has(id)) {
			claim.duplicates.push(record);
			continue;
		}
		valid.push(record);
	}
	valid.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
	let total = 0;
	for (const note of valid) {
		if (total + note.note.length > HANDOFF_CLAIM_MAX_CHARS) break; // stop: leave excess queued
		claim.taken.push(note);
		total += note.note.length;
	}
	claim.queued = valid.length - claim.taken.length;
	return claim;
}

/**
 * Visibility rows for the binding commit: one ingestion row per taken note,
 * one diagnosis row per invalid file. Same transaction that binds the ids+text.
 */
export function handoffClaimRows(claim: HandoffClaim, wave?: number): WaveRow[] {
	const rows: WaveRow[] = [];
	for (const note of claim.taken) {
		rows.push({
			ts: Date.now(),
			kind: "handoff",
			task: "session",
			...(wave !== undefined ? { wave } : {}),
			verb: "handoff-ingested",
			detail: note.note,
		});
	}
	for (const bad of claim.invalid) {
		rows.push({
			ts: Date.now(),
			kind: "handoff",
			task: "session",
			...(wave !== undefined ? { wave } : {}),
			verb: "handoff-invalid",
			detail: `${bad.file}: ${bad.reason}`,
			reason: "invalid-handoff-note",
		});
	}
	if (claim.queued > 0) {
		rows.push({
			ts: Date.now(),
			kind: "handoff",
			task: "session",
			...(wave !== undefined ? { wave } : {}),
			verb: "handoff-queued",
			detail: `${claim.queued} note(s) left queued — the ${HANDOFF_CLAIM_MAX_CHARS} char claim budget is full; a later wave claims them`,
		});
	}
	return rows;
}

/**
 * AFTER the binding commit lands: unlink consumed note files, unlink crash
 * duplicates (their text is already durable in HandoffDoc), and move invalid
 * files aside for diagnosis. A crash here is safe: the resume re-diagnoses the
 * invalid file and ignores/unlinks the consumed ones by id.
 */
export async function settleHandoffClaim(paths: ProjectPaths, claim: HandoffClaim): Promise<void> {
	for (const note of claim.taken) await rm(join(paths.handoffInbox, `${note.id}.json`), { force: true }).catch(() => {});
	for (const note of claim.duplicates) await rm(join(paths.handoffInbox, `${note.id}.json`), { force: true }).catch(() => {});
	if (claim.invalid.length) {
		await mkdir(paths.handoffInvalid, { recursive: true }).catch(() => {});
		for (const bad of claim.invalid) {
			await rename(join(paths.handoffInbox, bad.file), join(paths.handoffInvalid, bad.file)).catch(() => {});
		}
	}
}

/**
 * Resume cleanup: unlink inbox note files that a committed wave binding
 * already consumed (a crash between the binding commit and the unlink).
 * Duplicates are ignored — never re-claimed, never redelivered.
 */
export async function discardConsumedHandoffNotes(paths: ProjectPaths, boundIds: readonly string[]): Promise<void> {
	for (const id of boundIds) await rm(join(paths.handoffInbox, `${id}.json`), { force: true }).catch(() => {});
}

/**
 * One-time import of the pre-P17 queue `.orch/pending-handoff.json` into the
 * inbox, under the OWNER LOCK (runs only inside the driver; the `handoff` CLI
 * never opens storage). Each unique file content imports exactly once: the
 * content hash is recorded in RunStatusDoc.handoffImportedSha256, and legacy
 * note ids derive from that hash, so a crash between publishing the note
 * files and recording the hash re-writes the SAME filenames (no duplicates);
 * a crash after the hash commit but before the unlink just removes the file.
 */
export async function importLegacyHandoff(kit: LoopAndLock): Promise<void> {
	const paths = kit.loop.paths;
	const raw = await readFile(paths.pendingHandoff, "utf8").catch(() => undefined);
	if (raw === undefined) return;
	const hash = shasum(raw);
	const state = await readSessionState(kit.loop.harness);
	const imported = state.runStatus.handoffImportedSha256 ?? [];
	if (imported.includes(hash)) {
		// Imported before a crash skipped the unlink: dispose of the file only.
		await rm(paths.pendingHandoff, { force: true });
		return;
	}
	const rows: WaveRow[] = [];
	let parsed: { ts?: unknown; notes?: unknown; note?: unknown } | undefined;
	try {
		const value: unknown = JSON.parse(raw);
		if (value && typeof value === "object" && !Array.isArray(value)) parsed = value as typeof parsed;
	} catch {
		parsed = undefined;
	}
	if (parsed) {
		const ts = typeof parsed.ts === "number" && Number.isFinite(parsed.ts) ? parsed.ts : Date.now();
		const texts: string[] = [];
		if (Array.isArray(parsed.notes)) {
			for (const entry of parsed.notes) if (typeof entry === "string") texts.push(entry);
		}
		if (typeof parsed.note === "string") texts.push(parsed.note);
		let truncated = 0;
		for (const [index, text] of texts.entries()) {
			let note = text;
			if (note.length > HANDOFF_NOTE_MAX_CHARS) {
				// Cap (never silently drop): an over-long legacy note is truncated.
				note = note.slice(0, HANDOFF_NOTE_MAX_CHARS);
				truncated += 1;
			}
			await atomicWriteJson(join(paths.handoffInbox, `legacy-${hash.slice(0, 16)}-${index}.json`), {
				id: `legacy-${hash.slice(0, 16)}-${index}`,
				ts,
				note,
			});
		}
		if (texts.length > 0) {
			rows.push({
				ts: Date.now(),
				kind: "handoff",
				task: "session",
				verb: "handoff-imported",
				detail: `${texts.length} note(s) imported from pending-handoff.json${truncated ? ` (${truncated} truncated to ${HANDOFF_NOTE_MAX_CHARS} chars)` : ""}`,
			});
		}
	} else {
		// Diagnose: the legacy file is not a readable note queue — quarantine it.
		await mkdir(paths.handoffInvalid, { recursive: true }).catch(() => {});
		await rename(paths.pendingHandoff, join(paths.handoffInvalid, `pending-handoff-${hash.slice(0, 12)}.json`)).catch(() => {});
		rows.push({
			ts: Date.now(),
			kind: "handoff",
			task: "session",
			verb: "handoff-import-invalid",
			detail: "pending-handoff.json is not a valid note queue — moved to .orch/handoffs/invalid/",
			reason: "invalid-legacy-handoff",
		});
	}
	await commitState(kit, {
		runStatus: (d) => {
			d.handoffImportedSha256 = [...(d.handoffImportedSha256 ?? []), hash];
		},
		rows,
	});
	await rm(paths.pendingHandoff, { force: true }).catch(() => {});
}
