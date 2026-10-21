<script lang="ts">
	import { RefreshCw } from "@lucide/svelte";
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import { toast } from "svelte-sonner";
	import CodeEditor from "#lib/components/code-editor.svelte";
	import ExtensionPicker from "#lib/components/extension-picker.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { importSettingsSync } from "#lib/remote/workstations.remote.js";
	import { toastError } from "#lib/toast.js";

	interface Props {
		trailing?: Snippet;
		values: { editorSettings: Record<string, unknown>; extensions: string[] };
	}

	const { trailing: outerTrailing, values }: Props = $props();

	let extensions = $state(untrack(() => [...values.extensions]));
	let settings = $state(
		untrack(() =>
			Object.keys(values.editorSettings).length > 0
				? JSON.stringify(values.editorSettings, null, 2)
				: "",
		),
	);
	let importing = $state(false);

	function mergedSettings(synced: Record<string, unknown>): string {
		const text = settings.trim();
		if (!text) {
			return JSON.stringify(synced, null, 2);
		}
		let current: unknown;
		try {
			current = JSON.parse(text);
		} catch {
			throw new Error("Fix the settings.json below before importing into it.");
		}
		if (
			typeof current !== "object" ||
			current === null ||
			Array.isArray(current)
		) {
			throw new Error("The settings.json below must be a JSON object.");
		}
		return JSON.stringify({ ...current, ...synced }, null, 2);
	}

	async function importCallback() {
		importing = true;
		try {
			const synced = await importSettingsSync();
			const nextSettings = synced.settings
				? mergedSettings(synced.settings)
				: settings;
			const added = synced.extensions.filter((id) => !extensions.includes(id));
			extensions = [...extensions, ...added];
			settings = nextSettings;
			return {
				added: added.length,
				missing: synced.missingExtensions,
				settings: synced.settings ? Object.keys(synced.settings).length : 0,
			};
		} finally {
			importing = false;
		}
	}

	function handleImport() {
		return toast.promise(importCallback(), {
			error: (error) => toastError(error, "Couldn't import from Settings Sync"),
			loading: "Reading your VS Code Settings Sync",
			success: ({ added, missing, settings: count }) => {
				const base = `Added ${added} extension${added === 1 ? "" : "s"} and ${count} setting${count === 1 ? "" : "s"}`;
				return missing.length > 0
					? `${base}; not on Open VSX: ${missing.join(", ")}`
					: base;
			},
		});
	}
</script>

<section class="panel rounded-xl">
  <PanelHeader
    description="Applied by code-server or openvscode-server on every start. A repository's dev container config can fill this in."
    title="Editor"
  >
    {#snippet trailing()}
      <div class="flex items-center gap-2">
        <Button
          disabled={importing}
          onclick={handleImport}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RefreshCw class="size-3.5" />
          Import from Settings Sync
        </Button>
        {@render outerTrailing?.()}
      </div>
    {/snippet}
  </PanelHeader>
  <div class="space-y-4 p-5">
    <div>
      <label class={labelClass} for="extensions">Extensions</label>
      <ExtensionPicker id="extensions" bind:value={extensions} />
      <p class="text-text-subtle mt-1.5 text-xs">
        Installed from Open VSX. One removed here is uninstalled on the next
        start; extensions you install from the IDE itself are left alone.
      </p>
    </div>
    <div>
      <label class={labelClass} for="editorSettings">Settings (settings.json)</label>
      <CodeEditor
        id="editorSettings"
        class="min-h-40"
        language="json"
        name="editorSettings"
        placeholder={'{\n  "workbench.colorTheme": "Default Dark Modern",\n  "editor.formatOnSave": true\n}'}
        bind:value={settings}
      />
      <p class="text-text-subtle mt-1.5 text-xs">
        Replaces code-server's user settings.json (openvscode-server's machine
        settings.json) on every start. Leave it empty to keep whatever you set
        from the IDE. Import from Settings Sync fills both from what VS Code
        synced for your connected GitHub account; synced settings win over the
        ones already here.
      </p>
    </div>
  </div>
</section>
