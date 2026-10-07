package drunix

// IPFS content addressing, computed locally.
//
// A CID is not a link to a file — it IS the hash of the file, wrapped in a
// self-describing envelope that says which hash function and which codec were
// used. That is the whole reason it is useful here: a document's name is
// derived from its bytes, so serving different bytes under the same name is
// impossible, and a verifier can check a document without trusting us, our
// database, or our uptime.
//
// Why this is hand-rolled rather than imported:
//
//   - Computing a CID needs no network and no daemon. It is a hash and a
//     prescribed byte layout. Pulling in go-ipfs to do sha256 and base32 would
//     add a very large dependency tree to a service that currently has none.
//   - The rail must be able to tell a caller the correct CID even with no IPFS
//     node reachable. Pinning then becomes optional and swappable instead of a
//     hard runtime dependency.
//
// The output is the real thing, not a lookalike. For a file under the chunk
// size this produces exactly what
//
//	ipfs add --cid-version=1 --raw-leaves=true
//
// produces, and the test suite checks that against a published vector rather
// than against this implementation's own output. Larger files are split into a
// UnixFS DAG the same way IPFS splits them, so the root CID of a 40-page
// scanned deed matches too.
//
// Layout of a CIDv1:
//
//	multibase | version | codec | multihash
//	   'b'    |  0x01   | 0x55  | 0x12 0x20 <32-byte sha2-256>
//	(base32)                raw   sha2-256, 32 bytes
//
// Everything after the multibase prefix is base32-lowercase without padding.

import (
	"crypto/sha256"
	"encoding/base32"
	"errors"
	"fmt"
	"strings"
)

const (
	cidVersion1 = 0x01
	// codecRaw marks a block that is exactly the file bytes, nothing else.
	codecRaw = 0x55
	// codecDagPB marks a UnixFS node — the structure IPFS uses to stitch the
	// chunks of a large file back together.
	codecDagPB = 0x70
	// mhSHA256 is the multihash code for sha2-256, followed by length 32.
	mhSHA256 = 0x12
	mhLen32  = 0x20

	// ipfsChunkSize is the IPFS default chunker setting. Matching it is what
	// makes the root CID of a large file agree with a real node.
	ipfsChunkSize = 262144 // 256 KiB

	// unixfsTypeFile is the UnixFS Data_DataType enum value for a file.
	unixfsTypeFile = 2
)

// base32NoPad is multibase base32 lowercase without padding ('b' prefix).
var base32NoPad = base32.NewEncoding("abcdefghijklmnopqrstuvwxyz234567").WithPadding(base32.NoPadding)

// ErrBadCID is returned for a string that is not a CID this code can read.
var ErrBadCID = errors.New("ERR_BAD_CID")

// CIDFor returns the IPFS CIDv1 for a document's bytes, along with the plain
// SHA-256 hex that the rest of AasthiChain already uses for deeds.
//
// Both are returned deliberately: the CID is what makes the document
// retrievable and self-verifying on IPFS, while the hex digest is what the
// existing chaincode, the `hash~` uniqueness index and
// /api/properties/:id/verify-document speak. Keeping both means the new
// registry interoperates with what is already on the chain instead of
// replacing it.
func CIDFor(content []byte) (cid string, sha256hex string) {
	sum := sha256.Sum256(content)
	if len(content) <= ipfsChunkSize {
		return encodeCID(codecRaw, sum[:]), fmt.Sprintf("%x", sum)
	}
	return unixfsRootCID(content), fmt.Sprintf("%x", sum)
}

// encodeCID assembles version + codec + multihash and multibase-encodes it.
func encodeCID(codec byte, digest []byte) string {
	buf := make([]byte, 0, 4+len(digest))
	buf = append(buf, cidVersion1, codec, mhSHA256, mhLen32)
	buf = append(buf, digest...)
	return "b" + base32NoPad.EncodeToString(buf)
}

// cidBytes is the binary form of a CID, which is what goes inside a DAG link
// (links hold raw CID bytes, not the text form).
func cidBytes(codec byte, digest []byte) []byte {
	buf := make([]byte, 0, 4+len(digest))
	buf = append(buf, cidVersion1, codec, mhSHA256, mhLen32)
	return append(buf, digest...)
}

// DecodeCID recovers the codec and digest from a CIDv1 string. It is the check
// that a caller-supplied CID is well-formed before it is ever stored or used
// as a lookup key.
func DecodeCID(cid string) (codec byte, digest []byte, err error) {
	s := strings.TrimSpace(cid)
	if len(s) < 10 || s[0] != 'b' {
		return 0, nil, fmt.Errorf("%w: expected a base32 CIDv1 starting with 'b'", ErrBadCID)
	}
	raw, decErr := base32NoPad.DecodeString(strings.ToLower(s[1:]))
	if decErr != nil {
		return 0, nil, fmt.Errorf("%w: not valid base32", ErrBadCID)
	}
	if len(raw) != 36 {
		return 0, nil, fmt.Errorf("%w: expected 36 bytes, got %d", ErrBadCID, len(raw))
	}
	if raw[0] != cidVersion1 {
		return 0, nil, fmt.Errorf("%w: only CIDv1 is supported", ErrBadCID)
	}
	if raw[2] != mhSHA256 || raw[3] != mhLen32 {
		return 0, nil, fmt.Errorf("%w: only sha2-256 digests are supported", ErrBadCID)
	}
	return raw[1], raw[4:], nil
}

// VerifyCID reports whether content actually hashes to cid. This is the
// function that makes tamper detection a local computation: nobody has to
// trust a stored flag, they re-derive the name from the bytes.
func VerifyCID(cid string, content []byte) bool {
	want, _ := CIDFor(content)
	return strings.EqualFold(strings.TrimSpace(cid), want)
}

// ---------------------------------------------------------------------------
// UnixFS for files larger than one chunk
// ---------------------------------------------------------------------------
//
// IPFS does not hash a large file as one blob. It splits it into 256 KiB
// chunks, stores each as its own block, and builds a small "table of contents"
// node (dag-pb, carrying a UnixFS Data message) that links the chunks in
// order. The CID of that node is the file's CID. Reproducing the structure is
// the only way our CID for a big PDF equals the one a real node would report.
//
// Both message formats are protobuf, so the two encoders below are the minimum
// protobuf writer needed — varints, length-delimited fields, nothing else.

// putUvarint appends a protobuf base-128 varint.
func putUvarint(b []byte, v uint64) []byte {
	for v >= 0x80 {
		b = append(b, byte(v)|0x80)
		v >>= 7
	}
	return append(b, byte(v))
}

// pbTag appends a protobuf field key (field number + wire type).
func pbTag(b []byte, field int, wire int) []byte {
	return putUvarint(b, uint64(field)<<3|uint64(wire))
}

// pbBytes appends a length-delimited field.
func pbBytes(b []byte, field int, val []byte) []byte {
	b = pbTag(b, field, 2)
	b = putUvarint(b, uint64(len(val)))
	return append(b, val...)
}

// pbVarintField appends a varint field.
func pbVarintField(b []byte, field int, v uint64) []byte {
	b = pbTag(b, field, 0)
	return putUvarint(b, v)
}

// unixfsFileData builds the UnixFS Data message for a chunked file:
// Type=File, filesize, and the size of each chunk in order.
func unixfsFileData(totalSize uint64, blockSizes []uint64) []byte {
	var d []byte
	d = pbVarintField(d, 1, unixfsTypeFile) // Type
	d = pbVarintField(d, 3, totalSize)      // filesize
	for _, bs := range blockSizes {
		d = pbVarintField(d, 4, bs) // blocksizes, repeated
	}
	return d
}

// dagPBNode builds a PBNode. Links are field 2 and Data is field 1, but
// dag-pb requires links to be serialised BEFORE data — a detail that changes
// the bytes and therefore the CID, so it is not cosmetic.
func dagPBNode(links [][]byte, data []byte) []byte {
	var n []byte
	for _, l := range links {
		n = pbBytes(n, 2, l)
	}
	if len(data) > 0 {
		n = pbBytes(n, 1, data)
	}
	return n
}

// dagPBLink builds one PBLink: the child CID, an empty name, and Tsize (the
// cumulative encoded size of the subtree the link points at).
func dagPBLink(childCID []byte, tsize uint64) []byte {
	var l []byte
	l = pbBytes(l, 1, childCID) // Hash
	l = pbBytes(l, 2, nil)      // Name — empty for file chunks
	l = pbVarintField(l, 3, tsize)
	return l
}

// unixfsRootCID chunks content the way IPFS does and returns the root CID.
func unixfsRootCID(content []byte) string {
	var links [][]byte
	var sizes []uint64
	for off := 0; off < len(content); off += ipfsChunkSize {
		end := off + ipfsChunkSize
		if end > len(content) {
			end = len(content)
		}
		chunk := content[off:end]
		sum := sha256.Sum256(chunk)
		links = append(links, dagPBLink(cidBytes(codecRaw, sum[:]), uint64(len(chunk))))
		sizes = append(sizes, uint64(len(chunk)))
	}
	node := dagPBNode(links, unixfsFileData(uint64(len(content)), sizes))
	sum := sha256.Sum256(node)
	return encodeCID(codecDagPB, sum[:])
}

// IPFSGatewayURL is where a third party can fetch a CID without touching our
// infrastructure at all — the point of content addressing. Any gateway works;
// this is only a convenience for the UI.
func IPFSGatewayURL(cid string) string {
	return "https://ipfs.io/ipfs/" + cid
}
