package workstation_test

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/workstation"
	"github.com/orochibraru/homerun/tests/unit/go/internal/testsupport"
)

func TestHubDrivesAnSSHDockerHostOverOneConnection(t *testing.T) {
	local := &engine{listed: `[]`}
	remote := &engine{listed: `[{"Id":"old","State":"running"}]`}
	localDaemon := httptest.NewServer(local)
	t.Cleanup(localDaemon.Close)
	private, public := testsupport.SSHClientKey(t)
	host := testsupport.ServeSSHDocker(t, public, remote)
	router := chi.NewRouter()
	workstation.NewHub(workstation.NewManager(dockerapi.NewWithHTTP(localDaemon.Client(), localDaemon.URL))).Mount(router)
	server := httptest.NewServer(router)
	t.Cleanup(server.Close)

	encoded, _ := json.Marshal(dockerapi.RemoteHost{
		DockerHost: host.DockerHost("deploy"), SSHHostKey: host.HostKey, SSHPrivateKey: private,
	})
	header := base64.StdEncoding.EncodeToString(encoded)
	get := func(path string) (int, string) {
		request, _ := http.NewRequest(http.MethodGet, server.URL+"/v1/workstations/"+id+path, nil)
		request.Header.Set(workstation.RemoteHeader, header)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = response.Body.Close() }()
		body, _ := io.ReadAll(response.Body)
		return response.StatusCode, string(body)
	}

	code, body := get("")
	var status workstation.Status
	if code != http.StatusOK || json.Unmarshal([]byte(body), &status) != nil || status.State != workstation.StateRunning {
		t.Fatalf("status over SSH: %d %s", code, body)
	}
	if code, body := get("/logs"); code != http.StatusOK || !strings.Contains(body, "listening on 0.0.0.0:8080") {
		t.Fatalf("logs over SSH: %d %s", code, body)
	}
	if !remote.sawCall("GET /containers/json") || local.sawCall("GET /containers/json") {
		t.Fatalf("the SSH host's daemon should answer, remote %v local %v", remote.calls, local.calls)
	}
	if handshakes := host.Handshakes(); handshakes != 1 {
		t.Fatalf("handshakes = %d, want one connection reused across requests", handshakes)
	}
}
