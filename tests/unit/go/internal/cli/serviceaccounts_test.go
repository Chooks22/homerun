package cli_test

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
)

func TestServiceAccountsKeysCreateSendsExpiry(t *testing.T) {
	cases := map[string]struct {
		args     []string
		expected string
	}{
		"default":    {[]string{"service-accounts", "keys", "create", "acc1"}, `{}`},
		"named days": {[]string{"service-accounts", "keys", "create", "acc1", "--name", "ci", "--expires-in-days", "30"}, `{"expiresInDays":30,"name":"ci"}`},
		"never":      {[]string{"service-accounts", "keys", "create", "acc1", "--never-expires"}, `{"expiresInDays":null}`},
	}
	for name, testCase := range cases {
		t.Run(name, func(t *testing.T) {
			client, seen := jsonAPI(t, `{"id":"k1","key":"secret","name":null,"expiresAt":null}`)
			out, failed := runCLI(t, func() {
				cli.Execute(cli.Env{Client: func() *cli.Client { return client }}, testCase.args)
			})
			if failed != "" {
				t.Fatalf("failed: %s", failed)
			}
			request := (*seen)[0]
			if request.Method != "POST" || request.Path != "/api/v1/service-accounts/acc1/keys" || request.Body != testCase.expected {
				t.Errorf("unexpected request %+v", request)
			}
			if !strings.Contains(out, `"key": "secret"`) {
				t.Errorf("the key should be printed, got %q", out)
			}
		})
	}
}

func TestServiceAccountsKeysCreateRejectsConflictingExpiry(t *testing.T) {
	client, _ := jsonAPI(t, `{}`)
	_, failed := runCLI(t, func() {
		cli.Execute(cli.Env{Client: func() *cli.Client { return client }},
			[]string{"service-accounts", "keys", "create", "acc1", "--never-expires", "--expires-in-days", "5"})
	})
	if !strings.Contains(failed, "can't be combined") {
		t.Errorf("expected a conflict error, got %q", failed)
	}
}

func TestServiceAccountsListAndRevoke(t *testing.T) {
	client, seen := jsonAPI(t, `[{"id":"a1","name":"ci","disabled":false,"permissions":{"services":"write","stacks":"read"},"createdAt":"2026-01-01"}]`)
	env := cli.Env{Client: func() *cli.Client { return client }}
	out, failed := runCLI(t, func() { cli.Execute(env, []string{"service-accounts", "list"}) })
	if failed != "" || !strings.Contains(out, "services=write,stacks=read") {
		t.Errorf("unexpected list output %q (%s)", out, failed)
	}
	_, failed = runCLI(t, func() { cli.Execute(env, []string{"service-accounts", "keys", "revoke", "a1", "k1"}) })
	last := (*seen)[len(*seen)-1]
	if failed != "" || last.Method != "DELETE" || last.Path != "/api/v1/service-accounts/a1/keys/k1" {
		t.Errorf("unexpected revoke request %+v (%s)", last, failed)
	}
}

func TestServiceAccountsCreateAndDelete(t *testing.T) {
	client, seen := jsonAPI(t, `{"id":"a1","name":"ci"}`)
	env := cli.Env{Client: func() *cli.Client { return client }}
	_, failed := runCLI(t, func() { cli.Execute(env, []string{"service-accounts", "create", "ci"}) })
	var body map[string]string
	if err := json.Unmarshal([]byte((*seen)[0].Body), &body); err != nil || failed != "" || body["name"] != "ci" {
		t.Errorf("unexpected create body %q (%s)", (*seen)[0].Body, failed)
	}
	_, failed = runCLI(t, func() { cli.Execute(env, []string{"service-accounts", "delete", "a1"}) })
	last := (*seen)[len(*seen)-1]
	if failed != "" || last.Method != http.MethodDelete || last.Path != "/api/v1/service-accounts/a1" {
		t.Errorf("unexpected delete request %+v (%s)", last, failed)
	}
}
