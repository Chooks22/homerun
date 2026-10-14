package cli

import (
	"flag"
	"fmt"
	"net/url"
)

// versionPath is a path under a service's version routes.
func versionPath(id, suffix string) string {
	return fmt.Sprintf("/services/%s/version%s", url.PathEscape(id), suffix)
}

// VersionShow prints an image service's pin and its last update check as JSON.
func VersionShow(client *Client, id string) {
	body, _ := client.do("GET", versionPath(id, ""), nil)
	PrintJSON(body)
}

// VersionTags prints the registry tags published for exactly the image a
// service runs, and the tag to make on this host when none matches.
func VersionTags(client *Client, id string) {
	body, _ := client.do("GET", versionPath(id, "/pin"), nil)
	PrintJSON(body)
}

// VersionPin pins a service to tag, made on this host from the running image
// when local, and prints the resulting state.
func VersionPin(client *Client, id, tag string, local bool) {
	var result map[string]any
	client.decodeJSON("POST", versionPath(id, "/pin"), map[string]any{"local": local, "tag": tag}, &result)
	PrintValue(result)
}

// VersionUnpin puts a service back on the tag it was pinned from and prints the resulting state.
func VersionUnpin(client *Client, id string) {
	body, _ := client.do("DELETE", versionPath(id, "/pin"), nil)
	PrintJSON(body)
}

// WatchBody is the PATCH body for /services/{id}/version: only the settings
// whose flag was passed, nil when none was.
func WatchBody(set *flag.FlagSet, check, trial bool) map[string]any {
	body := map[string]any{}
	if flagSet(set, "check") {
		body["updateCheckEnabled"] = check
	}
	if flagSet(set, "trial") {
		body["updateTrialEnabled"] = trial
	}
	if len(body) == 0 {
		return nil
	}
	return body
}

// VersionWatch sends a service's update watch settings and prints the resulting state.
func VersionWatch(client *Client, id string, body map[string]any) {
	var result map[string]any
	client.decodeJSON("PATCH", versionPath(id, ""), body, &result)
	PrintValue(result)
}

// VersionPost sends a body-less POST to a version route (check or update) and prints the answer.
func VersionPost(client *Client, id, suffix string) {
	body, _ := client.do("POST", versionPath(id, suffix), nil)
	PrintJSON(body)
}

var versionCommands = []Command{
	{
		Args:    "<id>",
		Name:    "services version",
		Summary: "show an image service's version pin and the update its last check found",
		Setup:   noFlags(func(env Env, args []string) { VersionShow(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Args:    "<id>",
		Name:    "services version tags",
		Summary: "list the registry tags matching the image a service runs, to pin it to",
		Setup:   noFlags(func(env Env, args []string) { VersionTags(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Args:    "<id> <tag>",
		Name:    "services version pin",
		Summary: "pin an image service to a tag instead of a floating one",
		Setup: func(set *flag.FlagSet) Runner {
			local := set.Bool("local", false, "tag the running image on this host, for an image no registry tag matches")
			return func(env Env, args []string) {
				VersionPin(env.Client(), serviceID(env, args[0]), args[1], *local)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "services version unpin",
		Summary: "put a pinned service back on the tag it was pinned from, from its next deploy",
		Setup:   noFlags(func(env Env, args []string) { VersionUnpin(env.Client(), serviceID(env, args[0])) }),
	},
	{
		Args:    "<id>",
		Name:    "services version watch",
		Summary: "turn watching the registry for updates, and trying each one first, on or off",
		Setup: func(set *flag.FlagSet) Runner {
			check := set.Bool("check", false, "watch for updates (--check=false stops)")
			trial := set.Bool("trial", false, "try each update in a throwaway container first (--trial=false skips it)")
			return func(env Env, args []string) {
				body := WatchBody(set, *check, *trial)
				if body == nil {
					Fail("Nothing to change: pass --check, --trial or both.")
					return
				}
				VersionWatch(env.Client(), serviceID(env, args[0]), body)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "services version check",
		Summary: "ask the registry for an update to an image service now",
		Setup: noFlags(func(env Env, args []string) {
			VersionPost(env.Client(), serviceID(env, args[0]), "/check")
		}),
	},
	{
		Args:    "<id>",
		Name:    "services version update",
		Summary: "move an image service onto the update its last check found and deploy it",
		Setup: noFlags(func(env Env, args []string) {
			VersionPost(env.Client(), serviceID(env, args[0]), "/update")
		}),
	},
}
