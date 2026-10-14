package cli

import (
	"encoding/json"
	"flag"
	"net/url"
	"strconv"
	"strings"
)

var registryRepositoryColumns = []string{"repository", "tags", "usedBy"}

var registryTagColumns = []string{"tag", "digest"}

// RegistryTag is one tag of a built-in registry repository and the digest it points at.
type RegistryTag struct {
	Digest *string `json:"digest"`
	Tag    string  `json:"tag"`
}

// RegistryRepository is one built-in registry repository as GET /registry/repositories returns it.
type RegistryRepository struct {
	Repository string        `json:"repository"`
	Tags       []RegistryTag `json:"tags"`
	UsedBy     []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"usedBy"`
}

// registryTagsPath is the path of a repository's tags, each segment of its name escaped.
func registryTagsPath(repository string) string {
	segments := strings.Split(repository, "/")
	for index, segment := range segments {
		segments[index] = url.PathEscape(segment)
	}
	return "/registry/repositories/" + strings.Join(segments, "/") + "/tags"
}

// RegistryRepositoriesList prints the built-in registry's repositories with
// their tag count and the services using them, as a table or raw JSON.
func RegistryRepositoriesList(client *Client, options ListArgs) {
	body, header := client.do("GET", "/registry/repositories", ListQuery(options))
	if options.JSON {
		PrintJSON(body)
		return
	}
	var repositories []RegistryRepository
	if err := json.Unmarshal(body, &repositories); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(repositories))
	for _, repository := range repositories {
		names := make([]string, 0, len(repository.UsedBy))
		for _, service := range repository.UsedBy {
			names = append(names, service.Name)
		}
		rows = append(rows, map[string]string{
			"repository": repository.Repository,
			"tags":       strconv.Itoa(len(repository.Tags)),
			"usedBy":     Shorten(strings.Join(names, ", "), 60),
		})
	}
	PrintTable(rows, registryRepositoryColumns)
	PrintPageFooter(header, len(repositories))
}

// RegistryTagsList prints one built-in registry repository's tags and their
// digests, as a table or raw JSON.
func RegistryTagsList(client *Client, repository string, asJSON bool) {
	body, _ := client.do("GET", registryTagsPath(repository), nil)
	if asJSON {
		PrintJSON(body)
		return
	}
	var tags []RegistryTag
	if err := json.Unmarshal(body, &tags); err != nil {
		Fail(err.Error())
	}
	rows := make([]map[string]string, 0, len(tags))
	for _, tag := range tags {
		digest := ""
		if tag.Digest != nil {
			digest = *tag.Digest
		}
		rows = append(rows, map[string]string{"digest": digest, "tag": tag.Tag})
	}
	PrintTable(rows, registryTagColumns)
}

var registryCommands = []Command{
	{
		Name:    "registry repositories",
		Summary: "list the built-in registry's repositories with their tag count and the services using them",
		Setup: func(set *flag.FlagSet) Runner {
			options := ListFlags(set)
			return func(env Env, _ []string) { RegistryRepositoriesList(env.Client(), *options) }
		},
	},
	{
		Args:    "<repository>",
		Name:    "registry tags",
		Summary: "list a built-in registry repository's tags and the digest each points at",
		Setup: func(set *flag.FlagSet) Runner {
			asJSON := set.Bool("json", false, "print raw JSON instead of a table")
			return func(env Env, args []string) { RegistryTagsList(env.Client(), args[0], *asJSON) }
		},
	},
}
