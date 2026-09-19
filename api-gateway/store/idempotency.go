package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// IdempotencyStore — persistent store per Track A4
// Moves from in-memory map to file-backed + optional Redis
// Prevents double-mint on gateway restart

type IdempotencyRecord struct {
	Key       string      `json:"key"`
	Response  interface{} `json:"response"`
	CreatedAt time.Time   `json:"createdAt"`
	ExpiresAt time.Time   `json:"expiresAt"`
}

type IdempotencyStore struct {
	mu       sync.RWMutex
	records  map[string]IdempotencyRecord
	filePath string
	// Optional Redis client would go here for prod
}

func NewIdempotencyStore() *IdempotencyStore {
	// Ensure data dir exists
	dataDir := getEnv("IDEMPOTENCY_DATA_DIR", "./data")
	os.MkdirAll(dataDir, 0755)
	filePath := filepath.Join(dataDir, "idempotency.json")

	s := &IdempotencyStore{
		records:  make(map[string]IdempotencyRecord),
		filePath: filePath,
	}

	// Load existing records from file
	s.loadFromFile()

	// Cleanup expired records periodically
	go s.cleanupLoop()

	return s
}

func (s *IdempotencyStore) Get(key string) (interface{}, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	rec, ok := s.records[key]
	if !ok {
		return nil, false
	}
	if time.Now().After(rec.ExpiresAt) {
		return nil, false
	}
	return rec.Response, true
}

func (s *IdempotencyStore) Set(key string, response interface{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[key] = IdempotencyRecord{
		Key:       key,
		Response:  response,
		CreatedAt: time.Now(),
		ExpiresAt: time.Now().Add(24 * time.Hour), // 24h expiry
	}
	s.saveToFileAsync()
}

func (s *IdempotencyStore) Delete(key string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, key)
	s.saveToFileAsync()
}

func (s *IdempotencyStore) loadFromFile() {
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		if !os.IsNotExist(err) {
			fmt.Printf("Idempotency store load failed: %v\n", err)
		}
		return
	}
	var records map[string]IdempotencyRecord
	if err := json.Unmarshal(data, &records); err != nil {
		fmt.Printf("Idempotency store unmarshal failed: %v\n", err)
		return
	}
	// Filter expired
	now := time.Now()
	for k, v := range records {
		if now.Before(v.ExpiresAt) {
			s.records[k] = v
		}
	}
	fmt.Printf("Idempotency store loaded %d records from %s\n", len(s.records), s.filePath)
}

func (s *IdempotencyStore) saveToFile() {
	s.mu.RLock()
	defer s.mu.RUnlock()
	data, err := json.MarshalIndent(s.records, "", "  ")
	if err != nil {
		fmt.Printf("Idempotency store marshal failed: %v\n", err)
		return
	}
	if err := os.WriteFile(s.filePath, data, 0644); err != nil {
		fmt.Printf("Idempotency store save failed: %v\n", err)
	}
}

func (s *IdempotencyStore) saveToFileAsync() {
	go s.saveToFile()
}

func (s *IdempotencyStore) cleanupLoop() {
	ticker := time.NewTicker(1 * time.Hour)
	for range ticker.C {
		s.mu.Lock()
		now := time.Now()
		count := 0
		for k, v := range s.records {
			if now.After(v.ExpiresAt) {
				delete(s.records, k)
				count++
			}
		}
		if count > 0 {
			fmt.Printf("Idempotency store cleaned %d expired records\n", count)
			s.mu.Unlock()
			s.saveToFile()
		} else {
			s.mu.Unlock()
		}
	}
}

// For future Redis integration per Track A4
// If REDIS_URL env var is set, use Redis instead of file
// This is a stub for Phase-2 — interface already supports it

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
