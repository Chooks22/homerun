<script lang="ts">
	import { Plus, ScanSearch, Trash2 } from "@lucide/svelte";
	import EnvPasteButton from "#lib/components/env-paste-button.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import ServiceLinkPicker from "#lib/components/service-link-picker.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import { mergeEnvRows, type ParsedEnvVar } from "#lib/env-parse.js";
	import {
		type DetectedConfig,
		detectedFrom,
		overridableEnv,
	} from "#lib/image-config.js";
	import type { WizardData } from "./wizard-types";

	interface Props {
		data: WizardData;
		detected: DetectedConfig | null;
		hidden: boolean;
	}

	const { data, detected, hidden }: Props = $props();

	const detectedEnv = $derived(
		Object.entries(overridableEnv(detected?.env ?? {})).map(([key, value]) => ({
			key,
			value,
		})),
	);

	function envRowsFromTemplate(): ParsedEnvVar[] {
		const entries = data.template
			? Object.entries(data.template.envVars ?? {}).map(([key, value]) => ({
					key,
					value,
				}))
			: [];
		return entries.length > 0 ? entries : [{ key: "", value: "" }];
	}

	// $state, not $derived: pushed/spliced into directly below
	// (addEnvRow/removeEnvRow), a $derived value is read-only, so mutating
	// it doesn't reliably stick (see the same fix in settings/+page.svelte
	// for the OAuth-providers form this pattern was originally copied from).
	// Seeded once at init; re-synced if `data.template` changes (picking a
	// different template mid-form via the template-context query param).
	let envRows = $state<ParsedEnvVar[]>(envRowsFromTemplate());
	$effect(() => {
		envRows = envRowsFromTemplate();
	});

	function removeEnvRow(i: number) {
		envRows.splice(i, 1);
		if (envRows.length === 0) {
			envRows.push({ key: "", value: "" });
		}
	}

	function importEnvRows(imported: ParsedEnvVar[]) {
		envRows = mergeEnvRows(envRows, imported, (row) => row);
	}
</script>

<section class="rounded-md panel" class:hidden>
  <PanelHeader
    description="Passed to the container at deploy time."
    title="Environment variables"
  />

  <div class="space-y-2.5 p-5">
    {#each envRows as row, i}
      <div class="flex items-center gap-2">
        <Input
          name="envKey"
          placeholder="KEY"
          type="text"
          bind:value={row.key}
        />
        <Input
          name="envValue"
          placeholder="value"
          type="text"
          bind:value={row.value}
        />
        <Button
          aria-label="Remove"
          class="shrink-0 text-red-500 hover:bg-red-500/10 hover:text-red-500"
          onclick={() => removeEnvRow(i)}
          size="icon-sm"
          variant="ghost"
        >
          <Trash2 class="size-4" />
        </Button>
      </div>
    {/each}

    <div class="mt-1 flex flex-wrap items-center gap-4">
      <Button
        class="h-auto p-0"
        onclick={() => envRows.push({ key: "", value: "" })}
        variant="link"
      >
        <Plus class="size-3.5" />
        Add variable
      </Button>
      <EnvPasteButton onImport={importEnvRows} />
      {#if detectedEnv.length > 0}
        <Button
          class="h-auto p-0"
          onclick={() => importEnvRows(detectedEnv)}
          title={detectedEnv.map((row) => row.key).join(", ")}
          variant="link"
        >
          <ScanSearch class="size-3.5" />
          Import {detectedEnv.length} from
          {detected ? detectedFrom(detected) : ""}
        </Button>
      {/if}
      <ServiceLinkPicker
        onImport={importEnvRows}
        services={data.linkableServices}
        stackId={data.stackId}
        stacks={data.stacks}
      />
    </div>
  </div>
</section>
