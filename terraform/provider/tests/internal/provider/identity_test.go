package provider_test

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"
)

func userConfig(fake *fakeAPI, servicesLevel string) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_user" "jane" {
  email       = "jane@example.com"
  name        = "Jane"
  role        = "custom"
  permissions = { services = %q }
}
`, servicesLevel)
}

func TestUserLifecycle(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: userConfig(fake, "read"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_user.jane", "id", "id-1"),
					resource.TestCheckResourceAttr("homerun_user.jane", "permissions.services", "read"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/users")
						want := map[string]any{
							"email":       "jane@example.com",
							"name":        "Jane",
							"permissions": map[string]any{"services": "read"},
							"role":        "custom",
						}
						if len(created) != 1 || !reflect.DeepEqual(created[0].body, want) {
							return fmt.Errorf("unexpected create %v", created)
						}
						return nil
					},
				),
			},
			{
				Config: userConfig(fake, "write"),
				Check: func(*terraform.State) error {
					updates := fake.calls("PATCH", "/users/id-1")
					want := map[string]any{"permissions": map[string]any{"services": "write"}}
					if len(updates) != 1 || !reflect.DeepEqual(updates[0].body, want) {
						return fmt.Errorf("expected one PATCH of permissions, got %v", updates)
					}
					return nil
				},
			},
			{
				ImportState:       true,
				ImportStateVerify: true,
				ResourceName:      "homerun_user.jane",
			},
			{
				PreConfig: func() {
					fake.set("/users/id-1", "role", "viewer")
				},
				Config:             userConfig(fake, "write"),
				ExpectNonEmptyPlan: true,
				PlanOnly:           true,
			},
		},
	})
}

func oauthProviderConfig(fake *fakeAPI, label string) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_oauth_provider" "pocket" {
  name          = "pocket-id"
  label         = %q
  client_id     = "homerun"
  client_secret = "s3cret"
  discovery_url = "https://id.example.com/.well-known/openid-configuration"
}
`, label)
}

func TestOauthProviderKeepsItsSecretOutOfReads(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: oauthProviderConfig(fake, "Pocket ID"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_oauth_provider.pocket", "client_secret", "s3cret"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/oauth-providers")
						if len(created) != 1 || created[0].body["clientSecret"] != "s3cret" || created[0].body["name"] != "pocket-id" {
							return fmt.Errorf("unexpected create %v", created)
						}
						return nil
					},
				),
			},
			{
				Config: oauthProviderConfig(fake, "Pocket"),
				Check: func(*terraform.State) error {
					updates := fake.calls("PATCH", "/oauth-providers/id-1")
					if len(updates) != 1 || !reflect.DeepEqual(updates[0].body, map[string]any{"label": "Pocket"}) {
						return fmt.Errorf("expected one PATCH of the label, got %v", updates)
					}
					return nil
				},
			},
			{
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"client_secret"},
				ResourceName:            "homerun_oauth_provider.pocket",
			},
		},
	})
}
