package provider

import (
	_ "embed"
	"encoding/json"
	"net/url"
	"strings"
)

// spec.json is generated from src/lib/iac/resources.ts by `bun run gen`:
// the same mapping the dashboard's IaC page generates configuration and
// detects drift with.
//
//go:embed spec.json
var specJSON []byte

// Attribute is one attribute of a resource: its REST API field and its
// Terraform name, kind and behavior.
type Attribute struct {
	CreateOnly       bool        `json:"createOnly"`
	Description      string      `json:"description"`
	Fields           []Attribute `json:"fields"`
	ForceNew         bool        `json:"forceNew"`
	Kind             string      `json:"kind"`
	Name             string      `json:"name"`
	ReadOnly         bool        `json:"readOnly"`
	Required         bool        `json:"required"`
	ReturnedOnCreate bool        `json:"returnedOnCreate"`
	Sensitive        bool        `json:"sensitive"`
	TF               string      `json:"tf"`
	WriteOnly        bool        `json:"writeOnly"`
	Default          any         `json:"default"`
}

// FromAPI reports whether the API returns the attribute, in the create
// response at least.
func (a Attribute) FromAPI() bool {
	return !a.WriteOnly && !a.CreateOnly
}

// Refreshed reports whether a read refreshes the attribute: everything the
// API returns, except what only the create response carries.
func (a Attribute) Refreshed() bool {
	return a.FromAPI() && !a.ReturnedOnCreate
}

// ResourceSpec describes one resource type and the REST paths behind it.
type ResourceSpec struct {
	AdminOnly      bool        `json:"adminOnly"`
	Attributes     []Attribute `json:"attributes"`
	CollectionPath string      `json:"collectionPath"`
	Deployable     bool        `json:"deployable"`
	Description    string      `json:"description"`
	ImportID       []string    `json:"importId"`
	ItemPath       string      `json:"itemPath"`
	Singleton      bool        `json:"singleton"`
	Type           string      `json:"type"`
}

// SingletonID is the id, and the only import id, of a singleton resource:
// one object at a fixed path that's never created or deleted.
const SingletonID = "instance"

// DataSourceSpec describes one data source: a resource's attributes, or
// its own for a type that's only read.
type DataSourceSpec struct {
	Attributes     []Attribute `json:"attributes"`
	CollectionPath string      `json:"collectionPath"`
	Description    string      `json:"description"`
	ItemPath       string      `json:"itemPath"`
	Lookup         []string    `json:"lookup"`
	Resource       string      `json:"resource"`
	Type           string      `json:"type"`
}

// Spec is every resource and data source the provider serves.
type Spec struct {
	DataSources []DataSourceSpec `json:"dataSources"`
	Resources   []ResourceSpec   `json:"resources"`
}

// LoadSpec parses the embedded spec.
func LoadSpec() (Spec, error) {
	var spec Spec
	err := json.Unmarshal(specJSON, &spec)
	return spec, err
}

// TypeSuffix is the resource type without the provider's prefix, what
// Metadata appends to the provider type name.
func TypeSuffix(typeName string) string {
	return strings.TrimPrefix(typeName, "homerun")
}

// Attribute finds an attribute by its API name.
func (r ResourceSpec) Attribute(name string) (Attribute, bool) {
	for _, attribute := range r.Attributes {
		if attribute.Name == name {
			return attribute, true
		}
	}
	return Attribute{}, false
}

// Path fills a path template's {field} placeholders from values (API
// field names to their string values).
func Path(template string, values map[string]string) string {
	out := template
	for key, value := range values {
		out = strings.ReplaceAll(out, "{"+key+"}", url.PathEscape(value))
	}
	return out
}
