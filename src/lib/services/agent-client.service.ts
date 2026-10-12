/** Decrypted connection to a registered agent-mode Homerun worker : see remote-host-dto.ts's `toAgentConnection`. */
export interface AgentConnection {
	agentUrl: string;
	token: string;
}

/** A non-2xx answer from an agent, carrying its status and its own message. */
export class AgentRequestError extends Error {
	status: number;

	/** Wraps the agent's `{ error }` message and the HTTP status it came with. */
	constructor(message: string, status: number) {
		super(message);
		this.name = "AgentRequestError";
		this.status = status;
	}
}

/**
 * The app's side of a registered remote host, the Homerun worker in agent
 * mode (see cmd/worker/README.md): the health and token checks the Remote
 * Hosts pages run, and the workstation calls. Builds on that host go through
 * the local worker's deploy job, not through here.
 */
class AgentClientServiceClass {
	/**
	 * One authenticated JSON call to an agent, with a 30s timeout.
	 *
	 * @throws `AgentRequestError` on a non-2xx answer (a 404 on an agent too
	 *   old to know the route reads as such), a plain Error when the agent
	 *   can't be reached.
	 */
	async request<T>(
		connection: AgentConnection,
		method: string,
		path: string,
		options?: { body?: unknown; query?: Record<string, string> },
	): Promise<T> {
		const url = new URL(path, connection.agentUrl);
		for (const [key, value] of Object.entries(options?.query ?? {})) {
			url.searchParams.set(key, value);
		}
		let response: Response;
		try {
			response = await fetch(url, {
				body:
					options?.body === undefined
						? undefined
						: JSON.stringify(options.body),
				headers: {
					authorization: `Bearer ${connection.token}`,
					...(options?.body === undefined
						? {}
						: { "content-type": "application/json" }),
				},
				method,
				signal: AbortSignal.timeout(30_000),
			});
		} catch (error) {
			throw new Error(
				`Couldn't reach the agent at ${connection.agentUrl} : ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		const text = await response.text().catch(() => "");
		if (!response.ok) {
			let message = `The agent answered ${response.status}.`;
			try {
				const decoded = JSON.parse(text) as { error?: unknown };
				if (typeof decoded.error === "string") {
					message = decoded.error;
				}
			} catch {
				if (text.trim() !== "") {
					message = text.trim();
				}
			}
			if (response.status === 404 && message === "Not found") {
				message =
					"This agent doesn't know that route. Update the Homerun worker on that host to this instance's version.";
			}
			throw new AgentRequestError(message, response.status);
		}
		return (text === "" ? null : JSON.parse(text)) as T;
	}

	/** GET /v1/health, unauthenticated. Throws with a human-readable message on any failure. */
	async checkHealth(
		agentUrl: string,
	): Promise<{ status: string; version: string }> {
		const url = new URL("/v1/health", agentUrl);
		let response: Response;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(5000) });
		} catch (error) {
			throw new Error(
				`Couldn't reach the agent at ${agentUrl} : ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (!response.ok) {
			throw new Error(`Agent health check returned ${response.status}.`);
		}
		return response.json();
	}

	/**
	 * Confirms the bearer token is actually accepted by the agent, by hitting
	 * an authenticated route (`/v1/stats`, cheap and side-effect-free).
	 * Throws on an unreachable host, a 401 (bad token), or any other failure.
	 */
	async verifyToken(agentUrl: string, token: string): Promise<void> {
		const url = new URL("/v1/stats", agentUrl);
		let response: Response;
		try {
			response = await fetch(url, {
				headers: { authorization: `Bearer ${token}` },
				signal: AbortSignal.timeout(5000),
			});
		} catch (error) {
			throw new Error(
				`Couldn't reach the agent at ${agentUrl} : ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (response.status === 401) {
			throw new Error("The agent rejected this token.");
		}
		if (!response.ok) {
			throw new Error(
				`Agent returned ${response.status} while verifying the token.`,
			);
		}
	}
}

export const AgentClientService = new AgentClientServiceClass();
