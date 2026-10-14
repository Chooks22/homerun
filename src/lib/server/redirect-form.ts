import { RedirectDTO } from "#lib/dto/redirect-dto.js";
import { splitSource } from "#lib/redirects.js";
import { coreHosts } from "#lib/server/hostname-owner.js";
import { redirectSchema } from "#lib/server/validation/redirect.js";

/**
 * Validates a redirect (the form's entries, or an API body merged over the
 * stored row) and checks its source isn't taken by another redirect (`selfId`
 * is the one being edited) and its host isn't one of Homerun's own (the
 * dashboard, a core service's public host, a status page), which a redirect
 * would hijack and whose DNS record its removal would delete. Returns the
 * first error message, or the normalized fields.
 */
export async function parseRedirectInput(
	input: Record<string, unknown>,
	selfId?: string,
) {
	const result = redirectSchema.safeParse(input);
	if (!result.success) {
		return { error: result.error.issues[0]?.message ?? "Invalid redirect." };
	}
	const host = splitSource(result.data.source)?.host;
	const owner = host ? (await coreHosts()).get(host) : undefined;
	if (owner) {
		return { error: `${host} belongs to ${owner}, it can't be redirected.` };
	}
	const taken = await RedirectDTO.getBySource(result.data.source);
	if (taken && taken.toJSON().id !== selfId) {
		return { error: `${result.data.source} already has a redirect.` };
	}
	return { fields: result.data };
}
