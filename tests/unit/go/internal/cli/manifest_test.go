package cli_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
)

const manifestServiceID = "11111111-2222-3333-4444-555555555555"

func TestReadManifestPicksTheFirstFileAndItsType(t *testing.T) {
	directory := t.TempDir()
	if _, _, _, err := cli.ReadManifest("", directory); err == nil || !strings.Contains(err.Error(), ".homerun.json") {
		t.Fatalf("an empty directory should name the files it looked for, got %v", err)
	}
	if err := os.WriteFile(filepath.Join(directory, ".homerun.yml"), []byte("containerPort: 80\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	found, content, contentType, err := cli.ReadManifest("", directory)
	if err != nil || filepath.Base(found) != ".homerun.yml" || contentType != "application/yaml" || string(content) != "containerPort: 80\n" {
		t.Fatalf("got %q %q %q %v", found, content, contentType, err)
	}
	if err := os.WriteFile(filepath.Join(directory, ".homerun.json"), []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	found, _, contentType, _ = cli.ReadManifest("", directory)
	if filepath.Base(found) != ".homerun.json" || contentType != "application/json" {
		t.Fatalf(".homerun.json should win, got %q %q", found, contentType)
	}
}

func TestManifestApplySendsTheFileAndDeploys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "service.json")
	if err := os.WriteFile(path, []byte(`{"containerPort":3000}`), 0o600); err != nil {
		t.Fatal(err)
	}
	client, seen := jsonAPI(t, `{"applied":["containerPort"],"ignored":[],"deploymentId":"d1"}`)
	out, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }},
			[]string{"manifest", "apply", manifestServiceID, "--file", path, "--deploy"})
	})
	if failed != "" {
		t.Fatalf("failed: %s", failed)
	}
	request := (*seen)[0]
	if request.Method != "PUT" || request.Path != "/api/v1/services/"+manifestServiceID+"/manifest" || request.Body != `{"containerPort":3000}` {
		t.Errorf("unexpected request %+v", request)
	}
	if request.Query.Get("deploy") != "true" || request.Header.Get("Content-Type") != "application/json" {
		t.Errorf("expected ?deploy=true and a JSON body, got %+v", request)
	}
	if !strings.Contains(out, `"deploymentId": "d1"`) {
		t.Errorf("the answer should be printed, got %q", out)
	}
}

func TestManifestValidateFailsWithTheErrors(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad.yaml")
	if err := os.WriteFile(path, []byte("port: 3\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	client, seen := jsonAPI(t, `{"valid":false,"errors":["Unrecognized key: \"port\""]}`)
	_, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"manifest", "validate", "--file", path})
	})
	if (*seen)[0].Header.Get("Content-Type") != "application/yaml" {
		t.Errorf("a .yaml file should go as YAML, got %q", (*seen)[0].Header.Get("Content-Type"))
	}
	if !strings.Contains(failed, `Unrecognized key: "port"`) {
		t.Errorf("expected the errors, got %q", failed)
	}
}
