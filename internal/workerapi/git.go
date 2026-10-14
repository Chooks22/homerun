package workerapi

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/agent"
	"github.com/orochibraru/homerun/internal/httpapi"
)

// mountGit wires the git routes.
func (s *Server) mountGit(r chi.Router) {
	r.Post("/v1/git/file", httpapi.H(s.readRepoFile))
}

// readRepoFileBody asks for the first of paths that exists in a repository at
// a ref.
type readRepoFileBody struct {
	Credential *agent.GitCredential `json:"credential"`
	Paths      []string             `json:"paths"`
	Ref        string               `json:"ref"`
	URL        string               `json:"url"`
}

// readRepoFile answers with the first of the paths asked for that exists in
// the repository at the ref, and the commit it was read at, without checking
// the repository out. A path that exists nowhere comes back with an empty
// path, not an error.
func (s *Server) readRepoFile(w http.ResponseWriter, r *http.Request) error {
	var input readRepoFileBody
	if !httpapi.DecodeJSON(w, r, &input) {
		return nil
	}
	if input.URL == "" || input.Ref == "" || len(input.Paths) == 0 {
		return httpapi.Invalid(w, "Invalid request body",
			[]httpapi.ValidationIssue{{Message: "url, ref and paths are required", Path: []string{"url"}}})
	}
	file, err := agent.NewBuilder(s.docker, "").ReadRepoFile(r.Context(), input.URL, input.Ref, input.Credential, input.Paths)
	if err != nil {
		return httpapi.Error(w, http.StatusUnprocessableEntity, err.Error())
	}
	return httpapi.Answer(w, http.StatusOK, file)
}
