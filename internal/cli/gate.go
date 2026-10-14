package cli

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/homerun"
)

const gateCookieName = "homerun_app_session"

// GateCookie is the session cookie the login wall sets on an app's host.
type GateCookie struct {
	Expires  float64 `json:"expires"`
	Domain   string  `json:"domain"`
	HTTPOnly bool    `json:"httpOnly"`
	Name     string  `json:"name"`
	Path     string  `json:"path"`
	SameSite string  `json:"sameSite"`
	Secure   bool    `json:"secure"`
	Value    string  `json:"value"`
}

// GateStorageState is a Playwright storageState file holding the login wall's session cookie.
type GateStorageState struct {
	Cookies []GateCookie `json:"cookies"`
	Origins []any        `json:"origins"`
}

func gateClient() *http.Client {
	return &http.Client{
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
		Timeout:       30 * time.Second,
	}
}

type gateResponse struct {
	cookies    []*http.Cookie
	location   string
	requestURL *url.URL
	status     int
}

func gateRequest(client *http.Client, target string, header map[string]string) (gateResponse, error) {
	request, err := http.NewRequest(http.MethodGet, target, nil)
	if err != nil {
		return gateResponse{}, err
	}
	for name, value := range header {
		request.Header.Set(name, value)
	}
	response, err := client.Do(request)
	if err != nil {
		return gateResponse{}, err
	}
	_ = response.Body.Close()
	return gateResponse{
		cookies:    response.Cookies(),
		location:   response.Header.Get("Location"),
		requestURL: request.URL,
		status:     response.StatusCode,
	}, nil
}

func isRedirect(response gateResponse) bool {
	return response.status >= 300 && response.status < 400
}

func redirectTarget(response gateResponse) (*url.URL, error) {
	location, err := response.requestURL.Parse(response.location)
	if err != nil || response.location == "" {
		return nil, errors.New("the redirect has no usable Location")
	}
	return location, nil
}

func sameOrigin(left, right *url.URL) bool {
	return strings.EqualFold(left.Scheme, right.Scheme) && strings.EqualFold(left.Host, right.Host)
}

// GateSession signs the API key's owner in through an app's login wall
// without a browser and returns the app's session cookie. The key is only
// ever sent to the Homerun server's own origin: the wall's challenge must
// point there and the callback it answers with must point back at the app's
// host, or nothing secret is sent and the handshake aborts.
func GateSession(config homerun.Config, appURL string) (*http.Cookie, *url.URL, error) {
	app, err := url.Parse(appURL)
	if err != nil || (app.Scheme != "http" && app.Scheme != "https") || app.Host == "" {
		return nil, nil, fmt.Errorf("%q isn't a valid http(s) URL", appURL)
	}
	dashboard, err := url.Parse(config.BaseURL)
	if err != nil || dashboard.Host == "" {
		return nil, nil, fmt.Errorf("%q isn't a valid Homerun server URL", config.BaseURL)
	}
	client := gateClient()

	challenge, err := gateRequest(client, app.String(), map[string]string{"Accept": "text/html", "Sec-Fetch-Mode": "navigate"})
	if err != nil {
		return nil, nil, fmt.Errorf("couldn't reach %s: %w", app.Host, err)
	}
	if !isRedirect(challenge) {
		if challenge.status == http.StatusOK {
			return nil, nil, fmt.Errorf("no login wall in front of %s: it answered 200 without a session", app)
		}
		return nil, nil, fmt.Errorf("%s answered %d instead of the login wall's redirect", app, challenge.status)
	}
	authorize, err := redirectTarget(challenge)
	if err != nil {
		return nil, nil, err
	}
	if !sameOrigin(authorize, dashboard) {
		return nil, nil, fmt.Errorf(
			"%s redirects to %s://%s, which isn't your Homerun server (%s://%s): refusing to send the API key there",
			app.Host, authorize.Scheme, authorize.Host, dashboard.Scheme, dashboard.Host,
		)
	}

	grant, err := gateRequest(client, authorize.String(), map[string]string{"Accept": "text/html", "x-api-key": config.APIKey})
	if err != nil {
		return nil, nil, fmt.Errorf("couldn't reach %s: %w", dashboard.Host, err)
	}
	switch {
	case grant.status == http.StatusUnauthorized || grant.status == http.StatusForbidden:
		return nil, nil, fmt.Errorf("the Homerun server rejected the API key (%d): it is invalid, expired or disabled", grant.status)
	case !isRedirect(grant):
		return nil, nil, fmt.Errorf(
			"the Homerun server refused the session (%d): the key's owner probably isn't allowed on %s",
			grant.status, app.Host,
		)
	}
	callback, err := redirectTarget(grant)
	if err != nil {
		return nil, nil, err
	}
	if !strings.EqualFold(callback.Host, app.Host) {
		return nil, nil, fmt.Errorf("the Homerun server sent the callback to %s instead of %s: aborting", callback.Host, app.Host)
	}

	exchange, err := gateRequest(client, callback.String(), nil)
	if err != nil {
		return nil, nil, fmt.Errorf("couldn't reach %s: %w", app.Host, err)
	}
	for _, cookie := range exchange.cookies {
		if cookie.Name == gateCookieName && cookie.Value != "" {
			return cookie, app, nil
		}
	}
	return nil, nil, fmt.Errorf("%s didn't set a %s cookie (answered %d)", app.Host, gateCookieName, exchange.status)
}

// GateStorageStateFor builds the Playwright storageState for a session cookie of an app.
func GateStorageStateFor(cookie *http.Cookie, app *url.URL, now time.Time) GateStorageState {
	expires := float64(-1)
	switch {
	case cookie.MaxAge > 0:
		expires = float64(now.Unix() + int64(cookie.MaxAge))
	case !cookie.Expires.IsZero():
		expires = float64(cookie.Expires.Unix())
	}
	return GateStorageState{
		Cookies: []GateCookie{{
			Domain:   app.Hostname(),
			Expires:  expires,
			HTTPOnly: true,
			Name:     cookie.Name,
			Path:     "/",
			SameSite: "Lax",
			Secure:   cookie.Secure,
			Value:    cookie.Value,
		}},
		Origins: []any{},
	}
}

// GateSessionRun performs the handshake, then prints the cookie as a Cookie
// header value on stdout, or with a path writes a Playwright storageState file
// (mode 0600) and says where on stderr.
func GateSessionRun(config homerun.Config, appURL, playwrightPath string) {
	cookie, app, err := GateSession(config, appURL)
	if err != nil {
		Fail(err.Error())
		return
	}
	if playwrightPath == "" {
		fmt.Printf("%s=%s\n", cookie.Name, cookie.Value)
		return
	}
	encoded, err := json.MarshalIndent(GateStorageStateFor(cookie, app, time.Now()), "", "  ")
	if err != nil {
		Fail(err.Error())
		return
	}
	if err := os.WriteFile(playwrightPath, append(encoded, '\n'), 0o600); err != nil {
		Fail(err.Error())
		return
	}
	if err := os.Chmod(playwrightPath, 0o600); err != nil {
		Fail(err.Error())
		return
	}
	fmt.Fprintf(os.Stderr, "Wrote the Playwright storage state to %s\n", playwrightPath)
}

var gateCommands = []Command{
	{
		Args:    "<url>",
		Name:    "gate session",
		Summary: "sign in through an app's login wall headlessly with your API key and print its session cookie",
		Setup: func(set *flag.FlagSet) Runner {
			playwright := set.String("playwright", "", "write a Playwright storageState JSON to this `file` instead of printing the cookie")
			return func(env Env, args []string) {
				config := homerun.ResolveConfig(env.Global.BaseURL, env.Global.APIKey)
				if config == nil {
					Fail("Not logged in. Run `homerun login` to get started.")
					return
				}
				GateSessionRun(*config, args[0], *playwright)
			}
		},
	},
}
