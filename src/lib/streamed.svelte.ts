const MAX_ENTRIES = 50;

const cache = new Map<string, unknown>();

function remember(key: string, value: unknown): void {
	cache.delete(key);
	cache.set(key, value);
	if (cache.size > MAX_ENTRIES) {
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) {
			cache.delete(oldest);
		}
	}
}

export class Streamed<T> {
	current = $state<T | undefined>();
	failed = $state(false);

	/**
	 * Follows a promise streamed from a `load`, showing the last value resolved
	 * under the same key while a fresh one is in flight, so revisiting a page
	 * paints its previous data at once instead of a skeleton. Must be
	 * constructed during component init: it registers an effect that re-runs
	 * whenever `key` or `source` changes (a navigation, a `refreshAll()`). The
	 * cache lives in this tab's memory only, and a failed refresh keeps the
	 * cached value rather than flagging `failed`.
	 *
	 * @param key Identifies the data, including whatever scopes it (user, query string).
	 * @param source The streamed promise to follow.
	 */
	constructor(key: () => string, source: () => Promise<T>) {
		$effect.pre(() => {
			const id = key();
			const promise = source();
			let live = true;
			this.current = cache.get(id) as T | undefined;
			this.failed = false;
			promise.then(
				(value) => {
					remember(id, value);
					if (live) {
						this.current = value;
					}
				},
				() => {
					if (live && this.current === undefined) {
						this.failed = true;
					}
				},
			);
			return () => {
				live = false;
			};
		});
	}

	/** Whether nothing has resolved yet and nothing was cached: the skeleton's cue. */
	get pending(): boolean {
		return this.current === undefined && !this.failed;
	}
}
