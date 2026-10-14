package deploy

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// RouteSpec is what the route check probes once the workload runs: every
// hostname a Traefik router serves for the service, through the local
// Traefik on Entrypoint, and through its public URL when DNS automation or
// Pangolin points it here. ErrorPages says Homerun's error pages are
// published, so a request no router claims lands on its catch-all page.
type RouteSpec struct {
	Entrypoint string      `json:"entrypoint"`
	ErrorPages bool        `json:"errorPages"`
	Hosts      []RouteHost `json:"hosts"`
}

// RouteHost is one routed hostname. Path is what a domain like
// example.com/api routes ("" for the whole host), Port the container port
// its router sends it to, CertResolver whether the local Traefik obtains its
// certificate itself, Public whether its public URL is probed too.
type RouteHost struct {
	CertResolver bool   `json:"certResolver"`
	Host         string `json:"host"`
	Path         string `json:"path"`
	Port         int    `json:"port"`
	Public       bool   `json:"public"`
}

// Route check outcomes: the route answers; it answers but its certificate
// isn't issued yet; Traefik or the edge answered with its own error or its
// default certificate; nothing answered at all; something's off that can't
// be settled from here.
const (
	RouteOK          = "ok"
	RoutePending     = "pending"
	RouteBroken      = "broken"
	RouteUnreachable = "unreachable"
	RouteWarning     = "warning"
)

// ErrorPageHeader marks a response from Homerun's own error pages, set by the
// app on every page it serves for Traefik.
const ErrorPageHeader = "X-Homerun-Error-Page"

const traefikDefaultCertificate = "TRAEFIK DEFAULT CERT"

// RouteResult is the verdict on one probe. Status is the HTTP status when
// something answered, ErrorPage whether that answer was Homerun's error page.
type RouteResult struct {
	Detail    string
	ErrorPage bool
	Outcome   string
	Status    int
}

// RouteTiming bounds the route check: one probe's timeout, how long to keep
// retrying a route that isn't right yet (Traefik takes a moment to pick up a
// new router), and the pause between tries.
type RouteTiming struct {
	Attempt  time.Duration
	Interval time.Duration
	Window   time.Duration
}

// DefaultRouteTiming is the route check's timing in a real deploy.
var DefaultRouteTiming = RouteTiming{Attempt: 5 * time.Second, Interval: 2 * time.Second, Window: 30 * time.Second}

// RouteProbe is one request to judge. Addr is the address to dial instead of
// the hostname's own (the local Traefik), Public judges the certificate the
// way a visitor's browser would against Roots (nil for the system's), and
// ErrorPages says a missing router lands on Homerun's catch-all page.
type RouteProbe struct {
	Addr       string
	ErrorPages bool
	Public     bool
	Roots      *x509.CertPool
	Target     RouteHost
}

// TraefikError says why an answer is Traefik's own error rather than the
// app's, or "" when it's the app's (whatever its status). Traefik answers a
// request no router claims with a plain "404 page not found" (or, with
// Homerun's error pages published, its catch-all page), and one it couldn't
// hand to the container with a plain "Bad Gateway" or "Gateway Timeout" (or
// the matching error page). With the error pages published, a plain 404 can
// only be the app's own. Cloudflare's own 5xx pages count as the edge's.
func TraefikError(status int, header http.Header, body []byte, errorPages bool) string {
	marker := header.Get(ErrorPageHeader) != ""
	text := strings.TrimSpace(string(body))
	switch {
	case status == http.StatusNotFound && marker:
		return "no Traefik router answers for it (Homerun's catch-all page, 404)"
	case status == http.StatusNotFound && !errorPages && text == "404 page not found":
		return "no Traefik router answers for it (404)"
	case status == http.StatusBadGateway && (marker || text == "Bad Gateway"):
		return "Traefik can't reach the container (502)"
	case status == http.StatusGatewayTimeout && (marker || text == "Gateway Timeout"):
		return "Traefik timed out waiting for the container (504)"
	case strings.EqualFold(header.Get("Server"), "cloudflare") && (status == http.StatusBadGateway || status == http.StatusGatewayTimeout || (status >= 520 && status <= 530)):
		return fmt.Sprintf("Cloudflare can't reach this server (%d)", status)
	}
	return ""
}

// Certificate verdicts.
const (
	certValid          = "valid"
	certTraefikDefault = "traefik-default"
	certWrongHost      = "wrong-host"
	certUntrusted      = "untrusted"
)

// judgeCertificate classifies the certificate a handshake presented for
// host: Traefik's self-signed default (no certificate for this host yet), a
// trusted one that doesn't cover host (an edge's own default certificate),
// one that doesn't chain to roots, or a valid one.
func judgeCertificate(state tls.ConnectionState, host string, roots *x509.CertPool) (string, string) {
	if len(state.PeerCertificates) == 0 {
		return certUntrusted, "no certificate"
	}
	leaf := state.PeerCertificates[0]
	if leaf.Subject.CommonName == traefikDefaultCertificate {
		return certTraefikDefault, traefikDefaultCertificate
	}
	intermediates := x509.NewCertPool()
	for _, certificate := range state.PeerCertificates[1:] {
		intermediates.AddCert(certificate)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Intermediates: intermediates, Roots: roots}); err != nil {
		return certUntrusted, err.Error()
	}
	if err := leaf.VerifyHostname(host); err != nil {
		return certWrongHost, "a certificate for " + strings.Join(leaf.DNSNames, ", ")
	}
	return certValid, ""
}

// ProbeRoute sends one GET to https://host/path, through probe.Addr when set,
// and judges the answer: Traefik's or the edge's own error, its certificate,
// or a route that answers. Redirects aren't followed: a redirect is an answer.
func ProbeRoute(ctx context.Context, probe RouteProbe, timeout time.Duration) RouteResult {
	var certificate, certificateDetail string
	dialer := &net.Dialer{Timeout: timeout}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if probe.Addr != "" {
				addr = probe.Addr
			}
			return dialer.DialContext(ctx, network, addr)
		},
		DisableKeepAlives: true,
		TLSClientConfig: &tls.Config{
			InsecureSkipVerify: true, //nolint:gosec // judged by hand in VerifyConnection, a route check must see the certificate it refuses
			ServerName:         probe.Target.Host,
			VerifyConnection: func(state tls.ConnectionState) error {
				certificate, certificateDetail = judgeCertificate(state, probe.Target.Host, probe.Roots)
				return nil
			},
		},
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       timeout,
		Transport:     transport,
	}
	path := probe.Target.Path
	if path == "" {
		path = "/"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://"+probe.Target.Host+path, nil)
	if err != nil {
		return RouteResult{Detail: err.Error(), Outcome: RouteUnreachable}
	}
	request.Header.Set("User-Agent", "Homerun route check")
	response, err := client.Do(request)
	if err != nil {
		return RouteResult{Detail: err.Error(), Outcome: RouteUnreachable}
	}
	defer func() { _ = response.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(response.Body, 512))
	result := RouteResult{
		ErrorPage: response.Header.Get(ErrorPageHeader) != "",
		Outcome:   RouteOK,
		Status:    response.StatusCode,
	}
	if reason := TraefikError(response.StatusCode, response.Header, body, probe.ErrorPages); reason != "" {
		result.Outcome, result.Detail = RouteBroken, reason
		return result
	}
	switch {
	case probe.Public && certificate == certWrongHost:
		result.Outcome, result.Detail = RouteBroken, "the edge answers with its default certificate ("+certificateDetail+"), not one for this hostname"
	case (probe.Public || probe.Target.CertResolver) && certificate == certTraefikDefault:
		result.Outcome, result.Detail = RoutePending, "its certificate isn't issued yet (Traefik still serves its default one)"
	case probe.Public && certificate == certUntrusted:
		result.Outcome, result.Detail = RoutePending, "its certificate isn't trusted yet: "+certificateDetail
	}
	return result
}

// WaitForRoute probes until the route answers or timing.Window runs out, and
// returns the last verdict: a router Traefik hasn't picked up yet, or a
// certificate still being issued, gets the whole window.
func WaitForRoute(ctx context.Context, probe RouteProbe, timing RouteTiming) RouteResult {
	deadline := time.Now().Add(timing.Window)
	for {
		result := ProbeRoute(ctx, probe, timing.Attempt)
		if result.Outcome == RouteOK || time.Now().Add(timing.Interval).After(deadline) {
			return result
		}
		select {
		case <-ctx.Done():
			return result
		case <-time.After(timing.Interval):
		}
	}
}

// EntrypointPort is the port Traefik's entrypoint name listens on, read from
// its --entrypoints.<name>.address flag, or 80 for "web" and 443 otherwise
// when the flags don't say.
func EntrypointPort(args []string, name string) int {
	prefix := "--entrypoints." + strings.ToLower(name) + ".address="
	for _, arg := range args {
		if !strings.HasPrefix(strings.ToLower(arg), prefix) {
			continue
		}
		address := arg[len(prefix):]
		address = strings.TrimSuffix(strings.TrimSuffix(address, "/tcp"), "/udp")
		if port, err := strconv.Atoi(address[strings.LastIndex(address, ":")+1:]); err == nil {
			return port
		}
	}
	if strings.EqualFold(name, "web") {
		return 80
	}
	return 443
}

// field walks a decoded inspect answer down keys, nil when one is missing.
func field(value any, keys ...string) any {
	for _, key := range keys {
		object, ok := value.(map[string]any)
		if !ok {
			return nil
		}
		value = object[key]
	}
	return value
}

// stringField is field's string, "" when it isn't one.
func stringField(value any, keys ...string) string {
	text, _ := field(value, keys...).(string)
	return text
}

// isTraefikImage reports whether a container's image is Traefik, whatever
// its registry or tag.
func isTraefikImage(image string) bool {
	name := image
	if at := strings.Index(name, "@"); at >= 0 {
		name = name[:at]
	}
	if slash := strings.LastIndex(name, "/"); slash >= 0 {
		name = name[slash+1:]
	}
	if colon := strings.Index(name, ":"); colon >= 0 {
		name = name[:colon]
	}
	return name == "traefik"
}

// traefikAddress is where this worker reaches the local Traefik's entrypoint:
// its address on the shared network, else the port it publishes on this
// host's loopback (a worker running outside Docker). Errors when there's no
// Traefik container or neither address answers.
func (r *run) traefikAddress(ctx context.Context, entrypoint string) (string, error) {
	containers, err := r.docker.ListContainers(ctx, false, "")
	if err != nil {
		return "", err
	}
	for _, container := range containers {
		if !isTraefikImage(container.Image) {
			continue
		}
		inspected, err := r.docker.InspectRaw(ctx, container.ID)
		if err != nil {
			return "", err
		}
		var args []string
		if raw, ok := field(inspected, "Args").([]any); ok {
			for _, arg := range raw {
				if text, ok := arg.(string); ok {
					args = append(args, text)
				}
			}
		}
		port := EntrypointPort(args, entrypoint)
		var candidates []string
		if ip := stringField(inspected, "NetworkSettings", "Networks", r.spec.Network, "IPAddress"); ip != "" {
			candidates = append(candidates, net.JoinHostPort(ip, strconv.Itoa(port)))
		}
		if bindings, ok := field(inspected, "NetworkSettings", "Ports", strconv.Itoa(port)+"/tcp").([]any); ok && len(bindings) > 0 {
			if hostPort := stringField(bindings[0], "HostPort"); hostPort != "" {
				candidates = append(candidates, net.JoinHostPort("127.0.0.1", hostPort))
			}
		}
		dialer := &net.Dialer{Timeout: 2 * time.Second}
		for _, candidate := range candidates {
			if conn, err := dialer.DialContext(ctx, "tcp", candidate); err == nil {
				_ = conn.Close()
				return candidate, nil
			}
		}
		return "", fmt.Errorf("its %s entrypoint (port %d) doesn't answer from here", entrypoint, port)
	}
	return "", errors.New("no Traefik container is running")
}

// ContainerAnswer is what the new container said when asked directly on the
// shared network. Asked is false when it couldn't be: a swarm service, no
// address, or one this worker doesn't reach in time. Refused is a refused
// connection, Connected an opened one, and Status the HTTP status it
// answered (0 for no HTTP answer).
type ContainerAnswer struct {
	Asked     bool
	Connected bool
	Refused   bool
	Status    int
}

// GatewayVerdict settles a 502 or 504 through Traefik with what the container
// answered directly: the same status is the app's own; another HTTP answer,
// or a refused connection, is a route Traefik can't hand over; a connection
// with no HTTP answer is a service that doesn't speak HTTP; and no way to ask
// leaves a warning rather than a failure.
func GatewayVerdict(gateway RouteResult, answer ContainerAnswer) RouteResult {
	switch {
	case answer.Status == gateway.Status:
		return RouteResult{Detail: "the app answers that itself", Outcome: RouteOK, Status: gateway.Status}
	case answer.Status > 0:
		gateway.Detail += fmt.Sprintf(", while the container itself answers %d", answer.Status)
		return gateway
	case answer.Refused:
		gateway.Detail += ", and nothing listens on the container's network address (an app bound to 127.0.0.1?)"
		return gateway
	case answer.Connected:
		return RouteResult{Detail: "it doesn't answer HTTP, so its route can't be checked", Outcome: RouteWarning, Status: gateway.Status}
	default:
		return RouteResult{Detail: gateway.Detail + ", and the container couldn't be asked directly", Outcome: RouteWarning, Status: gateway.Status}
	}
}

// askContainer asks the new container for host's path directly on the shared
// network, the way Traefik would.
func (r *run) askContainer(ctx context.Context, host RouteHost) ContainerAnswer {
	if r.result.ContainerID == "" {
		return ContainerAnswer{}
	}
	inspected, err := r.docker.InspectRaw(ctx, r.result.ContainerID)
	if err != nil {
		return ContainerAnswer{}
	}
	ip := stringField(inspected, "NetworkSettings", "Networks", r.spec.Network, "IPAddress")
	if ip == "" {
		return ContainerAnswer{}
	}
	path := host.Path
	if path == "" {
		path = "/"
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+net.JoinHostPort(ip, strconv.Itoa(host.Port))+path, nil)
	if err != nil {
		return ContainerAnswer{}
	}
	request.Host = host.Host
	answer := ContainerAnswer{Asked: true}
	dialer := &net.Dialer{Timeout: DefaultRouteTiming.Attempt}
	transport := &http.Transport{
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			conn, err := dialer.DialContext(ctx, network, addr)
			answer.Connected = err == nil
			answer.Refused = errors.Is(err, syscall.ECONNREFUSED)
			return conn, err
		},
		DisableKeepAlives: true,
	}
	defer transport.CloseIdleConnections()
	client := &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       DefaultRouteTiming.Attempt,
		Transport:     transport,
	}
	response, err := client.Do(request)
	if err != nil {
		answer.Asked = answer.Connected || answer.Refused
		return answer
	}
	_ = response.Body.Close()
	answer.Status = response.StatusCode
	return answer
}

// checkHost probes one hostname through the local Traefik (when addr is set)
// and publicly (when it's Public), returning the deploy log lines and the
// reason the route is broken, "" when it isn't. A gateway error locally is
// settled by asking the container directly (GatewayVerdict); a plain 404
// publicly is the app's own when the local Traefik got one too.
func (r *run) checkHost(ctx context.Context, addr string, host RouteHost, timing RouteTiming) ([]string, string) {
	label := host.Host + host.Path
	var lines []string
	local := RouteResult{}
	if addr != "" {
		local = WaitForRoute(ctx, RouteProbe{Addr: addr, ErrorPages: r.spec.Route.ErrorPages, Target: host}, timing)
		if local.Outcome == RouteBroken && local.Status != http.StatusNotFound {
			local = GatewayVerdict(local, r.askContainer(ctx, host))
		}
		switch local.Outcome {
		case RouteOK:
			lines = append(lines, fmt.Sprintf("Route check: %s answers through Traefik (%d).", label, local.Status))
		case RouteWarning:
			lines = append(lines, fmt.Sprintf("Warning: %s through Traefik: %s.", label, local.Detail))
		case RoutePending:
			lines = append(lines, fmt.Sprintf("Warning: %s answers through Traefik (%d), but %s.", label, local.Status, local.Detail))
		case RouteBroken:
			return lines, fmt.Sprintf("%s: %s", label, local.Detail)
		default:
			lines = append(lines, fmt.Sprintf("Warning: couldn't reach %s through Traefik: %s", label, local.Detail))
		}
	}
	if !host.Public {
		return lines, ""
	}
	public := WaitForRoute(ctx, RouteProbe{Public: true, Target: host}, timing)
	if public.Outcome == RouteBroken && public.Status == http.StatusNotFound && !public.ErrorPage && local.Status == http.StatusNotFound {
		public.Outcome, public.Detail = RouteOK, ""
	}
	switch public.Outcome {
	case RouteOK:
		lines = append(lines, fmt.Sprintf("Route check: https://%s answers publicly (%d).", label, public.Status))
	case RoutePending:
		lines = append(lines, fmt.Sprintf("Warning: https://%s answers publicly (%d), but %s.", label, public.Status, public.Detail))
	case RouteBroken:
		return lines, fmt.Sprintf("https://%s: %s", label, public.Detail)
	default:
		lines = append(lines, fmt.Sprintf("Warning: https://%s doesn't answer publicly yet (DNS may still be propagating): %s", label, public.Detail))
	}
	return lines, ""
}

// checkRoutes probes every routed hostname once the workload runs, all at
// once, and fails the deploy with FailureRouteFailed when Traefik or the edge
// answers one with its own error or the edge's default certificate. A local
// Traefik the worker can't reach skips the local half with a warning.
func (r *run) checkRoutes(ctx context.Context) error {
	route := r.spec.Route
	if route == nil || len(route.Hosts) == 0 {
		return nil
	}
	addr, err := r.traefikAddress(ctx, route.Entrypoint)
	if err != nil {
		r.progress.line("Warning: route check through Traefik skipped: " + err.Error() + ".")
	}
	lines := make([][]string, len(route.Hosts))
	failures := make([]string, len(route.Hosts))
	var group sync.WaitGroup
	for index, host := range route.Hosts {
		group.Go(func() {
			lines[index], failures[index] = r.checkHost(ctx, addr, host, DefaultRouteTiming)
		})
	}
	group.Wait()
	var broken []string
	for index := range route.Hosts {
		for _, line := range lines[index] {
			r.progress.line(line)
		}
		if failures[index] != "" {
			broken = append(broken, failures[index])
		}
	}
	if len(broken) > 0 {
		return &kindError{kind: FailureRouteFailed, err: fmt.Errorf("the container runs, but its route doesn't answer: %s", strings.Join(broken, "; "))}
	}
	return nil
}
