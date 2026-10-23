package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

// This store exists for one reason, stated in its own comment: a gateway
// restart must not let the same mint happen twice. That claim was never
// tested. Everything below tests the claim rather than the implementation.

func newStoreIn(t *testing.T, dir string) *IdempotencyStore {
	t.Helper()
	t.Setenv("IDEMPOTENCY_DATA_DIR", dir)
	s := NewIdempotencyStore()
	// Set and Delete persist in a goroutine, so a write can still be in flight
	// when the test returns. TempDir's own cleanup then races it and fails the
	// test with "directory not empty" for a reason that has nothing to do with
	// what was being tested. Drain first: remove the file until it stays gone.
	t.Cleanup(func() {
		path := filepath.Join(dir, "idempotency.json")
		deadline := time.Now().Add(2 * time.Second)
		gone := 0
		for time.Now().Before(deadline) && gone < 3 {
			if err := os.Remove(path); err != nil && os.IsNotExist(err) {
				gone++
			} else {
				gone = 0
			}
			time.Sleep(10 * time.Millisecond)
		}
	})
	return s
}

// waitForFile gives the asynchronous writer a moment. Set() saves in a
// goroutine, so a test that reads the file immediately is testing the
// scheduler.
func waitForFile(t *testing.T, path string) []byte {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(path); err == nil && len(data) > 2 {
			return data
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("nothing was written to %s", path)
	return nil
}

func TestAnAnswerComesBackUnderItsKey(t *testing.T) {
	s := newStoreIn(t, t.TempDir())

	if _, ok := s.Get("mint-1"); ok {
		t.Fatal("an unknown key must miss, not return a zero value that reads like a hit")
	}

	s.Set("mint-1", map[string]interface{}{"assetId": "PROP-1", "tokens": 100})
	got, ok := s.Get("mint-1")
	if !ok {
		t.Fatal("the stored answer should come back")
	}
	m, isMap := got.(map[string]interface{})
	if !isMap || m["assetId"] != "PROP-1" {
		t.Fatalf("the stored answer came back altered: %#v", got)
	}

	// Different key, different answer. A store that returns the last write
	// for everything would pass the test above.
	if _, ok := s.Get("mint-2"); ok {
		t.Fatal("a second key must not inherit the first one's answer")
	}
}

// The actual promise: the record survives the process.
func TestARestartDoesNotForgetTheAnswer(t *testing.T) {
	dir := t.TempDir()
	first := newStoreIn(t, dir)
	first.Set("mint-restart", map[string]interface{}{"txId": "abc123"})
	waitForFile(t, filepath.Join(dir, "idempotency.json"))

	// A new store in the same directory is a restarted gateway.
	second := newStoreIn(t, dir)
	got, ok := second.Get("mint-restart")
	if !ok {
		t.Fatal("after a restart the gateway would mint a second time: the record was lost")
	}
	m, _ := got.(map[string]interface{})
	if m["txId"] != "abc123" {
		t.Fatalf("the recovered answer is not the one that was stored: %#v", got)
	}
}

func TestAnExpiredRecordIsNotAnAnswer(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "idempotency.json")

	// Write the file by hand so the expiry is in the past: a record stored
	// now expires in 24 hours and no test should sleep that long.
	stale := map[string]IdempotencyRecord{
		"old": {
			Key:       "old",
			Response:  map[string]interface{}{"txId": "stale"},
			CreatedAt: time.Now().Add(-48 * time.Hour),
			ExpiresAt: time.Now().Add(-24 * time.Hour),
		},
		"fresh": {
			Key:       "fresh",
			Response:  map[string]interface{}{"txId": "current"},
			CreatedAt: time.Now(),
			ExpiresAt: time.Now().Add(time.Hour),
		},
	}
	data, err := json.Marshal(stale)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	s := newStoreIn(t, dir)
	if _, ok := s.Get("old"); ok {
		t.Fatal("an expired record must not be replayed as a current answer")
	}
	if _, ok := s.Get("fresh"); !ok {
		t.Fatal("a record inside its window must survive the load")
	}
}

func TestDeleteRemovesTheRecord(t *testing.T) {
	s := newStoreIn(t, t.TempDir())
	s.Set("k", "v")
	if _, ok := s.Get("k"); !ok {
		t.Fatal("precondition: the record should be there")
	}
	s.Delete("k")
	if _, ok := s.Get("k"); ok {
		t.Fatal("a deleted record must not answer")
	}
}

// A corrupt file is a thing that happens: a container killed mid-write. The
// gateway must start, not crash, and must not pretend the garbage was data.
func TestACorruptFileDoesNotStopTheGatewayStarting(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "idempotency.json"), []byte("{not json"), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}
	s := newStoreIn(t, dir)
	if _, ok := s.Get("anything"); ok {
		t.Fatal("a corrupt file must not produce answers")
	}
	s.Set("after", "ok")
	if _, ok := s.Get("after"); !ok {
		t.Fatal("the store must still be usable after reading a corrupt file")
	}
}

// Run with -race: the gateway serves concurrent requests, and this store is
// shared between all of them.
func TestConcurrentWritersDoNotRaceOrLoseRecords(t *testing.T) {
	s := newStoreIn(t, t.TempDir())
	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			key := string(rune('a'+n%26)) + "-key"
			s.Set(key, n)
			s.Get(key)
		}(i)
	}
	wg.Wait()
	if _, ok := s.Get("a-key"); !ok {
		t.Fatal("writes made under contention should still be readable")
	}
}
