package tracing_test

import (
	"context"
	"testing"

	"github.com/orochibraru/homerun/internal/jobs"
	"github.com/orochibraru/homerun/internal/tracing"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"
)

func recordStageSpans(t *testing.T) *tracetest.SpanRecorder {
	t.Helper()
	recorder := tracetest.NewSpanRecorder()
	previous := otel.GetTracerProvider()
	otel.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(recorder)))
	t.Cleanup(func() { otel.SetTracerProvider(previous) })
	return recorder
}

func eventsOf(span sdktrace.ReadOnlySpan) []string {
	names := make([]string, 0, len(span.Events()))
	for _, event := range span.Events() {
		names = append(names, event.Name)
	}
	return names
}

func TestCursorSendsEachLineToTheInnermostStage(t *testing.T) {
	recorder := recordStageSpans(t)
	ctx, root := tracing.Tracer().Start(context.Background(), "job deploy")
	ctx, cursor := tracing.WithCursor(ctx)
	job, _, err := jobs.Recorder("deploy", map[string]string{})
	if err != nil {
		t.Fatal(err)
	}
	job = job.WithTrace(cursor.Event)

	job.AppendLog("before any stage")
	_ = tracing.Stage(ctx, "pull", func(ctx context.Context) error {
		job.AppendLog("pulling")
		return tracing.Stage(ctx, "scan", func(context.Context) error {
			job.Trace("scanning")
			return nil
		}, attribute.String("homerun.deploy.image", "nginx:alpine"))
	})
	job.AppendLog("after the stages")
	root.End()

	spans := map[string]sdktrace.ReadOnlySpan{}
	for _, span := range recorder.Ended() {
		spans[span.Name()] = span
	}
	cases := map[string][]string{
		"job deploy": {"before any stage", "after the stages"},
		"pull":       {"pulling"},
		"scan":       {"scanning"},
	}
	for name, want := range cases {
		got := eventsOf(spans[name])
		if len(got) != len(want) {
			t.Fatalf("%s: got events %v, want %v", name, got, want)
		}
		for index := range want {
			if got[index] != want[index] {
				t.Errorf("%s: got events %v, want %v", name, got, want)
			}
		}
	}
	if attributes := spans["scan"].Attributes(); len(attributes) != 1 || attributes[0].Value.AsString() != "nginx:alpine" {
		t.Errorf("the stage's attributes should be on its span, got %v", attributes)
	}
}

func TestANilCursorIgnoresEvents(t *testing.T) {
	var cursor *tracing.Cursor
	cursor.Event("nothing to record it on")
	if tracing.CursorFrom(context.Background()) != nil {
		t.Error("a context without a cursor should have none")
	}
}
