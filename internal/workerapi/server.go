// Package workerapi is the worker's Docker control surface: the HTTP API the
// SvelteKit app calls for everything it used to do against the Docker socket
// itself. The app keeps the database, the business rules and every spec it
// builds; this side owns the socket and does the engine I/O.
//
// Jobs do not come through here. A deploy, a scan, a backup or a cleanup still
// travels through the job table, because a job has to survive either process
// restarting (see the worker note). This API is for what a page is waiting on:
// a status, a preview, a start or stop, and the three things that can't be a
// job at all because they stream — logs, the web terminal and host stats.
package workerapi

import (
	"context"
	"crypto/rand"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/orochibraru/homerun/internal/buildinfo"
	"github.com/orochibraru/homerun/internal/dockerapi"
	"github.com/orochibraru/homerun/internal/hoststats"
	"github.com/orochibraru/homerun/internal/httpapi"
	"github.com/orochibraru/homerun/internal/janitor"
	"github.com/orochibraru/homerun/internal/workstation"
)

// Server answers the app's Docker control calls for one daemon.
type Server struct {
	// Wedged lists the helper containers the janitor couldn't remove, for
	// /v1/health. Nil reports none.
	Wedged func() []janitor.Wedged

	bootID       string
	docker       *dockerapi.Client
	stats        *hoststats.StatsSampler
	terminals    *TerminalHub
	token        string
	workstations *workstation.Hub
}

// NewServer builds the control surface over one daemon and one token. The
// terminal hub's reaper runs for the life of ctx.
func NewServer(ctx context.Context, token string, docker *dockerapi.Client) *Server {
	return &Server{
		bootID:       rand.Text(),
		docker:       docker,
		stats:        hoststats.NewStatsSampler(),
		terminals:    NewTerminalHub(ctx, docker),
		token:        token,
		workstations: workstation.NewHub(workstation.NewManager(docker)),
	}
}

// TerminalsClosed is closed once every terminal session has been closed after
// the server's context ended.
func (s *Server) TerminalsClosed() <-chan struct{} {
	return s.terminals.Done()
}

// Handler routes every request. /v1/health is open and unlogged, everything
// else needs the bearer token.
func (s *Server) Handler() http.Handler {
	router := chi.NewRouter()
	router.Use(httpapi.RequestLog("/v1/health"))
	router.NotFound(httpapi.NotFound)
	router.MethodNotAllowed(httpapi.MethodNotAllowed)

	router.Get("/v1/health", s.health)

	router.Group(func(r chi.Router) {
		r.Use(httpapi.BearerAuth(s.token))
		s.mountContainers(r)
		s.mountTerminal(r)
		s.mountGit(r)
		s.mountImages(r)
		s.mountNetworks(r)
		s.mountSystem(r)
		s.mountSwarm(r)
		s.workstations.Mount(r)
	})
	return router
}

// health answers with the worker's version, so the app can tell a worker
// that's up from one that's merely listening, a boot id that changes on every
// worker start, so the app can tell it restarted and re-converge the core
// services onto it, and the helper containers the daemon is wedged on, so the
// app can tell the operator to restart Docker.
func (s *Server) health(w http.ResponseWriter, _ *http.Request) {
	wedged := []janitor.Wedged{}
	if s.Wedged != nil {
		wedged = s.Wedged()
	}
	httpapi.WriteJSON(w, http.StatusOK, map[string]any{
		"bootId":           s.bootID,
		"status":           "ok",
		"version":          buildinfo.Version,
		"wedgedContainers": wedged,
	})
}
