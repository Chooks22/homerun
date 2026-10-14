import { config } from "#lib/config.js";

/**
 * How long a plain control call may take before it's abandoned. Generous
 * because some of these are genuinely slow against the daemon rather than
 * slow because something is wrong: `docker stop` waits out its own SIGTERM
 * grace period (10s by default) before killing, and a Traefik recreate stops,
 * removes and recreates a container inside one request.
 */
const REQUEST_TIMEOUT_MS = 60_000;

/** A non-2xx answer from the worker, carrying its status and its own message. */
export class WorkerRequestError extends Error {
	status: number;

	/** Wraps the worker's `{ error }` body and the HTTP status it came with. */
	constructor(message: string, status: number) {
		super(message);
		this.name = "WorkerRequestError";
		this.status = status;
	}
}

/** Whether an error is the worker reporting that the thing asked about is gone. */
export function isNotFound(error: unknown): boolean {
	return error instanceof WorkerRequestError && error.status === 404;
}

/**
 * The Go worker's Docker control API, as seen from the app.
 *
 * This is the whole of the app's access to Docker. There is no dockerode here
 * and no socket: the worker is the process that holds it, and the app asks.
 * The split is deliberate and worth keeping — everything that decides *what*
 * should happen (labels, container specs, swarm templates, keep sets, which
 * service is whose) stays on this side with the database, and the worker only
 * performs engine I/O and reports what it saw.
 *
 * Methods here are thin and mirror the worker's routes one for one; the
 * DockerService mixins compose them into the operations the rest of the app
 * calls, which is why those call sites didn't change when this replaced
 * dockerode underneath them.
 */
class WorkerClientClass {
	/** The worker's base URL, from `worker.url` (env `WORKER_URL`). */
	get baseUrl(): string {
		return config.worker.url.replace(/\/+$/, "");
	}

	/**
	 * A GET returning JSON.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	get<T>(path: string, query?: Record<string, string | undefined>): Promise<T> {
		return this.#json<T>("GET", this.#path(path, query));
	}

	/**
	 * A POST returning JSON, with an optional JSON body.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	post<T>(
		path: string,
		body?: unknown,
		query?: Record<string, string | undefined>,
	): Promise<T> {
		return this.#json<T>("POST", this.#path(path, query), body);
	}

	/**
	 * A PUT with a JSON body, returning JSON.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	put<T>(path: string, body: unknown): Promise<T> {
		return this.#json<T>("PUT", this.#path(path), body);
	}

	/**
	 * Any JSON call, with extra request headers.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	request<T>(
		method: "DELETE" | "GET" | "POST" | "PUT",
		path: string,
		options?: {
			body?: unknown;
			headers?: Record<string, string>;
			query?: Record<string, string | undefined>;
		},
	): Promise<T> {
		return this.#json<T>(
			method,
			this.#path(path, options?.query),
			options?.body,
			options?.headers,
		);
	}

	/**
	 * A PUT whose body is a raw byte stream rather than JSON, for writing a
	 * tar archive into a container.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	async putRaw(
		path: string,
		body: BodyInit,
		query?: Record<string, string | undefined>,
	): Promise<void> {
		const response = await this.#fetch("PUT", this.#path(path, query), {
			body,
			headers: { "content-type": "application/x-tar" },
		});
		await this.#assertOk(response);
	}

	/**
	 * A POST whose body is raw bytes rather than JSON, for terminal input.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	async postRaw(path: string, body: BodyInit): Promise<void> {
		const response = await this.#fetch("POST", this.#path(path), { body });
		await this.#assertOk(response);
	}

	/**
	 * A DELETE returning JSON.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	delete<T>(
		path: string,
		query?: Record<string, string | undefined>,
	): Promise<T> {
		return this.#json<T>("DELETE", this.#path(path, query));
	}

	/**
	 * Opens a long-lived response body as a web stream: a followed log, a
	 * terminal's output, a pull's progress.
	 *
	 * Deliberately has no timeout, unlike every other call here — these are
	 * meant to stay open, and the caller cancelling the stream (which a
	 * SvelteKit response does when the browser disconnects) is what closes the
	 * connection and lets the worker stop writing.
	 * @throws `WorkerRequestError` on a non-2xx answer.
	 */
	async stream(
		path: string,
		options?: {
			body?: unknown;
			headers?: Record<string, string>;
			method?: string;
			query?: Record<string, string | undefined>;
			signal?: AbortSignal;
		},
	): Promise<ReadableStream<Uint8Array>> {
		const method = options?.method ?? "GET";
		const response = await fetch(this.#path(path, options?.query), {
			body:
				options?.body === undefined ? undefined : JSON.stringify(options.body),
			headers: {
				authorization: `Bearer ${config.worker.token}`,
				...options?.headers,
				...(options?.body === undefined
					? {}
					: { "content-type": "application/json" }),
			},
			method,
			signal: options?.signal,
		}).catch((error: unknown) => {
			throw this.#unreachable(error);
		});
		await this.#assertOk(response);
		return response.body ?? new ReadableStream({ start: (c) => c.close() });
	}

	/** Builds an absolute worker URL with an optional query, dropping undefined values. */
	#path(path: string, query?: Record<string, string | undefined>): string {
		const url = new URL(path, `${this.baseUrl}/`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) {
				url.searchParams.set(key, value);
			}
		}
		return url.toString();
	}

	/** Sends one authenticated request with the shared timeout. */
	#fetch(
		method: string,
		url: string,
		init?: { body?: BodyInit; headers?: Record<string, string> },
	): Promise<Response> {
		return fetch(url, {
			body: init?.body,
			headers: {
				authorization: `Bearer ${config.worker.token}`,
				...init?.headers,
			},
			method,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		}).catch((error: unknown) => {
			throw this.#unreachable(error);
		});
	}

	/** Sends a request and decodes its JSON answer. */
	async #json<T>(
		method: string,
		url: string,
		body?: unknown,
		headers?: Record<string, string>,
	): Promise<T> {
		const response = await this.#fetch(method, url, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: {
				...headers,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
		});
		await this.#assertOk(response);
		const text = await response.text();
		return (text === "" ? null : JSON.parse(text)) as T;
	}

	/** Turns a non-2xx answer into a WorkerRequestError carrying the worker's own message. */
	async #assertOk(response: Response): Promise<void> {
		if (response.ok) {
			return;
		}
		const text = await response.text().catch(() => "");
		let message = `The worker answered ${response.status}.`;
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
		throw new WorkerRequestError(message, response.status);
	}

	/**
	 * The error for a worker that can't be reached at all, which is a
	 * different problem from one that answered badly: the app is running
	 * without the process that owns the Docker socket, and saying so beats a
	 * bare "fetch failed".
	 */
	#unreachable(error: unknown): Error {
		const reason = error instanceof Error ? error.message : String(error);
		return new Error(
			`Couldn't reach the Homerun worker at ${this.baseUrl} : ${reason}`,
		);
	}
}

export const WorkerClient = new WorkerClientClass();
