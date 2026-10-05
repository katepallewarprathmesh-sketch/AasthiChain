package drunix

// Durable backend for request idempotency. Lives beside the ledger in the
// same Postgres database, which is deliberate: the guarantee is only worth
// something if it survives the restart it exists to protect against, and a
// second datastore would be one more thing that can be up or down
// independently of the money.
//
// The whole design rests on one atomic operation — INSERT ... ON CONFLICT DO
// NOTHING — which lets exactly one caller win the key no matter how many
// arrive at once, across any number of instances.

import (
	"context"
	"database/sql"
	"time"
)

const idemSchema = `
CREATE TABLE IF NOT EXISTS umi_idempotency (
  key          TEXT PRIMARY KEY,
  fingerprint  TEXT        NOT NULL,
  status       INT         NOT NULL DEFAULT 0,
  body         BYTEA,
  done         BOOLEAN     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS umi_idempotency_expiry_idx ON umi_idempotency (expires_at);
`

func (s *PostgresUMIStore) IdemInit(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, idemSchema)
	return s.note(err)
}

func (s *PostgresUMIStore) IdemGet(ctx context.Context, key string) (*IdemRecord, error) {
	row := s.db.QueryRowContext(ctx,
		`SELECT key, fingerprint, status, body, done, created_at, expires_at
		   FROM umi_idempotency WHERE key = $1 AND expires_at > now()`, key)
	return scanIdem(row)
}

// IdemClaim is the atomic reservation. A row is inserted only if the key is
// free or its previous reservation has expired; the RETURNING tells us
// whether we won without a second round trip.
func (s *PostgresUMIStore) IdemClaim(ctx context.Context, key, fingerprint string, expires time.Time) (bool, *IdemRecord, error) {
	// Clear an expired reservation first so a stale key cannot lock a caller
	// out forever.
	if _, err := s.db.ExecContext(ctx,
		`DELETE FROM umi_idempotency WHERE key = $1 AND expires_at <= now()`, key); err != nil {
		return false, nil, s.note(err)
	}

	var got string
	err := s.db.QueryRowContext(ctx,
		`INSERT INTO umi_idempotency (key, fingerprint, expires_at)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (key) DO NOTHING
		 RETURNING key`, key, fingerprint, expires).Scan(&got)
	if err == nil {
		return true, nil, nil // inserted: we own the key
	}
	if err != sql.ErrNoRows {
		return false, nil, s.note(err)
	}

	// Someone else holds it. Return what they recorded.
	existing, gErr := s.IdemGet(ctx, key)
	if gErr != nil {
		return false, nil, gErr
	}
	return false, existing, nil
}

func (s *PostgresUMIStore) IdemComplete(ctx context.Context, key string, status int, body []byte) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE umi_idempotency SET status = $2, body = $3, done = true WHERE key = $1`,
		key, status, body)
	return s.note(err)
}

func (s *PostgresUMIStore) IdemRelease(ctx context.Context, key string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM umi_idempotency WHERE key = $1 AND done = false`, key)
	return s.note(err)
}

type rowScanner interface {
	Scan(dest ...interface{}) error
}

func scanIdem(row rowScanner) (*IdemRecord, error) {
	var r IdemRecord
	var body []byte
	err := row.Scan(&r.Key, &r.Fingerprint, &r.Status, &body, &r.Done, &r.CreatedAt, &r.ExpiresAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.Body = body
	return &r, nil
}
