<script lang="ts">
	import { Network } from "@lucide/svelte";
	import { untrack } from "svelte";
	import AdvancedDisclosure from "#lib/components/advanced-disclosure.svelte";
	import CheckBox from "#lib/components/check-box.svelte";
	import PanelHeader from "#lib/components/panel-header.svelte";
	import { Input } from "#lib/components/ui/input/index.js";
	import {
		SelectContent,
		SelectItem,
		Select as SelectRoot,
		SelectTrigger,
	} from "#lib/components/ui/select/index.js";
	import { type DetectedConfig, primaryPort } from "#lib/image-config.js";
	import { isDatabaseImage } from "#lib/service-link.js";
	import { visibleIn } from "#lib/ui-mode.js";
	import { errorClass, label } from "./field-classes";
	import type { WizardData } from "./wizard-types";

	interface Props {
		data: WizardData;
		detected: DetectedConfig | null;
		errors?: Record<string, string[]>;
		hidden: boolean;
		image: string;
		slug: string;
		values?: Record<string, string>;
	}

	const { data, detected, errors, hidden, image, slug, values }: Props =
		$props();

	let containerPort = $derived(
		values?.containerPort ?? String(data.template?.containerPort ?? ""),
	);
	let authRequired = $derived(values?.authRequired === "on");
	let networkMode = $derived<"bridge" | "host">(
		values?.networkMode === "host" ? "host" : "bridge",
	);
	let portProtocol = $derived<"tcp" | "udp" | "both">(
		values?.portProtocol === "udp"
			? "udp"
			: values?.portProtocol === "both"
				? "both"
				: "tcp",
	);
	let autoPort = "";

	$effect(() => {
		const found = primaryPort(detected);
		untrack(() => {
			if (!found || (containerPort !== "" && containerPort !== autoPort)) {
				return;
			}
			containerPort = String(found.port);
			autoPort = containerPort;
			if (found.protocol !== "tcp") {
				portProtocol = found.protocol;
			}
		});
	});

	// Datastores default to private : they're reached by their siblings over
	// the stack network, and a public hostname for a Postgres is a mistake
	// waiting to happen. A resubmit keeps whatever the user actually chose.
	let dnsResolvable = $derived(
		values?.dnsResolvable === undefined
			? !isDatabaseImage(image)
			: values.dnsResolvable !== "off" && values.dnsResolvable !== "false",
	);
</script>

<section class="rounded-md panel" class:hidden>
  <PanelHeader
    description="The port it listens on, and how it's routed."
    icon={Network}
    title="Networking"
  />

  <div class="space-y-5 p-5">
    <div>
      <label class={label} for="containerPort">
        Container port <span class="text-red-500">*</span>
      </label>
      <Input
        id="containerPort"
        max="65535"
        min="1"
        name="containerPort"
        placeholder="3000"
        required={!hidden}
        type="number"
        bind:value={containerPort}
      />
      <p class="mt-1 text-xs text-text-subtle">
        The port your app listens on inside the container.
      </p>
      {#if errors?.containerPort}
        <p class={errorClass}>{errors.containerPort[0]}</p>
      {/if}
    </div>

    <CheckBox
      helperText="Get a public {slug || 'slug'}.{data.serviceDomain} route. Turn off to keep this service reachable only from other services on the same network."
      id="dnsResolvable"
      label="DNS-resolvable"
      name="dnsResolvable"
      bind:checked={dnsResolvable}
    />

    {#if dnsResolvable}
      <div>
        <label class={label} for="domain">Domain</label>
        <Input
          id="domain"
          name="domain"
          placeholder="app.example.com"
          type="text"
          value={values?.domain ?? ""}
        />
        <p class="mt-1 text-xs text-text-subtle">
          Optional hostname of your own, used as the service's main
          link. Point its DNS at this host; Traefik requests a
          certificate for it on deploy. Add more on the Networking tab.
        </p>
        {#if errors?.domain}
          <p class={errorClass}>{errors.domain[0]}</p>
        {/if}
      </div>

      <CheckBox
        helperText="Visitors sign in with their Homerun account before they reach the service. Add OAuth providers or restrict it to some emails or groups on the Security tab."
        id="authRequired"
        label="Require login to access this app"
        name="authRequired"
        bind:checked={authRequired}
      />
      {#if errors?.authRequired}
        <p class={errorClass}>{errors.authRequired[0]}</p>
      {/if}
    {/if}

    <AdvancedDisclosure
      collapsible={!visibleIn(data.uiMode, "services/new#network")}
      description="Network mode and protocol"
    >
      <div class="grid gap-4 sm:grid-cols-2">
        <div>
          <label class={label} for="networkMode">Network mode</label>
          <SelectRoot name="networkMode" type="single" bind:value={networkMode}>
            <SelectTrigger class="w-full" id="networkMode">
              {networkMode === "host" ? "Host" : "Bridge"}
            </SelectTrigger>
            <SelectContent>
              <SelectItem label="Bridge" value="bridge" />
              <SelectItem label="Host" value="host" />
            </SelectContent>
          </SelectRoot>
          <p class="mt-1 text-xs text-text-subtle">
            Host shares the machine's network namespace : needed for
            mDNS/SSDP apps, and not routable by Traefik.
          </p>
        </div>
        <div>
          <label class={label} for="portProtocol">Protocol</label>
          <SelectRoot name="portProtocol" type="single" bind:value={portProtocol}>
            <SelectTrigger class="w-full" id="portProtocol">
              {portProtocol === "udp"
              ? "UDP"
              : portProtocol === "both"
                ? "Both"
                : "TCP"}
            </SelectTrigger>
            <SelectContent>
              <SelectItem label="TCP" value="tcp" />
              <SelectItem label="UDP" value="udp" />
              <SelectItem label="Both" value="both" />
            </SelectContent>
          </SelectRoot>
        </div>
      </div>
    </AdvancedDisclosure>
  </div>
</section>
