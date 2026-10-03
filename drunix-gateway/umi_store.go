package drunix

// Persistence for the UMI rail.
//
// Why: the rail's working set is in-memory (that is what makes the two-leg lock
// and the atomic commit cheap and race-free). On a free PaaS instance that means
// a sleep or redeploy wipes wallets, positions and instructions, and the demo
// looks broken. So the rail now WRITES THROUGH to Postgres (the project's
// existing Neon database) and RELOADS at boot.
//
// Design rules, in priority order:
//
//  1. Never break settlement. Persistence errors are logged and surfaced in
//     /umi/config, but a database hiccup must not fail or half-apply a DvP.
//     The money/securities invariants live in memory under one mutex; the DB is
//     a durable mirror, not the arbiter.
//  2. Opt-in and additive. No DATABASE_URL (or UMI_PERSIST=false) => store is
//     nil and behaviour is byte-for-byte what it was before.
//  3. Own namespace. Every table is prefixed umi_ and created with
//     IF NOT EXISTS, so it coexists with the app's existing Neon schema
//     (user, account, session, properties, balances, …) without touching it.
//  4. Single writer. One gateway instance owns the rail. Scaling to several
//     instances needs row-level locking or moving the settlement engine into
//     SQL transactions — documented, not pretended.

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// UMIStore is the durable mirror of the rail's state (DIP: the engine depends
// on this interface, not on Postgres).
type UMIStore interface {
	Init(ctx context.Context) error
	LoadSnapshot(ctx context.Context) (*UMISnapshot, error)
	SaveWallet(w CBDCWallet) error
	SavePosition(assetID, holder string, tokens, rev int64) error
	SaveISIN(p PilotISIN) error
	SaveServicing(rec ServicingRecord) error
	SaveInstruction(si SettlementInstruction) error
	SaveMeta(fundedPaise, settled, failed int64) error
	Mode() string
	LastError() string
	Close() error
}

// UMISnapshot is everything needed to rebuild the rail after a restart.
type UMISnapshot struct {
	// MaxRev is the highest persistence revision in the database. A restarted
	// process must resume ABOVE it, otherwise every new write looks stale to
	// the rev guard and is silently discarded.
	MaxRev int64 `json:"-"`

	Wallets      []CBDCWallet
	Positions    []PositionRow
	ISINs        []PilotISIN
	Instructions []SettlementInstruction
	Servicing    []ServicingRecord
	FundedPaise  int64
	Settled      int64
	Failed       int64
}

// PositionRow is one securities holding.
type PositionRow struct {
	Rev     int64 `json:"-"`
	AssetID string
	Holder  string
	Tokens  int64
}

// ---------- Postgres implementation ----------

// PostgresUMIStore mirrors rail state into the project's Neon database.
type PostgresUMIStore struct {
	db   *sql.DB
	mu   sync.Mutex
	last string
}

// NewPostgresUMIStore opens a pooled connection. Neon requires TLS; the DSN
// should carry sslmode=require (channel_binding is accepted and ignored by the
// driver when unsupported).
func NewPostgresUMIStore(dsn string) (*PostgresUMIStore, error) {
	if strings.TrimSpace(dsn) == "" {
		return nil, fmt.Errorf("empty DATABASE_URL")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return nil, err
	}
	// Serverless Postgres: keep the pool small and connections short-lived.
	db.SetMaxOpenConns(4)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(5 * time.Minute)
	db.SetConnMaxIdleTime(30 * time.Second)

	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	if err := db.PingContext(ctx); err != nil {
		db.Close()
		return nil, err
	}
	return &PostgresUMIStore{db: db}, nil
}

func (s *PostgresUMIStore) note(err error) error {
	if err == nil {
		return nil
	}
	s.mu.Lock()
	s.last = err.Error()
	s.mu.Unlock()
	log.Printf("UMI persistence warning (settlement unaffected): %v", err)
	return err
}

// Mode implements UMIStore.
func (s *PostgresUMIStore) Mode() string { return "postgres (Neon)" }

// LastError implements UMIStore.
func (s *PostgresUMIStore) LastError() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last
}

// Close implements UMIStore.
func (s *PostgresUMIStore) Close() error { return s.db.Close() }

const umiSchema = `
CREATE TABLE IF NOT EXISTS umi_wallet (
  participant     TEXT PRIMARY KEY,
  wallet_id       TEXT NOT NULL,
  bank            TEXT NOT NULL,
  balance_paise   BIGINT NOT NULL DEFAULT 0,
  reserved_paise  BIGINT NOT NULL DEFAULT 0,
  opened_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev             BIGINT NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS umi_position (
  asset_id   TEXT   NOT NULL,
  holder     TEXT   NOT NULL,
  tokens     BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev        BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (asset_id, holder)
);
CREATE TABLE IF NOT EXISTS umi_isin (
  asset_id    TEXT PRIMARY KEY,
  isin        TEXT NOT NULL,
  issuer      TEXT,
  pilot_flag  BOOLEAN NOT NULL DEFAULT true,
  depository  TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS umi_instruction (
  instruction_id TEXT PRIMARY KEY,
  asset_id       TEXT,
  seller         TEXT,
  buyer          TEXT,
  tokens         BIGINT,
  cash_paise     BIGINT,
  status         TEXT,
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS umi_instruction_created_idx ON umi_instruction (created_at DESC);
CREATE TABLE IF NOT EXISTS umi_servicing (
  servicing_id TEXT   NOT NULL,
  holder       TEXT   NOT NULL,
  asset_id     TEXT   NOT NULL,
  isin         TEXT,
  payer        TEXT   NOT NULL,
  tokens       BIGINT NOT NULL DEFAULT 0,
  amount_paise BIGINT NOT NULL DEFAULT 0,
  block_height BIGINT NOT NULL DEFAULT 0,
  settled_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  rev          BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (servicing_id, holder)
);
CREATE INDEX IF NOT EXISTS umi_servicing_holder_idx ON umi_servicing (holder, settled_at DESC);
CREATE TABLE IF NOT EXISTS umi_meta (
  key        TEXT PRIMARY KEY,
  value      BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Upgrades for databases created before revision guards existed.
ALTER TABLE umi_wallet      ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 0;
ALTER TABLE umi_position    ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 0;
ALTER TABLE umi_instruction ADD COLUMN IF NOT EXISTS rev BIGINT NOT NULL DEFAULT 0;
`

// Init creates the umi_* tables if they do not exist. It never touches any
// other table in the schema.
func (s *PostgresUMIStore) Init(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, umiSchema)
	return s.note(err)
}

// LoadSnapshot rebuilds rail state from the database.
func (s *PostgresUMIStore) LoadSnapshot(ctx context.Context) (*UMISnapshot, error) {
	snap := &UMISnapshot{}

	rows, err := s.db.QueryContext(ctx, `SELECT participant, wallet_id, bank, balance_paise, reserved_paise, opened_at, updated_at, rev FROM umi_wallet ORDER BY participant`)
	if err != nil {
		return nil, s.note(err)
	}
	for rows.Next() {
		var w CBDCWallet
		if err := rows.Scan(&w.Participant, &w.WalletID, &w.Bank, &w.BalancePaise, &w.ReservedPaise, &w.OpenedAt, &w.UpdatedAt, &w.Rev); err != nil {
			rows.Close()
			return nil, s.note(err)
		}
		// Reservations belong to in-flight instructions; a restart has none.
		w.ReservedPaise = 0
		if w.Rev > snap.MaxRev {
			snap.MaxRev = w.Rev
		}
		snap.Wallets = append(snap.Wallets, w)
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `SELECT asset_id, holder, tokens, rev FROM umi_position WHERE tokens > 0`)
	if err != nil {
		return nil, s.note(err)
	}
	for rows.Next() {
		var p PositionRow
		if err := rows.Scan(&p.AssetID, &p.Holder, &p.Tokens, &p.Rev); err != nil {
			rows.Close()
			return nil, s.note(err)
		}
		if p.Rev > snap.MaxRev {
			snap.MaxRev = p.Rev
		}
		snap.Positions = append(snap.Positions, p)
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `SELECT asset_id, isin, COALESCE(issuer,''), pilot_flag, COALESCE(depository,''), assigned_at FROM umi_isin`)
	if err != nil {
		return nil, s.note(err)
	}
	for rows.Next() {
		var p PilotISIN
		if err := rows.Scan(&p.AssetID, &p.ISIN, &p.Issuer, &p.PilotFlag, &p.Depository, &p.AssignedAt); err != nil {
			rows.Close()
			return nil, s.note(err)
		}
		snap.ISINs = append(snap.ISINs, p)
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `SELECT payload, rev FROM umi_instruction ORDER BY created_at ASC LIMIT 500`)
	if err != nil {
		return nil, s.note(err)
	}
	for rows.Next() {
		var raw []byte
		var rev int64
		if err := rows.Scan(&raw, &rev); err != nil {
			rows.Close()
			return nil, s.note(err)
		}
		if rev > snap.MaxRev {
			snap.MaxRev = rev
		}
		var si SettlementInstruction
		if err := json.Unmarshal(raw, &si); err == nil {
			si.Rev = rev
			snap.Instructions = append(snap.Instructions, si)
		}
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx,
		`SELECT servicing_id, holder, asset_id, COALESCE(isin,''), payer, tokens, amount_paise, block_height, settled_at, rev
		   FROM umi_servicing ORDER BY settled_at ASC LIMIT 2000`)
	if err != nil {
		return nil, s.note(err)
	}
	for rows.Next() {
		var rec ServicingRecord
		if err := rows.Scan(&rec.ServicingID, &rec.Holder, &rec.AssetID, &rec.ISIN, &rec.Payer,
			&rec.Tokens, &rec.AmountPaise, &rec.BlockHeight, &rec.SettledAt, &rec.Rev); err != nil {
			rows.Close()
			return nil, s.note(err)
		}
		rec.AmountINR = paiseToINR(rec.AmountPaise)
		if rec.Rev > snap.MaxRev {
			snap.MaxRev = rec.Rev
		}
		snap.Servicing = append(snap.Servicing, rec)
	}
	rows.Close()

	rows, err = s.db.QueryContext(ctx, `SELECT key, value FROM umi_meta`)
	if err != nil {
		return nil, s.note(err)
	}
	for rows.Next() {
		var k string
		var v int64
		if err := rows.Scan(&k, &v); err != nil {
			rows.Close()
			return nil, s.note(err)
		}
		switch k {
		case "funded_paise":
			snap.FundedPaise = v
		case "settled":
			snap.Settled = v
		case "failed":
			snap.Failed = v
		}
	}
	rows.Close()

	return snap, nil
}

func (s *PostgresUMIStore) exec(q string, args ...interface{}) error {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	_, err := s.db.ExecContext(ctx, q, args...)
	return s.note(err)
}

// SaveWallet upserts one wallet.
func (s *PostgresUMIStore) SaveWallet(w CBDCWallet) error {
	// Writes land after the rail's mutex is released, so two concurrent
	// settlements touching one wallet can arrive out of order. The rev guard
	// makes the last *logical* state win, not the last packet to arrive.
	return s.exec(`INSERT INTO umi_wallet (participant, wallet_id, bank, balance_paise, reserved_paise, opened_at, updated_at, rev)
	               VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
	               ON CONFLICT (participant) DO UPDATE SET
	                 wallet_id = EXCLUDED.wallet_id, bank = EXCLUDED.bank,
	                 balance_paise = EXCLUDED.balance_paise, reserved_paise = EXCLUDED.reserved_paise,
	                 updated_at = now(), rev = EXCLUDED.rev
	               WHERE umi_wallet.rev < EXCLUDED.rev`,
		w.Participant, w.WalletID, w.Bank, w.BalancePaise, w.ReservedPaise, w.OpenedAt, w.Rev)
}

// SavePosition upserts one securities holding.
func (s *PostgresUMIStore) SavePosition(assetID, holder string, tokens, rev int64) error {
	return s.exec(`INSERT INTO umi_position (asset_id, holder, tokens, updated_at, rev)
	               VALUES ($1,$2,$3,now(),$4)
	               ON CONFLICT (asset_id, holder) DO UPDATE SET
	                 tokens = EXCLUDED.tokens, updated_at = now(), rev = EXCLUDED.rev
	               WHERE umi_position.rev < EXCLUDED.rev`,
		assetID, holder, tokens, rev)
}

// SaveISIN upserts one pilot ISIN.
func (s *PostgresUMIStore) SaveISIN(p PilotISIN) error {
	return s.exec(`INSERT INTO umi_isin (asset_id, isin, issuer, pilot_flag, depository, assigned_at)
	               VALUES ($1,$2,$3,$4,$5,$6)
	               ON CONFLICT (asset_id) DO NOTHING`,
		p.AssetID, p.ISIN, p.Issuer, p.PilotFlag, p.Depository, p.AssignedAt)
}

// SaveInstruction upserts one settlement instruction (full payload as JSONB so
// the ISO 20022 trace survives a restart).
func (s *PostgresUMIStore) SaveInstruction(si SettlementInstruction) error {
	raw, err := json.Marshal(si)
	if err != nil {
		return s.note(err)
	}
	return s.exec(`INSERT INTO umi_instruction (instruction_id, asset_id, seller, buyer, tokens, cash_paise, status, payload, created_at, rev)
	               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
	               ON CONFLICT (instruction_id) DO UPDATE SET
	                 status = EXCLUDED.status, payload = EXCLUDED.payload, rev = EXCLUDED.rev
	               WHERE umi_instruction.rev <= EXCLUDED.rev`,
		si.InstructionID, si.AssetID, si.Seller, si.Buyer, si.Tokens, si.CashPaise, si.Status, raw, si.CreatedAt, si.Rev)
}

// SaveServicing records one holder's payout from one servicing run.
func (s *PostgresUMIStore) SaveServicing(rec ServicingRecord) error {
	return s.exec(`INSERT INTO umi_servicing
	                 (servicing_id, holder, asset_id, isin, payer, tokens, amount_paise, block_height, settled_at, rev)
	               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
	               ON CONFLICT (servicing_id, holder) DO UPDATE SET
	                 block_height = EXCLUDED.block_height, rev = EXCLUDED.rev
	               WHERE umi_servicing.rev <= EXCLUDED.rev`,
		rec.ServicingID, rec.Holder, rec.AssetID, rec.ISIN, rec.Payer,
		rec.Tokens, rec.AmountPaise, rec.BlockHeight, rec.SettledAt, rec.Rev)
}

// SaveMeta persists the rail's lifetime counters (conservation baseline).
func (s *PostgresUMIStore) SaveMeta(fundedPaise, settled, failed int64) error {
	// These counters are monotonic, so GREATEST makes an out-of-order write a
	// no-op rather than a rollback.
	return s.exec(`INSERT INTO umi_meta (key, value, updated_at) VALUES
	                 ('funded_paise',$1,now()), ('settled',$2,now()), ('failed',$3,now())
	               ON CONFLICT (key) DO UPDATE SET
	                 value = GREATEST(umi_meta.value, EXCLUDED.value), updated_at = now()`,
		fundedPaise, settled, failed)
}

// ---------- wiring helpers ----------

// OpenUMIStoreFromEnv builds a store from DATABASE_URL (or UMI_DATABASE_URL to
// point the rail at a different database than the app). Returns nil when
// persistence is not configured or unreachable — the rail then runs purely
// in-memory exactly as before.
// OpenUMIStoreFromEnv returns the concrete store so callers can use both the
// UMIStore (rail state) and BlockStore (ledger blocks) halves of it — one
// connection pool backs both. nil means "run in memory", and every caller
// treats that as the normal, supported case.
func OpenUMIStoreFromEnv() *PostgresUMIStore {
	if os.Getenv("UMI_PERSIST") == "false" {
		log.Printf("UMI persistence disabled (UMI_PERSIST=false) — in-memory only")
		return nil
	}
	dsn := os.Getenv("UMI_DATABASE_URL")
	if dsn == "" {
		dsn = os.Getenv("DATABASE_URL")
	}
	if strings.TrimSpace(dsn) == "" {
		log.Printf("UMI persistence: no DATABASE_URL — rail state is in-memory and resets on restart")
		return nil
	}
	store, err := NewPostgresUMIStore(dsn)
	if err != nil {
		log.Printf("UMI persistence: cannot reach Postgres (%v) — falling back to in-memory, demo unaffected", err)
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if err := store.Init(ctx); err != nil {
		log.Printf("UMI persistence: schema init failed (%v) — falling back to in-memory", err)
		store.Close()
		return nil
	}
	log.Printf("UMI persistence: Postgres connected (umi_* tables ready) — rail state survives restarts")
	return store
}
