# Signed feeds: how an outside fact gets onto the rail

Almost nothing interesting on a settlement rail is decided by the rail
alone. An exchange rate, a reserve attestation, a registry status, a price:
each one is a claim about the world outside, and the rail has to decide
whether to act on it.

Before this existed, every such bridge here was hand wired. The
cross-border funding leg is the clearest example. Its rupee-per-dollar rate
was a configured constant, `88.50`, and the quote described it as
"indicative, configured on the rail". That sentence was honest, which is
the only reason it was tolerable. But the shape of it was wrong in a way
that gets worse the moment anybody replaces the constant with something
live: there was nowhere to say who asserted the number, when they asserted
it, or at what age it should stop being believed.

A feed without those three answers is not a data source. It is a variable
with a REST API in front of it.

## What a feed is here

A feed is a declaration before it is a value:

- **who may publish to it.** A named list of holders, nobody else.
- **the age at which it stops being usable.** Mandatory. A feed registered
  without `maxStalenessSec` is refused, because a freshness contract that
  is optional is a freshness contract nobody writes.
- **how many publishers must agree** before a value exists at all, and
- **how far apart they may be** before the result is marked disputed.

Every reading is signed by the publisher, under a key already in the key
register (see `KEYS.md`). The feed inherits its trust from a key that was
screened before it ever signed anything, which is the whole point of the
join between the two.

## What gets refused

The useful part of a feed is not the number it returns. It is the list of
things it will not accept. In order:

| Refusal | Why |
| --- | --- |
| the holder is not a publisher on this feed | authorisation is per feed, not global |
| the key is not in the register, or is revoked | a signature under an unknown key is attributable to nobody |
| the key belongs to a different holder | the signer and the claimed publisher must be the same party |
| the signature does not cover the value, timestamp and nonce | the usual: a value changed after signing |
| the nonce was used before on this feed | otherwise one good reading can be replayed forever |
| the timestamp is at or before this publisher's last one | stops a replay dressed as a new reading |
| the timestamp is in the future | a reading dated forward never goes stale, which defeats the contract |

Refusals are written to the chain as `UMI_FEED_REJECTED`, with the reason.
A feed that quietly drops bad input teaches you nothing about who is
sending it.

## What it returns, and what it refuses to return

`Value()` gives the **median** of the fresh publishers, or a refusal. The
refusals are `STALE`, `NO_QUORUM`, `NO_DATA`, `RETIRED` and
`UNATTRIBUTABLE`.

The important one is `STALE`. A stale feed does not return its last value
with a warning attached; it returns no value. Last-value-with-a-warning is
how a frozen price keeps clearing trades: every caller that forgets to read
the warning behaves exactly as if the data were fresh. Refusing is the only
version of that contract which cannot be ignored by accident.

`UNATTRIBUTABLE` is the one inherited from the key register. If a
publisher's key is revoked as compromised, its past readings do not merely
stop counting going forward: they stop being evidence of anything, because
somebody else may have held that key the whole time.

A reading from a publisher more than `maxDeviationPct` from the median is
kept, not dropped, and the value is marked **disputed**. Discarding the
outlier would hide the disagreement, and the disagreement is usually the
interesting part.

## Does it earn its place

The test, as with every other feature here: not "was the input added", but
"does anything behave differently".

The rail ships with the rupee-per-dollar feed **declared and empty**. So on
a cold start the cross-border quote still prices at the indicative constant
and `/umi/crossborder/rules` says so in plain terms:

```
"rateProvenance": {
  "source":    "INDICATIVE_CONSTANT",
  "signed":    false,
  "feedId":    "FX.INR.USD",
  "feedState": "NO_DATA",
  "note":      "... this feed has never been published to"
}
```

Publish one signed reading at a different number and the quote moves to it,
the rules card relabels itself `SIGNED_FEED`, and the intent carries the
publisher, the key id, the observation age and the block the reading landed
in. `tests/oracle.test.mjs` runs exactly that sequence against a live rail
and fails if the number does not move. That is the ablation: with the feed
empty the system prices one way, with one signed reading it prices another,
and in both cases it says which.

What this does **not** show is that the rate is correct. Nobody is
publishing a real rupee-per-dollar rate to this deployment. The mechanism
is real; the number is still a demo number, and the posture route says so.

## A canonical timestamp, and why

The signed message is:

```
aasthi-feed|v1|<feedId>|<value>|<observedAt>|<nonce>
```

`observedAt` is UTC with exactly three decimal places, always. The first
implementation used RFC3339Nano, which trims trailing zeros. That meant a
publisher whose clock happened to land on a round millisecond built a
different string from the one the rail rebuilt, and got back a signature
error that pointed at the wrong thing entirely: roughly one reading in ten,
failing for a reason the error message actively misled you about. A
canonical form cannot be left to whichever time library each publisher
happens to use.

## What this is not

It is not a decentralised oracle network. There is no staking, no slashing,
no permissionless publisher set and no economic penalty for lying. A
publisher on a feed here is trusted because somebody named it, and the only
real defence against a dishonest one is quorum plus a visible deviation.

The posture route says all of that, unprompted, which is the point of
having a posture route.
