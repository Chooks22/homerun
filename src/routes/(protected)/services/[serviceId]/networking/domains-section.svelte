<script lang="ts">
	import { Globe, Plus, Trash2 } from "@lucide/svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import SaveButton from "#lib/components/save-button.svelte";
	import { Button } from "#lib/components/ui/button/index.js";
	import { Checkbox } from "#lib/components/ui/checkbox/index.js";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		defaultHostname,
		primaryHostname,
		type ServiceDomainFields,
		serviceHostnames,
	} from "#lib/service-domains.js";
	import { enhanceToast } from "#lib/toast.js";
	import { enhance } from "$app/forms";

	interface Props {
		baseDomain: string;
		serviceDomain: string;
		stackSlug: string | null;
		submitting: boolean;
		svc: ServiceDomainFields & {
			containerPort: number;
			dnsResolvable: boolean;
			domainPorts: Record<string, number>;
			networkMode: string;
			stripPathDomains: string[];
		};
	}

	let {
		baseDomain,
		serviceDomain,
		stackSlug,
		submitting = $bindable(),
		svc,
	}: Props = $props();

	const fallbackHost = $derived(
		defaultHostname(svc.slug, stackSlug, serviceDomain),
	);
	const mainHost = $derived(primaryHostname(svc, stackSlug, serviceDomain));
	const routedCount = $derived(
		serviceHostnames(svc, stackSlug, serviceDomain).length,
	);

	let domains = $derived([...svc.domains]);
	let ports = $derived(
		svc.domains.map((domain) => String(svc.domainPorts[domain] ?? "")),
	);
	let strips = $derived(
		svc.domains.map((domain) => svc.stripPathDomains.includes(domain)),
	);
	let defaultEnabled = $derived(svc.defaultDomainEnabled);
	let primary = $derived(mainHost ?? "");
	let conflicts = $state<{ entry: string; owner: string }[]>([]);

	function renameDomain(index: number, value: string) {
		const previous = domains[index];
		domains = domains.map((domain, i) => (i === index ? value : domain));
		if (primary === previous) {
			primary = value;
		}
	}

	function removeDomain(index: number) {
		if (primary === domains[index]) {
			primary = "";
		}
		domains = domains.filter((_, i) => i !== index);
		ports = ports.filter((_, i) => i !== index);
		strips = strips.filter((_, i) => i !== index);
	}
</script>

{#snippet mainToggle(host: string, disabled: boolean)}
  <div class="flex shrink-0 justify-center @2xl:w-24">
    {#if primary !== "" && primary === host}
      <span class="bg-accent/10 text-accent rounded-full px-2.5 py-0.5 text-xs font-medium">Main</span>
    {:else}
      <Button
        {disabled}
        onclick={() => {
          primary = host;
        }}
        size="xs"
        type="button"
        variant="ghost"
      >
        Make main
      </Button>
    {/if}
  </div>
{/snippet}

<section class="panel rounded-md">
  <PanelHeader icon={Globe} title="Domains">
    {#snippet description()}
      {#if svc.dnsResolvable && mainHost}
        Publicly routed at
        <span class="text-accent">{mainHost}</span>
        {#if routedCount > 1}
          and {routedCount - 1} more
        {/if}.
      {:else if svc.networkMode === "host"}
        Not publicly routed : this service is on the host network (see
        Network below), which Traefik can't route to.
      {:else}
        Not publicly routed : subnet-only. Change this in the Network
        section below.
      {/if}
    {/snippet}
    {#snippet trailing()}
      {#if svc.dnsResolvable}
        <SaveButton form="service-domains" pending={submitting} />
      {/if}
    {/snippet}
  </PanelHeader>

  {#if svc.dnsResolvable}
    <form
      id="service-domains"
      action="?/updateDomains"
      class="@container space-y-3 p-5"
      method="POST"
      use:enhance={enhanceToast({
        error: "Check the domains and try again.",
        loading: "Saving the domains",
        onFailure: (data) => {
          conflicts = data?.canTakeOver
            ? (data.conflicts as { entry: string; owner: string }[])
            : [];
        },
        onSettled: () => {
          submitting = false;
        },
        onStart: () => {
          submitting = true;
        },
        onSuccess: () => {
          conflicts = [];
        },
        success: (data) => {
          const takenOver = (data?.takenOver as string[] | undefined) ?? [];
          return takenOver.length > 0
            ? `Taken over from ${takenOver.join(", ")}. This service is redeploying; ${takenOver.join(", ")} keeps serving it until its own next deploy.`
            : "Saved. Redeploy for it to take effect.";
        },
      })}
    >
      <input name="primaryDomain" type="hidden" value={primary}>
      <div class="space-y-2">
        <div class="border-border flex flex-wrap items-center gap-3 rounded-lg border p-3 @2xl:flex-nowrap @2xl:border-0 @2xl:p-0">
          <Input
            class="basis-full @2xl:basis-auto {defaultEnabled ? '' : 'text-text-subtle line-through'}"
            aria-label="Default domain"
            readonly
            value={fallbackHost}
          />
          <div class="hidden w-28 shrink-0 @2xl:block"></div>
          <div class="hidden w-24 shrink-0 @2xl:block"></div>
          {@render mainToggle(fallbackHost, !defaultEnabled)}
          <label class="text-text-muted ml-auto flex shrink-0 items-center gap-2 text-xs @2xl:ml-0 @2xl:w-20">
            <Checkbox
              name="defaultDomainEnabled"
              onCheckedChange={(checked) => {
                if (!checked && primary === fallbackHost) {
                  primary = "";
                }
              }}
              bind:checked={defaultEnabled}
            />
            Routed
          </label>
        </div>
        {#each domains as domain, index (index)}
          <div class="border-border flex flex-wrap items-center gap-3 rounded-lg border p-3 @2xl:flex-nowrap @2xl:border-0 @2xl:p-0">
            <Input
              class="basis-full @2xl:basis-auto"
              aria-label="Domain"
              name="domains"
              oninput={(event) => renameDomain(index, event.currentTarget.value)}
              placeholder="app.example.com or example.com/api"
              spellcheck="false"
              type="text"
              value={domain}
            />
            <Input
              class="min-w-0 flex-1 @2xl:w-28 @2xl:flex-none @2xl:shrink-0"
              aria-label="Container port for this domain"
              max="65535"
              min="1"
              name="domainPorts"
              placeholder={String(svc.containerPort)}
              oninput={(event) => {
                ports = ports.map((port, i) =>
                  i === index ? event.currentTarget.value : port,
                );
              }}
              type="number"
              value={ports[index]}
            />
            <input name="domainStripPaths" type="hidden" value={strips[index] ? "on" : ""}>
            <div class="flex shrink-0 items-center @2xl:w-24">
              {#if domain.includes("/")}
                <label class="text-text-muted flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={strips[index]}
                    onCheckedChange={(checked) => {
                      strips = strips.map((strip, i) =>
                        i === index ? checked : strip,
                      );
                    }}
                  />
                  Strip path
                </label>
              {/if}
            </div>
            {@render mainToggle(domain, !domain)}
            <div class="shrink-0 @2xl:w-20">
              <Button
                aria-label="Remove this domain"
                onclick={() => removeDomain(index)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2 class="size-4" />
              </Button>
            </div>
          </div>
        {/each}
      </div>
      <Button
        onclick={() => {
          domains = [...domains, ""];
          ports = [...ports, ""];
          strips = [...strips, false];
        }}
        size="sm"
        type="button"
        variant="outline"
      >
        <Plus class="size-4" />
        Add domain
      </Button>
      <p class="text-text-subtle text-xs">
        A domain's port sends it to another port of the same container (blank
        means {svc.containerPort}), e.g. a web UI and an API side by side. A
        domain with a path, like example.com/api, routes only that path and
        what's under it, even when another service has example.com itself;
        Strip path sends /api/v2 to the container as /v2. The main domain is
        the service's link. Point each domain's
        DNS (A/CNAME) at this server yourself first : this app only tells
        Traefik to route it, it doesn't manage DNS for domains outside
        {baseDomain}.
      </p>
      <p class="text-text-subtle text-xs">Redeploy for changes to take effect.</p>
      {#if conflicts.length > 0}
        <div class="border-border space-y-2 rounded-lg border p-3 text-xs">
          <p class="text-text-muted">
            {#each conflicts as conflict (conflict.entry)}
              <span class="block">{conflict.entry} is already routed to {conflict.owner}.</span>
            {/each}
          </p>
          <p class="text-text-subtle">
            Taking it over removes it from there and redeploys this service. A
            service it's taken from keeps serving it until its own next deploy,
            so the move has no downtime; a redirect stops right away.
          </p>
          <Button
            name="takeOverDomains"
            disabled={submitting}
            size="sm"
            type="submit"
            value="on"
            variant="outline"
          >
            Take over and save
          </Button>
        </div>
      {/if}
    </form>
  {/if}
</section>
