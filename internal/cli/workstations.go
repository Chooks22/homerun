package cli

import (
	"flag"
	"fmt"
	"net/url"
)

var workstationResources = []Resource{
	{
		Columns: []string{"id", "name", "slug", "desiredState", "image", "domain", "authRequired", "lastError"},
		Group:   "workstations", ID: "id|slug", Noun: "workstation", Paginated: true, Path: "/workstations", Slugs: true,
		Verbs: []string{"list", "get", "create", "update"},
	},
	{
		Columns: []string{"id", "name", "image", "description", "remoteHostId", "authRequired"},
		Group:   "workstation-presets", ID: "id", Noun: "workstation preset", Path: "/workstation-presets", Verbs: allVerbs,
	},
}

var workstationCommands = []Command{
	workstationStateCommand("start", "running", "start a stopped workstation, recreating its container from its settings (the home volume survives)"),
	workstationStateCommand("stop", "stopped", "stop a running workstation, keeping its container and home volume"),
	{
		Args:    "<id|slug>",
		Name:    "workstations recreate",
		Summary: "recreate a workstation's container from its current settings, pulling its image again (the home volume survives, a stopped one starts)",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a field table")
			return func(env Env, args []string) {
				client := env.Client()
				WorkstationRecreate(client, ResolveSlug(client, "/workstations", args[0]), *asJSON)
			}
		},
	},
	{
		Args:    "<id|slug>",
		Name:    "workstations delete",
		Summary: "delete a workstation's container and record, asking first unless --yes (the home volume stays unless --volume)",
		Setup: func(set *flag.FlagSet) Runner {
			yes := set.Bool("yes", false, "don't ask for confirmation")
			volume := set.Bool("volume", false, "also delete the home volume and everything in it, uncommitted work included")
			return func(env Env, args []string) {
				question := fmt.Sprintf("Delete workstation %s?", args[0])
				if *volume {
					question = fmt.Sprintf("Delete workstation %s and its home volume?", args[0])
				}
				if !*yes && !Confirm(question) {
					Fail("Not deleted. Pass --yes to delete without asking.")
					return
				}
				client := env.Client()
				WorkstationDelete(client, ResolveSlug(client, "/workstations", args[0]), *volume)
			}
		},
	},
}

func workstationStateCommand(verb, state, summary string) Command {
	return Command{
		Args:    "<id|slug>",
		Name:    "workstations " + verb,
		Summary: summary,
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a field table")
			return func(env Env, args []string) {
				client := env.Client()
				WorkstationSetState(client, ResolveSlug(client, "/workstations", args[0]), state, *asJSON)
			}
		},
	}
}

func workstationPath(id string) string {
	return "/workstations/" + url.PathEscape(id)
}

// WorkstationSetState asks for a workstation running or stopped and prints it
// as the API answers, like ResourceGet.
func WorkstationSetState(client *Client, id, state string, asJSON bool) {
	ResourceWrite(client, "PATCH", workstationPath(id), map[string]any{"desiredState": state}, asJSON)
}

// WorkstationRecreate recreates a workstation's container from its current
// settings and prints it as the API answers, like ResourceGet.
func WorkstationRecreate(client *Client, id string, asJSON bool) {
	ResourceWrite(client, "POST", workstationPath(id)+"/recreate", map[string]any{}, asJSON)
}

// WorkstationDelete deletes a workstation, its home volume too when volume is
// set, and prints the id it deleted.
func WorkstationDelete(client *Client, id string, volume bool) {
	query := url.Values{}
	if volume {
		query.Set("volume", "true")
	}
	client.do("DELETE", workstationPath(id), query)
	PrintValue(map[string]any{"deleted": true, "id": id})
}
