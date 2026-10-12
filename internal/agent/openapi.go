package agent

import "github.com/orochibraru/homerun/internal/buildinfo"

type object = map[string]any

// jsonResponse is an OpenAPI response object with a JSON body of schema.
func jsonResponse(description string, schema object) object {
	return object{
		"content":     object{"application/json": object{"schema": schema}},
		"description": description,
	}
}

var (
	errorSchema = object{
		"properties": object{"error": object{"type": "string"}, "issues": object{}},
		"required":   []string{"error"},
		"type":       "object",
	}
	nullableNumber = object{"type": []string{"number", "null"}}
	statsSchema    = object{
		"properties": object{
			"cpuPercent":  object{"type": "number"},
			"diskPercent": nullableNumber,
			"diskTotalMb": nullableNumber,
			"diskUsedMb":  nullableNumber,
			"gpu": object{
				"anyOf": []object{
					{
						"properties": object{
							"memTotalMb":         object{"type": "number"},
							"memUsedMb":          object{"type": "number"},
							"name":               object{"type": "string"},
							"utilizationPercent": object{"type": "number"},
						},
						"required": []string{"memTotalMb", "memUsedMb", "name", "utilizationPercent"},
						"type":     "object",
					},
					{"type": "null"},
				},
			},
			"memPercent": object{"type": "number"},
			"memTotalMb": object{"type": "number"},
			"memUsedMb":  object{"type": "number"},
		},
		"required": []string{
			"cpuPercent", "diskPercent", "diskTotalMb", "diskUsedMb", "gpu",
			"memPercent", "memTotalMb", "memUsedMb",
		},
		"type": "object",
	}
	buildResultSchema = object{
		"properties": object{
			"commit":  object{"type": []string{"string", "null"}},
			"error":   object{"type": "string"},
			"success": object{"type": "boolean"},
		},
		"required": []string{"success"},
		"type":     "object",
	}
	workstationStatusSchema = object{
		"properties": object{
			"containerId": object{"type": "string"},
			"error":       object{"type": "string"},
			"hostPort":    object{"type": "integer"},
			"state": object{"enum": []string{
				"pulling", "starting", "cloning", "running", "stopped", "failed", "missing",
			}},
		},
		"required": []string{"hostPort", "state"},
		"type":     "object",
	}
	workstationSpecSchema = object{
		"properties": object{
			"env": object{"additionalProperties": object{"type": "string"}, "type": []string{"object", "null"}},
			"git": object{
				"properties": object{
					"branch":    object{"type": "string"},
					"directory": object{"pattern": "^[A-Za-z0-9._-]{1,100}$", "type": "string"},
					"token":     object{"type": "string"},
					"url":       object{"type": "string"},
					"username":  object{"type": "string"},
				},
				"required": []string{"directory", "url"},
				"type":     []string{"object", "null"},
			},
			"homePath":    object{"type": "string"},
			"image":       object{"minLength": 1, "type": "string"},
			"labels":      object{"additionalProperties": object{"type": "string"}, "type": []string{"object", "null"}},
			"memoryBytes": object{"minimum": 0, "type": "integer"},
			"name":        object{"pattern": "^[a-z0-9][a-z0-9_.-]{0,62}$", "type": "string"},
			"nanoCpus":    object{"minimum": 0, "type": "integer"},
			"network":     object{"type": "string"},
			"port":        object{"maximum": 65535, "minimum": 1, "type": "integer"},
			"publish":     object{"type": "boolean"},
		},
		"required": []string{"homePath", "image", "name", "port"},
		"type":     "object",
	}
	workstationIDParameter = object{"in": "path", "name": "id", "required": true, "schema": object{"pattern": "^[A-Za-z0-9-]{1,64}$", "type": "string"}}
	okSchema               = object{"properties": object{"ok": object{"type": "boolean"}}, "required": []string{"ok"}, "type": "object"}
	nullableString         = object{"type": []string{"string", "null"}}
	buildInputSchema       = object{
		"properties": object{
			"bakeFile":     nullableString,
			"buildTarget":  object{"pattern": "^[A-Za-z0-9_][A-Za-z0-9_-]*$", "type": []string{"string", "null"}},
			"buildContext": nullableString,
			"buildMethod":  object{"enum": append(toAny(Tools.BuildMethods), nil)},
			"commit":       object{"pattern": "^[0-9a-f]{40}$", "type": []string{"string", "null"}},
			"credential": object{
				"properties": object{"token": object{"minLength": 1, "type": "string"}, "username": object{"type": "string"}},
				"required":   []string{"token", "username"},
				"type":       []string{"object", "null"},
			},
			"dockerfilePath": nullableString,
			"gitRef":         nullableString,
			"gitUrl":         object{"minLength": 1, "type": "string"},
			"noCache":        object{"type": "boolean"},
			"platform":       object{"pattern": "^[a-z0-9]+/[a-z0-9]+$", "type": []string{"string", "null"}},
			"push": object{
				"properties": object{
					"password":    object{"type": "string"},
					"registryUrl": object{"minLength": 1, "type": "string"},
					"tag":         object{"minLength": 1, "type": "string"},
					"username":    object{"type": "string"},
				},
				"required": []string{"password", "registryUrl", "tag", "username"},
				"type":     []string{"object", "null"},
			},
			"tag": object{"minLength": 1, "type": "string"},
		},
		"required": []string{"gitUrl", "tag"},
		"type":     "object",
	}
)

// toAny widens a string slice to []any, for an OpenAPI enum value.
func toAny(values []string) []any {
	out := make([]any, 0, len(values))
	for _, value := range values {
		out = append(out, value)
	}
	return out
}

var bearer = []object{{"bearerAuth": []string{}}}

// openAPIDocument describes the agent's /v1 routes, with baseURL written into
// the document's servers entry.
func openAPIDocument(baseURL string) object {
	return object{
		"components": object{
			"securitySchemes": object{
				"bearerAuth": object{"bearerFormat": "opaque", "scheme": "bearer", "type": "http"},
			},
		},
		"info": object{
			"description": "The Homerun worker's agent-mode HTTP surface on a remote host : builds, image exports, dev workstations and host stats for the one Docker daemon it runs on. See cmd/worker/README.md.",
			"title":       "Homerun worker (agent mode) API",
			"version":     buildinfo.Version,
		},
		"openapi": "3.1.0",
		"paths": object{
			"/v1/build": object{"post": object{
				"description": "Clones a git repo at a ref and builds it into a local image tagged `tag` with `buildMethod` (its Dockerfile with BuildKit by default, a Docker Bake target, or Nixpacks, Railpack, Heroku or Paketo buildpacks), using `push`'s registry as the BuildKit layer cache and pushing the image to it afterward when set.",
				"requestBody": object{
					"content":  object{"application/json": object{"schema": buildInputSchema}},
					"required": true,
				},
				"responses": object{
					"200": jsonResponse("Build succeeded", buildResultSchema),
					"400": jsonResponse("Invalid request body", errorSchema),
					"401": jsonResponse("Unauthorized", errorSchema),
					"500": jsonResponse("Build failed", buildResultSchema),
				},
				"security": bearer,
				"summary":  "Build an image from a git repo",
				"tags":     []string{"Deploy"},
			}},
			"/v1/health": object{"get": object{
				"description": "Unauthenticated on purpose, for a load balancer/monitor probe.",
				"responses": object{
					"200": jsonResponse("OK", object{
						"properties": object{"status": object{"type": "string"}, "version": object{"type": "string"}},
						"required":   []string{"status", "version"},
						"type":       "object",
					}),
				},
				"summary": "Health check",
				"tags":    []string{"Meta"},
			}},
			"/v1/images/save": object{"get": object{
				"description": "Streams a local image as a `docker save` tarball, so the main app can `docker load` a build onto its own daemon when no cache registry is configured.",
				"parameters": []object{
					{"in": "query", "name": "ref", "required": true, "schema": object{"type": "string"}},
				},
				"responses": object{
					"200": object{
						"content":     object{"application/x-tar": object{"schema": object{"format": "binary", "type": "string"}}},
						"description": "The image tarball",
					},
					"400": object{"description": "Missing ref"},
					"401": object{"description": "Unauthorized"},
					"404": object{"description": "Image not found"},
				},
				"security": bearer,
				"summary":  "Export an image",
				"tags":     []string{"Deploy"},
			}},
			"/v1/workstations/{id}": object{
				"delete": object{
					"description": "Removes the workstation's container, and its home volume too with `volume=1`.",
					"parameters": []object{
						workstationIDParameter,
						{"in": "query", "name": "volume", "schema": object{"enum": []string{"0", "1"}}},
					},
					"responses": object{
						"200": jsonResponse("Removed", okSchema),
						"401": jsonResponse("Unauthorized", errorSchema),
					},
					"security": bearer,
					"summary":  "Remove a workstation",
					"tags":     []string{"Workstations"},
				},
				"get": object{
					"description": "What an in-flight start or the container itself says, with the host port it's published on when `port` names the container port.",
					"parameters": []object{
						workstationIDParameter,
						{"in": "query", "name": "port", "schema": object{"type": "integer"}},
					},
					"responses": object{
						"200": jsonResponse("The workstation's status", workstationStatusSchema),
						"401": jsonResponse("Unauthorized", errorSchema),
					},
					"security": bearer,
					"summary":  "Workstation status",
					"tags":     []string{"Workstations"},
				},
				"put": object{
					"description": "Pulls the image, ensures the home volume, recreates and starts the container, then clones `git` into the home volume when it isn't there yet. Answers as soon as the start is under way; poll the GET for progress.",
					"parameters":  []object{workstationIDParameter},
					"requestBody": object{
						"content":  object{"application/json": object{"schema": workstationSpecSchema}},
						"required": true,
					},
					"responses": object{
						"202": jsonResponse("Starting", workstationStatusSchema),
						"400": jsonResponse("Invalid spec", errorSchema),
						"401": jsonResponse("Unauthorized", errorSchema),
						"409": jsonResponse("Already starting", errorSchema),
					},
					"security": bearer,
					"summary":  "Start or recreate a workstation",
					"tags":     []string{"Workstations"},
				},
			},
			"/v1/workstations/{id}/connections": object{"get": object{
				"description": "How many established TCP connections the IDE's container port holds open, read inside the running container: its open browser tabs. The app's idle auto-stop polls it.",
				"parameters": []object{
					workstationIDParameter,
					{"in": "query", "name": "port", "required": true, "schema": object{"maximum": 65535, "minimum": 1, "type": "integer"}},
				},
				"responses": object{
					"200": jsonResponse("The open connections", object{"properties": object{"connections": object{"type": "integer"}}, "required": []string{"connections"}, "type": "object"}),
					"400": jsonResponse("Invalid port", errorSchema),
					"401": jsonResponse("Unauthorized", errorSchema),
					"404": jsonResponse("Not running", errorSchema),
					"409": jsonResponse("Still starting", errorSchema),
				},
				"security": bearer,
				"summary":  "Workstation connections",
				"tags":     []string{"Workstations"},
			}},
			"/v1/workstations/{id}/logs": object{"get": object{
				"description": "The container's stdout and stderr as plain text: the last `tail` lines (500 by default), then everything it writes after unless `follow=0`.",
				"parameters": []object{
					workstationIDParameter,
					{"in": "query", "name": "tail", "schema": object{"minimum": 0, "type": "integer"}},
					{"in": "query", "name": "follow", "schema": object{"enum": []string{"0", "1"}}},
				},
				"responses": object{
					"200": object{"content": object{"text/plain": object{"schema": object{"type": "string"}}}, "description": "The log stream"},
					"401": jsonResponse("Unauthorized", errorSchema),
					"404": jsonResponse("No container yet", errorSchema),
				},
				"security": bearer,
				"summary":  "Workstation logs",
				"tags":     []string{"Workstations"},
			}},
			"/v1/workstations/{id}/stop": object{"post": object{
				"parameters": []object{workstationIDParameter},
				"responses": object{
					"200": jsonResponse("Stopped", okSchema),
					"401": jsonResponse("Unauthorized", errorSchema),
				},
				"security": bearer,
				"summary":  "Stop a workstation",
				"tags":     []string{"Workstations"},
			}},
			"/v1/stats": object{"get": object{
				"responses": object{
					"200": jsonResponse("Host CPU/RAM/disk/GPU stats", statsSchema),
					"401": jsonResponse("Unauthorized", errorSchema),
				},
				"security": bearer,
				"summary":  "Host resource stats",
				"tags":     []string{"Meta"},
			}},
		},
		"servers": []object{{"url": baseURL}},
	}
}
