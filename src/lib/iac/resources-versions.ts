import type {
	IacAttribute,
	IacDataSource,
	IacKind,
} from "#lib/iac/resources.js";

type AttributeFactory = (
	name: string,
	kind: IacKind,
	options?: Omit<Partial<IacAttribute>, "kind" | "name">,
) => IacAttribute;

/** The homerun_service attributes of version pinning and the update watch: the watch is set here, a pin is setting tag. */
export function versionAttributes(attr: AttributeFactory): IacAttribute[] {
	return [
		attr("updateCheckEnabled", "bool", {
			default: false,
			description:
				"Image services: watch the registry for a newer release of tag, or a new image behind a floating tag. The homerun_service_version data source reads what it found.",
		}),
		attr("updateTrialEnabled", "bool", {
			default: true,
			description:
				"Image services: try each update in a throwaway container before notifying it.",
		}),
		attr("pinnedFromTag", "string", {
			description:
				"The floating tag the service was pinned from on the dashboard, the API or the CLI. Pinning here is setting tag.",
			readOnly: true,
		}),
		attr("pinnedLocally", "bool", { readOnly: true }),
	];
}

/** The homerun_service_version data source: an image service's pin and the update its last check found. */
export function serviceVersionDataSource(
	attr: AttributeFactory,
): IacDataSource {
	return {
		attributes: [
			attr("image", "string"),
			attr("tag", "string"),
			attr("pinned", "bool"),
			attr("pinnedFromTag", "string"),
			attr("pinnedLocally", "bool"),
			attr("updateCheckEnabled", "bool"),
			attr("updateTrialEnabled", "bool"),
			attr("checkedAt", "string"),
			attr("checkError", "string"),
			attr("availableTag", "string", {
				description:
					"The update the last check found, null when it's up to date. Set the service's tag to it to apply it.",
			}),
			attr("availableDigest", "string"),
			attr("availableFoundAt", "string"),
			attr("trialStatus", "string", {
				description: "The update's trial run: running, passed or failed.",
			}),
			attr("trialMessage", "string"),
			attr("trialTag", "string"),
			attr("trialAt", "string"),
		],
		collectionPath: "/services",
		description:
			"An image service's version pin and its last update check, by the service's id.",
		itemPath: "/services/{id}/version",
		lookup: [],
		type: "homerun_service_version",
	};
}
