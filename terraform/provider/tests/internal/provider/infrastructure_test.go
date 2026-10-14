package provider_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func remoteHostConfig(fake *fakeAPI, name string) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_remote_host" "builder" {
  name        = %q
  kind        = "agent"
  agent_url   = "http://10.0.0.5:7420"
  agent_token = "agent-secret"
}
`, name)
}

func TestRemoteHostLifecycle(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: remoteHostConfig(fake, "builder"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_remote_host.builder", "agent_token", "agent-secret"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/remote-hosts")
						want := map[string]any{"agentToken": "agent-secret", "agentUrl": "http://10.0.0.5:7420", "kind": "agent", "name": "builder"}
						if len(created) != 1 || !reflect.DeepEqual(created[0].body, want) {
							return fmt.Errorf("unexpected create %v", created)
						}
						return nil
					},
				),
			},
			{
				Config: remoteHostConfig(fake, "big-builder"),
				Check: func(*terraform.State) error {
					updates := fake.calls("PATCH", "/remote-hosts/id-1")
					if len(updates) != 1 || !reflect.DeepEqual(updates[0].body, map[string]any{"name": "big-builder"}) {
						return fmt.Errorf("expected one PATCH of the name, got %v", updates)
					}
					return nil
				},
			},
			{
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"agent_token"},
				ResourceName:            "homerun_remote_host.builder",
			},
		},
	})
}

// recordsServer answers record creates the way the API does, with a
// provider record id and the composite `<domainId>/<recordId>` id, and
// hands everything else to fake.
func recordsServer(t *testing.T, fake *fakeAPI) *httptest.Server {
	t.Helper()
	created := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/v1")
		if r.Method != http.MethodPost || !strings.HasSuffix(path, "/records") {
			fake.serve(w, r)
			return
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		created++
		domainID := strings.Split(path, "/")[2]
		recordID := fmt.Sprintf("MX:mail/%d", created)
		object := map[string]any{"domainId": domainID, "id": domainID + "/" + recordID, "managed": false, "recordId": recordID}
		for key, value := range body {
			object[key] = value
		}
		if _, ok := object["ttl"]; !ok {
			object["ttl"] = float64(300)
		}
		fake.put(fmt.Sprintf("%s/%s", path, recordID), object)
		fake.mu.Lock()
		fake.requests = append(fake.requests, recorded{body: body, method: r.Method, path: path})
		fake.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(object)
	}))
	t.Cleanup(server.Close)
	return server
}

func domainConfig(server *httptest.Server, content string) string {
	return fmt.Sprintf(`
provider "homerun" {
  endpoint = %q
  api_key  = "test-key"
}

resource "homerun_domain" "main" {
  name    = "example.com"
  zone_id = "zone-1"
}

resource "homerun_dns_record" "mail" {
  domain_id = homerun_domain.main.id
  name      = "mail.example.com"
  type      = "MX"
  content   = %q
  priority  = 10
}
`, server.URL, content)
}

func TestDomainAndRecordLifecycle(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	server := recordsServer(t, fake)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: domainConfig(server, "mx1.example.net"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_dns_record.mail", "id", "id-1/MX:mail/1"),
					resource.TestCheckResourceAttr("homerun_dns_record.mail", "record_id", "MX:mail/1"),
					resource.TestCheckResourceAttr("homerun_dns_record.mail", "ttl", "300"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/domains/id-1/records")
						if len(created) != 1 || created[0].body["priority"] != float64(10) {
							return fmt.Errorf("unexpected record create %v", created)
						}
						return nil
					},
				),
			},
			{
				Config: domainConfig(server, "mx2.example.net"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_dns_record.mail", "record_id", "MX:mail/2"),
					func(*terraform.State) error {
						if deleted := fake.calls("DELETE", "/domains/id-1/records/"); len(deleted) != 1 {
							return fmt.Errorf("expected the old record deleted, got %v", deleted)
						}
						if updates := fake.calls("PATCH", "/domains/"); len(updates) != 0 {
							return fmt.Errorf("a record change has to replace it, got %v", updates)
						}
						return nil
					},
				),
			},
			{
				ImportState:       true,
				ImportStateId:     "id-1/MX:mail/2",
				ImportStateVerify: true,
				ResourceName:      "homerun_dns_record.mail",
			},
		},
	})
}

func workstationConfig(fake *fakeAPI, minutes int) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_workstation_preset" "node" {
  name       = "node"
  extensions = ["esbenp.prettier-vscode"]
}

resource "homerun_workstation" "api" {
  name              = "api"
  git_url           = "https://github.com/acme/api.git"
  cpu_limit         = "1.5"
  desired_state     = "stopped"
  auto_stop_mode    = "idle"
  auto_stop_minutes = %d
}
`, minutes)
}

func TestWorkstationAndPresetLifecycle(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: workstationConfig(fake, 60),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_workstation_preset.node", "extensions.0", "esbenp.prettier-vscode"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/workstations")
						if len(created) != 1 {
							return fmt.Errorf("expected one workstation create, got %v", created)
						}
						body := created[0].body
						if body["cpuLimit"] != "1.5" || body["desiredState"] != "stopped" || body["autoStopMinutes"] != float64(60) {
							return fmt.Errorf("unexpected workstation create %v", body)
						}
						if _, sent := body["image"]; sent {
							return fmt.Errorf("an attribute left unset was sent: %v", body)
						}
						return nil
					},
				),
			},
			{
				Config: workstationConfig(fake, 30),
				Check: func(*terraform.State) error {
					updates := fake.calls("PATCH", "/workstations/")
					if len(updates) != 1 || !reflect.DeepEqual(updates[0].body, map[string]any{"autoStopMinutes": float64(30)}) {
						return fmt.Errorf("expected one PATCH of the auto-stop minutes, got %v", updates)
					}
					return nil
				},
			},
			{
				ImportState:       true,
				ImportStateVerify: true,
				ResourceName:      "homerun_workstation.api",
			},
		},
	})
}
