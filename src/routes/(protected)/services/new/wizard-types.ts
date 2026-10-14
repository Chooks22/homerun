import type { ComponentProps } from "svelte";
import type GitBuildFields from "#lib/components/git-build-fields.svelte";
import type GitSourceFields from "#lib/components/git-source-fields.svelte";
import type ServiceLinkPicker from "#lib/components/service-link-picker.svelte";
import type { UiMode } from "#lib/ui-mode.js";

export interface WizardTemplate {
	containerPort: number;
	cpuLimit: string | null;
	envVars: Record<string, string> | null;
	memoryLimitMb: number | null;
	name: string;
	restartPolicy: string;
	tag: string;
}

export interface WizardData {
	baseDomain: string;
	buildCacheRegistries: ComponentProps<typeof GitBuildFields>["registries"];
	builtinCacheRunning: boolean;
	connectedGitProviders: ComponentProps<typeof GitSourceFields>["providers"];
	linkableServices: ComponentProps<typeof ServiceLinkPicker>["services"];
	serviceDomain: string;
	stackId: string | null;
	stackSlug: string | null;
	stacks: ComponentProps<typeof ServiceLinkPicker>["stacks"];
	template: WizardTemplate | null;
	uiMode: UiMode;
}

export interface WizardVolume {
	id: string;
	kind: string;
	name: string;
	source: string;
}
