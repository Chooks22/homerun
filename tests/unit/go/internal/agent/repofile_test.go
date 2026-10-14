package agent_test

import (
	"reflect"
	"testing"

	"github.com/orochibraru/homerun/internal/agent"
)

func TestRepoMetadataStepsForABranch(t *testing.T) {
	got := agent.RepoMetadataSteps("https://example.com/repo.git", "main", "/workspace/repo")
	want := [][]string{{
		"clone", "--depth", "1", "--filter=blob:none", "--no-checkout",
		"--branch", "main", "--single-branch", "https://example.com/repo.git", "/workspace/repo",
	}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

func TestRepoMetadataStepsForACommit(t *testing.T) {
	sha := "0123456789ABCDEF0123456789abcdef01234567"
	got := agent.RepoMetadataSteps("https://example.com/repo.git", sha, "/workspace/repo")
	if len(got) != 4 {
		t.Fatalf("expected 4 steps, got %v", got)
	}
	if got[2][len(got[2])-1] != "0123456789abcdef0123456789abcdef01234567" {
		t.Fatalf("the fetch should pin the lowercased sha, got %v", got[2])
	}
	if !reflect.DeepEqual(got[3], []string{"-C", "/workspace/repo", "update-ref", "HEAD", "FETCH_HEAD"}) {
		t.Fatalf("HEAD should point at the fetched commit, got %v", got[3])
	}
}

func TestValidRepoPath(t *testing.T) {
	for path, want := range map[string]bool{
		".homerun.json":          true,
		"apps/web/.homerun.yaml": true,
		"":                       false,
		"/etc/passwd":            false,
		"../secret":              false,
		"apps/../../x":           false,
		"-c":                     false,
		"HEAD:other":             false,
	} {
		if got := agent.ValidRepoPath(path); got != want {
			t.Errorf("ValidRepoPath(%q) = %v, want %v", path, got, want)
		}
	}
}
