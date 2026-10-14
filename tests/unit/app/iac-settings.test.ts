import { describe, expect, test } from "bun:test";
import { detectDrift } from "../../../src/lib/iac/drift";
import { inventoryCounts } from "../../../src/lib/iac/generate";
import { providerDocs } from "../../../src/lib/iac/provider-docs";
import {
	IAC_RESOURCES,
	iacResource,
	importIdOf,
} from "../../../src/lib/iac/resources";
import { SINGLETON_ID } from "../../../src/lib/iac/resources-settings";

const smtpState = (host: string) =>
	JSON.stringify({
		resources: [
			{
				instances: [
					{
						attributes: {
							host,
							id: SINGLETON_ID,
							password: "hunter2",
							password_set: true,
							port: 587,
						},
					},
				],
				mode: "managed",
				name: "mail",
				type: "homerun_smtp_settings",
			},
		],
	});

const inventory = {
	homerun_smtp_settings: [
		{
			host: "smtp.example.com",
			id: SINGLETON_ID,
			passwordSet: true,
			port: 587,
		},
	],
	homerun_tls_settings: [{ id: SINGLETON_ID, installed: false, names: [] }],
};

describe("singleton resources", () => {
	test("sit at one fixed path, imported by the singleton id", () => {
		const singletons = IAC_RESOURCES.filter((resource) => resource.singleton);
		expect(singletons.map((resource) => resource.type).sort()).toEqual([
			"homerun_authentication_settings",
			"homerun_error_pages",
			"homerun_instance_settings",
			"homerun_ip_ban_settings",
			"homerun_registry_settings",
			"homerun_smtp_settings",
			"homerun_tls_settings",
		]);
		for (const resource of singletons) {
			expect(resource.itemPath).toBe(resource.collectionPath);
			expect(importIdOf(resource, { id: SINGLETON_ID })).toBe(SINGLETON_ID);
		}
	});

	test("are compared with the live settings and never reported unmanaged", () => {
		expect(detectDrift(smtpState("smtp.example.com"), inventory)).toEqual({
			drifted: [],
			inSync: 1,
			missing: [],
			unmanaged: [],
		});
		const drifted = detectDrift(smtpState("old.example.com"), inventory);
		expect(drifted.drifted).toEqual([
			{
				address: "homerun_smtp_settings.mail",
				changes: [
					{
						attribute: "host",
						live: "smtp.example.com",
						sensitive: false,
						state: "old.example.com",
					},
				],
				id: SINGLETON_ID,
				type: "homerun_smtp_settings",
			},
		]);
		expect(inventoryCounts(inventory)).toEqual([]);
	});

	test("document the fixed import id and that destroying only forgets them", () => {
		const page = providerDocs()["resources/smtp_settings.md"] ?? "";
		expect(page).toContain(`id = "${SINGLETON_ID}"`);
		expect(page).toContain("only removes it from the Terraform state");
	});

	test("the registry token keeps the secret only its create returns", () => {
		const secret = iacResource("homerun_registry_token")?.attributes.find(
			(attribute) => attribute.name === "secret",
		);
		expect(secret).toMatchObject({
			readOnly: true,
			returnedOnCreate: true,
			sensitive: true,
		});
	});
});
