package drunix

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

// Transactional outbox for the consequences of a committed block.
//
// See docs/EVENT-OUTBOX.md. The short version: a side effect that is dispatched
// from a goroutine dies with the process, so "a settlement always notifies" and
// "a document is always anchored" were true only while nothing crashed. An
// outbox row is written in THE SAME TRANSACTION as the block that caused it, so
// either both exist or neither does — the consequence can no longer be lost
// without also losing the fact.
//
// This file is step 1 of the plan: the schema and the atomic write. Nothing
// drains the table yet; the relay and the consumer moves come next. Writing
// rows nobody reads is harmless (they stay pending and are reported), and it
// lets the atomicity land on its own, separately from any behaviour change.

// OutboxEvent is one pending consequence of a block.
//
// DedupeKey must be derived from the fact, never from the clock or a random
// source: it is the only thing standing between an at-least-once relay and a
// duplicate notification. Same fact, same key, forever.
type OutboxEvent struct {
	Topic     string
	DedupeKey string
	Payload   map[string]interface{}
}

// Topics. Kept as constants so a typo is a compile error rather than an event
// that is written and never matched by any consumer.
const (
	TopicLedgerBlock = "ledger.block"
)

// blockEvents returns the outbox rows a committed block implies.
//
// Only ledger.block for now — the settlement, servicing and document topics
// arrive with the consumers that handle them, so that an event never exists in
// the table with nothing able to deliver it.
func blockEvents(b *DrunixBlock) []OutboxEvent {
	return []OutboxEvent{{
		Topic:     TopicLedgerBlock,
		DedupeKey: fmt.Sprintf("%s:%d", TopicLedgerBlock, b.Height),
		Payload: map[string]interface{}{
			"height":    b.Height,
			"type":      b.Type,
			"hash":      b.Hash,
			"timestamp": b.Timestamp,
		},
	}}
}

const outboxSchema = `
CREATE TABLE IF NOT EXISTS umi_outbox (
	seq          BIGSERIAL PRIMARY KEY,
	block_height BIGINT      NOT NULL REFERENCES umi_block(height),
	topic        TEXT        NOT NULL,
	dedupe_key   TEXT        NOT NULL,
	payload      JSONB       NOT NULL,
	created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
	delivered_at TIMESTAMPTZ,
	attempts     INT         NOT NULL DEFAULT 0,
	last_error   TEXT,
	UNIQUE (topic, dedupe_key)
);
CREATE INDEX IF NOT EXISTS umi_outbox_pending_idx
	ON umi_outbox (seq) WHERE delivered_at IS NULL;
`

// OutboxStats is what /drunix/ledger/status reports. Pending work that is also
// old is the condition worth alarming on: the ledger is advancing while its
// consequences are not landing.
type OutboxStats struct {
	Pending              int    `json:"pending"`
	OldestPendingSeconds int64  `json:"oldestPendingSeconds"`
	Failed               int    `json:"failed"`
	LastError            string `json:"lastError,omitempty"`
}

// InitOutbox creates the outbox table. Must run after InitBlocks: the foreign
// key is what makes "an event cannot exist for a block that does not" a
// database guarantee rather than a convention.
func (s *PostgresUMIStore) InitOutbox(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, outboxSchema)
	return err
}

// AppendBlockWithEvents writes the block and its outbox rows in one
// transaction.
//
// Both inserts keep ON CONFLICT DO NOTHING, so a retried append of an identical
// block stays a no-op instead of an error — the idempotence the previous
// AppendBlock had is preserved exactly.
func (s *PostgresUMIStore) AppendBlockWithEvents(b *DrunixBlock, evs []OutboxEvent) error {
	raw, err := json.Marshal(b.Txns)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return s.note(err)
	}
	// Rollback is a no-op once the commit has succeeded, so this is safe to
	// defer unconditionally and removes every early-return leak.
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO umi_block (height, block_type, ts, txns_root, prev_hash, hash, contract, txns)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (height) DO NOTHING`,
		b.Height, b.Type, b.Timestamp, b.TxnsRoot, b.PrevHash, b.Hash, b.Contract, raw); err != nil {
		return s.note(err)
	}

	for _, e := range evs {
		payload, err := json.Marshal(e.Payload)
		if err != nil {
			return s.note(err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO umi_outbox (block_height, topic, dedupe_key, payload)
			 VALUES ($1,$2,$3,$4) ON CONFLICT (topic, dedupe_key) DO NOTHING`,
			b.Height, e.Topic, e.DedupeKey, payload); err != nil {
			return s.note(err)
		}
	}

	return s.note(tx.Commit())
}

// OutboxStatus counts pending work. Reported, not acted on, until the relay
// exists.
func (s *PostgresUMIStore) OutboxStatus() OutboxStats {
	var st OutboxStats
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	var oldest sql.NullTime
	err := s.db.QueryRowContext(ctx,
		`SELECT count(*), min(created_at) FROM umi_outbox WHERE delivered_at IS NULL`).
		Scan(&st.Pending, &oldest)
	if err != nil {
		st.LastError = err.Error()
		return st
	}
	if oldest.Valid {
		st.OldestPendingSeconds = int64(time.Since(oldest.Time).Seconds())
	}
	// A row that has been tried and rejected is a different problem from one
	// that has simply not been picked up yet.
	if err := s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM umi_outbox WHERE delivered_at IS NULL AND attempts > 0`).
		Scan(&st.Failed); err != nil {
		st.LastError = err.Error()
	}
	return st
}
