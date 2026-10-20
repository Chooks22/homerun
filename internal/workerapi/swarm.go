package workerapi

import (
	"errors"
	"fmt"
	"net/http"
	"sort"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/httpapi"
)

// mountSwarm wires the swarm routes.
func (s *Server) mountSwarm(r chi.Router) {
	r.Post("/v1/swarm/init", httpapi.H(s.initSwarm))
	r.Get("/v1/swarm/nodes", httpapi.H(s.listSwarmNodes))
	r.Delete("/v1/swarm/nodes/{id}", httpapi.H(s.removeSwarmNode))
	r.Get("/v1/swarm/join", httpapi.H(s.swarmJoin))
	r.Post("/v1/swarm/overlay", httpapi.H(s.ensureOverlay))
	r.Post("/v1/swarm/services", httpapi.H(s.createSwarmService))
	r.Get("/v1/swarm/services/{id}", httpapi.H(s.inspectSwarmService))
	r.Get("/v1/swarm/services/{id}/status", httpapi.H(s.swarmServiceStatus))
	r.Get("/v1/swarm/services/{id}/replicas", httpapi.H(s.swarmServiceReplicas))
	r.Get("/v1/swarm/services/{id}/running-tasks/count", httpapi.H(s.countRunningSwarmTasks))
	r.Get("/v1/swarm/services/{id}/tasks", httpapi.H(s.swarmServiceTasks))
	r.Get("/v1/swarm/services/{id}/logs", httpapi.H(s.swarmServiceLogs))
	r.Post("/v1/swarm/services/{id}/scale", httpapi.H(s.scaleSwarmService))
	r.Post("/v1/swarm/services/{id}/restart", httpapi.H(s.restartSwarmService))
	r.Delete("/v1/swarm/services/{id}", httpapi.H(s.removeSwarmService))
}

// initSwarm turns this daemon into a single-node swarm manager.
func (s *Server) initSwarm(w http.ResponseWriter, r *http.Request) error {
	info, err := s.docker.SystemInfo(r.Context())
	if err != nil {
		return err
	}
	if info.Swarm.LocalNodeState == "active" && info.Swarm.ControlAvailable {
		return httpapi.Answer(w, http.StatusOK, map[string]bool{"alreadyActive": true})
	}
	if err := s.docker.InitSwarm(r.Context(), ""); err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"alreadyActive": false})
}

// listSwarmNodes answers with the swarm's nodes, which the replicas panel uses
// to label each replica with the host running it.
func (s *Server) listSwarmNodes(w http.ResponseWriter, r *http.Request) error {
	nodes, err := s.docker.ListSwarmNodes(r.Context())
	if err != nil {
		return err
	}
	if nodes == nil {
		nodes = []dockerapi.SwarmNode{}
	}
	return httpapi.Answer(w, http.StatusOK, nodes)
}

// ensureOverlayBody names the overlay network to create.
type ensureOverlayBody struct {
	Labels map[string]string `json:"labels"`
	Name   string            `json:"name"`
}

// ensureOverlay creates the attachable overlay a swarm-mode host needs
// alongside the shared bridge, treating one that exists as success.
func (s *Server) ensureOverlay(w http.ResponseWriter, r *http.Request) error {
	var input ensureOverlayBody
	if !httpapi.DecodeJSON(w, r, &input) {
		return nil
	}
	if input.Name == "" {
		return httpapi.Invalid(w, "Invalid request body",
			[]httpapi.ValidationIssue{{Message: "name is required", Path: []string{"name"}}})
	}
	if err := s.docker.EnsureOverlayNetwork(r.Context(), input.Name, input.Labels); err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// createSwarmService creates a swarm service from a raw Engine spec, for the
// app's own core services (the Newt tunnel in swarm mode); a deploy's services
// are created by the deploy job instead.
func (s *Server) createSwarmService(w http.ResponseWriter, r *http.Request) error {
	var spec map[string]any
	if !httpapi.DecodeJSON(w, r, &spec) {
		return nil
	}
	if name, _ := spec["Name"].(string); name == "" {
		return httpapi.Invalid(w, "Invalid request body",
			[]httpapi.ValidationIssue{{Message: "Name is required", Path: []string{"Name"}}})
	}
	id, err := s.docker.CreateSwarmService(r.Context(), spec, nil)
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusCreated, map[string]string{"id": id})
}

// inspectSwarmService answers with a swarm service's id, name and labels,
// looked up by id or name.
func (s *Server) inspectSwarmService(w http.ResponseWriter, r *http.Request) error {
	service, err := s.docker.InspectSwarmService(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such swarm service.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, service)
}

// swarmServiceStatus aggregates a service's tasks into one dashboard status.
//
// The rule is the TypeScript one, unchanged: a service scaled to zero is
// stopped, one with any running task is running, one with a failed or rejected
// task is failed, one with no tasks yet is pending, and anything else is still
// starting. A service the daemon can't inspect at all reads as stopped, since
// that's what a removed service looks like from the dashboard's side.
func (s *Server) swarmServiceStatus(w http.ResponseWriter, r *http.Request) error {
	id := chi.URLParam(r, "id")
	replicas, err := s.docker.SwarmServiceReplicas(r.Context(), id)
	if err != nil {
		return httpapi.Answer(w, http.StatusOK, map[string]string{"status": "stopped"})
	}
	if replicas == 0 {
		return httpapi.Answer(w, http.StatusOK, map[string]string{"status": "stopped"})
	}
	tasks, err := s.docker.ListSwarmTasks(r.Context(), id, false)
	if err != nil {
		return httpapi.Answer(w, http.StatusOK, map[string]string{"status": "stopped"})
	}
	return httpapi.Answer(w, http.StatusOK, map[string]string{"status": swarmStatusFrom(tasks)})
}

// swarmStatusFrom reduces a service's tasks to one status.
func swarmStatusFrom(tasks []dockerapi.SwarmTask) string {
	if len(tasks) == 0 {
		return "pending"
	}
	failed := false
	for _, task := range tasks {
		switch task.Status.State {
		case "running":
			return "running"
		case "failed", "rejected":
			failed = true
		}
	}
	if failed {
		return "failed"
	}
	return "starting"
}

// swarmServiceReplicas answers with a service's configured replica count.
func (s *Server) swarmServiceReplicas(w http.ResponseWriter, r *http.Request) error {
	replicas, err := s.docker.SwarmServiceReplicas(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such swarm service.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]int{"replicas": replicas})
}

// countRunningSwarmTasks answers with how many of a service's tasks are
// running on any node.
func (s *Server) countRunningSwarmTasks(w http.ResponseWriter, r *http.Request) error {
	count, err := s.docker.CountRunningSwarmTasks(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such swarm service.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]int{"count": count})
}

// swarmServiceTasks answers with a service's tasks, optionally only the ones
// the daemon wants running (the rest are previous generations swarm keeps).
func (s *Server) swarmServiceTasks(w http.ResponseWriter, r *http.Request) error {
	runningOnly := r.URL.Query().Get("running") == "1"
	tasks, err := s.docker.ListSwarmTasks(r.Context(), chi.URLParam(r, "id"), runningOnly)
	if err != nil {
		return err
	}
	if tasks == nil {
		tasks = []dockerapi.SwarmTask{}
	}
	return httpapi.Answer(w, http.StatusOK, tasks)
}

// swarmServiceLogs streams the logs of a swarm service's current tasks only,
// timestamped, each line labelled with its replica when there are several.
// Docker's own service logs interleave every task generation, dead ones
// included, in no reliable order, so an old revision's crash read like the
// running task's. A service with no current task falls back to those
// aggregated logs, the only place its last failure still shows.
func (s *Server) swarmServiceLogs(w http.ResponseWriter, r *http.Request) error {
	id := chi.URLParam(r, "id")
	follow := r.URL.Query().Get("follow") != "0"
	tasks, err := s.docker.ListSwarmTasks(r.Context(), id, true)
	if err != nil && !errors.Is(err, dockerapi.ErrNotFound) {
		return err
	}
	if len(tasks) == 0 {
		logs, err := s.docker.SwarmServiceLogs(r.Context(), id, tailParam(r), follow)
		if errors.Is(err, dockerapi.ErrNotFound) {
			return httpapi.Error(w, http.StatusNotFound, "No such swarm service.")
		}
		if err != nil {
			return err
		}
		defer func() { _ = logs.Close() }()
		return streamOut(w, r, logs)
	}
	sort.Slice(tasks, func(i, j int) bool { return tasks[i].Slot < tasks[j].Slot })
	streams := make([]taskStream, 0, len(tasks))
	for _, task := range tasks {
		logs, err := s.docker.SwarmTaskLogs(r.Context(), task.ID, tailParam(r), follow)
		if err != nil {
			continue
		}
		defer func() { _ = logs.Close() }()
		prefix := ""
		if len(tasks) > 1 {
			prefix = fmt.Sprintf("[replica %d] ", task.Slot)
		}
		streams = append(streams, taskStream{logs: logs, prefix: prefix})
	}
	return streamTasks(w, r, streams)
}

// scaleSwarmServiceBody is the replica count to scale to.
type scaleSwarmServiceBody struct {
	Replicas int `json:"replicas"`
}

// scaleSwarmService sets a service's replica count, which is how swarm mode
// does both "stop" (zero) and "start" (its usual count).
func (s *Server) scaleSwarmService(w http.ResponseWriter, r *http.Request) error {
	var input scaleSwarmServiceBody
	if !httpapi.DecodeJSON(w, r, &input) {
		return nil
	}
	if input.Replicas < 0 {
		return httpapi.Invalid(w, "Invalid request body",
			[]httpapi.ValidationIssue{{Message: "replicas can't be negative", Path: []string{"replicas"}}})
	}
	err := s.docker.ScaleSwarmService(r.Context(), chi.URLParam(r, "id"), input.Replicas)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such swarm service.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// restartSwarmService rolls a service's tasks without changing its spec.
func (s *Server) restartSwarmService(w http.ResponseWriter, r *http.Request) error {
	err := s.docker.RestartSwarmService(r.Context(), chi.URLParam(r, "id"))
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such swarm service.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// removeSwarmService removes a swarm service. One already gone isn't an error.
func (s *Server) removeSwarmService(w http.ResponseWriter, r *http.Request) error {
	if err := s.docker.RemoveSwarmService(r.Context(), chi.URLParam(r, "id")); err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// removeSwarmNode forcibly removes a node from the swarm.
func (s *Server) removeSwarmNode(w http.ResponseWriter, r *http.Request) error {
	if err := s.docker.RemoveSwarmNode(r.Context(), chi.URLParam(r, "id")); err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// swarmJoin answers with the worker join token and manager address a new node
// needs to join this swarm.
func (s *Server) swarmJoin(w http.ResponseWriter, r *http.Request) error {
	join, err := s.docker.SwarmJoinInfo(r.Context())
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, join)
}
