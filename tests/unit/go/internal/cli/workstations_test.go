package cli_test

import (
	"net/http"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
)

const workstationUUID = "11111111-2222-3333-4444-555555555555"

func TestWorkstationsStartAndStopPatchTheDesiredState(t *testing.T) {
	for verb, state := range map[string]string{"start": "running", "stop": "stopped"} {
		t.Run(verb, func(t *testing.T) {
			client, seen := jsonAPI(t, `{"id":"`+workstationUUID+`","desiredState":"`+state+`"}`)
			out, failed := runCLI(t, func() {
				cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"workstations", verb, workstationUUID})
			})
			if failed != "" {
				t.Fatalf("failed: %s", failed)
			}
			request := (*seen)[0]
			if request.Method != http.MethodPatch || request.Path != "/api/v1/workstations/"+workstationUUID || request.Body != `{"desiredState":"`+state+`"}` {
				t.Errorf("unexpected request %+v", request)
			}
			if !strings.Contains(out, state) {
				t.Errorf("the workstation should be printed, got %q", out)
			}
		})
	}
}

func TestWorkstationsRecreatePostsToItsRecreateRoute(t *testing.T) {
	client, seen := jsonAPI(t, `{"id":"`+workstationUUID+`","desiredState":"running"}`)
	out, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"workstations", "recreate", workstationUUID})
	})
	if failed != "" {
		t.Fatalf("failed: %s", failed)
	}
	request := (*seen)[0]
	if len(*seen) != 1 || request.Method != http.MethodPost || request.Path != "/api/v1/workstations/"+workstationUUID+"/recreate" {
		t.Errorf("unexpected requests %+v", *seen)
	}
	if !strings.Contains(out, "running") {
		t.Errorf("the workstation should be printed, got %q", out)
	}
}

func TestWorkstationsResolveASlugThroughTheList(t *testing.T) {
	client, seen := fakeAPI(t, func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		if request.Method == http.MethodGet {
			_, _ = writer.Write([]byte(`[{"id":"ws-1","slug":"alice"}]`))
			return
		}
		_, _ = writer.Write([]byte(`{"id":"ws-1"}`))
	})
	_, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"workstations", "stop", "alice"})
	})
	if failed != "" {
		t.Fatalf("failed: %s", failed)
	}
	if len(*seen) != 2 || (*seen)[0].Query.Get("q") != "alice" || (*seen)[1].Path != "/api/v1/workstations/ws-1" {
		t.Errorf("unexpected requests %+v", *seen)
	}
}

func TestWorkstationsDeleteKeepsTheVolumeUnlessAsked(t *testing.T) {
	cases := map[string]struct {
		args   []string
		volume string
	}{
		"keep":   {[]string{"workstations", "delete", workstationUUID, "--yes"}, ""},
		"volume": {[]string{"workstations", "delete", workstationUUID, "--yes", "--volume"}, "true"},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			client, seen := jsonAPI(t, ``)
			_, failed := runCLI(t, func() {
				cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, testCase.args)
			})
			if failed != "" {
				t.Fatalf("failed: %s", failed)
			}
			request := (*seen)[0]
			if request.Method != http.MethodDelete || request.Path != "/api/v1/workstations/"+workstationUUID || request.Query.Get("volume") != testCase.volume {
				t.Errorf("unexpected request %+v", request)
			}
		})
	}
}

func TestWorkstationsCreateAndPresetsUpdateSendTheBody(t *testing.T) {
	client, seen := jsonAPI(t, `{"id":"x"}`)
	env := cli.Env{Client: func() *cli.Client { return client }}
	_, failed := runCLI(t, func() {
		cli.Execute(env, []string{"workstations", "create", "--set", "name=Box", "--set", "authRequired=true", "--set", `authProviders=["password"]`})
	})
	create := (*seen)[0]
	if failed != "" || create.Method != http.MethodPost || create.Path != "/api/v1/workstations" ||
		create.Body != `{"authProviders":["password"],"authRequired":true,"name":"Box"}` {
		t.Errorf("unexpected create %+v (%s)", create, failed)
	}
	_, failed = runCLI(t, func() {
		cli.Execute(env, []string{"workstation-presets", "update", "p1", "--set", "description=go", "--set", "authRequired=true"})
	})
	update := (*seen)[len(*seen)-1]
	if failed != "" || update.Method != http.MethodPatch || update.Path != "/api/v1/workstation-presets/p1" || update.Body != `{"authRequired":true,"description":"go"}` {
		t.Errorf("unexpected preset update %+v (%s)", update, failed)
	}
}

func TestWorkstationPresetsListAndDelete(t *testing.T) {
	client, seen := jsonAPI(t, `[{"id":"p1","name":"Node","image":"codercom/code-server:4"}]`)
	env := cli.Env{Client: func() *cli.Client { return client }}
	out, failed := runCLI(t, func() { cli.Execute(env, []string{"workstation-presets", "list"}) })
	if failed != "" || !strings.Contains(out, "Node") || (*seen)[0].Path != "/api/v1/workstation-presets" {
		t.Errorf("unexpected list %q (%s)", out, failed)
	}
	_, failed = runCLI(t, func() { cli.Execute(env, []string{"workstation-presets", "delete", "p1", "--yes"}) })
	last := (*seen)[len(*seen)-1]
	if failed != "" || last.Method != http.MethodDelete || last.Path != "/api/v1/workstation-presets/p1" {
		t.Errorf("unexpected delete %+v (%s)", last, failed)
	}
}
