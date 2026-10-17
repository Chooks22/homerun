package s3_test

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/orochibraru/homerun/internal/s3"
)

func TestSignatureMatchesAWSExample(t *testing.T) {
	signature, signed := s3.Signature(
		"wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1", "20130524T000000Z",
		"GET", "/test.txt", "",
		map[string]string{
			"host":                 "examplebucket.s3.amazonaws.com",
			"range":                "bytes=0-9",
			"x-amz-content-sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			"x-amz-date":           "20130524T000000Z",
		},
		"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
	)
	if signature != "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41" {
		t.Fatalf("signature = %s", signature)
	}
	if signed != "host;range;x-amz-content-sha256;x-amz-date" {
		t.Fatalf("signed headers = %s", signed)
	}
}

// newFake starts a fake S3 endpoint holding objects (by request path), which
// fails any request whose signature doesn't verify, and returns a client
// pointed at it.
func newFake(t *testing.T, objects map[string]string) *s3.Client {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers := map[string]string{
			"host":                 r.Host,
			"x-amz-content-sha256": r.Header.Get("x-amz-content-sha256"),
			"x-amz-date":           r.Header.Get("x-amz-date"),
		}
		want, _ := s3.Signature("secret", "us-east-1", headers["x-amz-date"], r.Method, r.URL.EscapedPath(),
			s3.CanonicalQuery(r.URL.Query()), headers, s3.SHA256Hex(nil))
		if !strings.HasSuffix(r.Header.Get("Authorization"), "Signature="+want) {
			t.Errorf("bad signature on %s %s", r.Method, r.URL)
		}
		object, ok := objects[r.URL.Path]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_, _ = io.WriteString(w, object)
	}))
	t.Cleanup(server.Close)
	return &s3.Client{
		AccessKeyID: "key", Bucket: "bucket", Endpoint: server.URL, Region: "us-east-1", SecretAccessKey: "secret",
		Now: func() time.Time { return time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC) },
	}
}

func TestGetReadsAnObjectWhoseKeyNeedsEscaping(t *testing.T) {
	client := newFake(t, map[string]string{"/bucket/prefix/vol 1+x.tar.gz": "hello"})
	stream, err := client.Get(context.Background(), "prefix/vol 1+x.tar.gz")
	if err != nil {
		t.Fatal(err)
	}
	defer stream.Close()
	if got, _ := io.ReadAll(stream); string(got) != "hello" {
		t.Fatalf("got %q", got)
	}
}

func TestGetMissingIsAnError(t *testing.T) {
	client := newFake(t, map[string]string{})
	if _, err := client.Get(context.Background(), "nope"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("err = %v", err)
	}
}
