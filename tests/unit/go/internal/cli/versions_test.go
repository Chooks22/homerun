package cli_test

import (
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
)

const versionServiceID = "0b6f6c62-6a3b-4f8e-9d55-2f1a4c7e8d90"

func TestRunVersionDispatches(t *testing.T) {
	base := "/api/v1/services/" + versionServiceID + "/version"
	tests := []struct {
		name       string
		args       []string
		wantMethod string
		wantPath   string
		wantBody   string
	}{
		{"show", []string{versionServiceID}, "GET", base, ""},
		{"tags", []string{"tags", versionServiceID}, "GET", base + "/pin", ""},
		{"pin", []string{"pin", versionServiceID, "1.25.3"}, "POST", base + "/pin", `{"local":false,"tag":"1.25.3"}`},
		{"pin locally", []string{"pin", versionServiceID, "1.25.3-local", "--local"}, "POST", base + "/pin", `{"local":true,"tag":"1.25.3-local"}`},
		{"unpin", []string{"unpin", versionServiceID}, "DELETE", base + "/pin", ""},
		{"watch on, trial off", []string{"watch", versionServiceID, "--check", "--trial=false"}, "PATCH", base, `{"updateCheckEnabled":true,"updateTrialEnabled":false}`},
		{"watch off", []string{"watch", versionServiceID, "--check=false"}, "PATCH", base, `{"updateCheckEnabled":false}`},
		{"check", []string{"check", versionServiceID}, "POST", base + "/check", ""},
		{"update", []string{"update", versionServiceID}, "POST", base + "/update", ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			client, seen := jsonAPI(t, `{"tag":"1.25.3"}`)
			out, failed := runCLI(t, func() {
				cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, append([]string{"services", "version"}, test.args...))
			})
			if failed != "" {
				t.Fatalf("failed with %q", failed)
			}
			request := (*seen)[0]
			if request.Method != test.wantMethod || request.Path != test.wantPath {
				t.Errorf("wrong request %s %s", request.Method, request.Path)
			}
			if request.Body != test.wantBody {
				t.Errorf("want body %s, got %s", test.wantBody, request.Body)
			}
			if !strings.Contains(out, `"tag": "1.25.3"`) {
				t.Errorf("got %q", out)
			}
		})
	}
}

func TestVersionWatchNeedsAFlag(t *testing.T) {
	client, seen := jsonAPI(t, `{}`)
	_, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, []string{"services", "version", "watch", versionServiceID})
	})
	if failed != "Nothing to change: pass --check, --trial or both." {
		t.Errorf("got %q", failed)
	}
	if len(*seen) != 0 {
		t.Errorf("sent %d requests", len(*seen))
	}
}
