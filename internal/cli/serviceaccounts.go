package cli

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
)

var serviceAccountColumns = []string{"id", "name", "disabled", "permissions", "createdAt"}

var serviceAccountKeyColumns = []string{"id", "name", "start", "createdAt", "expiresAt", "lastRequest"}

// ServiceAccount is one service account as the API returns it.
type ServiceAccount struct {
	CreatedAt   string            `json:"createdAt"`
	Disabled    bool              `json:"disabled"`
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Permissions map[string]string `json:"permissions"`
}

// ServiceAccountKey is one API key of a service account as the API lists it, never its secret.
type ServiceAccountKey struct {
	CreatedAt   string  `json:"createdAt"`
	ExpiresAt   *string `json:"expiresAt"`
	ID          string  `json:"id"`
	LastRequest *string `json:"lastRequest"`
	Name        *string `json:"name"`
	Start       *string `json:"start"`
}

func serviceAccountPath(id string) string {
	return "/service-accounts/" + url.PathEscape(id)
}

func optionalText(value *string, fallback string) string {
	if value == nil || *value == "" {
		return fallback
	}
	return *value
}

func formatPermissions(permissions map[string]string) string {
	areas := make([]string, 0, len(permissions))
	for area, level := range permissions {
		areas = append(areas, area+"="+level)
	}
	slices.Sort(areas)
	return strings.Join(areas, ",")
}

// ServiceAccountsList prints service accounts as a table or raw JSON.
func ServiceAccountsList(client *Client, asJSON bool) {
	body, _ := client.do("GET", "/service-accounts", nil)
	if asJSON {
		PrintJSON(body)
		return
	}
	var accounts []ServiceAccount
	if err := json.Unmarshal(body, &accounts); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(accounts))
	for _, account := range accounts {
		rows = append(rows, map[string]string{
			"createdAt":   account.CreatedAt,
			"disabled":    strconv.FormatBool(account.Disabled),
			"id":          account.ID,
			"name":        account.Name,
			"permissions": formatPermissions(account.Permissions),
		})
	}
	PrintTable(rows, serviceAccountColumns)
}

// parsePermissions reads a --permissions value, comma-separated area=level
// pairs with level read or write, into the map the API takes. An empty
// value is no permissions at all; the API refuses an unknown area.
func parsePermissions(spec string) map[string]string {
	permissions := map[string]string{}
	for _, entry := range strings.Split(spec, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		area, level, found := strings.Cut(entry, "=")
		area, level = strings.TrimSpace(area), strings.TrimSpace(level)
		if !found || area == "" || (level != "read" && level != "write") {
			Fail(fmt.Sprintf("--permissions takes area=read or area=write pairs separated by commas, got %q.", entry))
		}
		permissions[area] = level
	}
	return permissions
}

// ServiceAccountCreate creates a service account, with the given
// permissions when they're not nil, and prints it as JSON.
func ServiceAccountCreate(client *Client, name string, permissions map[string]string) {
	payload := map[string]any{"name": name}
	if permissions != nil {
		payload["permissions"] = permissions
	}
	var created map[string]any
	client.decodeJSON("POST", "/service-accounts", payload, &created)
	PrintValue(created)
}

// ServiceAccountUpdate sends the fields in changes (name, disabled,
// permissions) to a service account and prints the updated account as JSON.
// Permissions replace the account's whole set, cut down by the API to what
// the caller's own key holds.
func ServiceAccountUpdate(client *Client, id string, changes map[string]any) {
	var updated map[string]any
	client.decodeJSON("PATCH", serviceAccountPath(id), changes, &updated)
	PrintValue(updated)
}

// ServiceAccountDelete deletes a service account, which revokes all of its keys.
func ServiceAccountDelete(client *Client, id string) {
	client.do("DELETE", serviceAccountPath(id), nil)
	PrintValue(map[string]any{"deleted": true, "id": id})
}

// ServiceAccountKeysList prints a service account's keys, never their secrets, as a table or raw JSON.
func ServiceAccountKeysList(client *Client, accountID string, asJSON bool) {
	body, _ := client.do("GET", serviceAccountPath(accountID)+"/keys", nil)
	if asJSON {
		PrintJSON(body)
		return
	}
	var keys []ServiceAccountKey
	if err := json.Unmarshal(body, &keys); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(keys))
	for _, key := range keys {
		rows = append(rows, map[string]string{
			"createdAt":   key.CreatedAt,
			"expiresAt":   optionalText(key.ExpiresAt, "never"),
			"id":          key.ID,
			"lastRequest": optionalText(key.LastRequest, "never"),
			"name":        optionalText(key.Name, ""),
			"start":       optionalText(key.Start, ""),
		})
	}
	PrintTable(rows, serviceAccountKeyColumns)
}

// ServiceAccountKeyCreate creates a key for a service account and prints the
// response as JSON. The secret is only ever returned here, so a reminder goes
// to stderr to keep stdout parseable. expiresInDays nil leaves the server's
// default, 0 or more is sent as is and never=true sends null for no expiry.
func ServiceAccountKeyCreate(client *Client, accountID, name string, expiresInDays *int, never bool) {
	payload := map[string]any{}
	if name != "" {
		payload["name"] = name
	}
	if never {
		payload["expiresInDays"] = nil
	} else if expiresInDays != nil {
		payload["expiresInDays"] = *expiresInDays
	}
	var created map[string]any
	client.decodeJSON("POST", serviceAccountPath(accountID)+"/keys", payload, &created)
	PrintValue(created)
	fmt.Fprintln(os.Stderr, "Copy the \"key\" value now: it is shown only once and can't be retrieved again.")
}

// ServiceAccountKeyRevoke revokes one key of a service account.
func ServiceAccountKeyRevoke(client *Client, accountID, keyID string) {
	client.do("DELETE", serviceAccountPath(accountID)+"/keys/"+url.PathEscape(keyID), nil)
	PrintValue(map[string]any{"accountId": accountID, "id": keyID, "revoked": true})
}

var serviceAccountCommands = []Command{
	{
		Name:    "service-accounts list",
		Summary: "list service accounts",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, _ []string) { ServiceAccountsList(env.Client(), *asJSON) }
		},
	},
	{
		Args:    "<name>",
		Name:    "service-accounts create",
		Summary: "create a service account, a non-human identity with its own API keys",
		Setup: func(set *flag.FlagSet) Runner {
			permissions := set.String("permissions", "", "grant these `areas`, e.g. services=write,stacks=read")
			return func(env Env, args []string) {
				var granted map[string]string
				if flagSet(set, "permissions") {
					granted = parsePermissions(*permissions)
				}
				ServiceAccountCreate(env.Client(), args[0], granted)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "service-accounts update",
		Summary: "rename a service account or replace its permissions",
		Setup: func(set *flag.FlagSet) Runner {
			name := set.String("name", "", "the account's new `name`")
			permissions := set.String("permissions", "", "replace its permissions with these `areas`, e.g. services=write,stacks=read; \"\" removes them all")
			return func(env Env, args []string) {
				changes := map[string]any{}
				if flagSet(set, "name") {
					if strings.TrimSpace(*name) == "" {
						Fail("--name can't be empty.")
					}
					changes["name"] = *name
				}
				if flagSet(set, "permissions") {
					changes["permissions"] = parsePermissions(*permissions)
				}
				if len(changes) == 0 {
					Fail("Nothing to change: pass --name or --permissions.")
				}
				ServiceAccountUpdate(env.Client(), args[0], changes)
			}
		},
	},
	{
		Args:    "<id>",
		Name:    "service-accounts disable",
		Summary: "refuse a service account's API keys without deleting it",
		Setup: noFlags(func(env Env, args []string) {
			ServiceAccountUpdate(env.Client(), args[0], map[string]any{"disabled": true})
		}),
	},
	{
		Args:    "<id>",
		Name:    "service-accounts enable",
		Summary: "let a disabled service account's API keys work again",
		Setup: noFlags(func(env Env, args []string) {
			ServiceAccountUpdate(env.Client(), args[0], map[string]any{"disabled": false})
		}),
	},
	{
		Args:    "<id>",
		Name:    "service-accounts delete",
		Summary: "delete a service account and revoke all of its keys",
		Setup:   noFlags(func(env Env, args []string) { ServiceAccountDelete(env.Client(), args[0]) }),
	},
	{
		Args:    "<accountId>",
		Name:    "service-accounts keys list",
		Summary: "list a service account's API keys",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) { ServiceAccountKeysList(env.Client(), args[0], *asJSON) }
		},
	},
	{
		Args:    "<accountId>",
		Name:    "service-accounts keys create",
		Summary: "create an API key for a service account, printing its secret once",
		Setup: func(set *flag.FlagSet) Runner {
			name := set.String("name", "", "label for the key")
			days := set.Int("expires-in-days", 0, "expire the key after this many `days` (default 90)")
			never := set.Bool("never-expires", false, "create a key that never expires")
			return func(env Env, args []string) {
				var expiresInDays *int
				if flagSet(set, "expires-in-days") {
					if *days < 1 {
						Fail("--expires-in-days must be at least 1.")
					}
					expiresInDays = days
				}
				if *never && expiresInDays != nil {
					Fail("--expires-in-days and --never-expires can't be combined.")
				}
				ServiceAccountKeyCreate(env.Client(), args[0], *name, expiresInDays, *never)
			}
		},
	},
	{
		Args:    "<accountId> <keyId>",
		Name:    "service-accounts keys revoke",
		Summary: "revoke an API key of a service account",
		Setup:   noFlags(func(env Env, args []string) { ServiceAccountKeyRevoke(env.Client(), args[0], args[1]) }),
	},
}
