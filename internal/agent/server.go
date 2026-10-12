package agent

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"regexp"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/buildinfo"
	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/hoststats"
	"github.com/orochibraru/homerun/internal/httpapi"
)

// Server is the agent's HTTP control surface: /v1/health and /v1/openapi.json
// are open, every other route needs the bearer token.
type Server struct {
	builder *Builder
	docker  Docker
	mounts  []func(chi.Router)
	stats   *hoststats.StatsSampler
	token   string
}

// NewServer builds the server for one daemon and one token. Each mount adds
// its own routes behind the same token, the way agent mode adds workstations.
func NewServer(token string, docker Docker, builder *Builder, stats *hoststats.StatsSampler, mounts ...func(chi.Router)) *Server {
	return &Server{builder: builder, docker: docker, mounts: mounts, stats: stats, token: token}
}

// Handler routes every request. /v1/health isn't logged: a monitor or the
// Remote Hosts page polls it every few seconds, which would drown everything
// else out.
func (s *Server) Handler() http.Handler {
	router := chi.NewRouter()
	router.Use(httpapi.RequestLog("/v1/health"))
	router.NotFound(httpapi.NotFound)
	router.MethodNotAllowed(httpapi.MethodNotAllowed)

	router.Get("/v1/health", s.health)
	router.Get("/v1/openapi.json", s.openAPI)

	router.Group(func(authed chi.Router) {
		authed.Use(httpapi.BearerAuth(s.token))
		authed.Get("/v1/stats", httpapi.H(s.statsRoute))
		authed.Post("/v1/build", httpapi.H(s.build))
		authed.Get("/v1/images/save", httpapi.H(s.saveImage))
		for _, mount := range s.mounts {
			mount(authed)
		}
	})
	return router
}

// health answers GET /v1/health with the agent's status and version, with no auth required.
func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	httpapi.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok", "version": buildinfo.Version})
}

// openAPI answers GET /v1/openapi.json with the agent's OpenAPI document.
func (s *Server) openAPI(w http.ResponseWriter, r *http.Request) {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	httpapi.WriteJSON(w, http.StatusOK, openAPIDocument(fmt.Sprintf("%s://%s", scheme, r.Host)))
}

// statsRoute answers GET /v1/stats with a fresh host stats sample.
func (s *Server) statsRoute(w http.ResponseWriter, _ *http.Request) error {
	httpapi.WriteJSON(w, http.StatusOK, s.stats.Sample())
	return nil
}

// build runs POST /v1/build. The whole build happens inside the request and
// answers with one JSON result: 200 when it succeeded, 500 when it didn't.
func (s *Server) build(w http.ResponseWriter, r *http.Request) error {
	var input BuildInput
	if !httpapi.DecodeJSON(w, r, &input) {
		return nil
	}
	if issues := validateBuildInput(input); len(issues) > 0 {
		return httpapi.Invalid(w, "Invalid request body", issues)
	}
	result := s.builder.Build(r.Context(), input)
	status := http.StatusOK
	if !result.Success {
		status = http.StatusInternalServerError
	}
	httpapi.WriteJSON(w, status, result)
	return nil
}

// saveImage streams a local image as a `docker save` tarball, for the main app
// to load onto its own daemon when a build has no cache registry to publish
// through.
func (s *Server) saveImage(w http.ResponseWriter, r *http.Request) error {
	ref := r.URL.Query().Get("ref")
	if ref == "" {
		return httpapi.Invalid(w, "Invalid query", []httpapi.ValidationIssue{{Message: "ref is required", Path: []string{"ref"}}})
	}
	archive, err := s.docker.SaveImage(r.Context(), ref)
	if errors.Is(err, dockerapi.ErrNotFound) {
		return httpapi.Error(w, http.StatusNotFound, fmt.Sprintf("Image %s not found.", ref))
	}
	if err != nil {
		return err
	}
	defer func() { _ = archive.Close() }()
	log.Printf("[save] %s", ref)
	w.Header().Set("Content-Type", "application/x-tar")
	w.WriteHeader(http.StatusOK)
	if _, copyErr := io.Copy(w, archive); copyErr != nil {
		log.Printf("[save] %s: the stream ended early: %s", ref, copyErr)
	}
	return nil
}

var commitPattern = regexp.MustCompile(`(?i)^[0-9a-f]{40}$`)

// validateBuildInput checks a build request the way the TypeScript agent's zod
// schema did, returning one issue per problem so a malformed request fails as
// a clean 400 instead of deep inside a docker call.
func validateBuildInput(input BuildInput) []httpapi.ValidationIssue {
	issues := []httpapi.ValidationIssue{}
	add := func(message string, path ...string) {
		issues = append(issues, httpapi.ValidationIssue{Message: message, Path: path})
	}
	if input.GitURL == "" {
		add("gitUrl is required", "gitUrl")
	}
	if input.Tag == "" {
		add("tag is required", "tag")
	}
	if input.Commit != nil && *input.Commit != "" && !commitPattern.MatchString(*input.Commit) {
		add("commit must be a full 40-character SHA", "commit")
	}
	if input.BuildMethod != nil && *input.BuildMethod != "" && !IsBuildMethod(*input.BuildMethod) {
		add(fmt.Sprintf("buildMethod must be one of %s", strings.Join(Tools.BuildMethods, ", ")), "buildMethod")
	}
	if input.BuildTarget != nil && *input.BuildTarget != "" && !bakeTargetPattern.MatchString(*input.BuildTarget) {
		add("buildTarget must be a plain target name", "buildTarget")
	}
	if input.Platform != nil && *input.Platform != "" && !platformPattern.MatchString(*input.Platform) {
		add("platform must be an os/arch pair like linux/amd64", "platform")
	}
	if input.Credential != nil && input.Credential.Token == "" {
		add("credential.token is required", "credential", "token")
	}
	if input.Push != nil {
		if input.Push.RegistryURL == "" {
			add("push.registryUrl is required", "push", "registryUrl")
		}
		if input.Push.Tag == "" {
			add("push.tag is required", "push", "tag")
		}
	}
	return issues
}
