import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * ui build config: the Svelte 5 client bundle into ui/dist. The API server is
 * TypeScript executed via the tsx register shim (bin/llm-toolkit-ui.js) — no
 * server build step, and imports of kit sources stay source-to-source.
 */
export default defineConfig({
	plugins: [svelte()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
		target: "es2022",
	},
});
