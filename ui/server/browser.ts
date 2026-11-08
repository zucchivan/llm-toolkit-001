/**
 * Best-effort browser opening at server start (`--no-open` skips). Failure is
 * silent: the URL is printed either way.
 */
import { spawn } from "node:child_process";

export function openBrowser(url: string): void {
	try {
		if (process.platform === "darwin") {
			spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
		} else if (process.platform === "win32") {
			spawn("cmd", ["/s", "/c", "start", "", url], { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
		} else {
			spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
		}
	} catch {
		/* the URL is printed regardless */
	}
}
