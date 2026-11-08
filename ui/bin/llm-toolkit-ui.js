#!/usr/bin/env node
/**
 * llm-toolkit-ui — bin shim. The whole ui/server (plus the kit engine it reads
 * through, which lives two levels up) is TypeScript executed via tsx's ESM
 * register hook: no server build step, no copy of kit typings to maintain.
 * Requires the ui package's devDependencies (tsx) — plain `npm --prefix ui
 * install` installs them.
 */
import { register } from "tsx/esm/api";

register();
await import("../server/cli.ts");
