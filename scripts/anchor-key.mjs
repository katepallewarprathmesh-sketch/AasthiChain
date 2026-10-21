#!/usr/bin/env node
// Generate the keypair the rail uses to publish ledger anchors to Solana.
//
// Writing an anchor costs a transaction fee, so the rail refuses to write
// until it has a funded key. This prints one, in the two forms you need: the
// address to fund, and the base58 secret to hand the rail.
//
//   node scripts/anchor-key.mjs
//
// Then fund the address at https://faucet.solana.com (devnet, sign in with
// GitHub), export SOLANA_SECRET_B58 and restart the rail. Devnet SOL has no
// value: do not reuse this key for anything on mainnet.

import { generateKeyPairSync } from 'node:crypto';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const base58 = (bytes) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = ALPHABET[0] + out;
  }
  return out;
};

const { publicKey, privateKey } = generateKeyPairSync('ed25519');

// The raw 32-byte seed is the tail of the PKCS#8 DER encoding, and the raw
// public key is the tail of the SPKI encoding. Both are fixed-length for
// ed25519, so slicing from the end is safe.
const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);

console.log('');
console.log('  Anchor address (fund this):  ' + base58(pub));
console.log('  SOLANA_SECRET_B58 (secret):  ' + base58(seed));
console.log('');
console.log('  1. Fund the address with devnet SOL: https://faucet.solana.com');
console.log('  2. export SOLANA_SECRET_B58=<the secret above>');
console.log('  3. Restart the rail, then POST /umi/anchors as a supervisor.');
console.log('');
console.log('  Devnet only. Never point this at a key that holds real value.');
console.log('');
