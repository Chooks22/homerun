package deploy_test

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/orochibraru/homerun/internal/jobs/deploy"
)

func TestTraefikError(t *testing.T) {
	marker := http.Header{deploy.ErrorPageHeader: {"404"}}
	cloudflare := http.Header{"Server": {"cloudflare"}}
	cases := []struct {
		name       string
		status     int
		header     http.Header
		body       string
		errorPages bool
		broken     bool
	}{
		{"no router", 404, http.Header{}, "404 page not found\n", false, true},
		{"app's plain 404 behind the catch-all", 404, http.Header{}, "404 page not found\n", true, false},
		{"catch-all page", 404, marker, "<html>", true, true},
		{"app's own 404 page", 404, http.Header{}, "<html>Not found</html>", false, false},
		{"traefik bad gateway", 502, http.Header{}, "Bad Gateway", false, true},
		{"error page bad gateway", 502, http.Header{deploy.ErrorPageHeader: {"502"}}, "<html>", true, true},
		{"app's own 502 page", 502, http.Header{}, "<html>upstream down</html>", false, false},
		{"traefik gateway timeout", 504, http.Header{}, "Gateway Timeout", false, true},
		{"app's 503", 503, http.Header{}, "Service Unavailable", false, false},
		{"app's 500", 500, http.Header{}, "boom", false, false},
		{"cloudflare origin unreachable", 521, cloudflare, "<html>", false, true},
		{"cloudflare passing the app's 404", 404, cloudflare, "<html>", false, false},
		{"ok", 200, http.Header{}, "hello", false, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := deploy.TraefikError(tc.status, tc.header, []byte(tc.body), tc.errorPages)
			if (got != "") != tc.broken {
				t.Fatalf("TraefikError = %q, want broken=%v", got, tc.broken)
			}
		})
	}
}

func TestEntrypointPort(t *testing.T) {
	args := []string{"--providers.docker=true", "--entrypoints.web.address=:8080", "--EntryPoints.websecure.address=0.0.0.0:8443/tcp"}
	if got := deploy.EntrypointPort(args, "web"); got != 8080 {
		t.Fatalf("web = %d", got)
	}
	if got := deploy.EntrypointPort(args, "websecure"); got != 8443 {
		t.Fatalf("websecure = %d", got)
	}
	if got := deploy.EntrypointPort(nil, "web"); got != 80 {
		t.Fatalf("web default = %d", got)
	}
	if got := deploy.EntrypointPort(nil, "websecure"); got != 443 {
		t.Fatalf("websecure default = %d", got)
	}
}

func routeServer(t *testing.T, handler http.HandlerFunc, certificate *tls.Certificate) *httptest.Server {
	t.Helper()
	server := httptest.NewUnstartedServer(handler)
	if certificate != nil {
		server.TLS = &tls.Config{Certificates: []tls.Certificate{*certificate}}
	}
	server.StartTLS()
	t.Cleanup(server.Close)
	return server
}

func traefikDefaultCertificate(t *testing.T) *tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		DNSNames:     []string{"traefik.default"},
		NotAfter:     time.Now().Add(time.Hour),
		NotBefore:    time.Now().Add(-time.Hour),
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "TRAEFIK DEFAULT CERT"},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	return &tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

func probe(server *httptest.Server, host string) deploy.RouteProbe {
	return deploy.RouteProbe{
		Addr:   strings.TrimPrefix(server.URL, "https://"),
		Target: deploy.RouteHost{Host: host, Port: 80},
	}
}

func TestProbeRouteThroughTraefik(t *testing.T) {
	var gotHost, gotPath string
	server := routeServer(t, func(w http.ResponseWriter, r *http.Request) {
		gotHost, gotPath = r.Host, r.URL.Path
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		w.WriteHeader(http.StatusInternalServerError)
	}, nil)

	request := probe(server, "app.example.com")
	request.Target.Path = "/api"
	result := deploy.ProbeRoute(context.Background(), request, time.Second)
	if result.Outcome != deploy.RouteOK || result.Status != 500 {
		t.Fatalf("an app's own 500 = %+v, want ok", result)
	}
	if gotHost != "app.example.com" || gotPath != "/api" {
		t.Fatalf("sent Host %q path %q", gotHost, gotPath)
	}

	request.Target.Path = "/missing"
	if result := deploy.ProbeRoute(context.Background(), request, time.Second); result.Outcome != deploy.RouteBroken {
		t.Fatalf("Traefik's plain 404 = %+v, want broken", result)
	}
	request.ErrorPages = true
	if result := deploy.ProbeRoute(context.Background(), request, time.Second); result.Outcome != deploy.RouteOK {
		t.Fatalf("a plain 404 behind the error pages = %+v, want the app's own", result)
	}
}

func TestProbeRouteCertificates(t *testing.T) {
	ok := func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "hello") }

	pending := routeServer(t, ok, traefikDefaultCertificate(t))
	request := probe(pending, "app.example.com")
	if result := deploy.ProbeRoute(context.Background(), request, time.Second); result.Outcome != deploy.RouteOK {
		t.Fatalf("default certificate without a resolver = %+v, want ok", result)
	}
	request.Target.CertResolver = true
	if result := deploy.ProbeRoute(context.Background(), request, time.Second); result.Outcome != deploy.RoutePending {
		t.Fatalf("default certificate with a resolver = %+v, want pending", result)
	}

	edge := routeServer(t, ok, nil)
	roots := x509.NewCertPool()
	roots.AddCert(edge.Certificate())
	public := probe(edge, "example.com")
	public.Public, public.Roots = true, roots
	if result := deploy.ProbeRoute(context.Background(), public, time.Second); result.Outcome != deploy.RouteOK {
		t.Fatalf("a trusted certificate for the host = %+v, want ok", result)
	}
	public.Target.Host = "app.other.test"
	if result := deploy.ProbeRoute(context.Background(), public, time.Second); result.Outcome != deploy.RouteBroken {
		t.Fatalf("a trusted certificate for another host = %+v, want broken", result)
	}
	public.Target.Host, public.Roots = "example.com", nil
	if result := deploy.ProbeRoute(context.Background(), public, time.Second); result.Outcome != deploy.RoutePending {
		t.Fatalf("an untrusted certificate = %+v, want pending", result)
	}
}

func TestProbeRouteUnreachable(t *testing.T) {
	request := deploy.RouteProbe{Addr: "127.0.0.1:1", Target: deploy.RouteHost{Host: "app.example.com"}}
	if result := deploy.ProbeRoute(context.Background(), request, time.Second); result.Outcome != deploy.RouteUnreachable {
		t.Fatalf("closed port = %+v, want unreachable", result)
	}
}

func TestWaitForRoute(t *testing.T) {
	var calls atomic.Int32
	server := routeServer(t, func(w http.ResponseWriter, r *http.Request) {
		if calls.Add(1) < 3 {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, "hello")
	}, nil)
	timing := deploy.RouteTiming{Attempt: time.Second, Interval: 10 * time.Millisecond, Window: 5 * time.Second}

	result := deploy.WaitForRoute(context.Background(), probe(server, "app.example.com"), timing)
	if result.Outcome != deploy.RouteOK || calls.Load() != 3 {
		t.Fatalf("a router appearing on the third try = %+v after %d calls", result, calls.Load())
	}

	missing := routeServer(t, http.NotFound, nil)
	timing.Window = 100 * time.Millisecond
	if result := deploy.WaitForRoute(context.Background(), probe(missing, "app.example.com"), timing); result.Outcome != deploy.RouteBroken {
		t.Fatalf("a router that never appears = %+v, want broken", result)
	}
}

func TestGatewayVerdict(t *testing.T) {
	gateway := deploy.RouteResult{Detail: "Traefik can't reach the container (502)", Outcome: deploy.RouteBroken, Status: 502}
	cases := []struct {
		name   string
		answer deploy.ContainerAnswer
		want   string
	}{
		{"the app's own 502", deploy.ContainerAnswer{Asked: true, Connected: true, Status: 502}, deploy.RouteOK},
		{"a container that works directly", deploy.ContainerAnswer{Asked: true, Connected: true, Status: 200}, deploy.RouteBroken},
		{"nothing listening on its address", deploy.ContainerAnswer{Asked: true, Refused: true}, deploy.RouteBroken},
		{"a service that doesn't speak HTTP", deploy.ContainerAnswer{Asked: true, Connected: true}, deploy.RouteWarning},
		{"a container that can't be asked", deploy.ContainerAnswer{}, deploy.RouteWarning},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := deploy.GatewayVerdict(gateway, tc.answer); got.Outcome != tc.want {
				t.Fatalf("GatewayVerdict = %+v, want %s", got, tc.want)
			}
		})
	}
}
