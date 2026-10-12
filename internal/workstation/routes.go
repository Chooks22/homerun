package workstation

import (
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/httpapi"
)

const defaultLogTail = 500

// Mount wires the workstation routes onto an authenticated router.
func (m *Manager) Mount(r chi.Router) {
	r.Put("/v1/workstations/{id}", httpapi.H(m.upRoute))
	r.Get("/v1/workstations/{id}", httpapi.H(m.statusRoute))
	r.Get("/v1/workstations/{id}/connections", httpapi.H(m.connectionsRoute))
	r.Get("/v1/workstations/{id}/logs", httpapi.H(m.logsRoute))
	r.Post("/v1/workstations/{id}/stop", httpapi.H(m.stopRoute))
	r.Delete("/v1/workstations/{id}", httpapi.H(m.removeRoute))
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
func (m *Manager) upRoute(w http.ResponseWriter, r *http.Request) error {
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
func (m *Manager) statusRoute(w http.ResponseWriter, r *http.Request) error {
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
func (m *Manager) connectionsRoute(w http.ResponseWriter, r *http.Request) error {
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

// stopRoute answers POST /v1/workstations/{id}/stop.
func (m *Manager) stopRoute(w http.ResponseWriter, r *http.Request) error {
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
func (m *Manager) removeRoute(w http.ResponseWriter, r *http.Request) error {
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
func (m *Manager) logsRoute(w http.ResponseWriter, r *http.Request) error {
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
