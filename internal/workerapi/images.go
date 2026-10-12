package workerapi

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/httpapi"
)

// mountImages wires the image routes.
func (s *Server) mountImages(r chi.Router) {
	r.Post("/v1/images/pull", httpapi.H(s.pullImage))
	r.Get("/v1/images/inspect", httpapi.H(s.inspectImage))
	r.Get("/v1/images/id", httpapi.H(s.imageID))
	r.Post("/v1/images/tag", httpapi.H(s.tagImage))
	r.Delete("/v1/images/{id}", httpapi.H(s.removeImage))
}

// pullImageBody is a pull request: the reference to fetch and the credentials
// to fetch it with.
type pullImageBody struct {
	Auth *dockerapi.AuthConfig `json:"auth"`
	Ref  string                `json:"ref"`
}

// pullImage pulls an image, streaming one JSON object per layer status change
// as it goes.
//
// The progress is newline-delimited JSON rather than a single answer at the
// end because it drives the live deploy log. It is deliberately per status
// change and not per byte tick: the daemon's raw progress events are far too
// chatty to log one for one.
func (s *Server) pullImage(w http.ResponseWriter, r *http.Request) error {
	var input pullImageBody
	if !httpapi.DecodeJSON(w, r, &input) {
		return nil
	}
	if input.Ref == "" {
		return httpapi.Invalid(w, "Invalid request body",
			[]httpapi.ValidationIssue{{Message: "ref is required", Path: []string{"ref"}}})
	}
	w.Header().Set("Content-Type", "application/x-ndjson")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.WriteHeader(http.StatusOK)
	controller := http.NewResponseController(w)
	_ = controller.SetWriteDeadline(noDeadline)
	encoder := json.NewEncoder(w)

	pullErr := s.docker.PullImageEvents(r.Context(), input.Ref, input.Auth, func(id, status string) {
		_ = encoder.Encode(map[string]string{"id": id, "status": status})
		_ = controller.Flush()
	})
	outcome := map[string]any{"done": true}
	if pullErr != nil {
		outcome["error"] = pullErr.Error()
	}
	_ = encoder.Encode(outcome)
	_ = controller.Flush()
	return nil
}

// inspectImage answers with the daemon's whole image inspect body.
func (s *Server) inspectImage(w http.ResponseWriter, r *http.Request) error {
	ref := r.URL.Query().Get("ref")
	if ref == "" {
		return httpapi.Invalid(w, "Invalid query",
			[]httpapi.ValidationIssue{{Message: "ref is required", Path: []string{"ref"}}})
	}
	inspected, err := s.docker.InspectImageRaw(r.Context(), ref)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such image.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, inspected)
}

// imageID answers with a local image's id, or null when it isn't on this host.
// Any failure reads as absent, which is what the revision list wants: it's
// asking "can I still roll back to this", not "is the daemon healthy".
func (s *Server) imageID(w http.ResponseWriter, r *http.Request) error {
	ref := r.URL.Query().Get("ref")
	if ref == "" {
		return httpapi.Invalid(w, "Invalid query",
			[]httpapi.ValidationIssue{{Message: "ref is required", Path: []string{"ref"}}})
	}
	inspected, err := s.docker.InspectImage(r.Context(), ref)
	if err != nil {
		return httpapi.Answer(w, http.StatusOK, map[string]any{"id": nil})
	}
	return httpapi.Answer(w, http.StatusOK, map[string]any{
		"digest": inspected.Digest(),
		"id":     inspected.ID,
	})
}

// removeImage removes an image, forcing it only when asked.
func (s *Server) removeImage(w http.ResponseWriter, r *http.Request) error {
	force := r.URL.Query().Get("force") == "1"
	err := s.docker.RemoveImage(r.Context(), chi.URLParam(r, "id"), force)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}

// tagImageBody is a tag request: the image to tag, by id or reference, and
// the repository and tag to give it.
type tagImageBody struct {
	Repository string `json:"repository"`
	Source     string `json:"source"`
	Tag        string `json:"tag"`
}

// tagImage tags a local image as repository:tag, without touching any
// registry.
func (s *Server) tagImage(w http.ResponseWriter, r *http.Request) error {
	var input tagImageBody
	if !httpapi.DecodeJSON(w, r, &input) {
		return nil
	}
	var issues []httpapi.ValidationIssue
	for _, field := range []struct{ name, value string }{
		{"source", input.Source}, {"repository", input.Repository}, {"tag", input.Tag},
	} {
		if field.value == "" {
			issues = append(issues, httpapi.ValidationIssue{Message: field.name + " is required", Path: []string{field.name}})
		}
	}
	if len(issues) > 0 {
		return httpapi.Invalid(w, "Invalid request body", issues)
	}
	err := s.docker.TagImage(r.Context(), input.Source, input.Repository, input.Tag)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, "No such image.")
	}
	if err != nil {
		return err
	}
	return httpapi.Answer(w, http.StatusOK, map[string]bool{"ok": true})
}
