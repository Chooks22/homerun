package workstation

import (
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/httpapi"
)

// Mount wires the workstation routes onto an authenticated router.
func (m *Manager) Mount(r chi.Router) {
	r.Put("/v1/workstations/{id}", httpapi.H(m.upRoute))
	r.Get("/v1/workstations/{id}", httpapi.H(m.statusRoute))
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
