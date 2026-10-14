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

// ServiceAccountCreate creates a service account and prints it as JSON.
func ServiceAccountCreate(client *Client, name string) {
	var created map[string]any
	client.decodeJSON("POST", "/service-accounts", map[string]string{"name": name}, &created)
	PrintValue(created)
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
		Setup:   noFlags(func(env Env, args []string) { ServiceAccountCreate(env.Client(), args[0]) }),
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
