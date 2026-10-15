package dockerapi

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strconv"
)

// SwarmService is the part of a swarm service's inspect a deploy reads.
type SwarmService struct {
	ID   string `json:"ID"`
	Spec struct {
		Labels       map[string]string `json:"Labels"`
		Name         string            `json:"Name"`
		TaskTemplate struct {
			ForceUpdate int `json:"ForceUpdate"`
		} `json:"TaskTemplate"`
	} `json:"Spec"`
	UpdateStatus *struct {
		Message   string `json:"Message"`
		StartedAt string `json:"StartedAt"`
		State     string `json:"State"`
	} `json:"UpdateStatus"`
	Version struct {
		Index int64 `json:"Index"`
	} `json:"Version"`
}

// SwarmServicesByLabel lists the swarm services carrying label ("key=value").
func (c *Client) SwarmServicesByLabel(ctx context.Context, label string) ([]SwarmService, error) {
	filters, err := json.Marshal(map[string][]string{"label": {label}})
	if err != nil {
		return nil, err
	}
	var services []SwarmService
	err = c.decode(ctx, http.MethodGet, "/services", url.Values{"filters": {string(filters)}}, nil, &services)
	return services, err
}

// InspectSwarmService inspects one swarm service.
func (c *Client) InspectSwarmService(ctx context.Context, id string) (*SwarmService, error) {
	var service SwarmService
	if err := c.decode(ctx, http.MethodGet, "/services/"+id, nil, nil, &service); err != nil {
		return nil, err
	}
	return &service, nil
}

// CreateSwarmService creates a swarm service from a raw spec and returns its id.
// auth, when given, is stored with the service so every node, not just this
// manager, can pull a private image (the CLI's --with-registry-auth).
func (c *Client) CreateSwarmService(ctx context.Context, spec map[string]any, auth *AuthConfig) (string, error) {
	response, err := c.request(ctx, http.MethodPost, "/services/create", nil, spec, auth)
	if err != nil {
		return "", err
	}
	defer func() { _ = response.Body.Close() }()
	var created struct {
		ID string `json:"ID"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		return "", err
	}
	return created.ID, nil
}

// UpdateSwarmService replaces a swarm service's spec at version, with auth
// handed to every node that pulls its image, as for CreateSwarmService.
func (c *Client) UpdateSwarmService(ctx context.Context, id string, version int64, spec map[string]any, auth *AuthConfig) error {
	response, err := c.request(ctx, http.MethodPost, "/services/"+id+"/update",
		url.Values{"version": {strconv.FormatInt(version, 10)}}, spec, auth)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, response.Body)
	return response.Body.Close()
}

// CountSwarmNodes is how many nodes the swarm has.
func (c *Client) CountSwarmNodes(ctx context.Context) (int, error) {
	var nodes []json.RawMessage
	if err := c.decode(ctx, http.MethodGet, "/nodes", nil, nil, &nodes); err != nil {
		return 0, err
	}
	return len(nodes), nil
}
