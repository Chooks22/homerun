import type { ApiClient } from "./client";

/**
 * Tracks every service a test creates and deletes it in `afterEach`, one
 * `DELETE /services/{id}` per id, through the app's own real teardown path
 * (`ServiceLifecycleService.remove`) — never a broad Docker label sweep :
 * this machine's own real dev containers share the same daemon these tests
 * run against, so cleanup has to be surgical, by exact id, not "everything
 * homerun.managed=true".
 */
export class ServiceCleanup {
	readonly #client: ApiClient;
	readonly #ids = new Set<string>();

	constructor(client: ApiClient) {
		this.#client = client;
	}

	track(serviceId: string): string {
		this.#ids.add(serviceId);
		return serviceId;
	}

	async cleanupAll(): Promise<void> {
		const ids = [...this.#ids];
		this.#ids.clear();
		await Promise.all(
			ids.map(async (id) => {
				await this.#client
					.DELETE("/services/{serviceId}", {
						params: { path: { serviceId: id }, query: { force: "true" } },
					})
					.catch(() => {
						// Best-effort : a test that already deleted its own service, or
						// failed before creating one, shouldn't fail cleanup too.
					});
			}),
		);
	}
}
