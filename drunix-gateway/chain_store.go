package drunix

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"time"
)

// BlockStore is the durable, append-only home of the Drunix block chain.
//
// A blockchain whose blocks vanish when the process restarts is not a
// blockchain — it is a log. The in-memory DrunixChain gives us the hash
// linkage; this interface gives us the permanence. Note what is deliberately
// absent: there is no Update and no Delete. The only write is an append.
//
// AppendBlockWithEvents takes the block together with the outbox rows it
// implies so an implementation can commit both atomically (see outbox.go).
// Passing no events is valid and means "this block has no consequences yet".
type BlockStore interface {
	InitBlocks(ctx context.Context) error
	LoadBlocks(ctx context.Context) ([]*DrunixBlock, error)
	AppendBlockWithEvents(b *DrunixBlock, evs []OutboxEvent) error
	BlockStoreMode() string
}

const blockSchema = `
CREATE TABLE IF NOT EXISTS umi_block (
	height      BIGINT PRIMARY KEY,
	block_type  TEXT        NOT NULL,
	ts          TEXT        NOT NULL,
	txns_root   TEXT        NOT NULL,
	prev_hash   TEXT        NOT NULL,
	hash        TEXT        NOT NULL UNIQUE,
	contract    TEXT        NOT NULL DEFAULT '',
	txns        JSONB       NOT NULL,
	committed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS umi_block_type_idx ON umi_block (block_type);
`

// InitBlocks creates the block table if it is missing.
func (s *PostgresUMIStore) InitBlocks(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, blockSchema)
	return err
}

// LoadBlocks replays every committed block, oldest first.
func (s *PostgresUMIStore) LoadBlocks(ctx context.Context) ([]*DrunixBlock, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT height, block_type, ts, txns_root, prev_hash, hash, contract, txns
		   FROM umi_block ORDER BY height ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var blocks []*DrunixBlock
	for rows.Next() {
		var b DrunixBlock
		var raw []byte
		if err := rows.Scan(&b.Height, &b.Type, &b.Timestamp, &b.TxnsRoot,
			&b.PrevHash, &b.Hash, &b.Contract, &raw); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			if err := json.Unmarshal(raw, &b.Txns); err != nil {
				return nil, fmt.Errorf("block %d: %w", b.Height, err)
			}
		}
		blocks = append(blocks, &b)
	}
	return blocks, rows.Err()
}

// AppendBlock writes one block with no outbox rows. Kept for callers that have
// no consequences to record; the atomic path lives in outbox.go.
func (s *PostgresUMIStore) AppendBlock(b *DrunixBlock) error {
	return s.AppendBlockWithEvents(b, nil)
}

// BlockStoreMode labels the durable chain backend for /drunix/ledger/status.
func (s *PostgresUMIStore) BlockStoreMode() string { return s.Mode() }

// --- chain wiring -----------------------------------------------------------

// NewChainWithStore restores the chain from durable storage, or seeds genesis
// if the store is empty. The returned chain write-throughs every later block.
//
// Restored blocks are re-verified before use: if the stored chain does not
// replay cleanly (linkage, merkle root, block hash), we refuse to extend it and
// say so loudly rather than quietly building on tampered history.
func NewChainWithStore(store BlockStore) (*DrunixChain, ChainVerification) {
	if store == nil {
		return NewChain(), ChainVerification{Valid: true, Blocks: 1}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := store.InitBlocks(ctx); err != nil {
		log.Printf("Drunix chain: durable block store unavailable (%v) — chain is in-memory for this run", err)
		return NewChain(), ChainVerification{Valid: true, Blocks: 1}
	}
	// The outbox is optional: a store that does not implement it still gets a
	// durable chain, just without the atomic-consequence guarantee.
	if ob, ok := store.(interface {
		InitOutbox(ctx context.Context) error
	}); ok {
		if err := ob.InitOutbox(ctx); err != nil {
			log.Printf("Drunix chain: outbox table unavailable (%v) — block consequences are best-effort this run", err)
		}
	}

	blocks, err := store.LoadBlocks(ctx)
	if err != nil {
		log.Printf("Drunix chain: could not replay stored blocks (%v) — chain is in-memory for this run", err)
		return NewChain(), ChainVerification{Valid: true, Blocks: 1}
	}

	c := &DrunixChain{store: store}
	if len(blocks) == 0 {
		// Fresh database: genesis is cut once and persisted forever.
		c.Append("GENESIS", []map[string]interface{}{{
			"config":    "aasthi-channel-init",
			"channel":   DrunixChainID,
			"orgs":      []string{"AasthiChainMSP", "OriginatorMSP", "RegistrarMSP", "InvestorMSP", "RegulatorMSP"},
			"consensus": "RAFT (simulated)",
			"hashAlgo":  "SHA-512",
		}})
		log.Printf("Drunix chain: new durable ledger started, genesis block committed to %s", store.BlockStoreMode())
		return c, c.Verify()
	}

	c.Blocks = blocks
	v := c.Verify()
	if !v.Valid {
		log.Printf("Drunix chain: STORED CHAIN FAILED VERIFICATION at height %d (%s) — refusing to append to tampered history",
			v.BrokenAt, v.Reason)
		c.sealed = true
	} else {
		log.Printf("Drunix chain: %d blocks replayed from %s, chain verified to height %d",
			len(blocks), store.BlockStoreMode(), v.Height)
	}
	return c, v
}
