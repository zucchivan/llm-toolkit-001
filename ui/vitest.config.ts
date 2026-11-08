import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";

/**
 * ui test config: the unit/contract suites run on the node environment; the
 * component tests (test/components-*.test.ts) opt into jsdom per file with a
 * `// @vitest-environment jsdom` docblock, so Svelte 5 components can mount.
 * The svelte vite plugin compiles .svelte imports; the "browser" resolve
 * condition makes Svelte 5 pick its client build inside vitest (it otherwise
 * resolves the SSR server export, which has no mount()).
 */
export default defineConfig({
	plugins: [svelte()],
	resolve: {
		conditions: ["browser"],
	},
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		pool: "forks",
	},
});
