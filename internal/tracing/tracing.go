// Package tracing gives the homerun worker its own OpenTelemetry traces: a
// span per job and per stage, exported straight into the app's trace_span
// table so they show up on the instance's Monitoring → Traces page with or
// without the OpenTelemetry collector running. Without Setup (agent mode,
// tests), every span is a no-op.
package tracing

import (
	"context"
	"sync"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/orochibraru/homerun/internal/buildinfo"
	"github.com/orochibraru/homerun/internal/logging"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

// ServiceName is the service.name every worker span carries, and the
// trace_span.service_name the instance's traces page filters on.
const ServiceName = "homerun-worker"

const instrumentationName = "github.com/orochibraru/homerun/internal/worker"

// Tracer is the worker's tracer, from whichever provider is installed
// globally: the Postgres-exporting one after Setup, a no-op before.
func Tracer() trace.Tracer {
	return otel.Tracer(instrumentationName)
}

// Stage runs fn inside a child span of ctx's span named name, carrying
// attributes, and records fn's error on it. While fn runs, the span is the one
// ctx's Cursor sends events to. The error is returned unchanged.
func Stage(ctx context.Context, name string, fn func(context.Context) error, attributes ...attribute.KeyValue) error {
	ctx, span := Tracer().Start(ctx, name, trace.WithAttributes(attributes...))
	defer span.End()
	if cursor := CursorFrom(ctx); cursor != nil {
		cursor.push(span)
		defer cursor.pop(span)
	}
	err := fn(ctx)
	Record(span, err)
	return err
}

type cursorKey struct{}

// Cursor follows the innermost stage a job is in, so each line the job logs
// lands as an event on the span it belongs to.
type Cursor struct {
	mu    sync.Mutex
	spans []trace.Span
}

// WithCursor returns ctx carrying a new Cursor that starts on ctx's span.
func WithCursor(ctx context.Context) (context.Context, *Cursor) {
	cursor := &Cursor{spans: []trace.Span{trace.SpanFromContext(ctx)}}
	return context.WithValue(ctx, cursorKey{}, cursor), cursor
}

// CursorFrom is ctx's Cursor, or nil when it has none.
func CursorFrom(ctx context.Context) *Cursor {
	cursor, _ := ctx.Value(cursorKey{}).(*Cursor)
	return cursor
}

// Event adds line as an event on the innermost stage's span. A nil Cursor
// does nothing.
func (c *Cursor) Event(line string) {
	if c == nil {
		return
	}
	c.mu.Lock()
	span := c.spans[len(c.spans)-1]
	c.mu.Unlock()
	span.AddEvent(line)
}

func (c *Cursor) push(span trace.Span) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.spans = append(c.spans, span)
}

func (c *Cursor) pop(span trace.Span) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for index := len(c.spans) - 1; index > 0; index-- {
		if c.spans[index] == span {
			c.spans = append(c.spans[:index], c.spans[index+1:]...)
			return
		}
	}
}

// Record marks span failed with err, or succeeded when err is nil.
func Record(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return
	}
	span.SetStatus(codes.Ok, "")
}

// Setup installs a tracer provider that batches every finished span into
// trace_span through pool, and returns its shutdown, which flushes what's
// still buffered.
func Setup(pool *pgxpool.Pool) func(context.Context) error {
	provider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(&PGExporter{Pool: pool}),
		sdktrace.WithResource(resource.NewSchemaless(
			attribute.String("service.name", ServiceName),
			attribute.String("service.version", buildinfo.Version),
		)),
	)
	otel.SetTracerProvider(provider)
	otel.SetErrorHandler(otel.ErrorHandlerFunc(func(err error) {
		logging.Warnf("tracing", "%s", err)
	}))
	return provider.Shutdown
}
