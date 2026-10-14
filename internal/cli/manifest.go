package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// ManifestFiles are the names a Homerun Manifest is looked for under, in order.
var ManifestFiles = []string{".homerun.json", ".homerun.yaml", ".homerun.yml"}

// ManifestValidation is the instance's verdict on a manifest.
type ManifestValidation struct {
	Errors []string `json:"errors"`
	Valid  bool     `json:"valid"`
}

// ReadManifest reads the manifest at path, or the first of ManifestFiles in
// directory when path is empty, with the content type to send it as: YAML for
// a .yaml or .yml file, JSON otherwise.
func ReadManifest(path, directory string) (string, []byte, string, error) {
	candidates := []string{path}
	if path == "" {
		candidates = make([]string, 0, len(ManifestFiles))
		for _, name := range ManifestFiles {
			candidates = append(candidates, filepath.Join(directory, name))
		}
	}
	for _, candidate := range candidates {
		content, err := os.ReadFile(candidate)
		if errors.Is(err, os.ErrNotExist) && path == "" {
			continue
		}
		if err != nil {
			return "", nil, "", err
		}
		contentType := "application/json"
		if extension := strings.ToLower(filepath.Ext(candidate)); extension == ".yaml" || extension == ".yml" {
			contentType = "application/yaml"
		}
		return candidate, content, contentType, nil
	}
	return "", nil, "", fmt.Errorf("no manifest here: looked for %s", strings.Join(ManifestFiles, ", "))
}

func requireManifest(path string) (string, []byte, string) {
	found, content, contentType, err := ReadManifest(path, ".")
	if err != nil {
		Fail(err.Error())
	}
	return found, content, contentType
}

// ManifestApply applies a manifest to a service and prints what the instance
// applied and left out, queueing a deploy afterwards when deploy is set.
func ManifestApply(client *Client, serviceID, path string, deploy bool) {
	_, content, contentType := requireManifest(path)
	target := "/services/" + url.PathEscape(serviceID) + "/manifest"
	if deploy {
		target += "?deploy=true"
	}
	var answer json.RawMessage
	client.decodeBody("PUT", target, contentType, content, &answer)
	PrintJSON(answer)
}

// ManifestValidate checks a manifest against the instance's schema, printing
// "valid" or exiting with every problem found.
func ManifestValidate(client *Client, path string) {
	found, content, contentType := requireManifest(path)
	var verdict ManifestValidation
	client.decodeBody("POST", "/manifests/validate", contentType, content, &verdict)
	if !verdict.Valid {
		Fail(found + " isn't a valid Homerun Manifest:\n  " + strings.Join(verdict.Errors, "\n  "))
		return
	}
	fmt.Println(found + " is valid")
}

var manifestCommands = []Command{
	{
		Args:    "<service>",
		Name:    "manifest apply",
		Summary: "apply a Homerun Manifest (.homerun.json, .yaml or .yml here by default) to a service",
		Setup: func(set *flag.FlagSet) Runner {
			file := set.String("file", "", "the manifest `file` to apply instead of .homerun.json/.yaml/.yml in this directory")
			deploy := set.Bool("deploy", false, "queue a deploy once it's applied")
			return func(env Env, args []string) {
				ManifestApply(env.Client(), serviceID(env, args[0]), *file, *deploy)
			}
		},
	},
	{
		Name:    "manifest validate",
		Summary: "check a Homerun Manifest against the instance's schema without applying it",
		Setup: func(set *flag.FlagSet) Runner {
			file := set.String("file", "", "the manifest `file` to check instead of .homerun.json/.yaml/.yml in this directory")
			return func(env Env, _ []string) { ManifestValidate(env.Client(), *file) }
		},
	},
}
