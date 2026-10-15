package main

import (
	"encoding/json"
	"strings"
)

// Every state value this chaincode writes has to be valid JSON.
//
// Fabric's own LevelDB state database stores opaque bytes, so index entries
// are conventionally written as a bare string, or even a single zero byte.
// Drunix keeps world state in a SQL database with a JSON column, and a bare
// string is not valid JSON there. The committing peer does not reject the
// transaction, it panics while writing the block:
//
//	ERRO [sqldb] Error in batch sql write. err:ERROR: invalid input syntax
//	for type json (SQLSTATE 22P02)
//	panic: error during commit to txmgr
//
// The block is already ordered at that point, so the peer crashes again on
// every restart as it replays it. One bare-string index entry takes the
// network down permanently.
//
// indexValue and indexRef are the only sanctioned way to write and read a
// pointer-style index entry.

// indexValue encodes an index target as a JSON string, so the value is valid
// JSON on a SQL state database and opaque bytes everywhere else.
func indexValue(target string) []byte {
	encoded, err := json.Marshal(target)
	if err != nil {
		// json.Marshal of a string cannot fail, but a silently empty index
		// entry would be worse than a quoted fallback.
		return []byte(`"` + strings.ReplaceAll(target, `"`, ``) + `"`)
	}
	return encoded
}

// indexRef decodes what indexValue wrote. Values written before this encoding
// existed are plain strings, so those are still read correctly.
func indexRef(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var target string
	if err := json.Unmarshal(raw, &target); err == nil {
		return target
	}
	return string(raw)
}
