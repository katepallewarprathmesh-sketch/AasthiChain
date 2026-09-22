package paymentgateway

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestFileStore_Basic(t *testing.T) {
	store := NewFileStore("test")

	// Set
	err := store.Set("key1", []byte(`{"name":"test"}`))
	assert.NoError(t, err)

	// Get
	val, err := store.Get("key1")
	assert.NoError(t, err)
	assert.Equal(t, `{"name":"test"}`, string(val))

	// All
	all, err := store.All()
	assert.NoError(t, err)
	assert.Len(t, all, 1)

	// Delete
	err = store.Delete("key1")
	assert.NoError(t, err)

	_, err = store.Get("key1")
	assert.Error(t, err)
}

func TestDB_FileBacked(t *testing.T) {
	db := NewTestDB()
	assert.Equal(t, DBFileBacked, db.Mode)
	assert.True(t, db.IsFileBacked())
	assert.False(t, db.IsPersistent())

	err := db.Init()
	assert.NoError(t, err)

	// Save and load
	err = SaveJSON(db.Properties, "PROP-001", map[string]interface{}{"assetId": "PROP-001", "title": "Test"})
	assert.NoError(t, err)

	var loaded map[string]interface{}
	err = LoadJSON(db.Properties, "PROP-001", &loaded)
	assert.NoError(t, err)
	assert.Equal(t, "PROP-001", loaded["assetId"])

	// Stats
	stats, err := db.Stats()
	assert.NoError(t, err)
	assert.Equal(t, 1, stats["properties"])
}

func TestDB_SaveLoadJSON(t *testing.T) {
	db := NewTestDB()

	type TestStruct struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	}

	original := TestStruct{ID: "123", Name: "Test Property"}
	err := SaveJSON(db.Properties, "123", original)
	assert.NoError(t, err)

	var loaded TestStruct
	err = LoadJSON(db.Properties, "123", &loaded)
	assert.NoError(t, err)
	assert.Equal(t, original.ID, loaded.ID)
	assert.Equal(t, original.Name, loaded.Name)
}

func TestDB_Stats(t *testing.T) {
	db := NewTestDB()

	SaveJSON(db.Properties, "PROP-001", map[string]string{"id": "PROP-001"})
	SaveJSON(db.Balances, "BAL-001", map[string]string{"id": "BAL-001"})
	SaveJSON(db.Transfers, "TXN-001", map[string]string{"id": "TXN-001"})

	stats, err := db.Stats()
	assert.NoError(t, err)
	assert.Equal(t, 1, stats["properties"])
	assert.Equal(t, 1, stats["balances"])
	assert.Equal(t, 1, stats["transfers"])
}

func TestGetDB_Singleton(t *testing.T) {
	// Test singleton pattern
	db1, err1 := GetDB()
	db2, err2 := GetDB()

	// Both should succeed or both fail similarly
	if err1 == nil && err2 == nil {
		assert.Equal(t, db1, db2, "GetDB should return singleton")
	}
}
