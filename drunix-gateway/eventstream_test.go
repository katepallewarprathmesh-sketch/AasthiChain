package drunix

import (
	"net"
	"testing"
	"time"
)

// The derivation must match what the durable outbox writes, because the whole
// point of reusing blockEvents is that the stream and the outbox can never
// disagree about what a block meant.
func TestStreamDerivesTheSameEventsAsTheOutbox(t *testing.T) {
	b := &DrunixBlock{
		Height: 42,
		Type:   BlockUMIDvPSettled,
		Hash:   "deadbeef",
		Txns: []map[string]interface{}{
			{"instructionId": "INS-1", "tokens": 10},
		},
	}
	p := &localPublisher{prefix: "aasthi"}
	PublishBlock(p, b)

	if got := p.stats.published.Load(); got != 2 {
		t.Fatalf("a settled block implies a ledger.block event and one settlement event, published %d", got)
	}
	d := p.Describe()
	recent, _ := d["recent"].([]StreamEnvelope)
	if len(recent) != 2 {
		t.Fatalf("want 2 envelopes, got %d", len(recent))
	}

	var settled *StreamEnvelope
	for i := range recent {
		if recent[i].Type == TopicUMISettled {
			settled = &recent[i]
		}
	}
	if settled == nil {
		t.Fatal("no umi.settled envelope was produced")
	}
	if settled.Subject != "INS-1" {
		t.Fatalf("the instruction id should become the subject, got %q", settled.Subject)
	}
	if settled.ISO20022 == "" {
		t.Fatal("a settlement event must carry its ISO 20022 message name")
	}
	if settled.ID != "umi.settled:42:0" {
		t.Fatalf("the envelope id must be the outbox dedupe key, got %q", settled.ID)
	}
	if settled.Mode != "simulation" {
		t.Fatalf("an unconfigured publisher must stamp every payload as a simulation, got %q", settled.Mode)
	}
}

// A block type with no settlement meaning must not invent one.
func TestStreamDoesNotInventEventsForPlainBlocks(t *testing.T) {
	p := &localPublisher{prefix: "aasthi"}
	PublishBlock(p, &DrunixBlock{Height: 1, Type: "GENESIS", Hash: "x"})
	if got := p.stats.published.Load(); got != 1 {
		t.Fatalf("a plain block implies exactly one ledger.block event, got %d", got)
	}
	d := p.Describe()
	recent, _ := d["recent"].([]StreamEnvelope)
	if recent[0].ISO20022 != "" {
		t.Fatalf("there is no honest ISO 20022 mapping for a plain block, got %q", recent[0].ISO20022)
	}
}

// The property that matters most: a broker that is unreachable, hung or
// simply wrong must never be able to delay or fail a settlement.
func TestUnreachableBrokerNeverBlocksSettlement(t *testing.T) {
	// Port 1 on loopback refuses immediately on most systems and is
	// unroutable on the rest; either way it is not a Kafka broker.
	t.Setenv("EVENT_STREAM_BROKERS", "127.0.0.1:1")
	p := NewEventPublisher()
	defer func() { _ = p.Close() }()

	if p.Mode() != "live" {
		t.Fatalf("naming a broker should select the real producer, got %q", p.Mode())
	}

	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			p.Publish(TopicUMISettled, "k", map[string]interface{}{"instructionId": "INS"})
		}
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("publishing blocked on an unreachable broker: settlement would have stalled")
	}
}

// A full queue must drop and count rather than apply backpressure. Proving
// this matters because the alternative failure mode is silent and fatal: a
// slow broker quietly becoming a brake on the settlement engine.
func TestFullQueueDropsRatherThanBlocking(t *testing.T) {
	p := &kafkaPublisher{
		// No worker goroutine is started, so nothing drains the queue.
		queue:  make(chan StreamEnvelope, 2),
		stop:   make(chan struct{}),
		done:   make(chan struct{}),
		prefix: "aasthi",
	}
	for i := 0; i < 10; i++ {
		p.Publish(TopicUMISettled, "k", map[string]interface{}{})
	}
	if got := p.stats.dropped.Load(); got != 8 {
		t.Fatalf("a queue of 2 given 10 events should drop 8, dropped %d", got)
	}
	if got := p.stats.published.Load(); got != 0 {
		t.Fatalf("nothing drained the queue, so nothing was published, got %d", got)
	}
}

// The live path must be a real Kafka client doing real network I/O, not a
// stub that pretends. Point it at a listener we control and assert that it
// actually dials and writes protocol bytes.
func TestLiveProducerPerformsRealNetworkIO(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Skipf("no loopback listener available: %v", err)
	}
	defer ln.Close()

	connected := make(chan int, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
		buf := make([]byte, 512)
		n, _ := conn.Read(buf)
		connected <- n
	}()

	t.Setenv("EVENT_STREAM_BROKERS", ln.Addr().String())
	p := NewEventPublisher()
	defer func() { _ = p.Close() }()
	p.Publish(TopicUMISettled, "k1", map[string]interface{}{"instructionId": "INS-9"})

	select {
	case n := <-connected:
		if n <= 0 {
			t.Fatal("the producer connected but sent nothing: that is not a real client")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the producer never dialled the broker, so the live path is not real")
	}
}

// Nothing may leave the process until a broker is named. This is the claim
// /trust makes on our behalf, so it is worth a test rather than a comment.
func TestUnconfiguredStreamContactsNothing(t *testing.T) {
	t.Setenv("EVENT_STREAM_BROKERS", "")
	p := NewEventPublisher()
	defer func() { _ = p.Close() }()
	if p.Mode() != "simulation" {
		t.Fatalf("with no broker the publisher must report simulation, got %q", p.Mode())
	}
	d := p.Describe()
	if brokers, _ := d["brokers"].([]string); len(brokers) != 0 {
		t.Fatalf("a simulated publisher must not claim brokers, got %v", brokers)
	}
	if d["disclaimer"] == nil {
		t.Fatal("the simulated publisher must say plainly that nothing leaves the process")
	}
}
