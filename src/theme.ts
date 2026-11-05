/** ANSI helpers, no deps. Honors NO_COLOR / non-TTY. */
const enabled = !process.env["NO_COLOR"] && process.stdout.isTTY;

const wrap = (code: string, text: string): string => (enabled ? `\x1b[${code}m${text}\x1b[0m` : text);

export const ansi = {
	bold: (t: string) => wrap("1", t),
	dim: (t: string) => wrap("2", t),
	red: (t: string) => wrap("31", t),
	green: (t: string) => wrap("32", t),
	yellow: (t: string) => wrap("33", t),
	blue: (t: string) => wrap("34", t),
	magenta: (t: string) => wrap("35", t),
	cyan: (t: string) => wrap("36", t),
};

export type AnsiStyle = typeof ansi;
