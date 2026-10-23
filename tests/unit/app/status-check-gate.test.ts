import { afterEach, describe, expect, mock, test } from "bun:test";
import type { CheckResult } from "../../../src/lib/status-checks";
import { restoreStubs, stub } from "../support/stub";

mock.module("$app/env", () => ({ building: false, dev: false }));

const { StatusCheckService } = await import(
	"../../../src/lib/services/status-check.service"
);
const { JobDeferredError } = await import(
	"../../../src/lib/services/queue/deferred"
);
const { gateStatusChecks, StatusChecksFailedError } = await import(
	"../../../src/lib/services/deploy/status-check-step"
);

const SHA = "b".repeat(40);

function fakeDep(gitCommit: string | null = null, log = "") {
	const dep = {
		appendLog: mock(async (line: string) => {
			dep.log += `${line}\n`;
		}),
		log,
		toJSON: () => ({ gitCommit }),
		update: mock(async () => undefined),
	};
	return dep;
}

function fakeSvc(overrides: Record<string, unknown> = {}) {
	const row = {
		gitRef: "main",
		gitUrl: "https://github.com/acme/web.git",
		requireStatusChecks: true,
		requiredStatusChecks: ["build"],
		...overrides,
	};
	return { id: "svc-1", toJSON: () => row };
}

function fakeJob(
	gate: "status-checks" | "build-slot" | null = null,
	since: Date = new Date(),
) {
	return { deferral: gate ? { gate, since } : null, id: "job-1" };
}

function client(states: CheckResult["state"][]) {
	const checks = mock(async () =>
		states.map((state) => ({ detail: null, name: "build", state })),
	);
	const resolveCommit = mock(async () => SHA);
	stub(StatusCheckService, "clientFor", async () => ({
		checks,
		resolveCommit,
	}));
	return { checks, resolveCommit };
}

function gate(
	dep: ReturnType<typeof fakeDep>,
	svc: ReturnType<typeof fakeSvc>,
	job: ReturnType<typeof fakeJob>,
) {
	return gateStatusChecks({
		dep,
		job,
		svc,
		userId: "user-1",
	} as never);
}

afterEach(() => restoreStubs());

describe("gateStatusChecks", () => {
	test("passes through a service that doesn't require checks", async () => {
		const { resolveCommit } = client(["success"]);
		const result = await gate(
			fakeDep(),
			fakeSvc({ requireStatusChecks: false }),
			fakeJob(),
		);
		expect(result).toBeNull();
		expect(resolveCommit).not.toHaveBeenCalled();
	});

	test("pins the commit and returns it when the checks passed", async () => {
		client(["success"]);
		const dep = fakeDep();
		expect(await gate(dep, fakeSvc(), fakeJob())).toBe(SHA);
		expect(dep.update).toHaveBeenCalledWith({ gitCommit: SHA, gitRef: "main" });
	});

	test("defers the job while the checks are pending, logging the wait once", async () => {
		client(["pending"]);
		const dep = fakeDep();
		const first = gate(dep, fakeSvc(), fakeJob());
		await expect(first).rejects.toBeInstanceOf(JobDeferredError);
		await first.catch((err) => {
			expect(err.gate).toBe("status-checks");
		});
		const waits = () =>
			dep.appendLog.mock.calls.filter(([line]) =>
				String(line).startsWith("Waiting for status checks"),
			).length;
		expect(waits()).toBe(1);

		const pinned = fakeDep(SHA, dep.log);
		await expect(
			gate(pinned, fakeSvc(), fakeJob("status-checks", new Date())),
		).rejects.toBeInstanceOf(JobDeferredError);
		expect(pinned.appendLog).not.toHaveBeenCalled();
	});

	test("checks the commit pinned on the first round, not the branch head again", async () => {
		const { resolveCommit } = client(["success"]);
		const result = await gate(
			fakeDep("c".repeat(40)),
			fakeSvc(),
			fakeJob("status-checks", new Date()),
		);
		expect(result).toBe("c".repeat(40));
		expect(resolveCommit).not.toHaveBeenCalled();
	});

	test("a job waiting on its build slot already passed and keeps its commit", async () => {
		const { checks } = client(["failure"]);
		const result = await gate(
			fakeDep(SHA),
			fakeSvc(),
			fakeJob("build-slot", new Date()),
		);
		expect(result).toBe(SHA);
		expect(checks).not.toHaveBeenCalled();
	});

	test("fails on a failed check and once the wait timed out", async () => {
		client(["failure"]);
		await expect(gate(fakeDep(), fakeSvc(), fakeJob())).rejects.toBeInstanceOf(
			StatusChecksFailedError,
		);

		client(["pending"]);
		const longAgo = new Date(Date.now() - 31 * 60 * 1000);
		await expect(
			gate(fakeDep(SHA), fakeSvc(), fakeJob("status-checks", longAgo)),
		).rejects.toThrow("didn't finish within 30 minutes");
	});

	test("fails when checks are required but none are selected", async () => {
		client(["success"]);
		await expect(
			gate(fakeDep(), fakeSvc({ requiredStatusChecks: [] }), fakeJob()),
		).rejects.toThrow("no checks are selected");
	});
});
