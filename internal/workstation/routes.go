package workstation

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/httpapi"
)

const defaultLogTail = 500

// RemoteHeader carries a raw remote Docker daemon, a base64 JSON
// dockerapi.RemoteHost, on a request a Hub serves: the workstation runs on
// that daemon instead of the worker's own.
const RemoteHeader = "X-Homerun-Docker-Remote"

// routes answers the workstation routes with the Manager pick chooses for
// each request.
type routes struct {
	pick func(r *http.Request) (*Manager, error)
}

// Mount wires the workstation routes onto an authenticated router, every
// request served by m. Agent mode mounts this: it only ever drives its own
// daemon.
func (m *Manager) Mount(r chi.Router) {
	routes{pick: func(*http.Request) (*Manager, error) { return m, nil }}.mount(r)
}

// Hub serves workstations on the worker's own daemon and on raw remote
// Docker daemons named by the RemoteHeader, keeping one Manager per remote
// so a start's progress survives between the requests that ask about it.
type Hub struct {
	local  *Manager
	mu     sync.Mutex
	remote map[string]*Manager
}

// NewHub builds a Hub over the worker's own Manager.
func NewHub(local *Manager) *Hub {
	return &Hub{local: local, remote: map[string]*Manager{}}
}

// Mount wires the workstation routes onto an authenticated router, each
// request served on the daemon its RemoteHeader names, else the local one.
func (h *Hub) Mount(r chi.Router) {
	routes{pick: h.manager}.mount(r)
}

// manager is the Manager for r's daemon, built on first use for a remote one.
func (h *Hub) manager(r *http.Request) (*Manager, error) {
	header := r.Header.Get(RemoteHeader)
	if header == "" {
		return h.local, nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if manager, ok := h.remote[header]; ok {
		return manager, nil
	}
	raw, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, fmt.Errorf("the %s header isn't base64: %w", RemoteHeader, err)
	}
	var host dockerapi.RemoteHost
	if err := json.Unmarshal(raw, &host); err != nil {
		return nil, fmt.Errorf("the %s header isn't a remote host: %w", RemoteHeader, err)
	}
	client, err := dockerapi.NewRemote(host)
	if err != nil {
		return nil, err
	}
	manager := NewManager(client)
	h.remote[header] = manager
	return manager, nil
}

// mount registers every workstation route.
func (rt routes) mount(r chi.Router) {
	r.Put("/v1/workstations/{id}", rt.with(upRoute))
	r.Get("/v1/workstations/{id}", rt.with(statusRoute))
	r.Get("/v1/workstations/{id}/connections", rt.with(connectionsRoute))
	r.Get("/v1/workstations/{id}/disk", rt.with(diskRoute))
	r.Get("/v1/workstations/{id}/logs", rt.with(logsRoute))
	r.Get("/v1/workstations/{id}/stats", rt.with(statsRoute))
	r.Post("/v1/workstations/{id}/stop", rt.with(stopRoute))
	r.Delete("/v1/workstations/{id}", rt.with(removeRoute))
}

// with adapts a route taking its Manager into a handler, answering 400 when
// the request's remote daemon can't be used.
func (rt routes) with(route func(*Manager, http.ResponseWriter, *http.Request) error) http.HandlerFunc {
	return httpapi.H(func(w http.ResponseWriter, r *http.Request) error {
		manager, err := rt.pick(r)
		if err != nil {
			return httpapi.Error(w, http.StatusBadRequest, err.Error())
		}
		return route(manager, w, r)
	})
}

// workstationID reads and checks the {id} path parameter.
func workstationID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := chi.URLParam(r, "id")
	if !ValidID(id) {
		_ = httpapi.Invalid(w, "Invalid workstation id",
			[]httpapi.ValidationIssue{{Message: "id must be letters, digits and dashes", Path: []string{"id"}}})
		return "", false
	}
	return id, true
}

// upRoute answers PUT /v1/workstations/{id} with 202 once the start is under
// way, 409 when one already is.
func upRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	var spec Spec
	if !httpapi.DecodeJSON(w, r, &spec) {
		return nil
	}
	if problems := Validate(spec); len(problems) > 0 {
		issues := make([]httpapi.ValidationIssue, 0, len(problems))
		for _, problem := range problems {
			issues = append(issues, httpapi.ValidationIssue{Message: problem, Path: []string{}})
		}
		return httpapi.Invalid(w, "Invalid workstation spec", issues)
	}
	if err := m.Up(id, spec); err != nil {
		if errors.Is(err, ErrBusy) {
			return httpapi.Error(w, http.StatusConflict, err.Error())
		}
		return err
	}
	return httpapi.Answer(w, http.StatusAccepted, Status{State: StatePulling})
}

// statusRoute answers GET /v1/workstations/{id}?port= with its Status.
func statusRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	port, _ := strconv.Atoi(r.URL.Query().Get("port"))
	status, err := m.Status(r.Context(), id, port)
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, status)
}

// connectionsRoute answers GET /v1/workstations/{id}/connections?port= with
// how many connections the IDE's port holds open, 404 when nothing runs and
// 409 while a start is in flight.
func connectionsRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	port, err := strconv.Atoi(r.URL.Query().Get("port"))
	if err != nil || port < 1 || port > 65535 {
		return httpapi.Invalid(w, "Invalid port",
			[]httpapi.ValidationIssue{{Message: "port must be between 1 and 65535", Path: []string{"port"}}})
	}
	connections, err := m.Connections(r.Context(), id, port)
	switch {
	case errors.Is(err, ErrBusy):
		return httpapi.Error(w, http.StatusConflict, err.Error())
	case errors.Is(err, dockerapi.ErrNotFound):
		return httpapi.Error(w, http.StatusNotFound, "This workstation isn't running.")
	case err != nil:
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]int{"connections": connections})
}

// statsRoute answers GET /v1/workstations/{id}/stats with the running
// container's resource use, 404 when nothing runs.
func statsRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	sample, err := m.Stats(r.Context(), id)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "This workstation isn't running.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, sample)
}

// diskRoute answers GET /v1/workstations/{id}/disk?path= with how many
// bytes the home directory at path holds, 404 when nothing runs.
func diskRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	path := r.URL.Query().Get("path")
	if !validHomePath(path) {
		return httpapi.Invalid(w, "Invalid path",
			[]httpapi.ValidationIssue{{Message: "path must be an absolute path", Path: []string{"path"}}})
	}
	bytes, err := m.DiskUsage(r.Context(), id, path)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "This workstation isn't running.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]int64{"bytes": bytes})
}

// stopRoute answers POST /v1/workstations/{id}/stop.
func stopRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	if err := m.Stop(r.Context(), id); err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// removeRoute answers DELETE /v1/workstations/{id}?volume=1, the volume
// parameter deciding whether the home volume goes too.
func removeRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	if err := m.Remove(r.Context(), id, r.URL.Query().Get("volume") == "1"); err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// logsRoute answers GET /v1/workstations/{id}/logs?tail=&follow=0 with the
// container's output as plain text, followed unless follow=0, 404 when the
// workstation has no container.
func logsRoute(m *Manager, w http.ResponseWriter, r *http.Request) error {
	id, ok := workstationID(w, r)
	if !ok {
		return nil
	}
	tail, err := strconv.Atoi(r.URL.Query().Get("tail"))
	if err != nil || tail < 0 {
		tail = defaultLogTail
	}
	logs, err := m.Logs(r.Context(), id, tail, r.URL.Query().Get("follow") != "0")
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "This workstation has no container yet.")
	}
	if err != nil {
		return err
	}
	defer func() { _ = logs.Close() }()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(time.Time{})
	if err := dockerapi.DemuxAuto(logs, &flushWriter{controller: controller, writer: w}); err != nil && r.Context().Err() == nil {
		return err
	}
	return nil
}

// flushWriter flushes every chunk, so a follower sees each line as it's written.
type flushWriter struct {
	controller *http.ResponseController
	writer     http.ResponseWriter
}

// Write forwards a chunk and flushes it.
func (f *flushWriter) Write(chunk []byte) (int, error) {
	written, err := f.writer.Write(chunk)
	if err != nil {
		return written, err
	}
	return written, f.controller.Flush()
}
