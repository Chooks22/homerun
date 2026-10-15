export const BUILD_METHODS = [
	"dockerfile",
	"bake",
	"nixpacks",
	"railpack",
	"heroku",
	"paketo",
] as const;

export type BuildMethod = (typeof BUILD_METHODS)[number];

export const DEFAULT_BAKE_FILE = "docker-bake.hcl";

export const DEFAULT_BAKE_TARGET = "default";

export const BAKE_TARGET_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const BUILD_ARG_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const BUILD_METHOD_LABELS: Record<BuildMethod, string> = {
	bake: "Docker Bake",
	dockerfile: "Dockerfile",
	heroku: "Heroku buildpacks",
	nixpacks: "Nixpacks",
	paketo: "Paketo buildpacks",
	railpack: "Railpack",
};

export const BUILD_METHOD_DESCRIPTIONS: Record<BuildMethod, string> = {
	bake: "Build one target of a Docker Bake file (HCL, JSON or a compose file) with BuildKit.",
	dockerfile: "Build the Dockerfile in the repository with BuildKit.",
	heroku:
		"Detect the language and build with Cloud Native Buildpacks on heroku/builder:24.",
	nixpacks:
		"Detect the language and build with Nixpacks, no Dockerfile needed.",
	paketo:
		"Detect the language and build with Cloud Native Buildpacks on paketobuildpacks/builder-jammy-base.",
	railpack:
		"Detect the language and build with Railpack, the successor to Nixpacks.",
};

/** Whether `value` names one of the supported build methods. */
export function isBuildMethod(value: unknown): value is BuildMethod {
	return (
		typeof value === "string" &&
		(BUILD_METHODS as readonly string[]).includes(value)
	);
}
