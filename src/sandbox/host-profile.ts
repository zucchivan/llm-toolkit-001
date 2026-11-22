/**
 * Narrow reader for the operator-owned host delivery allowlist (§2).
 * P13 deliberately reads only `projects[].deliveryOrigin`; project config and
 * caller options can never select or override a publication destination.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ApprovedGitHubOrigin = { origin: string; repository: string };

export function defaultHostProfilePath(): string {
	if (process.platform === "win32") {
		const local = process.env.LOCALAPPDATA;
		if (!local) throw new Error("LOCALAPPDATA is unset; cannot locate the operator host profile");
		return join(local, "llm-toolkit-001", "host-v1.json");
	}
	return join(homedir(), ".config", "llm-toolkit-001", "host-v1.json");
}

/** Accept only a plain HTTPS GitHub repository URL and return its canonical form. */
export function parseApprovedGitHubOrigin(value: unknown): ApprovedGitHubOrigin {
	if (typeof value !== "string" || value.length > 512) throw new Error("approved deliveryOrigin is missing or invalid");
	let url: URL;
	try { url = new URL(value); }
	catch { throw new Error("deliveryOrigin must be a canonical HTTPS GitHub repository URL"); }
	if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) {
		throw new Error("deliveryOrigin must be an HTTPS github.com repository URL without credentials, port, query, or fragment");
	}
	const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
	if (!match || match[1] === "." || match[1] === ".." || match[2] === "." || match[2] === "..") {
		throw new Error("deliveryOrigin must name exactly one GitHub owner/repository");
	}
	const owner = match[1]!;
	const repository = match[2]!;
	return { origin: `https://github.com/${owner}/${repository}.git`, repository: `${owner}/${repository}` };
}

/**
 * Resolve the one exact-root project entry and return only its approved origin.
 * The file must be a user-owned regular file with private POSIX permissions;
 * `profilePath` is an internal test seam, not project-controlled input.
 */
export async function readApprovedDeliveryOrigin(
	projectRoot: string,
	profilePath = defaultHostProfilePath(),
): Promise<ApprovedGitHubOrigin> {
	const canonicalRoot = await realpath(projectRoot);
	const profile = resolve(profilePath);
	const info = await lstat(profile).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") throw new Error(`operator host profile not found at ${profile}; PR delivery requires projects[].deliveryOrigin`);
		throw error;
	});
	if (!info.isFile() || info.isSymbolicLink()) throw new Error("operator host profile must be a regular, non-symlink file");
	if (info.size > 1024 * 1024) throw new Error("operator host profile exceeds the 1 MiB read limit");
	if (process.platform !== "win32") {
		if ((info.mode & 0o077) !== 0) throw new Error("operator host profile permissions are too broad; chmod it to 600");
		if (typeof process.getuid === "function" && info.uid !== process.getuid()) throw new Error("operator host profile is not owned by the current user");
	}
	// Reject a symlinked path component so the configured user-owned location
	// cannot be redirected through a project-controlled alias.
	const actualProfile = await realpath(profile);
	if (actualProfile !== profile) throw new Error("operator host profile path must not traverse a symlink");
	const text = await readFile(profile, "utf8");
	let parsed: unknown;
	try { parsed = JSON.parse(text); }
	catch { throw new Error("operator host profile is not valid JSON"); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("operator host profile must be a JSON object");
	const root = parsed as Record<string, unknown>;
	if (root["version"] !== 1 || !Array.isArray(root["projects"])) throw new Error("operator host profile must use version 1 and a projects array");
	const matches = root["projects"].filter((entry): entry is Record<string, unknown> =>
		!!entry && typeof entry === "object" && !Array.isArray(entry) && entry["root"] === canonicalRoot,
	);
	if (matches.length !== 1) throw new Error(`host profile needs exactly one project entry for ${canonicalRoot}`);
	const approved = matches[0]!["deliveryOrigin"];
	if (typeof approved !== "string") throw new Error("host profile project entry has no approved deliveryOrigin");
	return parseApprovedGitHubOrigin(approved);
}
