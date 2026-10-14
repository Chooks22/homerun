package provider_test

import (
	"fmt"
	"os/exec"
	"reflect"
	"testing"

	"github.com/hashicorp/terraform-plugin-framework/providerserver"
	"github.com/hashicorp/terraform-plugin-go/tfprotov6"
	"github.com/hashicorp/terraform-plugin-testing/helper/resource"
	"github.com/hashicorp/terraform-plugin-testing/terraform"

	"github.com/orochibraru/homerun/terraform/provider/internal/provider"
)

func factories() map[string]func() (tfprotov6.ProviderServer, error) {
	return map[string]func() (tfprotov6.ProviderServer, error){
		"homerun": providerserver.NewProtocol6WithError(provider.New("test")()),
	}
}

func requireTerraform(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("terraform"); err != nil {
		t.Skip("terraform isn't on PATH")
	}
}

func providerBlock(fake *fakeAPI) string {
	return fmt.Sprintf(`
provider "homerun" {
  endpoint = %q
  api_key  = "test-key"
}
`, fake.URL())
}

func serviceConfig(fake *fakeAPI, replicas int) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_stack" "web" {
  name = "Web"
  slug = "web"
}

resource "homerun_service" "api" {
  name              = "API"
  slug              = "api"
  stack_id          = homerun_stack.web.id
  image             = "nginx"
  container_port    = 80
  replicas          = %d
  env_vars          = { A = "1" }
  domains           = ["api.example.com"]
  registry_password = "s3cret"
  deploy_on_change  = true
  published_ports = [
    { container_port = 53, host_port = 5353, protocol = "udp" },
    { container_port = 80, host_port = 8080 },
  ]
}
`, replicas)
}

func TestServiceAndStackLifecycle(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: serviceConfig(fake, 1),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttrPair("homerun_service.api", "stack_id", "homerun_stack.web", "id"),
					resource.TestCheckResourceAttr("homerun_service.api", "published_ports.1.protocol", "tcp"),
					resource.TestCheckResourceAttr("homerun_service.api", "registry_password", "s3cret"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/services")
						if len(created) != 2 || created[0].path != "/services" {
							return fmt.Errorf("expected a create then a deploy, got %v", created)
						}
						body := created[0].body
						if body["stackId"] == nil || body["registryPassword"] != "s3cret" || body["containerPort"] != float64(80) {
							return fmt.Errorf("unexpected create body %v", body)
						}
						if _, sent := body["tracesEnabled"]; sent {
							return fmt.Errorf("an attribute left unset was sent: %v", body)
						}
						return nil
					},
				),
			},
			{
				Config: serviceConfig(fake, 2),
				Check: func(*terraform.State) error {
					updates := fake.calls("PATCH", "/services/")
					if len(updates) != 1 || !reflect.DeepEqual(updates[0].body, map[string]any{"replicas": float64(2)}) {
						return fmt.Errorf("expected one PATCH of replicas, got %v", updates)
					}
					if deploys := fake.calls("POST", "/services/id-2/deploy"); len(deploys) != 2 {
						return fmt.Errorf("expected a deploy after the change, got %d", len(deploys))
					}
					return nil
				},
			},
			{
				ImportState:             true,
				ImportStateVerify:       true,
				ImportStateVerifyIgnore: []string{"deploy_on_change", "registry_password", "template_id"},
				ResourceName:            "homerun_service.api",
			},
			{
				PreConfig: func() {
					fake.set("/services/id-2", "replicas", 5)
				},
				Config:             serviceConfig(fake, 2),
				ExpectNonEmptyPlan: true,
				PlanOnly:           true,
			},
		},
	})
}

func TestBucketImportsByCompositeID(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	fake.put("/object-stores/store-1", map[string]any{"id": "store-1", "name": "Garage", "kind": "s3"})
	config := providerBlock(fake) + `
resource "homerun_bucket" "state" {
  store_id        = "store-1"
  name            = "tfstate"
  expiration_days = 30
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: config,
				Check:  resource.TestCheckResourceAttr("homerun_bucket.state", "id", "store-1/tfstate"),
			},
			{
				ImportState:       true,
				ImportStateId:     "store-1/tfstate",
				ImportStateVerify: true,
				ResourceName:      "homerun_bucket.state",
			},
		},
	})
}

func serviceAccountConfig(fake *fakeAPI, disabled bool, servicesLevel string) string {
	return providerBlock(fake) + fmt.Sprintf(`
resource "homerun_service_account" "smoke" {
  name        = "smoke-tests"
  disabled    = %t
  permissions = { services = %q }
}
`, disabled, servicesLevel)
}

func TestServiceAccountLifecycle(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{
			{
				Config: serviceAccountConfig(fake, false, "read"),
				Check: resource.ComposeAggregateTestCheckFunc(
					resource.TestCheckResourceAttr("homerun_service_account.smoke", "id", "id-1"),
					resource.TestCheckResourceAttr("homerun_service_account.smoke", "permissions.services", "read"),
					func(*terraform.State) error {
						created := fake.calls("POST", "/service-accounts")
						want := map[string]any{"disabled": false, "name": "smoke-tests", "permissions": map[string]any{"services": "read"}}
						if len(created) != 1 || !reflect.DeepEqual(created[0].body, want) {
							return fmt.Errorf("unexpected create %v", created)
						}
						return nil
					},
				),
			},
			{
				Config: serviceAccountConfig(fake, true, "write"),
				Check: func(*terraform.State) error {
					updates := fake.calls("PATCH", "/service-accounts/id-1")
					want := map[string]any{"disabled": true, "permissions": map[string]any{"services": "write"}}
					if len(updates) != 1 || !reflect.DeepEqual(updates[0].body, want) {
						return fmt.Errorf("expected one PATCH of disabled and permissions, got %v", updates)
					}
					return nil
				},
			},
			{
				ImportState:       true,
				ImportStateVerify: true,
				ResourceName:      "homerun_service_account.smoke",
			},
			{
				PreConfig: func() {
					fake.set("/service-accounts/id-1", "permissions", map[string]any{"services": "read"})
				},
				Config:             serviceAccountConfig(fake, true, "write"),
				ExpectNonEmptyPlan: true,
				PlanOnly:           true,
			},
		},
	})
}

func TestDataSourcesLookUpBySlug(t *testing.T) {
	requireTerraform(t)
	fake := newFakeAPI(t)
	fake.put("/stacks/stack-1", map[string]any{"id": "stack-1", "name": "Web", "slug": "web"})
	fake.put("/templates/postgres", map[string]any{"id": "postgres", "name": "PostgreSQL", "image": "postgres", "containerPort": 5432})
	config := providerBlock(fake) + `
data "homerun_stack" "web" {
  slug = "web"
}

data "homerun_template" "postgres" {
  id = "postgres"
}
`
	resource.UnitTest(t, resource.TestCase{
		ProtoV6ProviderFactories: factories(),
		Steps: []resource.TestStep{{
			Config: config,
			Check: resource.ComposeAggregateTestCheckFunc(
				resource.TestCheckResourceAttr("data.homerun_stack.web", "id", "stack-1"),
				resource.TestCheckResourceAttr("data.homerun_template.postgres", "container_port", "5432"),
			),
		}},
	})
}
