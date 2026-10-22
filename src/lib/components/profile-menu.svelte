<script lang="ts">
	import {
		LogOut,
		SlidersHorizontal,
		Sparkles,
		UserCircle,
	} from "@lucide/svelte";
	import { toast } from "svelte-sonner";
	import { signOut } from "#lib/auth-client.js";
	import { headerControlClass } from "#lib/components/header-styles.js";
	import * as DropdownMenu from "#lib/components/ui/dropdown-menu/index.js";
	import { setUiMode } from "#lib/remote/ui-mode.remote.js";
	import { toastError } from "#lib/toast.js";
	import { UI_MODE_LABELS, type UiMode } from "#lib/ui-mode.js";
	import { goto, refreshAll } from "$app/navigation";
	import { resolve } from "$app/paths";

	interface ProfileUser {
		email?: string | null;
		image?: string | null;
		name?: string | null;
	}

	const { uiMode, user }: { uiMode: UiMode; user: ProfileUser | undefined } =
		$props();

	const otherMode = $derived<UiMode>(
		uiMode === "simple" ? "advanced" : "simple",
	);

	const userInitial = $derived(user?.name?.[0]?.toUpperCase() ?? "?");

	async function signOutCallback() {
		await signOut();
		await refreshAll();
	}

	async function switchModeCallback(mode: UiMode) {
		await setUiMode(mode);
		await refreshAll();
	}

	function handleSwitchMode() {
		const mode = otherMode;
		return toast.promise(switchModeCallback(mode), {
			error: (error) =>
				toastError(error, "Couldn't switch the interface mode."),
			loading: `Switching to ${UI_MODE_LABELS[mode].toLowerCase()} mode`,
			success: `${UI_MODE_LABELS[mode]} mode on.`,
		});
	}

	function handleSignOut() {
		return toast.promise(signOutCallback, {
			error: (e) => (e instanceof Error ? e.message : "Failed to sign you out"),
			loading: "Signing you out",
			success: "Signed you out successfully",
		});
	}
</script>

<DropdownMenu.Root>
  <DropdownMenu.Trigger>
    {#snippet child({ props })}
      <button
        {...props}
        aria-label="Account menu"
        class="{headerControlClass} w-10 sm:w-8"
        type="button"
      >
        {#if user?.image}
          <img
            alt={user.name ?? ""}
            class="ring-border size-8 rounded-full object-cover ring-1 sm:size-5 sm:ring-0"
            src={user.image}
          />
        {:else}
          <span class="bg-accent text-bg flex size-8 items-center justify-center rounded-full text-sm font-semibold sm:size-5 sm:text-[0.625rem]">
            {userInitial}
          </span>
        {/if}
      </button>
    {/snippet}
  </DropdownMenu.Trigger>
  <DropdownMenu.Content align="end" class="w-56">
    <DropdownMenu.Label class="font-normal">
      <p class="text-text truncate text-sm font-semibold">{user?.name}</p>
      <p class="text-text-muted truncate text-xs">{user?.email}</p>
    </DropdownMenu.Label>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={() => goto(resolve('profile'))}><UserCircle class="size-4" />Account settings</DropdownMenu.Item>
    <DropdownMenu.Item onSelect={handleSwitchMode}>
      {#if otherMode === "simple"}
        <Sparkles class="size-4" />
      {:else}
        <SlidersHorizontal class="size-4" />
      {/if}
      Switch to {UI_MODE_LABELS[otherMode].toLowerCase()} mode
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    <DropdownMenu.Item onSelect={handleSignOut} variant="destructive">
      <LogOut class="size-4" />
      Sign out
    </DropdownMenu.Item>
  </DropdownMenu.Content>
</DropdownMenu.Root>
