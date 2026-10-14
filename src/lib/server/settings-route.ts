import type { z } from "zod";
import { apiCaller, apiError, readApiBody } from "#lib/server/api-route.js";
import { InstanceSettingsError } from "#lib/services/instance-settings.service.js";

type SettingsJson = Record<string, unknown>;

/** The GET of a settings singleton: what `read` returns, or the 401 refusing a signed-out caller. */
export async function readSettings(
	locals: App.Locals,
	read: () => Promise<SettingsJson>,
): Promise<Response> {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	return Response.json(await read());
}

/**
 * The PATCH of a settings singleton: validates the body with `schema`, saves
 * it with `handlers.save` and answers what `handlers.read` returns then. A
 * refused value answers 400 and any other failure (a host that couldn't be
 * prepared, a failed registry job) 500, both with the reason.
 */
export async function patchSettings<T extends z.ZodType>(
	locals: App.Locals,
	request: Request,
	schema: T,
	handlers: {
		read: () => Promise<SettingsJson>;
		save: (body: z.infer<T>, userId: string) => Promise<void>;
	},
): Promise<Response> {
	const caller = apiCaller(locals);
	if ("refused" in caller) {
		return caller.refused;
	}
	const body = await readApiBody(request, schema);
	if ("response" in body) {
		return body.response;
	}
	try {
		await handlers.save(body.data, caller.userId);
	} catch (err) {
		if (err instanceof InstanceSettingsError) {
			return apiError(err.message);
		}
		return apiError(err instanceof Error ? err.message : String(err), 500);
	}
	return Response.json(await handlers.read());
}
