import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/svelte";

/**
 * Imported inside each test, not at module scope: Svelte 5 compiles this
 * component's event handlers into a module-level `delegate([...])` call that
 * touches `document`, and the DOM only exists between svelte-loader.ts's
 * `beforeEach`/`afterEach` (see tests/unit/app/README.md).
 */
async function viewer() {
	return (await import("../../../src/lib/components/live-log-viewer.svelte"))
		.default;
}

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function hangingStream(): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			controller.enqueue(new TextEncoder().encode("first\n"));
		},
	});
}

function stubFetch(respond: (url: string) => Response | Promise<Response>) {
	const urls: string[] = [];
	const spy = spyOn(globalThis, "fetch").mockImplementation((async (
		input: RequestInfo | URL,
	) => {
		urls.push(String(input));
		return await respond(String(input));
	}) as typeof fetch);
	return { spy, urls };
}

afterEach(() => {
	(globalThis.fetch as unknown as { mockRestore?: () => void }).mockRestore?.();
});

describe("LiveLogViewer", () => {
	test("a swarm service's logs are not treated as undeployed", async () => {
		stubFetch(() => new Response(streamOf([])));
		const { queryByText, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "p10z6a15p3an0r",
		});

		expect(queryByText("This service hasn't been deployed yet.")).toBeNull();
		unmount();
	});

	test("says so only when there is no workload at all, and never fetches", async () => {
		const { spy } = stubFetch(() => new Response(streamOf([])));
		const { getByText, getByRole, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: null,
		});

		expect(getByText("This service hasn't been deployed yet.")).not.toBeNull();
		expect(
			getByRole("button", { name: /Reconnect/ }).hasAttribute("disabled"),
		).toBe(true);
		expect(spy).not.toHaveBeenCalled();
		unmount();
	});

	test("Reconnect stays enabled whatever the workload's health", async () => {
		stubFetch(() => new Response(null, { status: 500 }));
		const { getByRole, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "dead-container-id",
		});

		expect(
			getByRole("button", { name: /Reconnect/ }).hasAttribute("disabled"),
		).toBe(false);
		unmount();
	});
});

describe("LiveLogViewer streaming", () => {
	test("renders complete lines, joining ones split across chunks", async () => {
		const { urls } = stubFetch(
			() =>
				new Response(streamOf(["one\ntw", "o\n\x1b[31mred\x1b[0m\npartial"])),
		);
		const { container, unmount } = render(await viewer(), {
			logsUrl: "/system-logs/containers/traefik/logs",
			serviceId: "svc-1",
			workloadId: "c1",
		});

		await waitFor(() => {
			expect(container.querySelectorAll(".log-output > div").length).toBe(3);
		});
		const lines = [...container.querySelectorAll(".log-output > div")].map(
			(el) => el.textContent,
		);
		expect(lines).toEqual(["one", "two", "red"]);
		expect(container.textContent).not.toContain("partial");
		expect(urls).toEqual(["/system-logs/containers/traefik/logs"]);
		unmount();
	});

	test("defaults to the service's own log route", async () => {
		const { urls } = stubFetch(() => new Response(streamOf([])));
		const { unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "c1",
		});
		await waitFor(() => expect(urls.length).toBe(1));
		expect(urls[0]).toContain("/services/");
		unmount();
	});

	test("shows live while the stream is open", async () => {
		stubFetch(() => new Response(hangingStream()));
		const { getByText, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "c1",
		});
		await waitFor(() => expect(getByText("live")).not.toBeNull());
		expect(getByText("first")).not.toBeNull();
		unmount();
	});
});

describe("LiveLogViewer failures", () => {
	test("a refused request shows the server's reason", async () => {
		stubFetch(() => new Response("No container yet.", { status: 404 }));
		const { getByText, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "c1",
		});
		await waitFor(() => expect(getByText(/No container yet\./)).not.toBeNull());
		unmount();
	});

	test("a failed request says it couldn't connect", async () => {
		stubFetch(() => new Response("nope", { status: 502 }));
		const { getByText, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "c1",
		});
		await waitFor(() =>
			expect(getByText(/Couldn't connect to the log stream/)).not.toBeNull(),
		);
		unmount();
	});

	test("a broken stream or network error says so too, and Reconnect retries", async () => {
		let calls = 0;
		stubFetch(() => {
			calls += 1;
			if (calls === 1) {
				throw new Error("network down");
			}
			return new Response(streamOf(["back\n"]));
		});
		const { getByRole, getByText, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "c1",
		});
		await waitFor(() =>
			expect(getByText(/Couldn't connect to the log stream/)).not.toBeNull(),
		);

		await fireEvent.click(getByRole("button", { name: /Reconnect/ }));
		await waitFor(() => expect(getByText("back")).not.toBeNull());
		expect(calls).toBe(2);
		unmount();
	});

	test("an error mid-stream flips to the error message", async () => {
		const chunks = [new TextEncoder().encode("a\n")];
		const body = {
			getReader: () => ({
				cancel: async () => undefined,
				read: async () => {
					const value = chunks.shift();
					if (!value) {
						throw new Error("reset");
					}
					return { done: false, value };
				},
			}),
		};
		stubFetch(() => ({ body, ok: true }) as unknown as Response);
		const { getByText, unmount } = render(await viewer(), {
			serviceId: "svc-1",
			workloadId: "c1",
		});
		await waitFor(() =>
			expect(getByText(/Couldn't connect to the log stream/)).not.toBeNull(),
		);
		unmount();
	});
});
