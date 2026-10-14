package workerapi_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/tests/unit/go/internal/testsupport"
)

// probe posts body to the SSH Docker probe route and answers its status and body.
func probe(t *testing.T, api *httptest.Server, body any) (int, string) {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	request, err := http.NewRequest(http.MethodPost, api.URL+"/v1/ssh/docker-probe", strings.NewReader(string(encoded)))
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = response.Body.Close() }()
	answer, _ := io.ReadAll(response.Body)
	return response.StatusCode, string(answer)
}

func TestSSHDockerProbeAnswersTheHostKeyAndRefusesAChangedOne(t *testing.T) {
	api := newAPI(t, &fakeDaemon{bodies: map[string]string{}})
	private, public := testsupport.SSHClientKey(t)
	host := testsupport.ServeSSHDocker(t, public, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "OK")
	}))

	status, body := probe(t, api, map[string]string{"dockerHost": host.DockerHost("deploy")})
	if status != http.StatusBadRequest {
		t.Fatalf("no key: %d %s", status, body)
	}

	status, body = probe(t, api, map[string]string{"dockerHost": host.DockerHost("deploy"), "sshPrivateKey": private})
	var answer struct {
		HostKey string `json:"hostKey"`
	}
	if status != http.StatusOK || json.Unmarshal([]byte(body), &answer) != nil || answer.HostKey != host.HostKey {
		t.Fatalf("probe: %d %s", status, body)
	}

	status, body = probe(t, api, map[string]string{
		"dockerHost": host.DockerHost("deploy"), "sshHostKey": "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH", "sshPrivateKey": private,
	})
	if status != http.StatusConflict {
		t.Fatalf("changed key: %d %s", status, body)
	}

	status, body = probe(t, api, map[string]string{"dockerHost": "ssh://deploy@127.0.0.1:1", "sshPrivateKey": private})
	if status != http.StatusBadGateway || !strings.Contains(body, "couldn't reach") {
		t.Fatalf("unreachable: %d %s", status, body)
	}
}
