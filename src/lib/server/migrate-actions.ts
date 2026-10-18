import { fail, type RequestEvent } from "@sveltejs/kit";
import type {
	MigrationConnection,
	MigrationEntry,
} from "#lib/migrate/common.js";
import { can } from "#lib/permissions.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import { MigrationService } from "#lib/services/migration.service.js";

export interface MigrationSource {
	label: string;
	listEntries: (
		connection: MigrationConnection,
		only?: Set<string>,
	) => Promise<MigrationEntry[]>;
}

function guard(event: RequestEvent): string {
	if (!event.locals.user) {
		redirectToSignIn();
	}
	return event.locals.user.id;
}

function readConnection(
	formData: FormData,
	label: string,
): MigrationConnection | string {
	const baseUrl = String(formData.get("baseUrl") ?? "").trim();
	const token = String(formData.get("token") ?? "").trim();
	if (!(baseUrl && token)) {
		return `Both the ${label} URL and an API token are needed.`;
	}
	if (!(URL.canParse(baseUrl) && /^https?:/i.test(baseUrl))) {
		return `${label} URL must be a full URL, like "https://${label.toLowerCase()}.example.com".`;
	}
	return { baseUrl, token };
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/**
 * Builds the admin-only `preview` and `import` form actions for a
 * migrate-from-another-platform tab. Both read the source instance's URL and
 * API token from the form and allow long-running requests; `import` only brings
 * over the picked entry ids. Failures come back as `fail(400)` with the typed
 * URL preserved.
 *
 * @param source How to label the other platform and list its importable
 * entries.
 */
export function migrationActions(source: MigrationSource) {
	return {
		import: async (event: RequestEvent) => {
			const userId = guard(event);
			const formData = await event.request.formData();
			const connection = readConnection(formData, source.label);
			const baseUrl = String(formData.get("baseUrl") ?? "").trim();
			if (typeof connection === "string") {
				return fail(400, { error: connection, values: { baseUrl } });
			}
			const ids = new Set(formData.getAll("ids").map(String).filter(Boolean));
			if (ids.size === 0) {
				return fail(400, {
					error: "Pick at least one thing to import.",
					values: { baseUrl },
				});
			}
			try {
				const entries = await source.listEntries(connection, ids);
				if (entries.length === 0) {
					return fail(400, {
						error: `None of the picked entries exist on ${source.label} any more : read the instance again.`,
						values: { baseUrl },
					});
				}
				const result = await MigrationService.importEntries(
					entries,
					userId,
					source.label,
					can(event.locals.permissions, "system", "write"),
				);
				return { result, values: { baseUrl } };
			} catch (err) {
				return fail(400, { error: message(err), values: { baseUrl } });
			}
		},

		preview: async (event: RequestEvent) => {
			guard(event);
			const formData = await event.request.formData();
			const connection = readConnection(formData, source.label);
			const baseUrl = String(formData.get("baseUrl") ?? "").trim();
			if (typeof connection === "string") {
				return fail(400, { error: connection, values: { baseUrl } });
			}
			try {
				const entries = await source.listEntries(connection);
				const preview = await MigrationService.preview(entries);
				return { preview, values: { baseUrl } };
			} catch (err) {
				return fail(400, { error: message(err), values: { baseUrl } });
			}
		},
	};
}
