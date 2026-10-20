import { describe, expect, test } from "bun:test";
import { updateComputeSchema } from "../../../src/lib/server/validation/service";
import {
	formatNodeLabels,
	isDefaultSwarmPlacement,
	normalizePlacementConstraint,
	normalizePlacementPreference,
	parseNodeLabels,
	swarmPlacementFrom,
	swarmPlacementSpec,
} from "../../../src/lib/swarm-placement";

describe("swarmPlacementSpec", () => {
	test("leaves placement unset by default", () => {
		expect(swarmPlacementSpec(null)).toBeUndefined();
		expect(
			swarmPlacementSpec({
				constraints: [],
				preferences: [],
				roles: ["manager", "worker"],
			}),
		).toBeUndefined();
		expect(isDefaultSwarmPlacement(swarmPlacementFrom({}))).toBe(true);
	});

	test("maps one role, label constraints and spread preferences", () => {
		expect(
			swarmPlacementSpec({
				constraints: ["env==staging", "disk!=hdd"],
				preferences: ["zone"],
				roles: ["worker"],
			}),
		).toEqual({
			Constraints: [
				"node.role==worker",
				"node.labels.env==staging",
				"node.labels.disk!=hdd",
			],
			Preferences: [{ Spread: { SpreadDescriptor: "node.labels.zone" } }],
		});
	});

	test("sends preferences alone without an empty constraint list", () => {
		expect(
			swarmPlacementSpec({
				constraints: [],
				preferences: ["zone"],
				roles: ["manager", "worker"],
			}),
		).toEqual({
			Constraints: undefined,
			Preferences: [{ Spread: { SpreadDescriptor: "node.labels.zone" } }],
		});
	});

	test("falls back to every role when none is stored", () => {
		expect(swarmPlacementFrom({ roles: [] }).roles).toEqual([
			"manager",
			"worker",
		]);
	});
});

describe("normalizers", () => {
	test("constraints drop spacing and a pasted node.labels. prefix", () => {
		expect(normalizePlacementConstraint(" env == staging ")).toBe(
			"env==staging",
		);
		expect(normalizePlacementConstraint("node.labels.env!=prod")).toBe(
			"env!=prod",
		);
		expect(normalizePlacementConstraint("env=staging")).toBeNull();
		expect(normalizePlacementConstraint("==x")).toBeNull();
	});

	test("preferences accept a key or a full spread descriptor", () => {
		expect(normalizePlacementPreference("zone")).toBe("zone");
		expect(normalizePlacementPreference("spread=node.labels.zone")).toBe(
			"zone",
		);
		expect(normalizePlacementPreference("a zone")).toBeNull();
	});
});

describe("node labels", () => {
	test("round-trips key=value lines", () => {
		const labels = parseNodeLabels("zone = eu\n\nenv=staging\n");
		expect(labels).toEqual({ env: "staging", zone: "eu" });
		expect(formatNodeLabels(labels)).toBe("env=staging\nzone=eu");
	});

	test("refuses a line without a key", () => {
		expect(() => parseNodeLabels("staging")).toThrow();
		expect(() => parseNodeLabels("=x")).toThrow();
	});
});

describe("updateComputeSchema placement", () => {
	test("leaves placement alone when the form has no placement fields", () => {
		const result = updateComputeSchema.parse({ replicas: "2" });
		expect(result.swarmPlacement).toBeUndefined();
	});

	test("reads roles, constraints and preferences", () => {
		const result = updateComputeSchema.parse({
			placementConstraints: "env == staging\n\n",
			placementPreferences: "zone",
			placementWorker: "on",
		});
		expect(result.swarmPlacement).toEqual({
			constraints: ["env==staging"],
			preferences: ["zone"],
			roles: ["worker"],
		});
	});

	test("needs a role and well-formed lines", () => {
		const result = updateComputeSchema.safeParse({
			placementConstraints: "env=staging",
			placementPreferences: "",
		});
		expect(result.success).toBe(false);
		const errors = result.error?.flatten().fieldErrors ?? {};
		expect(Object.keys(errors).sort()).toEqual([
			"placementConstraints",
			"placementRoles",
		]);
	});
});

describe("updateServiceApiBody swarmPlacement", () => {
	test("normalizes lines and defaults the rest", async () => {
		const { updateServiceApiBody } = await import(
			"../../../src/lib/server/validation/api"
		);
		const result = updateServiceApiBody.parse({
			swarmPlacement: { constraints: ["node.labels.env == staging"] },
		});
		expect(result.swarmPlacement).toEqual({
			constraints: ["env==staging"],
			preferences: [],
			roles: ["manager", "worker"],
		});
		expect(
			updateServiceApiBody.parse({
				swarmPlacement: { preferences: ["spread=node.labels.zone"] },
			}).swarmPlacement?.preferences,
		).toEqual(["zone"]);
		expect(
			updateServiceApiBody.safeParse({
				swarmPlacement: { constraints: ["env=staging"] },
			}).success,
		).toBe(false);
		expect(
			updateServiceApiBody.safeParse({
				swarmPlacement: { preferences: ["a zone"] },
			}).success,
		).toBe(false);
		expect(
			updateServiceApiBody.safeParse({ swarmPlacement: { roles: [] } }).success,
		).toBe(false);
	});
});
