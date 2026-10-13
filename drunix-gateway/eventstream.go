package drunix

// Settlement event stream: publishing what settled, to whoever needs to know.
//
// WHY THIS EXISTS
//
// A settlement system is not finished when the trade settles. A depository
// tells custodians, participants reconcile, a regulator watches, and an
// operations desk picks up the fails. Today those consumers would have to
// poll our REST API, which is the wrong shape: it makes every consumer our
// problem, it cannot replay, and it gives a late subscriber no history.
//
// A log does fit. Each committed block already implies an exact, durable set
// of consequences (see blockEvents in outbox.go), and the same derivation now
// also feeds a Kafka-protocol topic per event family.
//
// WHERE IT SITS, AND WHERE IT DELIBERATELY DOES NOT
//
// Strictly post-commit, and strictly off the settlement path. A broker is a
// network dependency, and nothing that can be slow or unreachable belongs
// between a buyer's cash and a seller's securities. So:
//
//   - Publishing happens AFTER the block is appended, never before.
//   - It is asynchronous, through a buffered channel drained by one worker,
//     so a slow broker applies no backpressure to settlement.
//   - If the buffer is full the event is DROPPED and counted, not queued
//     indefinitely and not blocked on.
//
// Dropping sounds alarming, so to be explicit about the guarantee: the stream
// is a best-effort fan-out, NOT the system of record. The ledger is the record
// and the transactional outbox (with DATABASE_URL set) is the at-least-once
// path. A consumer that must not miss anything reads the chain, which is
// replayable from height zero. That division is deliberate; the alternative,
// making settlement wait on a broker, trades a correct system for a fast one.
//
// WHY THE KAFKA PROTOCOL SPECIFICALLY
//
// Partly it is the obvious fit for an ordered, replayable, multi-consumer log.
// Partly it is lineage: Hyperledger Fabric's ordering service was Kafka-based
// through the 1.x line before Raft replaced it in 1.4.1, and this ledger
// models that same execute-order-validate pipeline. Speaking the Kafka
// protocol rather than a vendor API means one client works against Apache
// Kafka, Redpanda, WarpStream, MSK and Confluent Cloud without a code change,
// so the deployment picks the broker and we do not.
//
// WHAT IS ACTUALLY WIRED
//
// The producer below is a real Kafka client doing real network I/O. No broker
// is configured in this project, so by default the publisher is a local
// counter that contacts nothing and reports itself as a simulation. Setting
// EVENT_STREAM_BROKERS switches on the real client. That is the same
// live-or-honest-simulation pattern used at every other boundary here, and
// /trust reports which one is active.

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/segmentio/kafka-go"
	"github.com/segmentio/kafka-go/sasl/plain"
)

// StreamEnvelope is the on-the-wire shape of one published event.
//
// Modelled on CloudEvents so a consumer can route on `type` without parsing
// our payload, and carrying the ISO 20022 message name for settlement events
// so a post-trade system can map it to something it already understands.
type StreamEnvelope struct {
	SpecVersion string                 `json:"specversion"`
	ID          string                 `json:"id"`
	Source      string                 `json:"source"`
	Type        string                 `json:"type"`
	Time        string                 `json:"time"`
	Subject     string                 `json:"subject,omitempty"`
	ISO20022    string                 `json:"iso20022,omitempty"`
	Mode        string                 `json:"mode"`
	Data        map[string]interface{} `json:"data"`
}

// isoForTopic maps an event family to the ISO 20022 message a real securities
// settlement rail would emit for it. Empty where there is no honest mapping:
// inventing one would be worse than leaving the field out.
func isoForTopic(topic string) string {
	switch topic {
	case TopicUMISettled:
		return "sese.025 (settlement confirmation) + camt.054 (credit advice)"
	case TopicUMIFailed:
		return "sese.024 (settlement status advice, rejected)"
	case TopicUMIServicing:
		return "camt.054 (credit advice)"
	}
	return ""
}

// EventPublisher is the seam. The chain depends on this, never on Kafka.
type EventPublisher interface {
	Name() string
	// Mode is "live" when a broker is configured, "simulation" otherwise.
	Mode() string
	// Publish hands over one committed block's consequence. It must never
	// block and must never return an error that could reach a settlement.
	Publish(topic, dedupeKey string, payload map[string]interface{})
	Describe() map[string]interface{}
	Close() error
}

type streamStats struct {
	published atomic.Int64
	dropped   atomic.Int64
	failed    atomic.Int64
	lastErr   atomic.Value // string
}

func (s *streamStats) snapshot() map[string]interface{} {
	out := map[string]interface{}{
		"published": s.published.Load(),
		"dropped":   s.dropped.Load(),
		"failed":    s.failed.Load(),
	}
	if v, ok := s.lastErr.Load().(string); ok && v != "" {
		out["lastError"] = v
	}
	return out
}

// ---------- simulation ----------

// localPublisher is the default. It contacts nothing, counts what it was
// given, and keeps the most recent few so /umi/stream can show that the
// derivation works even with no broker attached.
type localPublisher struct {
	mu     sync.Mutex
	recent []StreamEnvelope
	stats  streamStats
	prefix string
}

func (p *localPublisher) Name() string { return "event-stream" }
func (p *localPublisher) Mode() string { return "simulation" }

func (p *localPublisher) Publish(topic, dedupeKey string, payload map[string]interface{}) {
	env := buildEnvelope(topic, dedupeKey, payload, p.Mode())
	p.mu.Lock()
	p.recent = append([]StreamEnvelope{env}, p.recent...)
	if len(p.recent) > 25 {
		p.recent = p.recent[:25]
	}
	p.mu.Unlock()
	p.stats.published.Add(1)
}

func (p *localPublisher) Close() error { return nil }

func (p *localPublisher) Describe() map[string]interface{} {
	p.mu.Lock()
	recent := make([]StreamEnvelope, len(p.recent))
	copy(recent, p.recent)
	p.mu.Unlock()
	return map[string]interface{}{
		"provider":   p.Name(),
		"mode":       p.Mode(),
		"protocol":   "Apache Kafka wire protocol",
		"compatible": []string{"Apache Kafka", "Redpanda", "WarpStream", "Amazon MSK", "Confluent Cloud"},
		"brokers":    []string{},
		"topics":     topicNames(p.prefix),
		"stats":      p.stats.snapshot(),
		"recent":     recent,
		"disclaimer": "No broker is configured, so nothing leaves this process. Events are derived and counted locally. Set EVENT_STREAM_BROKERS to publish for real.",
		"toGoLive":   "EVENT_STREAM_BROKERS=host:9092[,host2:9092]; optionally EVENT_STREAM_USERNAME/PASSWORD (SASL PLAIN) and EVENT_STREAM_TLS=true",
		"guarantee":  "Best-effort fan-out, post-commit. The ledger is the system of record and the transactional outbox is the at-least-once path.",
	}
}

// ---------- live ----------

type kafkaPublisher struct {
	writer  *kafka.Writer
	brokers []string
	prefix  string
	queue   chan StreamEnvelope
	stop    chan struct{}
	done    chan struct{}
	stats   streamStats
	tls     bool
	sasl    bool
}

func (p *kafkaPublisher) Name() string { return "event-stream" }
func (p *kafkaPublisher) Mode() string { return "live" }

// Publish never blocks. A full queue means the broker cannot keep up with
// settlement, and in that situation the correct thing to sacrifice is the
// notification, not the settlement.
func (p *kafkaPublisher) Publish(topic, dedupeKey string, payload map[string]interface{}) {
	env := buildEnvelope(topic, dedupeKey, payload, p.Mode())
	select {
	case p.queue <- env:
	default:
		p.stats.dropped.Add(1)
	}
}

func (p *kafkaPublisher) run() {
	defer close(p.done)
	for {
		select {
		case <-p.stop:
			return
		case env := <-p.queue:
			body, err := json.Marshal(env)
			if err != nil {
				p.stats.failed.Add(1)
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			err = p.writer.WriteMessages(ctx, kafka.Message{
				Topic: p.prefix + "." + env.Type,
				// The dedupe key is the partition key too, so every event
				// about one instruction lands on one partition and stays in
				// order for the consumer that cares about it.
				Key:   []byte(env.ID),
				Value: body,
				Time:  time.Now(),
			})
			cancel()
			if err != nil {
				p.stats.failed.Add(1)
				p.stats.lastErr.Store(err.Error())
				// Logged, never returned. A broker outage must be visible
				// without being able to affect the rail.
				log.Printf("[event-stream] publish failed topic=%s id=%s: %v", env.Type, env.ID, err)
				continue
			}
			p.stats.published.Add(1)
		}
	}
}

func (p *kafkaPublisher) Close() error {
	select {
	case <-p.stop:
	default:
		close(p.stop)
	}
	select {
	case <-p.done:
	case <-time.After(3 * time.Second):
	}
	return p.writer.Close()
}

func (p *kafkaPublisher) Describe() map[string]interface{} {
	return map[string]interface{}{
		"provider":   p.Name(),
		"mode":       p.Mode(),
		"protocol":   "Apache Kafka wire protocol",
		"compatible": []string{"Apache Kafka", "Redpanda", "WarpStream", "Amazon MSK", "Confluent Cloud"},
		"brokers":    p.brokers,
		"tls":        p.tls,
		"sasl":       map[string]interface{}{"enabled": p.sasl, "mechanism": "PLAIN"},
		"topics":     topicNames(p.prefix),
		"stats":      p.stats.snapshot(),
		"queueDepth": len(p.queue),
		"queueSize":  cap(p.queue),
		"guarantee":  "Best-effort fan-out, post-commit, asynchronous. A full queue drops rather than applying backpressure to settlement. The ledger is the system of record.",
	}
}

// ---------- construction ----------

func topicNames(prefix string) []string {
	out := []string{}
	for _, t := range []string{TopicLedgerBlock, TopicUMISettled, TopicUMIFailed, TopicUMIServicing, TopicDocAnchored} {
		out = append(out, prefix+"."+t)
	}
	return out
}

func buildEnvelope(topic, dedupeKey string, payload map[string]interface{}, mode string) StreamEnvelope {
	subject := ""
	for _, k := range []string{"instructionId", "orderId", "assetId", "documentId"} {
		if v, ok := payload[k].(string); ok && v != "" {
			subject = v
			break
		}
	}
	return StreamEnvelope{
		SpecVersion: "1.0",
		ID:          dedupeKey,
		Source:      "aasthichain/drunix-gateway",
		Type:        topic,
		Time:        time.Now().UTC().Format(time.RFC3339Nano),
		Subject:     subject,
		ISO20022:    isoForTopic(topic),
		Mode:        mode,
		Data:        payload,
	}
}

// NewEventPublisher reads the environment and returns the live producer when a
// broker is named, otherwise the local counter. It never returns nil and never
// fails: a misconfigured stream must not stop the rail from settling.
func NewEventPublisher() EventPublisher {
	prefix := strings.TrimSpace(os.Getenv("EVENT_STREAM_PREFIX"))
	if prefix == "" {
		prefix = "aasthi"
	}
	raw := strings.TrimSpace(os.Getenv("EVENT_STREAM_BROKERS"))
	if raw == "" {
		return &localPublisher{prefix: prefix}
	}
	brokers := []string{}
	for _, b := range strings.Split(raw, ",") {
		if b = strings.TrimSpace(b); b != "" {
			brokers = append(brokers, b)
		}
	}
	if len(brokers) == 0 {
		return &localPublisher{prefix: prefix}
	}

	transport := &kafka.Transport{DialTimeout: 10 * time.Second}
	useTLS := strings.EqualFold(strings.TrimSpace(os.Getenv("EVENT_STREAM_TLS")), "true")
	if useTLS {
		transport.TLS = &tls.Config{MinVersion: tls.VersionTLS12}
	}
	user := strings.TrimSpace(os.Getenv("EVENT_STREAM_USERNAME"))
	pass := os.Getenv("EVENT_STREAM_PASSWORD")
	useSASL := user != ""
	if useSASL {
		transport.SASL = plain.Mechanism{Username: user, Password: pass}
	}

	p := &kafkaPublisher{
		writer: &kafka.Writer{
			Addr:                   kafka.TCP(brokers...),
			Balancer:               &kafka.Hash{},
			RequiredAcks:           kafka.RequireAll,
			AllowAutoTopicCreation: true,
			Async:                  false,
			Transport:              transport,
		},
		brokers: brokers,
		prefix:  prefix,
		// Deep enough to absorb a burst of settlements, shallow enough that a
		// dead broker is noticed in the drop counter rather than hidden.
		queue: make(chan StreamEnvelope, 1024),
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
		tls:   useTLS,
		sasl:  useSASL,
	}
	go p.run()
	log.Printf("event stream: Kafka protocol, brokers=%s prefix=%s tls=%v sasl=%v",
		strings.Join(brokers, ","), prefix, useTLS, useSASL)
	return p
}

// PublishBlock turns a committed block into stream events using exactly the
// same derivation the durable outbox uses, so the two can never disagree about
// what a block meant.
func PublishBlock(p EventPublisher, b *DrunixBlock) {
	if p == nil || b == nil {
		return
	}
	for _, e := range blockEvents(b) {
		p.Publish(e.Topic, e.DedupeKey, e.Payload)
	}
}

var _ = fmt.Sprintf
