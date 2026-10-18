import { fail } from "@sveltejs/kit";
import { Logger } from "#lib/logger.js";
import { redirectToSignIn } from "#lib/server/sign-in-redirect.js";
import {
	MachineTerminalError,
	MachineTerminalService,
} from "#lib/services/machine-terminal.service.js";

const logger = new Logger("MachineTerminal");

export const load = async () => {
	const [machines, publicKey] = await Promise.all([
		MachineTerminalService.machines(),
		MachineTerminalService.publicKey(),
	]);
	return { machines, publicKey };
};

export const actions = {
	configure: async ({ request, locals }) => {
		if (!locals.user) {
			redirectToSignIn();
		}
		const formData = await request.formData();
		const machineId = String(formData.get("machineId") ?? "");
		const host = String(formData.get("host") ?? "").trim() || null;
		const user = String(formData.get("user") ?? "").trim() || null;
		const portText = String(formData.get("port") ?? "").trim();
		const port = portText ? Number(portText) : null;
		if (
			port !== null &&
			!(Number.isInteger(port) && port > 0 && port < 65536)
		) {
			return fail(400, { error: "The port must be a number from 1 to 65535." });
		}
		if (Boolean(host) !== Boolean(user)) {
			return fail(400, {
				error:
					"Set both the host and the user, or clear both to turn the terminal off.",
			});
		}
		try {
			await MachineTerminalService.configure(machineId, { host, port, user });
		} catch (err) {
			if (err instanceof MachineTerminalError) {
				return fail(err.status, { error: err.message });
			}
			throw err;
		}
		logger.info(
			`Machine SSH settings saved: machine=${machineId} target=${user ?? "-"}@${host ?? "-"} user=${locals.user.id}`,
		);
		return { success: true };
	},
};
