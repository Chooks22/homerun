package cli_test

import (
	"errors"
	"testing"

	"github.com/orochibraru/homerun/internal/cli"
	"github.com/orochibraru/homerun/internal/homerun"
)

func TestTakeOverHint(t *testing.T) {
	cases := []struct {
		err  error
		name string
		want bool
	}{
		{name: "takeable conflict", err: &homerun.APIError{Status: 409, Body: []byte(`{"error":"x","canTakeOver":true}`)}, want: true},
		{name: "workstation conflict", err: &homerun.APIError{Status: 409, Body: []byte(`{"error":"x","canTakeOver":false}`)}},
		{name: "slug conflict", err: &homerun.APIError{Status: 409, Body: []byte(`{"error":"x"}`)}},
		{name: "not a conflict", err: &homerun.APIError{Status: 400, Body: []byte(`{"canTakeOver":true}`)}},
		{name: "not JSON", err: &homerun.APIError{Status: 409, Body: []byte(`<html>`)}},
		{name: "transport error", err: errors.New("connection refused")},
	}
	for _, testCase := range cases {
		got := cli.TakeOverHint(testCase.err) != ""
		if got != testCase.want {
			t.Errorf("%s: want a hint %v, got %v", testCase.name, testCase.want, got)
		}
	}
}
