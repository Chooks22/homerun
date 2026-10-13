<script lang="ts">
	import type { Snippet } from "svelte";
	import { untrack } from "svelte";
	import CodeEditor from "#lib/components/code-editor.svelte";
	import ExtensionPicker from "#lib/components/extension-picker.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";

	interface Props {
		trailing?: Snippet;
		values: { editorSettings: Record<string, unknown>; extensions: string[] };
	}

	const { trailing, values }: Props = $props();

	let extensions = $state(untrack(() => [...values.extensions]));
	let settings = $state(
		untrack(() =>
			Object.keys(values.editorSettings).length > 0
				? JSON.stringify(values.editorSettings, null, 2)
				: "",
		),
	);
</script>

<section class="panel rounded-xl">
  <PanelHeader
    description="Applied by code-server on every start. A repository's dev container config can fill this in on creation."
    title="Editor"
    {trailing}
  />
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
        Replaces code-server's user settings.json on every start. Leave it empty
        to keep whatever you set from the IDE.
      </p>
    </div>
  </div>
</section>
