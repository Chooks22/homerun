package agent

import (
	"context"
	"errors"
	"strings"
)

// MaxRepoFileBytes is the largest file ReadRepoFile hands back.
const MaxRepoFileBytes = 256 * 1024

// RepoFile is one file read out of a repository at a ref. Path is empty when
// none of the paths asked for exists there.
type RepoFile struct {
	Commit  string `json:"commit"`
	Content string `json:"content"`
	Path    string `json:"path"`
}

// RepoMetadataSteps is the git argv lists that fetch ref's commit into repoDir
// with its tree but no file contents and no checkout: a shallow, blob-less
// clone for a branch or tag, an init plus a shallow blob-less fetch pinned to
// HEAD for a commit SHA. Blobs are then fetched one at a time on demand.
func RepoMetadataSteps(cloneURL, ref, repoDir string) [][]string {
	if !IsCommitSHA(ref) {
		return [][]string{{
			"clone", "--depth", "1", "--filter=blob:none", "--no-checkout",
			"--branch", ref, "--single-branch", cloneURL, repoDir,
		}}
	}
	sha := strings.ToLower(strings.TrimSpace(ref))
	return [][]string{
		{"init", "--quiet", repoDir},
		{"-C", repoDir, "remote", "add", "origin", cloneURL},
		{"-C", repoDir, "fetch", "--depth", "1", "--filter=blob:none", "origin", sha},
		{"-C", repoDir, "update-ref", "HEAD", "FETCH_HEAD"},
	}
}

// ValidRepoPath reports whether path is a plain relative path inside a
// repository: no leading slash or dash, no `..` segment, no colon.
func ValidRepoPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.HasPrefix(path, "-") || strings.Contains(path, ":") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == ".." {
			return false
		}
	}
	return true
}

// ReadRepoFile reads the first of paths that exists in gitURL at ref, from a
// shallow, blob-less clone into a throwaway volume, and the commit it was read
// at. A file over MaxRepoFileBytes is refused.
func (b *Builder) ReadRepoFile(ctx context.Context, gitURL, ref string, credential *GitCredential, paths []string) (RepoFile, error) {
	for _, path := range paths {
		if !ValidRepoPath(path) {
			return RepoFile{}, errors.New("invalid repository path: " + path)
		}
	}
	volume := "homerun-agent-read-" + b.NewID()
	defer func() {
		cleanup, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
		defer cancel()
		_ = b.docker.RemoveVolume(cleanup, volume)
	}()
	if err := b.ensureImage(ctx, GitImage, func(string) {}); err != nil {
		return RepoFile{}, err
	}
	if err := b.docker.CreateVolume(ctx, volume, map[string]string{managedLabel: "true"}); err != nil {
		return RepoFile{}, err
	}
	cloneURL := AuthenticatedCloneURL(gitURL, credential)
	if err := b.runSteps(ctx, RepoMetadataSteps(cloneURL, ref, repoDir), volume); err != nil {
		return RepoFile{}, errors.New(RedactCloneURL(err.Error()))
	}
	result := RepoFile{}
	if output, code, err := b.RunGit(ctx, []string{"-C", repoDir, "rev-parse", "HEAD"}, volume); err == nil && code == 0 {
		result.Commit = ExtractCommitSHA(output)
	}
	for _, path := range paths {
		content, code, err := b.runGit(ctx, []string{"-C", repoDir, "show", "HEAD:" + path}, volume, true)
		if err != nil {
			return RepoFile{}, errors.New(RedactCloneURL(err.Error()))
		}
		if code != 0 {
			continue
		}
		if len(content) > MaxRepoFileBytes {
			return RepoFile{}, errors.New(path + " is larger than 256 KiB")
		}
		result.Content = content
		result.Path = path
		return result, nil
	}
	return result, nil
}
