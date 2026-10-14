import { describe, expect, test } from "bun:test";

const { parseRecordForm } = await import(
	"../../../src/lib/server/validation/dns-forms"
);
const { recordFormData, workstationColumns } = await import(
	"../../../src/lib/server/validation/infrastructure-api"
);

describe("recordFormData", () => {
	test("goes through the dashboard's record form checks", () => {
		expect(
			parseRecordForm(
				recordFormData({
					content: "mail.example.com",
					name: "@",
					priority: 20,
					ttl: 300,
					type: "mx",
				}),
				"example.com",
			),
		).toEqual({
			error: null,
			value: {
				content: "mail.example.com",
				name: "example.com",
				priority: 20,
				ttl: 300,
				type: "MX",
			},
		});
	});

	test("a missing TTL and priority read as automatic and the MX default", () => {
		const form = recordFormData({
			content: "mail.example.com",
			name: "www",
			type: "MX",
		});
		expect(form.get("ttl")).toBe("");
		expect(form.get("priority")).toBe("");
		expect(parseRecordForm(form, "example.com").value).toMatchObject({
			name: "www.example.com",
			priority: 10,
			ttl: null,
		});
	});

	test("a bad value is refused like the form refuses it", () => {
		expect(
			parseRecordForm(
				recordFormData({ content: "not-an-ip", name: "@", type: "A" }),
				"example.com",
			).error,
		).toBe("An A record's value is an IPv4 address.");
	});
});

describe("workstationColumns", () => {
	test("blanks become null, the CPU limit a number, extensions deduplicated, PASSWORD dropped", () => {
		expect(
			workstationColumns({
				cpuLimit: "1.5",
				env: { NODE_ENV: "dev", PASSWORD: "hunter2" },
				extensions: ["Esbenp.Prettier-Vscode", "esbenp.prettier-vscode"],
				gitAuthorEmail: "  ",
				gitAuthorName: " Alice ",
				gitBranch: null,
				port: 9000,
				remoteHostId: "",
			}),
		).toEqual({
			cpuLimit: 1.5,
			env: { NODE_ENV: "dev" },
			extensions: ["esbenp.prettier-vscode"],
			gitAuthorEmail: null,
			gitAuthorName: "Alice",
			gitBranch: null,
			port: 9000,
			remoteHostId: null,
		});
	});

	test("fields left out stay out, a cleared CPU limit stays null", () => {
		expect(workstationColumns({})).toEqual({});
		expect(workstationColumns({ cpuLimit: null, image: "ide:1" })).toEqual({
			cpuLimit: null,
			image: "ide:1",
		});
		expect(workstationColumns({ cpuLimit: 2 })).toEqual({ cpuLimit: 2 });
	});
});
