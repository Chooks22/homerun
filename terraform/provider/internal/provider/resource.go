package provider

import (
	"context"
	"fmt"
	"strings"

	"github.com/hashicorp/terraform-plugin-framework/diag"
	"github.com/hashicorp/terraform-plugin-framework/path"
	"github.com/hashicorp/terraform-plugin-framework/resource"
	"github.com/hashicorp/terraform-plugin-go/tftypes"

	"github.com/orochibraru/homerun/terraform/provider/internal/client"
)

var (
	_ resource.ResourceWithConfigure   = (*specResource)(nil)
	_ resource.ResourceWithImportState = (*specResource)(nil)
)

// specResource is one resource type, driven entirely by its spec: the
// attributes it maps to API fields and the REST paths it calls.
type specResource struct {
	client *client.Client
	spec   ResourceSpec
}

// NewResource returns the constructor the framework calls for spec's type.
func NewResource(spec ResourceSpec) func() resource.Resource {
	return func() resource.Resource {
		return &specResource{spec: spec}
	}
}

func (r *specResource) Metadata(_ context.Context, req resource.MetadataRequest, resp *resource.MetadataResponse) {
	resp.TypeName = req.ProviderTypeName + TypeSuffix(r.spec.Type)
}

func (r *specResource) Schema(_ context.Context, _ resource.SchemaRequest, resp *resource.SchemaResponse) {
	resp.Schema = ResourceSchema(r.spec)
}

func (r *specResource) Configure(_ context.Context, req resource.ConfigureRequest, resp *resource.ConfigureResponse) {
	if req.ProviderData == nil {
		return
	}
	apiClient, ok := req.ProviderData.(*client.Client)
	if !ok {
		resp.Diagnostics.AddError("Unexpected provider data", fmt.Sprintf("%T isn't a Homerun client.", req.ProviderData))
		return
	}
	r.client = apiClient
}

func (r *specResource) Create(ctx context.Context, req resource.CreateRequest, resp *resource.CreateResponse) {
	plan, err := valuesOf(req.Plan.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the plan", err.Error())
		return
	}
	body, err := RequestBody(r.spec, plan, nil)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't build the request", err.Error())
		return
	}
	var created client.Object
	if r.spec.Singleton {
		created, err = r.client.Update(ctx, Path(r.spec.ItemPath, PathValues(r.spec, plan)), body)
	} else {
		created, err = r.client.Create(ctx, Path(r.spec.CollectionPath, PathValues(r.spec, plan)), body)
	}
	if err != nil {
		resp.Diagnostics.AddError("Couldn't create the "+r.spec.Type, err.Error())
		return
	}
	state, err := StateValue(r.spec, req.Plan.Schema.Type().TerraformType(ctx), plan, created)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the created "+r.spec.Type, err.Error())
		return
	}
	resp.State.Raw = state
	r.deploy(ctx, plan, created, &resp.Diagnostics)
}

func (r *specResource) Read(ctx context.Context, req resource.ReadRequest, resp *resource.ReadResponse) {
	prior, err := valuesOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the state", err.Error())
		return
	}
	live, err := r.client.Get(ctx, Path(r.spec.ItemPath, PathValues(r.spec, prior)))
	if client.IsNotFound(err) {
		resp.State.RemoveResource(ctx)
		return
	}
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the "+r.spec.Type, err.Error())
		return
	}
	state, err := RefreshedState(r.spec, req.State.Schema.Type().TerraformType(ctx), prior, live)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the "+r.spec.Type, err.Error())
		return
	}
	resp.State.Raw = state
}

func (r *specResource) Update(ctx context.Context, req resource.UpdateRequest, resp *resource.UpdateResponse) {
	plan, err := valuesOf(req.Plan.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the plan", err.Error())
		return
	}
	prior, err := valuesOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the state", err.Error())
		return
	}
	body, err := RequestBody(r.spec, plan, prior)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't build the request", err.Error())
		return
	}
	item := Path(r.spec.ItemPath, PathValues(r.spec, prior))
	var live client.Object
	if len(body) > 0 {
		live, err = r.client.Update(ctx, item, body)
	} else {
		live, err = r.client.Get(ctx, item)
	}
	if err != nil {
		resp.Diagnostics.AddError("Couldn't update the "+r.spec.Type, err.Error())
		return
	}
	state, err := StateValue(r.spec, req.Plan.Schema.Type().TerraformType(ctx), plan, live)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the updated "+r.spec.Type, err.Error())
		return
	}
	resp.State.Raw = state
	if len(body) > 0 {
		r.deploy(ctx, plan, live, &resp.Diagnostics)
	}
}

func (r *specResource) Delete(ctx context.Context, req resource.DeleteRequest, resp *resource.DeleteResponse) {
	prior, err := valuesOf(req.State.Raw)
	if err != nil {
		resp.Diagnostics.AddError("Couldn't read the state", err.Error())
		return
	}
	if r.spec.Singleton {
		return
	}
	if err := r.client.Delete(ctx, Path(r.spec.ItemPath, PathValues(r.spec, prior))); err != nil {
		resp.Diagnostics.AddError("Couldn't delete the "+r.spec.Type, err.Error())
	}
}

func (r *specResource) ImportState(ctx context.Context, req resource.ImportStateRequest, resp *resource.ImportStateResponse) {
	if r.spec.Singleton && req.ID != SingletonID {
		resp.Diagnostics.AddError("Invalid import id", fmt.Sprintf("There's only one %s: import it as %q.", r.spec.Type, SingletonID))
		return
	}
	fields, err := ImportFields(r.spec, req.ID)
	if err != nil {
		resp.Diagnostics.AddError("Invalid import id", err.Error())
		return
	}
	for name, value := range fields {
		resp.Diagnostics.Append(resp.State.SetAttribute(ctx, path.Root(name), value)...)
	}
}

func (r *specResource) deploy(ctx context.Context, plan map[string]tftypes.Value, live client.Object, diags *diag.Diagnostics) {
	if !r.spec.Deployable {
		return
	}
	var wanted bool
	if value, ok := plan[DeployOnChange]; !ok || !value.IsKnown() || value.IsNull() || value.As(&wanted) != nil || !wanted {
		return
	}
	id, _ := live["id"].(string)
	if err := r.client.Deploy(ctx, id); err != nil {
		diags.AddWarning("The deploy failed", fmt.Sprintf("Saved, but deploying %s failed: %s", id, err))
	}
}

func valuesOf(raw tftypes.Value) (map[string]tftypes.Value, error) {
	values := map[string]tftypes.Value{}
	if raw.IsNull() || !raw.IsKnown() {
		return values, nil
	}
	return values, raw.As(&values)
}

// PathValues is what a path template's placeholders are filled from: the
// id and every string attribute set, by API name.
func PathValues(spec ResourceSpec, values map[string]tftypes.Value) map[string]string {
	out := map[string]string{}
	read := func(name, tf string) {
		value, ok := values[tf]
		var text string
		if ok && value.IsKnown() && !value.IsNull() && value.As(&text) == nil {
			out[name] = text
		}
	}
	read("id", "id")
	for _, attribute := range spec.Attributes {
		if attribute.Kind == "string" {
			read(attribute.Name, attribute.TF)
		}
	}
	return out
}

// RequestBody is the JSON body of a create (prior nil: every value set in
// the plan) or of an update (only the values that changed from prior, a
// cleared one sent as null).
func RequestBody(spec ResourceSpec, plan, prior map[string]tftypes.Value) (client.Object, error) {
	body := client.Object{}
	for _, attribute := range spec.Attributes {
		if attribute.ReadOnly || (prior != nil && attribute.CreateOnly) {
			continue
		}
		value, ok := plan[attribute.TF]
		if !ok || !value.IsKnown() {
			continue
		}
		if prior != nil {
			if before, had := prior[attribute.TF]; had && before.Equal(value) {
				continue
			}
		}
		if value.IsNull() {
			if prior != nil && !attribute.WriteOnly {
				body[attribute.Name] = nil
			}
			continue
		}
		converted, err := ToAPI(attribute, value)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", attribute.TF, err)
		}
		body[attribute.Name] = converted
	}
	return body, nil
}

// StateValue is the state after a create or an update: the planned values
// where they're known, the API's answer for everything else.
func StateValue(spec ResourceSpec, typ tftypes.Type, plan map[string]tftypes.Value, live client.Object) (tftypes.Value, error) {
	objectType, ok := typ.(tftypes.Object)
	if !ok {
		return tftypes.Value{}, fmt.Errorf("the schema of %s isn't an object", spec.Type)
	}
	out := map[string]tftypes.Value{}
	for tf, attributeType := range objectType.AttributeTypes {
		if value, ok := plan[tf]; ok && value.IsKnown() {
			out[tf] = value
			continue
		}
		value, err := liveValue(spec, tf, attributeType, live)
		if err != nil {
			return tftypes.Value{}, err
		}
		out[tf] = value
	}
	return tftypes.NewValue(typ, out), nil
}

// RefreshedState is the state after a read: every attribute the API returns
// from its answer, the rest (secrets, create-only and provider-side
// attributes) kept from prior.
func RefreshedState(spec ResourceSpec, typ tftypes.Type, prior map[string]tftypes.Value, live client.Object) (tftypes.Value, error) {
	objectType, ok := typ.(tftypes.Object)
	if !ok {
		return tftypes.Value{}, fmt.Errorf("the schema of %s isn't an object", spec.Type)
	}
	out := map[string]tftypes.Value{}
	for tf, attributeType := range objectType.AttributeTypes {
		kept, hasPrior := prior[tf]
		if !fromLive(spec, tf) {
			if !hasPrior || kept.IsNull() {
				kept = tftypes.NewValue(attributeType, nil)
				if tf == DeployOnChange {
					kept = tftypes.NewValue(attributeType, false)
				}
			}
			out[tf] = kept
			continue
		}
		value, err := liveValue(spec, tf, attributeType, live)
		if err != nil {
			return tftypes.Value{}, err
		}
		out[tf] = value
	}
	return tftypes.NewValue(typ, out), nil
}

func fromLive(spec ResourceSpec, tf string) bool {
	if tf == "id" {
		return true
	}
	for _, attribute := range spec.Attributes {
		if attribute.TF == tf {
			return attribute.Refreshed()
		}
	}
	return false
}

func liveValue(spec ResourceSpec, tf string, typ tftypes.Type, live client.Object) (tftypes.Value, error) {
	if tf == "id" && spec.Singleton {
		return tftypes.NewValue(typ, SingletonID), nil
	}
	if tf == "id" {
		return FromAPI(Attribute{Kind: "string", Name: "id"}, typ, live["id"])
	}
	if tf == DeployOnChange {
		return tftypes.NewValue(typ, false), nil
	}
	for _, attribute := range spec.Attributes {
		if attribute.TF == tf {
			if !attribute.FromAPI() {
				return tftypes.NewValue(typ, nil), nil
			}
			return FromAPI(attribute, typ, live[attribute.Name])
		}
	}
	return tftypes.NewValue(typ, nil), nil
}

// ImportFields reads an import id into the attributes it sets: the id
// itself, plus each field of a composite id (`<store_id>/<name>`).
func ImportFields(spec ResourceSpec, id string) (map[string]string, error) {
	fields := map[string]string{"id": id}
	if len(spec.ImportID) <= 1 {
		return fields, nil
	}
	parts := strings.SplitN(id, "/", len(spec.ImportID))
	if len(parts) != len(spec.ImportID) {
		return nil, fmt.Errorf("expected %s", strings.Join(spec.ImportID, "/"))
	}
	for index, name := range spec.ImportID {
		attribute, ok := spec.Attribute(name)
		if !ok || parts[index] == "" {
			return nil, fmt.Errorf("expected %s", strings.Join(spec.ImportID, "/"))
		}
		fields[attribute.TF] = parts[index]
	}
	return fields, nil
}
