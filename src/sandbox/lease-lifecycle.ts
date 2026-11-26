import { randomUUID } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export type LeasePhase = "intent" | "cgroup-created" | "launching" | "attached" | "fencing" | "fenced" | "importing" | "imported" | "complete" | "not-launched" | "recovery-required";
export type LeaseRole = "planner" | "implementer" | "verifier" | "gate" | "probe";
export interface LeaseRecord {
	version: 1;
	id: string;
	role: LeaseRole;
	phase: LeasePhase;
	sequence: number;
	createdAt: number;
	cgroupPath: string;
	manifestDigest?: string;
	resultDigest?: string;
	recoveryReason?: string;
}

export interface CgroupOps {
	create(path: string): Promise<void>;
	writePid(path: string, pid: number): Promise<void>;
	kill(path: string): Promise<void>;
	populated(path: string): Promise<boolean>;
	remove(path: string): Promise<void>;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TERMINAL = new Set<LeasePhase>(["complete", "not-launched", "recovery-required"]);
const NEXT: Readonly<Record<LeasePhase, readonly LeasePhase[]>> = {
	intent: ["cgroup-created", "not-launched", "recovery-required"],
	"cgroup-created": ["launching", "not-launched", "recovery-required"],
	launching: ["attached", "fencing", "recovery-required"],
	attached: ["fencing", "recovery-required"],
	fencing: ["fenced", "recovery-required"],
	fenced: ["importing", "complete", "recovery-required"],
	importing: ["imported", "recovery-required"],
	imported: ["complete", "recovery-required"],
	complete: [],
	"not-launched": [],
	"recovery-required": [],
};

/** Durable host journal. Guest input is never accepted as a phase or fence observation. */
export class LeaseLifecycle {
	private constructor(private readonly root: string, private recordValue: LeaseRecord, private readonly cgroups: CgroupOps) {}
	get record(): Readonly<LeaseRecord> { return Object.freeze({ ...this.recordValue }); }

	static async create(root: string, role: LeaseRole, cgroupPath: string, cgroups: CgroupOps = new LinuxCgroupOps()): Promise<LeaseLifecycle> {
		if (!isRole(role) || !isCanonicalAbsolutePath(cgroupPath)) throw new Error("invalid lease intent");
		await ensurePrivateDirectory(root);
		const id = randomUUID();
		const record: LeaseRecord = { version: 1, id, role, phase: "intent", sequence: 0, createdAt: Date.now(), cgroupPath: join(cgroupPath, `kit-${id}`) };
		const file = join(root, `${id}.json`);
		await persist(file, record);
		return new LeaseLifecycle(root, record, cgroups);
	}

	static async reopen(root: string, id: string, cgroups: CgroupOps = new LinuxCgroupOps()): Promise<LeaseLifecycle> {
		if (!UUID_V4.test(id)) throw new Error("invalid lease UUID");
		const file = join(root, `${id}.json`);
		const record = decodeRecord(JSON.parse(await readFile(file, "utf8")), id);
		return new LeaseLifecycle(root, record, cgroups);
	}

	async createCgroup(): Promise<void> {
		this.requirePhase("intent");
		await this.cgroups.create(this.recordValue.cgroupPath);
		await this.advance("cgroup-created");
	}

	async beginLaunch(): Promise<void> { await this.advance("launching"); }
	async attach(pid: number): Promise<void> {
		this.requirePhase("launching");
		if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid launcher pid");
		await this.cgroups.writePid(this.recordValue.cgroupPath, pid);
		await this.advance("attached");
	}

	async fence(maxWaitMs = 5_000): Promise<void> {
		if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs < 0) throw new Error("invalid fence timeout");
		if (this.recordValue.phase !== "launching" && this.recordValue.phase !== "attached" && this.recordValue.phase !== "fencing") throw new Error(`cannot fence lease in ${this.recordValue.phase}`);
		// A persisted kill intent is not a kill receipt. Repeating cgroup.kill on
		// the same child is safe and required after an interrupted fence.
		if (this.recordValue.phase !== "fencing") await this.advance("fencing");
		try {
			await this.cgroups.kill(this.recordValue.cgroupPath);
			const deadline = Date.now() + maxWaitMs;
			while (await this.cgroups.populated(this.recordValue.cgroupPath)) {
				if (Date.now() >= deadline) throw new Error("cgroup remained populated after cgroup.kill");
				await new Promise((r) => setTimeout(r, 20));
			}
		} catch (error) {
			await this.markRecoveryRequired(`fence failed: ${(error as Error).message}`);
			throw error;
		}
		await this.advance("fenced");
	}

	async beginImport(): Promise<void> {
		this.requirePhase("fenced");
		await this.requireCurrentFence();
		await this.advance("importing");
	}
	async recordImported(manifestDigest: string, resultDigest: string): Promise<void> {
		this.requirePhase("importing");
		if (!/^[a-f0-9]{64}$/.test(manifestDigest) || !/^[a-f0-9]{64}$/.test(resultDigest)) throw new Error("invalid import receipt digest");
		await this.advance("imported", { manifestDigest, resultDigest });
	}
	async complete(): Promise<void> { await this.advance("complete"); }

	async reconcile(): Promise<Readonly<LeaseRecord>> {
		const phase = this.recordValue.phase;
		if (phase === "intent" || phase === "cgroup-created") {
			const exists = await lstat(this.recordValue.cgroupPath).then(() => true, (e: NodeJS.ErrnoException) => e.code === "ENOENT" ? false : Promise.reject(e));
			if (!exists) await this.advance("not-launched");
			else await this.markRecoveryRequired("cgroup exists without a trusted launch acknowledgement");
		} else if (phase === "launching" || phase === "attached" || phase === "fencing") {
			await this.fence();
		} else if (phase === "fenced") {
			await this.requireCurrentFence();
		} else if (phase === "importing") {
			await this.markRecoveryRequired("import receipt missing after import intent; reconcile only from the same sealed bytes");
		} else if (phase === "imported") {
			await this.complete();
		}
		return this.record;
	}

	async markRecoveryRequired(reason: string): Promise<void> {
		if (TERMINAL.has(this.recordValue.phase)) return;
		await this.advance("recovery-required", { recoveryReason: reason.slice(0, 512) });
	}

	async removeFencedCgroup(): Promise<void> {
		if (this.recordValue.phase !== "complete" && this.recordValue.phase !== "not-launched") throw new Error("cannot remove cgroup before terminal lifecycle state");
		if (await this.cgroups.populated(this.recordValue.cgroupPath)) throw new Error("cannot remove populated lease cgroup");
		await this.cgroups.remove(this.recordValue.cgroupPath);
	}

	private async requireCurrentFence(): Promise<void> {
		try {
			if (await this.cgroups.populated(this.recordValue.cgroupPath)) throw new Error("lease cgroup is populated after recorded fence");
		} catch (error) {
			await this.markRecoveryRequired(`fence observation failed: ${(error as Error).message}`);
			throw error;
		}
	}

	private requirePhase(phase: LeasePhase): void { if (this.recordValue.phase !== phase) throw new Error(`lease phase is ${this.recordValue.phase}, expected ${phase}`); }
	private async advance(phase: LeasePhase, extra: Partial<LeaseRecord> = {}): Promise<void> {
		if (!NEXT[this.recordValue.phase].includes(phase)) throw new Error(`invalid lease transition ${this.recordValue.phase} -> ${phase}`);
		const next = { ...this.recordValue, ...extra, phase, sequence: this.recordValue.sequence + 1 };
		await persist(join(this.root, `${next.id}.json`), next);
		this.recordValue = next;
	}
}

export class LinuxCgroupOps implements CgroupOps {
	async create(path: string): Promise<void> {
		this.assertDelegatedChild(path);
		await mkdir(path, { mode: 0o700 });
		for (const entry of ["cgroup.kill", "cgroup.events", "cgroup.procs"]) await accessWritable(join(path, entry));
	}
	async writePid(path: string, pid: number): Promise<void> { this.assertDelegatedChild(path); if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("invalid cgroup process id"); await writeControl(join(path, "cgroup.procs"), `${pid}\n`); }
	async kill(path: string): Promise<void> { this.assertDelegatedChild(path); await writeControl(join(path, "cgroup.kill"), "1\n"); }
	async populated(path: string): Promise<boolean> {
		this.assertDelegatedChild(path);
		const events = await readFile(join(path, "cgroup.events"), "utf8");
		const match = /^populated ([01])$/m.exec(events);
		if (!match) throw new Error("cgroup.events lacks a valid populated value");
		return match[1] === "1";
	}
	async remove(path: string): Promise<void> { this.assertDelegatedChild(path); await rm(path); }
	private assertDelegatedChild(path: string): void {
		const parent = delegatedCgroupParent();
		if (process.platform !== "linux" || !path.startsWith(`${parent}/`) || dirname(path) !== parent || !/^kit-[0-9a-f-]{36}$/.test(basename(path))) {
			throw new Error("cgroup path is not a single child of the current delegated cgroup-v2 subtree");
		}
	}
}

export function delegatedCgroupParent(): string {
	if (process.platform !== "linux") throw new Error("local lease requires Linux cgroup v2");
	const line = requireCgroupLine();
	const relativePath = line.slice(3);
	const root = resolve("/sys/fs/cgroup", `.${relativePath}`);
	if (!root.startsWith("/sys/fs/cgroup/")) throw new Error("current process cgroup path is unsafe");
	return root;
}

async function persist(path: string, value: LeaseRecord): Promise<void> {
	await ensurePrivateDirectory(dirname(path));
	const lockPath = `${path}.lock`;
	let lock;
	try { lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); }
	catch { throw new Error("lease journal is locked or already being recovered"); }
	try {
		const temp = `${path}.tmp.${process.pid}.${randomUUID()}`;
		const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
		try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
		await rename(temp, path);
		const directory = await open(dirname(path), constants.O_RDONLY);
		try { await directory.sync(); } finally { await directory.close(); }
	} finally { await lock.close(); await rm(lockPath, { force: true }); }
}
async function ensurePrivateDirectory(path: string): Promise<void> {
	await mkdir(path, { recursive: true, mode: 0o700 });
	const info = await lstat(path);
	if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error("lease journal root must be a private real directory");
}
async function accessWritable(path: string): Promise<void> { const info = await stat(path); if (!info.isFile()) throw new Error(`missing cgroup control ${path}`); }
function requireCgroupLine(): string {
	const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((row) => row.startsWith("0::"));
	if (!line) throw new Error("unified cgroup-v2 membership is unavailable");
	return line;
}
async function writeControl(path: string, value: string): Promise<void> {
	const handle = await open(path, constants.O_WRONLY);
	try { await handle.writeFile(value); } finally { await handle.close(); }
}
function decodeRecord(value: unknown, id: string): LeaseRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("lease journal record is malformed");
	const row = value as Record<string, unknown>;
	if (row.version !== 1 || row.id !== id || !UUID_V4.test(id) || typeof row.phase !== "string" || !Object.hasOwn(NEXT, row.phase) || !isRole(row.role) || !isCanonicalAbsolutePath(row.cgroupPath) || basename(row.cgroupPath) !== `kit-${id}` || !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 0 || !Number.isSafeInteger(row.createdAt) || (row.createdAt as number) < 0) throw new Error("lease journal identity or schema mismatch");
	const digest = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
	if ((row.manifestDigest !== undefined && !digest(row.manifestDigest)) || (row.resultDigest !== undefined && !digest(row.resultDigest)) ||
		((row.manifestDigest === undefined) !== (row.resultDigest === undefined)) ||
		(row.phase === "imported" && (!digest(row.manifestDigest) || !digest(row.resultDigest))) ||
		(row.recoveryReason !== undefined && (typeof row.recoveryReason !== "string" || row.recoveryReason.length > 512))) throw new Error("lease journal receipt or recovery schema mismatch");
	return row as unknown as LeaseRecord;
}
function isCanonicalAbsolutePath(value: unknown): value is string {
	return typeof value === "string" && isAbsolute(value) && !value.includes("\0") && resolve(value) === value;
}
function isRole(value: unknown): value is LeaseRole { return typeof value === "string" && ["planner", "implementer", "verifier", "gate", "probe"].includes(value); }
