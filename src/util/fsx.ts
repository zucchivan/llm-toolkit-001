/** Atomic JSON side-car + atomic text writers. */
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Write a file atomically: temp file in the same directory, then rename. */
export async function atomicWrite(file: string, data: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.tmp.${process.pid}`;
	await writeFile(tmp, data, "utf8");
	await rename(tmp, file);
}

export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
	await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Corrupt side-cars read as absent; the engine re-writes them. */
export async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		const raw = await readFile(file, "utf8");
		return JSON.parse(raw) as T;
	} catch {
		return undefined;
	}
}

export function exists(file: string): boolean {
	return existsSync(file);
}
