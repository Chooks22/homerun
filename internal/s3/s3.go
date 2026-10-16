// Package s3 is a minimal S3-compatible object storage client (AWS S3, MinIO,
// R2, Backblaze B2...) signed with AWS Signature V4 by hand, covering what
// Homerun's backups need: streaming multipart uploads and streaming downloads.
// Path-style addressing (bucket in the path) is used, which both AWS and MinIO
// accept.
package s3

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/orochibraru/homerun/internal/activity"
)

// Client is one bucket on one S3-compatible endpoint.
type Client struct {
	AccessKeyID     string `json:"accessKeyId"`
	Bucket          string `json:"bucket"`
	Endpoint        string `json:"endpoint"`
	Region          string `json:"region"`
	SecretAccessKey string `json:"secretAccessKey"`

	HTTP *http.Client     `json:"-"`
	Now  func() time.Time `json:"-"`
}

// StatusError is a non-2xx answer from the endpoint.
type StatusError struct {
	Code    int
	Message string
}

// Error renders the status and the body S3 sent back.
func (e *StatusError) Error() string { return e.Message }

// httpClient returns c.HTTP, or http.DefaultClient when unset.
func (c *Client) httpClient() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

// now returns c.Now(), or time.Now() when unset.
func (c *Client) now() time.Time {
	if c.Now != nil {
		return c.Now()
	}
	return time.Now()
}

// hmacSHA256 computes the HMAC-SHA256 of data keyed by key.
func hmacSHA256(key []byte, data string) []byte {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(data))
	return mac.Sum(nil)
}

// SHA256Hex hex-encodes the SHA-256 digest of data.
func SHA256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// escape percent-encodes s for AWS Signature V4, keeping slashes intact when
// keepSlash is set.
func escape(s string, keepSlash bool) string {
	var b strings.Builder
	for i := range len(s) {
		ch := s[i]
		switch {
		case ch >= 'A' && ch <= 'Z', ch >= 'a' && ch <= 'z', ch >= '0' && ch <= '9',
			ch == '-', ch == '_', ch == '.', ch == '~', keepSlash && ch == '/':
			b.WriteByte(ch)
		default:
			fmt.Fprintf(&b, "%%%02X", ch)
		}
	}
	return b.String()
}

// CanonicalQuery renders query in AWS Signature V4's canonical form.
func CanonicalQuery(query url.Values) string {
	keys := make([]string, 0, len(query))
	for key := range query {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, key := range keys {
		for _, value := range query[key] {
			parts = append(parts, escape(key, false)+"="+escape(value, false))
		}
	}
	return strings.Join(parts, "&")
}

// Signature computes an AWS Signature V4 for an S3 request. headers are the
// lowercase header names and values to sign, host included.
func Signature(secretAccessKey, region, amzDate, method, canonicalURI, query string, headers map[string]string, payloadHash string) (signature, signedHeaders string) {
	names := make([]string, 0, len(headers))
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	var canonicalHeaders strings.Builder
	for _, name := range names {
		canonicalHeaders.WriteString(name + ":" + strings.TrimSpace(headers[name]) + "\n")
	}
	signedHeaders = strings.Join(names, ";")
	canonicalRequest := strings.Join([]string{method, canonicalURI, query, canonicalHeaders.String(), signedHeaders, payloadHash}, "\n")
	dateStamp := amzDate[:8]
	scope := dateStamp + "/" + region + "/s3/aws4_request"
	stringToSign := strings.Join([]string{"AWS4-HMAC-SHA256", amzDate, scope, SHA256Hex([]byte(canonicalRequest))}, "\n")
	key := hmacSHA256([]byte("AWS4"+secretAccessKey), dateStamp)
	key = hmacSHA256(key, region)
	key = hmacSHA256(key, "s3")
	key = hmacSHA256(key, "aws4_request")
	return hex.EncodeToString(hmacSHA256(key, stringToSign)), signedHeaders
}

// objectPath is key's escaped, slash-collapsed path within c.Bucket.
func (c *Client) objectPath(key string) string {
	path := "/" + c.Bucket + "/" + key
	for strings.Contains(path, "//") {
		path = strings.ReplaceAll(path, "//", "/")
	}
	return escape(path, true)
}

// do sends one signed S3 request and returns the raw response, or an error
// for a non-2xx status.
func (c *Client) do(ctx context.Context, method, key string, query url.Values, body []byte) (*http.Response, error) {
	endpoint, err := url.Parse(strings.TrimRight(c.Endpoint, "/"))
	if err != nil {
		return nil, fmt.Errorf("invalid S3 endpoint %q: %w", c.Endpoint, err)
	}
	escapedPath := c.objectPath(key)
	canonical := CanonicalQuery(query)
	target, err := url.Parse(endpoint.Scheme + "://" + endpoint.Host + escapedPath)
	if err != nil {
		return nil, err
	}
	target.RawQuery = canonical
	payloadHash := SHA256Hex(body)
	amzDate := c.now().UTC().Format("20060102T150405Z")
	headers := map[string]string{
		"host":                 target.Host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date":           amzDate,
	}
	signature, signedHeaders := Signature(c.SecretAccessKey, c.Region, amzDate, method, escapedPath, canonical, headers, payloadHash)
	var payload io.Reader = http.NoBody
	if len(body) > 0 {
		payload = activity.Reader(ctx, bytes.NewReader(body))
	}
	request, err := http.NewRequestWithContext(ctx, method, target.String(), payload)
	if err != nil {
		return nil, err
	}
	request.ContentLength = int64(len(body))
	if len(body) > 0 {
		request.GetBody = func() (io.ReadCloser, error) { return io.NopCloser(bytes.NewReader(body)), nil }
	}
	request.Header.Set("x-amz-content-sha256", payloadHash)
	request.Header.Set("x-amz-date", amzDate)
	request.Header.Set("Authorization", fmt.Sprintf("AWS4-HMAC-SHA256 Credential=%s/%s/%s/s3/aws4_request, SignedHeaders=%s, Signature=%s",
		c.AccessKeyID, amzDate[:8], c.Region, signedHeaders, signature))
	response, err := c.httpClient().Do(request)
	if err != nil {
		return nil, err
	}
	if response.StatusCode >= 200 && response.StatusCode < 300 {
		return response, nil
	}
	defer func() { _ = response.Body.Close() }()
	text, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
	return nil, &StatusError{Code: response.StatusCode, Message: fmt.Sprintf("S3 %s failed: %s %s", method, response.Status, strings.TrimSpace(string(text)))}
}

// MiB renders a byte count in MiB.
func MiB(n int64) string {
	return fmt.Sprintf("%.1f MiB", float64(n)/(1<<20))
}

// Get opens key for reading. The caller closes the stream.
func (c *Client) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	response, err := c.do(ctx, http.MethodGet, key, nil, nil)
	if err != nil {
		return nil, err
	}
	response.Body = progressBody{Reader: activity.Reader(ctx, response.Body), Closer: response.Body}
	return response.Body, nil
}

type progressBody struct {
	io.Reader
	io.Closer
}
