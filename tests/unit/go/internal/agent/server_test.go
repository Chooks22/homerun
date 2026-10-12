package agent_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/buildinfo"
	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/hoststats"
	"github.com/orochibraru/homerun/internal/httpapi"

	"github.com/orochibraru/homerun/internal/agent"
)

const testToken = "s3cret"

// newTestServer starts an httptest server over an agent.Server backed by docker.
func newTestServer(t *testing.T, docker *fakeDocker) *httptest.Server {
	t.Helper()
	sampler := &hoststats.StatsSampler{ProcRoot: t.TempDir(), RunCommand: func(string, ...string) (string, bool) { return "", false }}
	server := httptest.NewServer(agent.NewServer(testToken, docker, newTestBuilder(docker), sampler).Handler())
	t.Cleanup(server.Close)
	return server
}

// call sends one HTTP request with an optional Authorization token and
// returns the response and its body.
func call(t *testing.T, method, url, token, body string) (*http.Response, string) {
	t.Helper()
	request, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		request.Header.Set("Authorization", token)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	raw, _ := io.ReadAll(response.Body)
	return response, string(raw)
}

func TestHealthIsOpenAndReportsTheVersion(t *testing.T) {
	server := newTestServer(t, newFakeDocker())
	response, body := call(t, http.MethodGet, server.URL+"/v1/health", "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health must answer without a token, got %d", response.StatusCode)
	}
	var health map[string]string
	if err := json.Unmarshal([]byte(body), &health); err != nil {
		t.Fatal(err)
	}
	if health["status"] != "ok" || health["version"] != buildinfo.Version {
		t.Errorf("got %v", health)
	}
}

func TestProtectedRoutesNeedTheBearerToken(t *testing.T) {
	server := newTestServer(t, newFakeDocker())
	for _, header := range []string{"", "Bearer wrong", "Basic " + testToken, "Bearer ", testToken} {
		response, _ := call(t, http.MethodGet, server.URL+"/v1/stats", header, "")
		if response.StatusCode != http.StatusUnauthorized {
			t.Errorf("Authorization %q should be refused, got %d", header, response.StatusCode)
		}
	}
	response, body := call(t, http.MethodGet, server.URL+"/v1/stats", "Bearer "+testToken, "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the right token is let in, got %d", response.StatusCode)
	}
	var stats hoststats.SystemStats
	if err := json.Unmarshal([]byte(body), &stats); err != nil {
		t.Errorf("stats should be JSON, got %q", body)
	}
}

func TestSaveImage(t *testing.T) {
	docker := newFakeDocker()
	docker.saved["alpine:3"] = "TARBALL"
	server := newTestServer(t, docker)
	auth := "Bearer " + testToken

	response, body := call(t, http.MethodGet, server.URL+"/v1/images/save?ref=alpine:3", auth, "")
	if response.StatusCode != http.StatusOK || body != "TARBALL" {
		t.Errorf("the image should stream through, got %d %q", response.StatusCode, body)
	}
	if response.Header.Get("Content-Type") != "application/x-tar" {
		t.Errorf("got %q", response.Header.Get("Content-Type"))
	}

	response, body = call(t, http.MethodGet, server.URL+"/v1/images/save?ref=nope:1", auth, "")
	if response.StatusCode != http.StatusNotFound || !strings.Contains(body, "Image nope:1 not found.") {
		t.Errorf("a missing image is a 404, got %d %q", response.StatusCode, body)
	}

	response, _ = call(t, http.MethodGet, server.URL+"/v1/images/save", auth, "")
	if response.StatusCode != http.StatusBadRequest {
		t.Errorf("no ref is a 400, got %d", response.StatusCode)
	}

	docker.failOn["save "] = errBoom
	response, body = call(t, http.MethodGet, server.URL+"/v1/images/save?ref=alpine:3", auth, "")
	if response.StatusCode != http.StatusInternalServerError || !strings.Contains(body, "boom") {
		t.Errorf("a daemon failure surfaces as a 500 with its message, got %d %q", response.StatusCode, body)
	}
}

func TestBuildRoute(t *testing.T) {
	docker := newFakeDocker()
	docker.run = gitSucceeds
	server := newTestServer(t, docker)
	auth := "Bearer " + testToken

	response, body := call(t, http.MethodPost, server.URL+"/v1/build", auth,
		`{"gitUrl":"https://github.com/o/r.git","tag":"svc:1"}`)
	if response.StatusCode != http.StatusOK {
		t.Fatalf("a successful build is a 200, got %d %q", response.StatusCode, body)
	}
	var result agent.BuildResult
	if err := json.Unmarshal([]byte(body), &result); err != nil || !result.Success {
		t.Errorf("got %q %v", body, err)
	}
	if strings.Contains(body, `"error"`) {
		t.Errorf("a success carries no error key, got %q", body)
	}

	docker.run = func(dockerapi.ContainerConfig) (int, string) { return 1, "fatal: nope\n" }
	response, body = call(t, http.MethodPost, server.URL+"/v1/build", auth,
		`{"gitUrl":"https://github.com/o/r.git","tag":"svc:2"}`)
	if response.StatusCode != http.StatusInternalServerError || !strings.Contains(body, `"success":false`) {
		t.Errorf("a failed build is a 500 with the result, got %d %q", response.StatusCode, body)
	}
	if !strings.Contains(body, `"commit":null`) {
		t.Errorf("a failure before any checkout reports a null commit, got %q", body)
	}
}

func TestBuildRouteValidatesTheBody(t *testing.T) {
	server := newTestServer(t, newFakeDocker())
	auth := "Bearer " + testToken
	cases := map[string]string{
		"not JSON":        `{nope`,
		"missing fields":  `{}`,
		"short commit":    `{"gitUrl":"g","tag":"t","commit":"abc"}`,
		"unknown method":  `{"gitUrl":"g","tag":"t","buildMethod":"compose"}`,
		"shell in target": `{"gitUrl":"g","tag":"t","buildTarget":"a;b"}`,
		"empty token":     `{"gitUrl":"g","tag":"t","credential":{"username":"u","token":""}}`,
		"incomplete push": `{"gitUrl":"g","tag":"t","push":{"username":"u","password":"p"}}`,
	}
	for name, body := range cases {
		response, answer := call(t, http.MethodPost, server.URL+"/v1/build", auth, body)
		if response.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: want a 400, got %d %q", name, response.StatusCode, answer)
			continue
		}
		var decoded struct {
			Error  string                    `json:"error"`
			Issues []httpapi.ValidationIssue `json:"issues"`
		}
		if err := json.Unmarshal([]byte(answer), &decoded); err != nil || decoded.Error != "Invalid request body" || len(decoded.Issues) == 0 {
			t.Errorf("%s: want the error plus its issues, got %q", name, answer)
		}
	}
}

func TestUnknownPathsAndMethods(t *testing.T) {
	server := newTestServer(t, newFakeDocker())
	response, body := call(t, http.MethodGet, server.URL+"/nope", "", "")
	if response.StatusCode != http.StatusNotFound || !strings.Contains(body, "Not found") {
		t.Errorf("got %d %q", response.StatusCode, body)
	}
	response, _ = call(t, http.MethodDelete, server.URL+"/v1/health", "", "")
	if response.StatusCode == http.StatusOK {
		t.Error("only the documented method is served")
	}
}

func TestOpenAPIDocumentsEveryRoute(t *testing.T) {
	server := newTestServer(t, newFakeDocker())
	response, body := call(t, http.MethodGet, server.URL+"/v1/openapi.json", "", "")
	if response.StatusCode != http.StatusOK {
		t.Fatalf("the spec is open, got %d", response.StatusCode)
	}
	var document struct {
		Info    struct{ Version string } `json:"info"`
		OpenAPI string                   `json:"openapi"`
		Paths   map[string]map[string]struct {
			Security []map[string][]string `json:"security"`
		} `json:"paths"`
		Servers []struct{ URL string } `json:"servers"`
	}
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		t.Fatal(err)
	}
	if document.OpenAPI != "3.1.0" || document.Info.Version != buildinfo.Version {
		t.Errorf("got %+v", document)
	}
	if len(document.Servers) != 1 || document.Servers[0].URL != server.URL {
		t.Errorf("the server entry is the address the spec was fetched from, got %+v", document.Servers)
	}
	for _, route := range []string{
		"/v1/build", "/v1/health", "/v1/images/save", "/v1/stats", "/v1/workstations/{id}", "/v1/workstations/{id}/stop",
	} {
		operations, ok := document.Paths[route]
		if !ok {
			t.Errorf("%s isn't documented", route)
			continue
		}
		for _, operation := range operations {
			secured := len(operation.Security) > 0
			if route == "/v1/health" && secured {
				t.Error("health is documented as open, since it is")
			}
			if route != "/v1/health" && !secured {
				t.Errorf("%s should be documented as needing the bearer token", route)
			}
		}
	}
}
