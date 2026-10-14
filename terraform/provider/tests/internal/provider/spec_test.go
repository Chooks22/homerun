package provider_test

import (
	"context"
	"encoding/json"
	"math/big"
	"reflect"
	"testing"

	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/orochibraru/homerun/terraform/provider/internal/provider"
)

func loadSpec(t *testing.T) provider.Spec {
	t.Helper()
	spec, err := provider.LoadSpec()
	if err != nil {
		t.Fatal(err)
	}
	return spec
}

func TestEverySchemaIsValid(t *testing.T) {
	ctx := context.Background()
	spec := loadSpec(t)
	if len(spec.Resources) < 15 || len(spec.DataSources) != 4 {
		t.Fatalf("unexpected spec size: %d resources, %d data sources", len(spec.Resources), len(spec.DataSources))
	}
	seen := map[string]bool{}
	for _, resource := range spec.Resources {
		if seen[resource.Type] {
			t.Errorf("%s is declared twice", resource.Type)
		}
		seen[resource.Type] = true
		if diags := provider.ResourceSchema(resource).ValidateImplementation(ctx); diags.HasError() {
			t.Errorf("%s: %v", resource.Type, diags)
		}
	}
	for _, dataSource := range spec.DataSources {
		attributes := dataSource.Attributes
		for _, resource := range spec.Resources {
			if resource.Type == dataSource.Resource {
				attributes = resource.Attributes
			}
		}
		if diags := provider.DataSourceSchema(dataSource, attributes).ValidateImplementation(ctx); diags.HasError() {
			t.Errorf("%s: %v", dataSource.Type, diags)
		}
	}
}

func TestValuesRoundTripThroughTheAPI(t *testing.T) {
	ports := provider.Attribute{Fields: []provider.Attribute{
		{Kind: "int", Name: "hostPort", TF: "host_port"},
		{Kind: "string", Name: "protocol", TF: "protocol"},
	}, Kind: "objects", Name: "publishedPorts"}
	portType := tftypes.Object{AttributeTypes: map[string]tftypes.Type{"host_port": tftypes.Number, "protocol": tftypes.String}}
	cases := []struct {
		attribute provider.Attribute
		raw       any
		typ       tftypes.Type
		want      any
	}{
		{provider.Attribute{Kind: "string"}, "nginx", tftypes.String, "nginx"},
		{provider.Attribute{Kind: "bool"}, true, tftypes.Bool, true},
		{provider.Attribute{Kind: "int"}, json.Number("3"), tftypes.Number, int64(3)},
		{provider.Attribute{Kind: "strings"}, []any{"a", "b"}, tftypes.List{ElementType: tftypes.String}, []any{"a", "b"}},
		{provider.Attribute{Kind: "stringMap"}, map[string]any{"A": "1"}, tftypes.Map{ElementType: tftypes.String}, map[string]any{"A": "1"}},
		{provider.Attribute{Kind: "intMap"}, map[string]any{"a.com": json.Number("8080")}, tftypes.Map{ElementType: tftypes.Number}, map[string]any{"a.com": int64(8080)}},
		{ports, []any{map[string]any{"hostPort": 53.0, "protocol": "udp"}}, tftypes.List{ElementType: portType}, []any{map[string]any{"hostPort": int64(53), "protocol": "udp"}}},
	}
	for _, testCase := range cases {
		value, err := provider.FromAPI(testCase.attribute, testCase.typ, testCase.raw)
		if err != nil {
			t.Fatalf("%v: %v", testCase.raw, err)
		}
		back, err := provider.ToAPI(testCase.attribute, value)
		if err != nil || !reflect.DeepEqual(back, testCase.want) {
			t.Errorf("%v came back as %#v (%v)", testCase.raw, back, err)
		}
	}
	if value, err := provider.FromAPI(provider.Attribute{Kind: "int"}, tftypes.Number, nil); err != nil || !value.IsNull() {
		t.Errorf("null should stay null: %v %v", value, err)
	}
	if _, err := provider.FromAPI(provider.Attribute{Kind: "bool", Name: "on"}, tftypes.Bool, "yes"); err == nil {
		t.Error("a string isn't a boolean")
	}
}

func TestRequestBodySendsChangesAndClearsNulls(t *testing.T) {
	spec := provider.ResourceSpec{Attributes: []provider.Attribute{
		{Kind: "string", Name: "name", TF: "name"},
		{Kind: "string", Name: "cpuLimit", TF: "cpu_limit"},
		{Kind: "int", Name: "replicas", TF: "replicas"},
		{Kind: "string", Name: "registryPassword", TF: "registry_password", WriteOnly: true},
		{CreateOnly: true, Kind: "string", Name: "templateId", TF: "template_id"},
		{Kind: "bool", Name: "customSslSet", ReadOnly: true, TF: "custom_ssl_set"},
	}}
	str := func(value string) tftypes.Value { return tftypes.NewValue(tftypes.String, value) }
	null := tftypes.NewValue(tftypes.String, nil)
	prior := map[string]tftypes.Value{
		"cpu_limit": str("0.5"), "name": str("web"), "registry_password": str("old"),
		"replicas": tftypes.NewValue(tftypes.Number, big.NewFloat(1)), "template_id": str("postgres"),
	}
	plan := map[string]tftypes.Value{
		"cpu_limit": null, "custom_ssl_set": tftypes.NewValue(tftypes.Bool, true), "name": str("web"),
		"registry_password": null, "replicas": tftypes.NewValue(tftypes.Number, tftypes.UnknownValue),
		"template_id": str("redis"),
	}
	body, err := provider.RequestBody(spec, plan, prior)
	if err != nil || !reflect.DeepEqual(body, map[string]any{"cpuLimit": nil}) {
		t.Errorf("update body %v (%v)", body, err)
	}
	created, err := provider.RequestBody(spec, plan, nil)
	if err != nil || !reflect.DeepEqual(created, map[string]any{"name": "web", "templateId": "redis"}) {
		t.Errorf("create body %v (%v)", created, err)
	}
}

func TestImportFieldsAndPaths(t *testing.T) {
	spec := loadSpec(t)
	var bucket provider.ResourceSpec
	for _, resource := range spec.Resources {
		if resource.Type == "homerun_bucket" {
			bucket = resource
		}
	}
	fields, err := provider.ImportFields(bucket, "store-1/tf state")
	if err != nil || fields["store_id"] != "store-1" || fields["name"] != "tf state" || fields["id"] != "store-1/tf state" {
		t.Errorf("fields %v (%v)", fields, err)
	}
	for _, id := range []string{"store-1", "/name", "store-1/"} {
		if _, err := provider.ImportFields(bucket, id); err == nil {
			t.Errorf("%q should be refused", id)
		}
	}
	values := provider.PathValues(bucket, map[string]tftypes.Value{
		"name": tftypes.NewValue(tftypes.String, "tf state"), "store_id": tftypes.NewValue(tftypes.String, "store-1"),
	})
	if got := provider.Path(bucket.ItemPath, values); got != "/object-stores/store-1/buckets/tf%20state" {
		t.Errorf("path %s", got)
	}
	if provider.TypeSuffix("homerun_stack") != "_stack" {
		t.Error("the suffix keeps its underscore")
	}
}
