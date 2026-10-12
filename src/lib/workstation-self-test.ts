import {
	type WorkstationStatus,
	workstationStateLabel,
} from "#lib/workstations.js";

/** One line of a workstation self-test: what was checked, whether it passed, and why. */
export interface WorkstationCheck {
	detail: string;
	label: string;
	ok: boolean;
}

/** Reads the worker's or agent's status: only a running container can be routed to. */
export function containerCheck(status: WorkstationStatus): WorkstationCheck {
	const label = "Container";
	if (status.state === "running") {
		return { detail: "The container is running.", label, ok: true };
	}
	const reason = status.error ? ` ${status.error}` : "";
	return {
		detail: `${workstationStateLabel(status.state)}, not running.${reason} The Logs tab shows what it printed.`,
		label,
		ok: false,
	};
}

/**
 * Reads what `https://<host>/` answered through Traefik: a 404 means no router
 * matches the host, a 502 to 504 means the router exists but nothing answers
 * on the IDE port, anything else is the IDE itself answering.
 */
export function routeCheck(
	host: string,
	status: number,
	port: number,
): WorkstationCheck {
	const label = `https://${host}`;
	if (status === 404) {
		return {
			detail: `Answered 404: Traefik has no router for ${host}, or the request reached something other than this server's Traefik. Check the host's DNS points at this server, then start the workstation again to recreate its route.`,
			label,
			ok: false,
		};
	}
	if (status >= 502 && status <= 504) {
		return {
			detail: `Answered ${status}: Traefik routes ${host} but nothing answers on port ${port} in the container. Check the IDE port under Settings matches the port the image listens on, and the Logs tab for a crash.`,
			label,
			ok: false,
		};
	}
	if (status >= 500) {
		return {
			detail: `Answered ${status}: the IDE is reachable but failing. The Logs tab shows why.`,
			label,
			ok: false,
		};
	}
	return {
		detail: `Answered ${status}: routed to the IDE with a certificate that verifies.`,
		label,
		ok: true,
	};
}
