package paymentgateway

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	_ "github.com/lib/pq" // Postgres driver — add via go get github.com/lib/pq
)

// Persistent production database abstraction — Go version
// Supports file-backed (hackathon) and Postgres (production)
// Factory: GetDB() returns same interface for both modes

type DBMode string

const (
	DBFileBacked DBMode = "file-backed"
	DBPostgres   DBMode = "postgres"
)

// Store interface — same for file and postgres
type Store interface {
	Get(key string) ([]byte, error)
	Set(key string, value []byte) error
	Delete(key string) error
	All() (map[string][]byte, error)
	Close() error
}

// FileStore — in-memory with file persistence for hackathon
// For real file persistence, use os.WriteFile to /tmp like JS version
type FileStore struct {
	mu   sync.RWMutex
	data map[string][]byte
	name string
}

func NewFileStore(name string) *FileStore {
	return &FileStore{
		data: make(map[string][]byte),
		name: name,
	}
}

func (f *FileStore) Get(key string) ([]byte, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if key == "" {
		return nil, fmt.Errorf("key required")
	}
	val, ok := f.data[key]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return val, nil
}

func (f *FileStore) Set(key string, value []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.data[key] = value
	// In real file-backed, would write to /tmp/aasthi_*.json
	// For Go, keep in-memory for simplicity — JS version handles file persistence
	return nil
}

func (f *FileStore) Delete(key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.data, key)
	return nil
}

func (f *FileStore) All() (map[string][]byte, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	// Return copy
	copy := make(map[string][]byte, len(f.data))
	for k, v := range f.data {
		copy[k] = v
	}
	return copy, nil
}

func (f *FileStore) Close() error { return nil }

// PostgresStore — production
type PostgresStore struct {
	db        *sql.DB
	tableName string
}

func NewPostgresStore(db *sql.DB, tableName string) *PostgresStore {
	return &PostgresStore{db: db, tableName: tableName}
}

func (p *PostgresStore) Get(key string) ([]byte, error) {
	var data []byte
	err := p.db.QueryRow(fmt.Sprintf("SELECT data FROM %s WHERE id = $1", p.tableName), key).Scan(&data)
	if err != nil {
		return nil, err
	}
	return data, nil
}

func (p *PostgresStore) Set(key string, value []byte) error {
	_, err := p.db.Exec(
		fmt.Sprintf("INSERT INTO %s (id, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()", p.tableName),
		key, value,
	)
	return err
}

func (p *PostgresStore) Delete(key string) error {
	_, err := p.db.Exec(fmt.Sprintf("DELETE FROM %s WHERE id = $1", p.tableName), key)
	return err
}

func (p *PostgresStore) All() (map[string][]byte, error) {
	rows, err := p.db.Query(fmt.Sprintf("SELECT id, data FROM %s", p.tableName))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string][]byte)
	for rows.Next() {
		var id string
		var data []byte
		if err := rows.Scan(&id, &data); err != nil {
			continue
		}
		result[id] = data
	}
	return result, nil
}

func (p *PostgresStore) Close() error { return nil }

// DB — main abstraction
type DB struct {
	Mode       DBMode
	PostgresDB *sql.DB // nil if file-backed

	Properties Store
	Balances   Store
	Transfers  Store
	KYC        Store
	Idempotency Store
	NPCIPayments Store
	NPCIBalances Store
	UTRIndex   Store
	Webhooks   Store
}

var (
	globalDB *DB
	dbOnce   sync.Once
)

func GetDB() (*DB, error) {
	var err error
	dbOnce.Do(func() {
		globalDB, err = initDB()
	})
	return globalDB, err
}

func initDB() (*DB, error) {
	databaseURL := os.Getenv("DATABASE_URL")
	if databaseURL == "" {
		// File-backed mode — hackathon
		fmt.Println("[DB] Using file-backed store (hackathon mode) — in-memory + /tmp persistence in JS, in-memory in Go")
		return &DB{
			Mode:         DBFileBacked,
			Properties:   NewFileStore("properties"),
			Balances:     NewFileStore("balances"),
			Transfers:    NewFileStore("transfers"),
			KYC:          NewFileStore("kyc"),
			Idempotency:  NewFileStore("idempotency"),
			NPCIPayments: NewFileStore("npci_payments"),
			NPCIBalances: NewFileStore("npci_balances"),
			UTRIndex:     NewFileStore("utr_index"),
			Webhooks:     NewFileStore("webhooks"),
		}, nil
	}

	// Postgres mode — production
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("failed to open postgres: %w", err)
	}

	// Test connection
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("postgres ping failed: %w", err)
	}

	fmt.Println("[DB] Using postgres — production ready")

	return &DB{
		Mode:         DBPostgres,
		PostgresDB:   db,
		Properties:   NewPostgresStore(db, "properties"),
		Balances:     NewPostgresStore(db, "balances"),
		Transfers:    NewPostgresStore(db, "transfers"),
		KYC:          NewPostgresStore(db, "kyc"),
		Idempotency:  NewPostgresStore(db, "idempotency"),
		NPCIPayments: NewPostgresStore(db, "npci_payments"),
		NPCIBalances: NewPostgresStore(db, "npci_balances"),
		UTRIndex:     NewPostgresStore(db, "utr_index"),
		Webhooks:     NewPostgresStore(db, "webhooks"),
	}, nil
}

func (db *DB) IsPersistent() bool {
	return db.Mode == DBPostgres
}

func (db *DB) IsFileBacked() bool {
	return db.Mode == DBFileBacked
}

// Init — creates tables if postgres
func (db *DB) Init() error {
	if db.Mode != DBPostgres {
		fmt.Println("[DB] File-backed — no migration needed, uses /tmp/aasthi_*.json + globalThis in JS")
		return nil
	}

	tables := []string{
		`CREATE TABLE IF NOT EXISTS properties (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS balances (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS transfers (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS kyc (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS idempotency (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS npci_payments (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS npci_balances (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS utr_index (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE TABLE IF NOT EXISTS webhooks (id TEXT PRIMARY KEY, data JSONB, updated_at TIMESTAMPTZ)`,
		`CREATE INDEX IF NOT EXISTS idx_properties_status ON properties ((data->>'status'))`,
		`CREATE INDEX IF NOT EXISTS idx_transfers_asset ON transfers ((data->>'assetId'))`,
		`CREATE INDEX IF NOT EXISTS idx_npcipayments_status ON npci_payments ((data->>'status'))`,
		`CREATE INDEX IF NOT EXISTS idx_npcipayments_utr ON npci_payments ((data->>'utr'))`,
	}

	for _, sql := range tables {
		if _, err := db.PostgresDB.Exec(sql); err != nil {
			return fmt.Errorf("migration failed for %s: %w", sql, err)
		}
	}

	fmt.Println("[DB] Postgres initialized — tables created")
	return nil
}

func (db *DB) Stats() (map[string]int, error) {
	stats := make(map[string]int)

	stores := map[string]Store{
		"properties":    db.Properties,
		"balances":      db.Balances,
		"transfers":     db.Transfers,
		"kyc":           db.KYC,
		"npciPayments":  db.NPCIPayments,
		"utrIndex":      db.UTRIndex,
		"webhooks":      db.Webhooks,
	}

	for name, store := range stores {
		all, err := store.All()
		if err != nil {
			stats[name] = 0
		} else {
			stats[name] = len(all)
		}
	}

	return stats, nil
}

func (db *DB) Close() error {
	if db.PostgresDB != nil {
		return db.PostgresDB.Close()
	}
	return nil
}

// Helper — save struct as JSON
func SaveJSON(store Store, key string, v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return store.Set(key, data)
}

func LoadJSON(store Store, key string, v interface{}) error {
	data, err := store.Get(key)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, v)
}

// For testing — in-memory DB
func NewTestDB() *DB {
	return &DB{
		Mode:         DBFileBacked,
		Properties:   NewFileStore("properties"),
		Balances:     NewFileStore("balances"),
		Transfers:    NewFileStore("transfers"),
		KYC:          NewFileStore("kyc"),
		Idempotency:  NewFileStore("idempotency"),
		NPCIPayments: NewFileStore("npci_payments"),
		NPCIBalances: NewFileStore("npci_balances"),
		UTRIndex:     NewFileStore("utr_index"),
		Webhooks:     NewFileStore("webhooks"),
	}
}

// Example usage for production:
/*
func main() {
    db, err := GetDB()
    if err != nil {
        log.Fatal(err)
    }
    defer db.Close()

    if err := db.Init(); err != nil {
        log.Fatal(err)
    }

    // Save property
    prop := map[string]interface{}{"assetId": "PROP-001", "title": "Green Valley"}
    SaveJSON(db.Properties, "PROP-001", prop)

    // Stats
    stats, _ := db.Stats()
    fmt.Printf("Stats: %+v\n", stats)
}
*/

// Env for Vercel/Production:
// DATABASE_URL=postgres://user:pass@host:5432/dbname?sslmode=require (Neon/Supabase/RDS)
// No DATABASE_URL -> file-backed (hackathon)
var _ = time.Now // avoid unused import
