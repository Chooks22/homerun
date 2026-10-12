package dockerapi

import (
	"context"
	"net/http"
	"strconv"
)

// PublishedPort is the host port the daemon bound for a container's
// containerPort ("8080/tcp"), 0 when it isn't published or the container isn't
// running.
func (c *Client) PublishedPort(ctx context.Context, id, containerPort string) (int, error) {
	var inspected struct {
		NetworkSettings struct {
			Ports map[string][]struct {
				HostIP   string `json:"HostIp"`
				HostPort string `json:"HostPort"`
			} `json:"Ports"`
		} `json:"NetworkSettings"`
	}
	if err := c.decode(ctx, http.MethodGet, "/containers/"+id+"/json", nil, nil, &inspected); err != nil {
		return 0, err
	}
	for _, binding := range inspected.NetworkSettings.Ports[containerPort] {
		port, err := strconv.Atoi(binding.HostPort)
		if err == nil && port > 0 {
			return port, nil
		}
	}
	return 0, nil
}
