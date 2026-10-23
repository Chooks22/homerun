import type { IacAttribute, IacKind } from "#lib/iac/resources.js";

type AttributeFactory = (
	name: string,
	kind: IacKind,
	options?: Omit<Partial<IacAttribute>, "kind" | "name">,
) => IacAttribute;

/** The homerun_service attributes of where a git build runs and caches its layers. */
export function buildTargetAttributes(attr: AttributeFactory): IacAttribute[] {
	return [
		attr("buildCacheBuiltin", "bool", {
			default: false,
			description: "Use the built-in registry as the build cache.",
		}),
		attr("buildCacheRegistryId", "string", {
			ref: "homerun_build_cache_registry",
		}),
		attr("buildServerRemoteHostId", "string"),
		attr("buildServerAny", "bool", {
			default: false,
			description:
				"Build on whichever build server has a free slot instead of build_server_remote_host_id.",
		}),
	];
}
