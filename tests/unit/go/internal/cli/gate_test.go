package cli_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
	"github.com/orochibraru/homerun/internal/homerun"
)

type gateServers struct {
	appKeyHeaders []string
	appURL        string
	dashboardURL  string
	mutex         sync.Mutex
}

func (servers *gateServers) recordKey(request *http.Request) {
	servers.mutex.Lock()
	defer servers.mutex.Unlock()
	for _, name := range []string{"X-Api-Key", "Authorization"} {
		if value := request.Header.Get(name); value != "" {
			servers.appKeyHeaders = append(servers.appKeyHeaders, name+"="+value)
		}
	}
}

func newGateServers(t *testing.T, challengeTarget func(servers *gateServers) string) (*gateServers, *[]string) {
	t.Helper()
	servers := &gateServers{}
	dashboardKeys := &[]string{}
	app := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		servers.recordKey(request)
		switch request.URL.Path {
		case "/__homerun_auth/callback":
			http.SetCookie(writer, &http.Cookie{HttpOnly: true, MaxAge: 3600, Name: "homerun_app_session", Path: "/", Secure: true, Value: "session-value"})
			http.Redirect(writer, request, "/", http.StatusFound)
		default:
			if request.Header.Get("Sec-Fetch-Mode") != "navigate" || request.Header.Get("Accept") != "text/html" {
				writer.WriteHeader(http.StatusBadRequest)
				return
			}
			http.Redirect(writer, request, challengeTarget(servers), http.StatusFound)
		}
	}))
	t.Cleanup(app.Close)
	dashboard := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		*dashboardKeys = append(*dashboardKeys, request.Header.Get("x-api-key"))
		if request.Header.Get("x-api-key") != "secret-key" {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		http.Redirect(writer, request, servers.appURL+"/__homerun_auth/callback?token=abc", http.StatusFound)
	}))
	t.Cleanup(dashboard.Close)
	servers.appURL, servers.dashboardURL = app.URL, dashboard.URL
	return servers, dashboardKeys
}

func TestGateSessionPrintsCookieAndNeverSendsKeyToApp(t *testing.T) {
	servers, dashboardKeys := newGateServers(t, func(servers *gateServers) string {
		return servers.dashboardURL + "/app-auth?rd=" + url.QueryEscape(servers.appURL)
	})
	config := homerun.Config{APIKey: "secret-key", BaseURL: servers.dashboardURL}

	out, failed := runCLI(t, func() { cli.GateSessionRun(config, servers.appURL+"/some/page", "") })
	if failed != "" {
		t.Fatalf("failed: %s", failed)
	}
	if out != "homerun_app_session=session-value\n" {
		t.Errorf("stdout should be the cookie alone, got %q", out)
	}
	if len(servers.appKeyHeaders) != 0 {
		t.Errorf("the app received credentials: %v", servers.appKeyHeaders)
	}
	if len(*dashboardKeys) != 1 || (*dashboardKeys)[0] != "secret-key" {
		t.Errorf("the dashboard should receive the key exactly once, got %v", *dashboardKeys)
	}
}

func TestGateSessionWritesPlaywrightStorageState(t *testing.T) {
	servers, _ := newGateServers(t, func(servers *gateServers) string {
		return servers.dashboardURL + "/app-auth?rd=" + url.QueryEscape(servers.appURL)
	})
	config := homerun.Config{APIKey: "secret-key", BaseURL: servers.dashboardURL}
	path := filepath.Join(t.TempDir(), "state.json")

	out, failed := runCLI(t, func() { cli.GateSessionRun(config, servers.appURL, path) })
	if failed != "" || out != "" {
		t.Fatalf("stdout should stay empty, got %q (%s)", out, failed)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("expected mode 0600, got %v", info.Mode().Perm())
	}
	body, _ := os.ReadFile(path)
	var state struct {
		Cookies []map[string]any `json:"cookies"`
		Origins []any            `json:"origins"`
	}
	if err := json.Unmarshal(body, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Cookies) != 1 || state.Origins == nil || len(state.Origins) != 0 {
		t.Fatalf("unexpected state %s", body)
	}
	cookie := state.Cookies[0]
	appHost := strings.Split(strings.TrimPrefix(servers.appURL, "http://"), ":")[0]
	expectations := map[string]any{
		"domain": appHost, "httpOnly": true, "name": "homerun_app_session", "path": "/",
		"sameSite": "Lax", "secure": true, "value": "session-value",
	}
	for key, expected := range expectations {
		if cookie[key] != expected {
			t.Errorf("cookie %s: expected %v, got %v", key, expected, cookie[key])
		}
	}
	if expires, _ := cookie["expires"].(float64); expires <= 0 {
		t.Errorf("expires should be a unix time from Max-Age, got %v", cookie["expires"])
	}
}

func TestGateSessionAbortsWhenChallengeLeavesTheServer(t *testing.T) {
	var strangerKeys []string
	stranger := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		strangerKeys = append(strangerKeys, request.Header.Get("x-api-key"))
	}))
	t.Cleanup(stranger.Close)
	servers, dashboardKeys := newGateServers(t, func(*gateServers) string { return stranger.URL + "/app-auth" })
	config := homerun.Config{APIKey: "secret-key", BaseURL: servers.dashboardURL}

	_, failed := runCLI(t, func() { cli.GateSessionRun(config, servers.appURL, "") })
	if !strings.Contains(failed, "refusing to send the API key") {
		t.Errorf("expected an abort, got %q", failed)
	}
	if len(strangerKeys) != 0 || len(*dashboardKeys) != 0 || len(servers.appKeyHeaders) != 0 {
		t.Errorf("the key leaked: stranger %v dashboard %v app %v", strangerKeys, *dashboardKeys, servers.appKeyHeaders)
	}
}

func TestGateSessionFailsClearly(t *testing.T) {
	t.Run("no wall", func(t *testing.T) {
		open := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(open.Close)
		_, failed := runCLI(t, func() {
			cli.GateSessionRun(homerun.Config{APIKey: "k", BaseURL: "http://127.0.0.1:1"}, open.URL, "")
		})
		if !strings.Contains(failed, "no login wall") {
			t.Errorf("got %q", failed)
		}
	})
	t.Run("bad key", func(t *testing.T) {
		servers, _ := newGateServers(t, func(servers *gateServers) string { return servers.dashboardURL + "/app-auth" })
		_, failed := runCLI(t, func() {
			cli.GateSessionRun(homerun.Config{APIKey: "wrong", BaseURL: servers.dashboardURL}, servers.appURL, "")
		})
		if !strings.Contains(failed, "rejected the API key") {
			t.Errorf("got %q", failed)
		}
	})
	t.Run("refused", func(t *testing.T) {
		denying := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusOK)
		}))
		t.Cleanup(denying.Close)
		challenging := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			http.Redirect(writer, request, denying.URL+"/app-auth", http.StatusFound)
		}))
		t.Cleanup(challenging.Close)
		_, failed := runCLI(t, func() {
			cli.GateSessionRun(homerun.Config{APIKey: "k", BaseURL: denying.URL}, challenging.URL, "")
		})
		if !strings.Contains(failed, "refused the session") {
			t.Errorf("got %q", failed)
		}
	})
}
