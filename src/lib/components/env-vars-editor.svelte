<script lang="ts">
	import { Hammer, Lock, LockOpen, Plus, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import EnvPasteButton from "#lib/components/env-paste-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		type EnvEditorRow,
		envEditorRows,
		envRowKeep,
		mergeEnvRows,
		type ParsedEnvVar,
		plainEnvRow,
		toggleEnvRowSecret,
	} from "#lib/env-parse.js";
	import { SECRET_MASK } from "#lib/formatting.js";

	const {
		buildEnvKeys,
		envVars,
		secretEnvKeys,
	}: {
		buildEnvKeys?: string[];
		envVars: Record<string, string>;
		secretEnvKeys: string[];
	} = $props();

	let rows = $state<EnvEditorRow[]>(
		untrack(() => envEditorRows(envVars, secretEnvKeys, buildEnvKeys)),
	);
	$effect(() => {
		rows = envEditorRows(envVars, secretEnvKeys, buildEnvKeys);
	});

	function addRow() {
		rows.push(plainEnvRow());
	}

	function removeRow(i: number) {
		rows.splice(i, 1);
		if (rows.length === 0) {
			rows.push(plainEnvRow());
		}
	}

	function importRows(imported: ParsedEnvVar[]) {
		rows = mergeEnvRows(rows, imported, plainEnvRow);
	}
</script>

{#each rows as row, i (i)}
  <div class="border-border flex flex-wrap items-center gap-2 rounded-lg border p-2 sm:flex-nowrap sm:border-0 sm:p-0">
    <Input
      class="basis-full sm:basis-auto"
      name="envKey"
      placeholder="KEY"
      type="text"
      bind:value={row.key}
    />
    <Input
      class="w-auto min-w-0 flex-1 sm:w-full sm:flex-initial"
      autocomplete="off"
      name="envValue"
      oninput={() => {
        row.keep = null;
      }}
      placeholder={row.keep === null ? "value" : SECRET_MASK}
      type={row.secret ? "password" : "text"}
      bind:value={row.value}
    />
    <input name="envKeep" type="hidden" value={envRowKeep(row)} />
    {#if row.secret}
      <input name="envSecret" type="hidden" value={row.key} />
    {/if}
    {#if buildEnvKeys && row.build}
      <input name="envBuild" type="hidden" value={row.key} />
    {/if}
    {#if buildEnvKeys}
      <Button
        aria-label={row.build ? "Unmark as build-time" : "Mark as build-time"}
        aria-pressed={row.build}
        class="shrink-0 {row.build ? 'text-accent' : 'text-text-subtle'}"
        onclick={() => {
          row.build = !row.build;
        }}
        size="icon-sm"
        title={row.build
          ? "Build-time: also passed to the build as a build arg"
          : "Mark as build-time"}
        variant="ghost"
      >
        <Hammer class="size-4" />
      </Button>
    {/if}
    <Button
      aria-label={row.secret ? "Unmark as secret" : "Mark as secret"}
      aria-pressed={row.secret}
      class="shrink-0 {row.secret ? 'text-accent' : 'text-text-subtle'}"
      onclick={() => toggleEnvRowSecret(row, envVars)}
      size="icon-sm"
      title={row.secret
        ? "Secret: hidden here and always redacted for AI agents"
        : "Mark as secret"}
      variant="ghost"
    >
      {#if row.secret}
        <Lock class="size-4" />
      {:else}
        <LockOpen class="size-4" />
      {/if}
    </Button>
    <Button
      aria-label="Remove"
      class="shrink-0 text-red-500 hover:bg-red-500/10 hover:text-red-500"
      onclick={() => removeRow(i)}
      size="icon-sm"
      variant="ghost"
    >
      <Trash2 class="size-4" />
    </Button>
  </div>
{/each}

<div class="mt-1 flex items-center gap-4">
  <Button class="h-auto p-0" onclick={addRow} variant="link">
    <Plus class="size-3.5" />
    Add variable
  </Button>
  <EnvPasteButton onImport={importRows} />
</div>
