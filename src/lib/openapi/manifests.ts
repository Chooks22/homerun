import { z } from "zod";
import { manifestSchema } from "#lib/server/manifest.js";
import type { RouteDef } from "./registry";
import { errorResponse } from "./schemas";

const appliedManifestResponse = z.object({
	applied: z.array(z.string()).meta({ description: "The keys applied" }),
	deploymentId: z.string().optional().meta({
		description: "The deploy queued, with ?deploy=true",
	}),
	ignored: z.array(z.string()).meta({
		description:
			"Keys this service doesn't take: a preview or canary only takes build and runtime keys, a git service ignores image, tag and pullPolicy",
	}),
});

const validationResponse = z.object({
	errors: z.array(z.string()),
	valid: z.boolean(),
});

const tags = ["Manifests"];

export const manifestRoutes: RouteDef[] = [
	{
		description:
			"Applies a Homerun Manifest to the service, through the same checks as the dashboard. Send JSON, or YAML with a YAML content type. Keys left out keep their value; envVars are merged into the environment. Host access (privileged, devices, capabilities, env files), labels, networking mode, published ports and registry credentials can't be set this way. Add ?deploy=true to queue a deploy afterwards. A git service re-applies the manifest in its repository on every deploy, which wins over this one for the keys it sets.",
		method: "put",
		path: "/services/{serviceId}/manifest",
		pathParams: [{ description: "Service id", name: "serviceId" }],
		queryParams: [
			{ description: '"true" to queue a deploy once applied', name: "deploy" },
		],
		requestBody: manifestSchema,
		responses: {
			200: { description: "Applied", schema: appliedManifestResponse },
			202: {
				description: "Applied and a deploy queued",
				schema: appliedManifestResponse,
			},
			400: {
				description: "Invalid manifest, or a value the service's checks refuse",
				schema: errorResponse,
			},
			401: { description: "Unauthorized", schema: errorResponse },
			404: { description: "Not found", schema: errorResponse },
		},
		summary: "Apply a manifest to a service",
		tags,
	},
	{
		description:
			"Checks a Homerun Manifest against the schema without applying it. Send JSON, or YAML with a YAML content type.",
		method: "post",
		path: "/manifests/validate",
		requestBody: manifestSchema,
		responses: {
			200: { description: "The verdict", schema: validationResponse },
			401: { description: "Unauthorized", schema: errorResponse },
		},
		summary: "Validate a manifest",
		tags,
	},
	{
		description:
			"The Homerun Manifest's JSON schema for this instance's version, public. The same schema is published as manifest.schema.json at the root of Homerun's repository.",
		method: "get",
		path: "/manifest.schema.json",
		responses: {
			200: { description: "The JSON schema" },
		},
		summary: "Get the manifest JSON schema",
		tags,
	},
];
