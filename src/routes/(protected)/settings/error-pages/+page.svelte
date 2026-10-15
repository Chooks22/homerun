<script lang="ts">
	import { ExternalLink, FileText, Palette } from "@lucide/svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import { labelClass as label } from "#lib/components/form-styles.js";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import { Textarea } from "#lib/components/ui/textarea/index.js";
	import { ERROR_PAGE_KINDS } from "#lib/error-pages.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";
	import { resolve } from "$app/paths";

	const { data } = $props();

	const stored = $derived(data.errorPages);
	let savingBranding = $state(false);
	let savingText = $state(false);
	let showPoweredBy = $derived(stored.showPoweredBy ?? true);

	const previewStatus = {
		blocked: 403,
		notFound: 404,
		notReady: 404,
		unavailable: 503,
		waking: 503,
	};
</script>

<div class="space-y-6">
  {#if !data.published}
    <p class="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600">
      Traefik's dynamic config directory isn't set (Settings → Networking), so
      Traefik keeps showing its own error pages. These settings apply once it
      is.
    </p>
  {/if}

  <section class="panel rounded-md">
    <PanelHeader
      description="What visitors see instead of Traefik's bare errors: on an address no app answers yet (a service still deploying, a stopped one, an unknown host) and when an app can't answer (502, 503, 504). A running service picks up the 502–504 pages on its next deploy. The brand also dresses the sign-in pages of apps behind a login wall."
      icon={Palette}
      title="Branding"
    >
      {#snippet trailing()}
        <SaveButton form="error-pages-branding" pending={savingBranding} />
      {/snippet}
    </PanelHeader>
    <form
      id="error-pages-branding"
      action="?/updateBranding"
      class="space-y-4 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the branding.",
        loading: "Saving error page branding",
        onSettled: () => {
          savingBranding = false;
        },
        onStart: () => {
          savingBranding = true;
        },
        success: "Branding saved.",
      })}
    >
      <div class="grid gap-4 sm:grid-cols-3">
        <div>
          <label class={label} for="brandName">Brand name</label>
          <Input
            id="brandName"
            name="brandName"
            placeholder={data.defaults.brandName}
            type="text"
            value={stored.brandName ?? ""}
          />
        </div>
        <div>
          <label class={label} for="logoUrl">Logo URL</label>
          <Input
            id="logoUrl"
            name="logoUrl"
            placeholder="https://example.com/logo.svg"
            type="url"
            value={stored.logoUrl ?? ""}
          />
        </div>
        <div>
          <label class={label} for="accentColor">Accent colour</label>
          <Input
            id="accentColor"
            name="accentColor"
            placeholder="#8b2942"
            type="text"
            value={stored.accentColor ?? ""}
          />
        </div>
      </div>
      <p class="text-text-subtle text-xs">
        Leave a field empty for Homerun's own. A logo replaces the Homerun mark
        and the brand name next to it; the brand name still titles the page.
      </p>
      <CheckBox
        helperText="Adds a small &quot;Powered by Homerun&quot; line under a page carrying another brand name."
        id="showPoweredBy"
        label="Show Powered by Homerun"
        name="showPoweredBy"
        bind:checked={showPoweredBy}
      />
    </form>
  </section>

  <section class="panel rounded-md">
    <PanelHeader
      description="Each page's title and message. Leave one empty for the default shown in it."
      icon={FileText}
      title="Page text"
    >
      {#snippet trailing()}
        <SaveButton form="error-pages-text" pending={savingText} />
      {/snippet}
    </PanelHeader>
    <form
      id="error-pages-text"
      action="?/updateText"
      class="divide-border divide-y"
      method="POST"
      use:enhance={enhanceToast({
        error: "Couldn't save the page text.",
        loading: "Saving error page text",
        onSettled: () => {
          savingText = false;
        },
        onStart: () => {
          savingText = true;
        },
        success: "Page text saved.",
      })}
    >
      {#each ERROR_PAGE_KINDS as { kind, label: pageLabel } (kind)}
        <div class="space-y-3 p-5">
          <div class="flex items-center justify-between gap-3">
            <h3 class="text-text text-sm font-medium">{pageLabel}</h3>
            <a
              class="text-accent inline-flex items-center gap-1 text-xs hover:underline"
              href="{resolve('/homerun-error/[status]', {
                status: String(previewStatus[kind]),
              })}?preview={kind}"
              rel="noopener"
              target="_blank"
            >
              Preview
              <ExternalLink class="size-3" />
            </a>
          </div>
          <div>
            <label class={label} for="{kind}Title">Title</label>
            <Input
              id="{kind}Title"
              name="{kind}Title"
              placeholder={data.defaults.pages[kind].title}
              type="text"
              value={stored.pages?.[kind]?.title ?? ""}
            />
          </div>
          <div>
            <label class={label} for="{kind}Message">Message</label>
            <Textarea
              id="{kind}Message"
              name="{kind}Message"
              placeholder={data.defaults.pages[kind].message}
              rows={2}
              value={stored.pages?.[kind]?.message ?? ""}
            />
          </div>
        </div>
      {/each}
    </form>
  </section>
</div>
