package cli_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
)

func TestRegistryRepositoriesListsTagCountsAndUsers(t *testing.T) {
	client, seen := jsonAPI(t, `[{"repository":"team/app","tags":[{"tag":"1.0","digest":"sha256:a"},{"tag":"latest","digest":"sha256:a"}],"usedBy":[{"id":"s1","name":"App"},{"id":"s2","name":"Worker"}]}]`)
	out, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"registry", "repositories", "--search", "team", "--page", "2"})
	})
	if failed != "" {
		t.Fatalf("failed: %s", failed)
	}
	request := (*seen)[0]
	if request.Method != http.MethodGet || request.Path != "/api/v1/registry/repositories" || request.Query.Get("q") != "team" || request.Query.Get("page") != "2" {
		t.Errorf("unexpected request %+v", request)
	}
	for _, want := range []string{"team/app", "2", "App, Worker"} {
		if !strings.Contains(out, want) {
			t.Errorf("output should contain %q, got %q", want, out)
		}
	}
}

func TestRegistryTagsListsTagsAndDigests(t *testing.T) {
	client, seen := jsonAPI(t, `[{"tag":"1.0","digest":"sha256:abc"},{"tag":"old","digest":null}]`)
	out, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"registry", "tags", "team/app"})
	})
	if failed != "" {
		t.Fatalf("failed: %s", failed)
	}
	if path := (*seen)[0].Path; path != "/api/v1/registry/repositories/team/app/tags" {
		t.Errorf("unexpected path %q", path)
	}
	if !strings.Contains(out, "sha256:abc") || !strings.Contains(out, "old") {
		t.Errorf("the tags should be printed, got %q", out)
	}
}

func TestRegistryTagsPrintsRawJSON(t *testing.T) {
	client, _ := jsonAPI(t, `[{"tag":"1.0","digest":"sha256:abc"}]`)
	out, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"registry", "tags", "app", "--json"})
	})
	if failed != "" || !strings.Contains(out, `"digest": "sha256:abc"`) {
		t.Errorf("expected raw JSON, got %q (%s)", out, failed)
	}
}

func TestRegistryRepositoriesPrintsRawJSON(t *testing.T) {
	client, _ := jsonAPI(t, `[{"repository":"app","tags":[],"usedBy":[]}]`)
	out, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"registry", "repositories", "--json"})
	})
	if failed != "" || !strings.Contains(out, `"repository": "app"`) {
		t.Errorf("expected raw JSON, got %q (%s)", out, failed)
	}
}
