import { afterEach, describe, expect, mock, test } from "bun:test";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({
	browser: false,
	building: false,
	dev: false,
}));

const { Logger } = await import("../../../src/lib/logger");
const { WorkstationDTO } = await import("../../../src/lib/dto/workstation-dto");
const { WorkstationService } = await import(
	"../../../src/lib/services/workstation.service"
);
const recreateRoute = await import(
	"../../../src/routes/api/v1/workstations/[workstationId]/recreate/+server"
);

afterEach(() => {
	restoreStubs();
});

function event(user: { id: string } | null = { id: "u1" }): never {
	return {
		locals: { permissions: {}, user },
		params: { workstationId: "ws1" },
	} as never;
}

const workstation = {
	id: "ws1",
	toPublic: () => ({ cpuLimit: 1.5, desiredState: "running", id: "ws1" }),
};

describe("POST /workstations/{id}/recreate", () => {
	test("refuses an anonymous caller", async () => {
		const response = await recreateRoute.POST(event(null));
		expect(response.status).toBe(401);
	});

	test("answers 404 for a workstation the caller doesn't own", async () => {
		const lookups: unknown[][] = [];
		stub(WorkstationDTO, "get", async (...args: unknown[]) => {
			lookups.push(args);
			return null;
		});
		const response = await recreateRoute.POST(event());
		expect(response.status).toBe(404);
		expect(lookups).toEqual([["ws1", "u1"]]);
	});

	test("starts it again and answers the workstation", async () => {
		const started: unknown[] = [];
		stub(WorkstationDTO, "get", async () => workstation);
		stub(WorkstationService, "start", async (ws: unknown) => {
			started.push(ws);
		});
		stub(Logger.prototype, "info", () => undefined);
		const response = await recreateRoute.POST(event());
		expect(response.status).toBe(200);
		expect(started).toEqual([workstation]);
		expect(await response.json()).toEqual({
			cpuLimit: "1.5",
			desiredState: "running",
			id: "ws1",
		});
	});

	test("a refused start answers 502 with its message", async () => {
		stub(WorkstationDTO, "get", async () => workstation);
		stub(WorkstationService, "start", async () => {
			throw new Error("agent unreachable");
		});
		stub(Logger.prototype, "error", () => undefined);
		const response = await recreateRoute.POST(event());
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "agent unreachable" });
	});
});
