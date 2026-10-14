package provider_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"regexp"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/orochibraru/homerun/terraform/provider/internal/client"
	"github.com/orochibraru/homerun/terraform/provider/internal/provider"
)

func smtpConfig(fake *fakeAPI, host string) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_smtp_settings" "mail" {
  host     = %q
  port     = 587
  password = "hunter2"
}
`, host)
}

func TestSingletonAdoptsPatchesAndForgets(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	fake.put("/instance/smtp", map[string]any{
		"enabled": true, "from": "homerun@example.com", "host": "old.example.com",
		"passwordSet": false, "port": 25, "secure": false, "username": "homerun",
	})
	resource.UnitTest(t, resource.TestCase{
		CheckDestroy: func(*terraform.State) error {
			if deletes := fake.calls("DELETE", "/instance"); len(deletes) != 0 {
				return fmt.Errorf("destroying a singleton deleted it: %v", deletes)
			}
			if _, kept := fake.objects["/instance/smtp"]; !kept {
				return fmt.Errorf("destroying a singleton removed the settings")
			}
			return nil
		},
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: smtpConfig(fake, "smtp.example.com"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_smtp_settings.mail", "id", provider.SingletonID),
					resource.TestCheckResourceAttr("homerun_smtp_settings.mail", "from", "homerun@example.com"),
					func(*terraform.State) error {
						if created := fake.calls("POST", "/instance"); len(created) != 0 {
							return fmt.Errorf("a singleton was POSTed: %v", created)
						}
						patches := fake.calls("PATCH", "/instance/smtp")
						want := map[string]any{"host": "smtp.example.com", "password": "hunter2", "port": float64(587)}
						if len(patches) != 1 || !reflect.DeepEqual(patches[0].body, want) {
							return fmt.Errorf("expected one PATCH of the configured fields, got %v", patches)
						}
						return nil
					},
				),
			},
			{
				Config: smtpConfig(fake, "mail.example.com"),
				Check: func(*terraform.State) error {
					patches := fake.calls("PATCH", "/instance/smtp")
					if len(patches) != 2 || !reflect.DeepEqual(patches[1].body, map[string]any{"host": "mail.example.com"}) {
						return fmt.Errorf("expected a PATCH of host alone, got %v", patches)
					}
					return nil
				},
			},
			{
				ImportState:             true,
				ImportStateId:           provider.SingletonID,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"password"},
				ResourceName:            "homerun_smtp_settings.mail",
			},
			{
				ExpectError:   regexp.MustCompile(`import it as "instance"`),
				ImportState:   true,
				ImportStateId: "smtp",
				ResourceName:  "homerun_smtp_settings.mail",
			},
		},
	})
}

const generatedSecret = "generated-once"

// tokenServer is the fake API, except that creating a registry token answers
// with a generated secret the fake never stores, like the real API.
func tokenServer(t *testing.T, fake *fakeAPI) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/v1/registry/tokens" {
			fake.serve(w, r)
			return
		}
		recorder := httptest.NewRecorder()
		fake.serve(recorder, r)
		var created map[string]any
		if err := json.Unmarshal(recorder.Body.Bytes(), &created); err != nil {
			t.Errorf("the fake's create answer isn't JSON: %v", err)
		}
		created["secret"] = generatedSecret
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(created)
	}))
	t.Cleanup(server.Close)
	return server
}

func TestRegistryTokenKeepsTheSecretOnlyCreateReturns(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	server := tokenServer(t, fake)
	config := fmt.Sprintf(`
provider "homerun" {
  endpoint = %q
  api_key  = "test-key"
}

resource "homerun_registry_token" "ci" {
  username = "ci"
}
`, server.URL)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: config,
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_registry_token.ci", "secret", generatedSecret),
					func(*terraform.State) error {
						if object := fake.objects["/registry/tokens/id-1"]; object["secret"] != nil {
							return fmt.Errorf("the fake stored the secret: %v", object)
						}
						return nil
					},
				),
			},
			{
				Check:        resource.TestCheckResourceAttr("homerun_registry_token.ci", "secret", generatedSecret),
				RefreshState: true,
			},
			{
				Config:   config,
				PlanOnly: true,
			},
		},
	})
}

func TestSingletonStateAndReturnedOnCreateRefresh(t *testing.T) {
	spec := provider.ResourceSpec{
		Attributes: []provider.Attribute{
			{Kind: "string", Name: "username", TF: "username"},
			{Kind: "string", Name: "secret", ReadOnly: true, ReturnedOnCreate: true, Sensitive: true, TF: "secret"},
		},
		Singleton: true,
		Type:      "homerun_test",
	}
	objectType := tftypes.Object{AttributeTypes: map[string]tftypes.Type{
		"id": tftypes.String, "secret": tftypes.String, "username": tftypes.String,
	}}
	unknown := tftypes.NewValue(tftypes.String, tftypes.UnknownValue)
	plan := map[string]tftypes.Value{"id": unknown, "secret": unknown, "username": tftypes.NewValue(tftypes.String, "ci")}
	created, err := provider.StateValue(spec, objectType, plan, client.Object{"secret": "s3cret", "username": "ci"})
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]tftypes.Value{}
	if err := created.As(&values); err != nil {
		t.Fatal(err)
	}
	if !values["id"].Equal(tftypes.NewValue(tftypes.String, provider.SingletonID)) {
		t.Errorf("a singleton's id is %v", values["id"])
	}
	if !values["secret"].Equal(tftypes.NewValue(tftypes.String, "s3cret")) {
		t.Errorf("the create response's secret wasn't stored: %v", values["secret"])
	}
	refreshed, err := provider.RefreshedState(spec, objectType, values, client.Object{"username": "renamed"})
	if err != nil {
		t.Fatal(err)
	}
	after := map[string]tftypes.Value{}
	if err := refreshed.As(&after); err != nil {
		t.Fatal(err)
	}
	if !after["secret"].Equal(tftypes.NewValue(tftypes.String, "s3cret")) || !after["username"].Equal(tftypes.NewValue(tftypes.String, "renamed")) {
		t.Errorf("a read should keep the secret and refresh the rest: %v", after)
	}
}

func TestSettingsResourcesAreSingletons(t *testing.T) {
	spec := loadSpec(t)
	singletons := map[string]bool{}
	for _, resource := range spec.Resources {
		if resource.Singleton {
			singletons[resource.Type] = true
			if resource.ItemPath != resource.CollectionPath || resource.ItemPath == "" {
				t.Errorf("%s: a singleton lives at one fixed path, got %q and %q", resource.Type, resource.ItemPath, resource.CollectionPath)
			}
		}
	}
	for _, name := range []string{
		"homerun_authentication_settings", "homerun_error_pages", "homerun_instance_settings",
		"homerun_ip_ban_settings", "homerun_registry_settings", "homerun_smtp_settings", "homerun_tls_settings",
	} {
		if !singletons[name] {
			t.Errorf("%s isn't a singleton", name)
		}
	}
}
