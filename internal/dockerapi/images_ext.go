package dockerapi

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// ImageInspect is the part of an image's inspect a deploy reads.
type ImageInspect struct {
	Architecture string `json:"Architecture"`
	Config       struct {
		ImageConfig
		Healthcheck *struct {
			Test []string `json:"Test"`
		} `json:"Healthcheck"`
	} `json:"Config"`
	ID          string   `json:"Id"`
	RepoDigests []string `json:"RepoDigests"`
}

// ImageConfig is what an image runs when a container doesn't say otherwise.
type ImageConfig struct {
	Cmd        []string `json:"Cmd"`
	Entrypoint []string `json:"Entrypoint"`
}

// Digest is the image's first registry digest, empty when it never came from
// or went to a registry.
func (i *ImageInspect) Digest() string {
	if len(i.RepoDigests) == 0 {
		return ""
	}
	_, digest, _ := strings.Cut(i.RepoDigests[0], "@")
	return digest
}

// InspectImage inspects ref, returning ErrNotFound when the daemon lacks it.
func (c *Client) InspectImage(ctx context.Context, ref string) (*ImageInspect, error) {
	var inspected ImageInspect
	if err := c.decode(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, &inspected); err != nil {
		return nil, err
	}
	return &inspected, nil
}

// PullImageEvents pulls ref like PullImage, but hands each progress event's
// layer id along with its status, for a caller that dedupes per layer.
func (c *Client) PullImageEvents(ctx context.Context, ref string, auth *AuthConfig, onEvent func(id, status string)) error {
	repository, tag := SplitRef(ref)
	response, err := c.stream(ctx, http.MethodPost, "/images/create",
		url.Values{"fromImage": {repository}, "tag": {tag}}, nil, auth, nil)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	return followEvents(response.Body, onEvent)
}

// LoadImage loads a `docker save` tarball into the daemon, consuming archive
// as it arrives.
func (c *Client) LoadImage(ctx context.Context, archive io.Reader) error {
	response, err := c.upload(ctx, http.MethodPost, "/images/load", url.Values{"quiet": {"1"}},
		archive, "application/x-tar", nil, c.daemonAnswers)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	_, err = io.Copy(io.Discard, response.Body)
	return err
}

// followEvents reads a progress stream to the end like followProgress,
// forwarding each event's id and status.
func followEvents(body io.Reader, onEvent func(id, status string)) error {
	decoder := json.NewDecoder(bufio.NewReader(body))
	for {
		var message struct {
			Error       string `json:"error"`
			ErrorDetail struct {
				Message string `json:"message"`
			} `json:"errorDetail"`
			ID     string `json:"id"`
			Status string `json:"status"`
		}
		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if message.ErrorDetail.Message != "" {
			return errors.New(message.ErrorDetail.Message)
		}
		if message.Error != "" {
			return errors.New(message.Error)
		}
		if onEvent != nil && message.Status != "" {
			onEvent(message.ID, message.Status)
		}
	}
}
