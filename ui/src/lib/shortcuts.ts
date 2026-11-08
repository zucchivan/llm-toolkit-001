/**
 * The EventLog registers its filter input here so the global "/" shortcut
 * (§10) can focus it without App holding a DOM ref across components.
 */

let eventFilter: { focus(): void; select?(): void } | undefined;

/** EventLog calls this on mount; returns the unregister function. */
export function registerEventFilter(el: { focus(): void }): () => void {
	eventFilter = el;
	return () => {
		if (eventFilter === el) eventFilter = undefined;
	};
}

/** True when a filter input existed and was focused. */
export function focusEventFilter(): boolean {
	if (!eventFilter) return false;
	eventFilter.focus();
	return true;
}

/** Test/teardown helper. */
export function resetEventFilterRegistration(): void {
	eventFilter = undefined;
}
