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
	"net/url"
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
	// Apply writes every row of one state change in a single database
	// transaction: all of it lands or none of it does. Money moves between
	// two wallets and two positions at once, so persisting those rows
	// independently can leave the durable copy holding a half-settled trade
	// that no restart could reconcile. Every Save* method below is a
	// one-row Apply.
	Apply(m Mutation) error
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

// Mutation is the set of rows one logical state change touches. The rail
// builds it under its settlement mutex and hands it over in one piece, which
// is what lets the store make the write atomic.
type Mutation struct {
	Wallets      []CBDCWallet
	Positions    []PositionRow
	ISINs        []PilotISIN
	Instructions []SettlementInstruction
	Servicing    []ServicingRecord
	Meta         *MetaCounters
}

// MetaCounters are the rail's lifetime totals, the conservation baseline a
// restart compares against.
type MetaCounters struct {
	FundedPaise int64
	Settled     int64
	Failed      int64
}

// Empty reports whether applying this mutation would write nothing.
func (m Mutation) Empty() bool {
	return len(m.Wallets) == 0 && len(m.Positions) == 0 && len(m.ISINs) == 0 &&
		len(m.Instructions) == 0 && len(m.Servicing) == 0 && m.Meta == nil
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

// The write statements. Each one is guarded on rev so that an out-of-order
// arrival is a no-op rather than a rollback to stale state; the rail stamps
// rev under its mutex, so "last write wins" means last logical change, not
// last packet. Held as constants because Apply and the single-row helpers
// must issue byte-identical SQL, because two copies of an upsert is how the guards
// drift apart.
const (
	sqlSaveWallet = `INSERT INTO umi_wallet (participant, wallet_id, bank, balance_paise, reserved_paise, opened_at, updated_at, rev)
	                 VALUES ($1,$2,$3,$4,$5,$6,now(),$7)
	                 ON CONFLICT (participant) DO UPDATE SET
	                   wallet_id = EXCLUDED.wallet_id, bank = EXCLUDED.bank,
	                   balance_paise = EXCLUDED.balance_paise, reserved_paise = EXCLUDED.reserved_paise,
	                   updated_at = now(), rev = EXCLUDED.rev
	                 WHERE umi_wallet.rev < EXCLUDED.rev`

	sqlSavePosition = `INSERT INTO umi_position (asset_id, holder, tokens, updated_at, rev)
	                   VALUES ($1,$2,$3,now(),$4)
	                   ON CONFLICT (asset_id, holder) DO UPDATE SET
	                     tokens = EXCLUDED.tokens, updated_at = now(), rev = EXCLUDED.rev
	                   WHERE umi_position.rev < EXCLUDED.rev`

	sqlSaveISIN = `INSERT INTO umi_isin (asset_id, isin, issuer, pilot_flag, depository, assigned_at)
	               VALUES ($1,$2,$3,$4,$5,$6)
	               ON CONFLICT (asset_id) DO NOTHING`

	sqlSaveInstruction = `INSERT INTO umi_instruction (instruction_id, asset_id, seller, buyer, tokens, cash_paise, status, payload, created_at, rev)
	                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
	                      ON CONFLICT (instruction_id) DO UPDATE SET
	                        status = EXCLUDED.status, payload = EXCLUDED.payload, rev = EXCLUDED.rev
	                      WHERE umi_instruction.rev <= EXCLUDED.rev`

	sqlSaveServicing = `INSERT INTO umi_servicing
	                      (servicing_id, holder, asset_id, isin, payer, tokens, amount_paise, block_height, settled_at, rev)
	                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
	                    ON CONFLICT (servicing_id, holder) DO UPDATE SET
	                      block_height = EXCLUDED.block_height, rev = EXCLUDED.rev
	                    WHERE umi_servicing.rev <= EXCLUDED.rev`

	// Monotonic counters: GREATEST makes an out-of-order write a no-op.
	sqlSaveMeta = `INSERT INTO umi_meta (key, value, updated_at) VALUES
	                 ('funded_paise',$1,now()), ('settled',$2,now()), ('failed',$3,now())
	               ON CONFLICT (key) DO UPDATE SET
	                 value = GREATEST(umi_meta.value, EXCLUDED.value), updated_at = now()`
)

// execer is satisfied by both *sql.DB and *sql.Tx, so one set of statements
// serves the autocommit path and the transactional one. The store depends on
// this narrow capability rather than on a concrete connection type.
type execer interface {
	ExecContext(ctx context.Context, query string, args ...interface{}) (sql.Result, error)
}

// writeMutation issues every statement for m against ex, in dependency order.
// It does not open or commit anything: the caller decides whether these
// statements share a transaction.
func writeMutation(ctx context.Context, ex execer, m Mutation) error {
	for _, p := range m.ISINs {
		if _, err := ex.ExecContext(ctx, sqlSaveISIN, p.AssetID, p.ISIN, p.Issuer, p.PilotFlag, p.Depository, p.AssignedAt); err != nil {
			return err
		}
	}
	for _, w := range m.Wallets {
		if _, err := ex.ExecContext(ctx, sqlSaveWallet, w.Participant, w.WalletID, w.Bank, w.BalancePaise, w.ReservedPaise, w.OpenedAt, w.Rev); err != nil {
			return err
		}
	}
	for _, p := range m.Positions {
		if _, err := ex.ExecContext(ctx, sqlSavePosition, p.AssetID, p.Holder, p.Tokens, p.Rev); err != nil {
			return err
		}
	}
	for _, si := range m.Instructions {
		raw, err := json.Marshal(si)
		if err != nil {
			return err
		}
		if _, err := ex.ExecContext(ctx, sqlSaveInstruction, si.InstructionID, si.AssetID, si.Seller, si.Buyer,
			si.Tokens, si.CashPaise, si.Status, raw, si.CreatedAt, si.Rev); err != nil {
			return err
		}
	}
	for _, rec := range m.Servicing {
		if _, err := ex.ExecContext(ctx, sqlSaveServicing, rec.ServicingID, rec.Holder, rec.AssetID, rec.ISIN,
			rec.Payer, rec.Tokens, rec.AmountPaise, rec.BlockHeight, rec.SettledAt, rec.Rev); err != nil {
			return err
		}
	}
	if m.Meta != nil {
		if _, err := ex.ExecContext(ctx, sqlSaveMeta, m.Meta.FundedPaise, m.Meta.Settled, m.Meta.Failed); err != nil {
			return err
		}
	}
	return nil
}

// Apply implements UMIStore. One settlement, one transaction: the buyer's
// debit, the seller's credit, both position rows, the instruction and the
// counters commit together or not at all. A failure here leaves the database
// exactly as it was, which is the state a restart can safely rebuild from.
func (s *PostgresUMIStore) Apply(m Mutation) error {
	if m.Empty() {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return s.note(err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := writeMutation(ctx, tx, m); err != nil {
		return s.note(err)
	}
	return s.note(tx.Commit())
}

// The single-row helpers below are Apply with one row in it. They exist for
// callers that genuinely change one thing (opening a wallet, assigning an
// ISIN); anything that moves money should build one Mutation instead.

func (s *PostgresUMIStore) SaveWallet(w CBDCWallet) error {
	return s.Apply(Mutation{Wallets: []CBDCWallet{w}})
}

func (s *PostgresUMIStore) SavePosition(assetID, holder string, tokens, rev int64) error {
	return s.Apply(Mutation{Positions: []PositionRow{{AssetID: assetID, Holder: holder, Tokens: tokens, Rev: rev}}})
}

func (s *PostgresUMIStore) SaveISIN(p PilotISIN) error {
	return s.Apply(Mutation{ISINs: []PilotISIN{p}})
}

func (s *PostgresUMIStore) SaveInstruction(si SettlementInstruction) error {
	return s.Apply(Mutation{Instructions: []SettlementInstruction{si}})
}

func (s *PostgresUMIStore) SaveServicing(rec ServicingRecord) error {
	return s.Apply(Mutation{Servicing: []ServicingRecord{rec}})
}

func (s *PostgresUMIStore) SaveMeta(fundedPaise, settled, failed int64) error {
	return s.Apply(Mutation{Meta: &MetaCounters{FundedPaise: fundedPaise, Settled: settled, Failed: failed}})
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
	dsn = strings.TrimSpace(dsn)
	if dsn == "" {
		log.Printf("UMI persistence: no DATABASE_URL — rail state is in-memory and resets on restart")
		return nil
	}
	// Guard against a DATABASE_URL that is set but is not a connection string
	// (a placeholder, a shell-quoted paste, a bare hostname). pgx would accept
	// it as a keyword/value DSN, find no recognised keys, and silently fall
	// back to a local unix socket - producing the baffling
	// "host=/tmp user=nonroot database=" error against a machine that has no
	// Postgres on it at all. Say plainly what was received instead.
	if !strings.HasPrefix(dsn, "postgres://") && !strings.HasPrefix(dsn, "postgresql://") && !strings.Contains(dsn, "host=") {
		log.Printf("UMI persistence: DATABASE_URL is set but is not a Postgres connection string "+
			"(got %q). It must start with postgres:// or postgresql:// — for Neon, copy the "+
			"pooled connection string and keep ?sslmode=require. Falling back to in-memory.",
			redactDSN(dsn))
		return nil
	}
	store, err := NewPostgresUMIStore(dsn)
	if err != nil {
		log.Printf("UMI persistence: cannot reach Postgres at %s (%v) — falling back to in-memory, demo unaffected",
			redactDSN(dsn), err)
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

// redactDSN returns a connection string with any password removed, safe to put
// in a log. Credentials must never reach a log aggregator.
func redactDSN(dsn string) string {
	if u, err := url.Parse(dsn); err == nil && u.Host != "" {
		if u.User != nil {
			if name := u.User.Username(); name != "" {
				u.User = url.UserPassword(name, "REDACTED")
			}
		}
		return u.Redacted()
	}
	// not a URL: show only the first 24 characters so a pasted secret is not logged
	if len(dsn) > 24 {
		return dsn[:24] + "..."
	}
	return dsn
}
