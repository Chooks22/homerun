package dockerapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// SwarmTask is one task of a swarm service: which node runs it, which slot it
// fills, what the daemon wants it to be doing and what it's actually doing.
type SwarmTask struct {
	CreatedAt    string `json:"CreatedAt"`
	DesiredState string `json:"DesiredState"`
	ID           string `json:"ID"`
	NodeID       string `json:"NodeID"`
	ServiceID    string `json:"ServiceID"`
	Slot         int    `json:"Slot"`
	Status       struct {
		ContainerStatus *struct {
			ContainerID string `json:"ContainerID"`
			ExitCode    int    `json:"ExitCode"`
		} `json:"ContainerStatus"`
		Err       string `json:"Err"`
		Message   string `json:"Message"`
		State     string `json:"State"`
		Timestamp string `json:"Timestamp"`
	} `json:"Status"`
	UpdatedAt string `json:"UpdatedAt"`
}

// SwarmNode is one node of the swarm, reduced to what the replicas panel and
// the Remote Hosts page show about it.
type SwarmNode struct {
	Description struct {
		Engine struct {
			EngineVersion string `json:"EngineVersion"`
		} `json:"Engine"`
		Hostname string `json:"Hostname"`
		Platform struct {
			Architecture string `json:"Architecture"`
			OS           string `json:"OS"`
		} `json:"Platform"`
		Resources struct {
			MemoryBytes int64 `json:"MemoryBytes"`
			NanoCPUs    int64 `json:"NanoCPUs"`
		} `json:"Resources"`
	} `json:"Description"`
	ID            string `json:"ID"`
	ManagerStatus *struct {
		Leader bool `json:"Leader"`
	} `json:"ManagerStatus,omitempty"`
	Spec struct {
		Availability string            `json:"Availability"`
		Labels       map[string]string `json:"Labels"`
		Role         string            `json:"Role"`
	} `json:"Spec"`
	Status struct {
		Addr  string `json:"Addr"`
		State string `json:"State"`
	} `json:"Status"`
}

// SwarmJoin is what a new worker node needs to join this swarm.
type SwarmJoin struct {
	ManagerAddress string `json:"managerAddress"`
	Token          string `json:"token"`
}

// SwarmJoinInfo reads the worker join token and the address this manager
// listens on for joins.
func (c *Client) SwarmJoinInfo(ctx context.Context) (*SwarmJoin, error) {
	var swarm struct {
		JoinTokens struct {
			Worker string `json:"Worker"`
		} `json:"JoinTokens"`
	}
	if err := c.decode(ctx, http.MethodGet, "/swarm", nil, nil, &swarm); err != nil {
		return nil, err
	}
	var info struct {
		Swarm struct {
			NodeAddr       string `json:"NodeAddr"`
			NodeID         string `json:"NodeID"`
			RemoteManagers []struct {
				Addr   string `json:"Addr"`
				NodeID string `json:"NodeID"`
			} `json:"RemoteManagers"`
		} `json:"Swarm"`
	}
	if err := c.decode(ctx, http.MethodGet, "/info", nil, nil, &info); err != nil {
		return nil, err
	}
	address := info.Swarm.NodeAddr + ":2377"
	for _, manager := range info.Swarm.RemoteManagers {
		if manager.NodeID == info.Swarm.NodeID {
			address = manager.Addr
		}
	}
	return &SwarmJoin{ManagerAddress: address, Token: swarm.JoinTokens.Worker}, nil
}

// RemoveSwarmNode forcibly removes a node from the swarm. The node itself
// still believes it's joined until someone runs `docker swarm leave` on it.
func (c *Client) RemoveSwarmNode(ctx context.Context, id string) error {
	return c.Call(ctx, http.MethodDelete, "/nodes/"+url.PathEscape(id), url.Values{"force": {"true"}}, nil)
}

// SetSwarmNodeLabels replaces a node's labels, the ones placement constraints
// and preferences read as `node.labels.<key>`, keeping the rest of its spec.
func (c *Client) SetSwarmNodeLabels(ctx context.Context, id string, labels map[string]string) error {
	var inspected struct {
		Spec    map[string]any `json:"Spec"`
		Version struct {
			Index int64 `json:"Index"`
		} `json:"Version"`
	}
	if err := c.decode(ctx, http.MethodGet, "/nodes/"+url.PathEscape(id), nil, nil, &inspected); err != nil {
		return err
	}
	if inspected.Spec == nil {
		inspected.Spec = map[string]any{}
	}
	if labels == nil {
		labels = map[string]string{}
	}
	inspected.Spec["Labels"] = labels
	return c.Call(ctx, http.MethodPost, "/nodes/"+url.PathEscape(id)+"/update",
		url.Values{"version": {strconv.FormatInt(inspected.Version.Index, 10)}}, inspected.Spec)
}

// InitSwarm turns this daemon into a single-node swarm manager. A daemon
// already in a swarm answers 503, which is reported as-is: the caller checks
// SystemInfo first rather than relying on this being idempotent.
func (c *Client) InitSwarm(ctx context.Context, listenAddr string) error {
	if listenAddr == "" {
		listenAddr = "0.0.0.0:2377"
	}
	return c.Call(ctx, http.MethodPost, "/swarm/init", nil, map[string]any{"ListenAddr": listenAddr})
}

// ListSwarmTasks lists a service's tasks, restricted to the ones the daemon
// wants running when runningOnly is set (the rest are the corpses of previous
// generations, which swarm keeps around).
func (c *Client) ListSwarmTasks(ctx context.Context, serviceID string, runningOnly bool) ([]SwarmTask, error) {
	filter := map[string][]string{"service": {serviceID}}
	if runningOnly {
		filter["desired-state"] = []string{"running"}
	}
	filters, err := json.Marshal(filter)
	if err != nil {
		return nil, err
	}
	var tasks []SwarmTask
	err = c.decode(ctx, http.MethodGet, "/tasks", url.Values{"filters": {string(filters)}}, nil, &tasks)
	return tasks, err
}

// ListSwarmNodes lists the swarm's nodes.
func (c *Client) ListSwarmNodes(ctx context.Context) ([]SwarmNode, error) {
	var nodes []SwarmNode
	err := c.decode(ctx, http.MethodGet, "/nodes", nil, nil, &nodes)
	return nodes, err
}

// RemoveSwarmService removes a swarm service. One already gone isn't an error.
func (c *Client) RemoveSwarmService(ctx context.Context, id string) error {
	err := c.Call(ctx, http.MethodDelete, "/services/"+id, nil, nil)
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// RestartSwarmService rolls a service's tasks without changing its spec, by
// bumping the one field swarm treats as "this task template is new".
func (c *Client) RestartSwarmService(ctx context.Context, id string) error {
	response, err := c.request(ctx, http.MethodGet, "/services/"+id, nil, nil, nil)
	if err != nil {
		return err
	}
	var inspected struct {
		Spec    map[string]any `json:"Spec"`
		Version struct {
			Index int64 `json:"Index"`
		} `json:"Version"`
	}
	err = json.NewDecoder(response.Body).Decode(&inspected)
	_ = response.Body.Close()
	if err != nil {
		return err
	}
	if inspected.Spec == nil {
		return errors.New("that swarm service has no spec")
	}
	template, _ := inspected.Spec["TaskTemplate"].(map[string]any)
	if template == nil {
		template = map[string]any{}
	}
	force, _ := template["ForceUpdate"].(float64)
	template["ForceUpdate"] = int(force) + 1
	inspected.Spec["TaskTemplate"] = template
	return c.Call(ctx, http.MethodPost, "/services/"+id+"/update",
		url.Values{"version": {strconv.FormatInt(inspected.Version.Index, 10)}}, inspected.Spec)
}

// SwarmServiceLogs opens a swarm service's aggregated task logs, following
// them when follow is set. The caller closes the stream.
func (c *Client) SwarmServiceLogs(ctx context.Context, id string, tail int, follow bool) (io.ReadCloser, error) {
	query := url.Values{"stderr": {"1"}, "stdout": {"1"}}
	if follow {
		query.Set("follow", "1")
	}
	if tail > 0 {
		query.Set("tail", strconv.Itoa(tail))
	}
	response, err := c.stream(ctx, http.MethodGet, "/services/"+id+"/logs", query, nil, nil, c.daemonAnswers)
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

// SwarmTaskLogs opens one swarm task's logs with a timestamp on every line,
// following them when follow is set. The caller closes the stream.
func (c *Client) SwarmTaskLogs(ctx context.Context, id string, tail int, follow bool) (io.ReadCloser, error) {
	query := url.Values{"stderr": {"1"}, "stdout": {"1"}, "timestamps": {"1"}}
	if follow {
		query.Set("follow", "1")
	}
	if tail > 0 {
		query.Set("tail", strconv.Itoa(tail))
	}
	response, err := c.stream(ctx, http.MethodGet, "/tasks/"+id+"/logs", query, nil, nil, c.daemonAnswers)
	if err != nil {
		return nil, err
	}
	return response.Body, nil
}

// CountRunningSwarmTasks counts a service's tasks running on any node, as the
// daemon itself counts them (`?status=true`), so no task list is fetched or
// walked.
func (c *Client) CountRunningSwarmTasks(ctx context.Context, id string) (int, error) {
	var inspected struct {
		ServiceStatus *struct {
			RunningTasks int `json:"RunningTasks"`
		} `json:"ServiceStatus"`
	}
	if err := c.decode(ctx, http.MethodGet, "/services/"+id, url.Values{"status": {"true"}}, nil, &inspected); err != nil {
		return 0, err
	}
	if inspected.ServiceStatus == nil {
		return 0, nil
	}
	return inspected.ServiceStatus.RunningTasks, nil
}

// SwarmServiceReplicas is a replicated service's configured replica count.
func (c *Client) SwarmServiceReplicas(ctx context.Context, id string) (int, error) {
	var inspected struct {
		Spec struct {
			Mode struct {
				Replicated *struct {
					Replicas int `json:"Replicas"`
				} `json:"Replicated"`
			} `json:"Mode"`
		} `json:"Spec"`
	}
	if err := c.decode(ctx, http.MethodGet, "/services/"+id, nil, nil, &inspected); err != nil {
		return 0, err
	}
	if inspected.Spec.Mode.Replicated == nil {
		return 0, nil
	}
	return inspected.Spec.Mode.Replicated.Replicas, nil
}

// EnsureOverlayNetwork creates an attachable overlay network, treating one
// that already exists as success. Swarm services can only join an overlay, so
// this is the second network a swarm-mode host needs alongside the shared
// bridge every plain container is on.
func (c *Client) EnsureOverlayNetwork(ctx context.Context, name string, labels map[string]string) error {
	body := map[string]any{"Attachable": true, "Driver": "overlay", "Name": name}
	if len(labels) > 0 {
		body["Labels"] = labels
	}
	_, err := c.EnsureNetwork(ctx, body)
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "already exists") {
		return nil
	}
	return err
}
