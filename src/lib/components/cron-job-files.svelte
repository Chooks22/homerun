<script lang="ts">
	import { Plus, Trash2 } from "@lucide/svelte";
	import { untrack } from "svelte";
	import CodeEditor from "#lib/components/code-editor.svelte";
	import { labelClass } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import type { CronJobFile } from "#lib/cron-job-script.js";
	import { languageFor } from "#lib/highlight.js";

	const { files }: { files: CronJobFile[] } = $props();

	let rows = $state<CronJobFile[]>(
		untrack(() => files.map((file) => ({ ...file, mode: file.mode ?? "" }))),
	);

	function addRow() {
		rows.push({ content: "", mode: "", path: "" });
	}

	function removeRow(i: number) {
		rows.splice(i, 1);
	}
</script>

<section class="panel rounded-md">
  <PanelHeader
    description="Text files written into the container before its process starts, for a config file the image reads. The image needs /bin/sh, and the path must be writable by the user the container runs as (/tmp always is). Mode is optional octal permissions, like 600 for a file holding a token."
    title="Config files"
  />
  <div class="space-y-4 p-5">
    {#each rows as row, i (i)}
      <div class="space-y-2">
        <div class="flex items-end gap-2">
          <div class="flex-1">
            <label class={labelClass} for="filePath-{i}">Path</label>
            <Input
              id="filePath-{i}"
              name="filePath"
              placeholder="/tmp/config.json"
              type="text"
              bind:value={row.path}
            />
          </div>
          <div class="w-28">
            <label class={labelClass} for="fileMode-{i}">Mode</label>
            <Input
              id="fileMode-{i}"
              name="fileMode"
              placeholder="644"
              type="text"
              bind:value={row.mode}
            />
          </div>
          <Button
            aria-label="Remove file"
            class="shrink-0 text-red-500 hover:bg-red-500/10 hover:text-red-500"
            onclick={() => removeRow(i)}
            size="icon-sm"
            variant="ghost"
          >
            <Trash2 class="size-4" />
          </Button>
        </div>
        <CodeEditor
          aria-label="Content of {row.path || 'the file'}"
          language={languageFor(row.path)}
          name="fileContent"
          bind:value={row.content}
        />
      </div>
    {/each}
    <Button class="h-auto p-0" onclick={addRow} variant="link">
      <Plus class="size-3.5" />
      Add file
    </Button>
  </div>
</section>
