# Anti money laundering: a list, a case, a report

## What was wrong with what was here before

Payments were scored for fraud and a reporting threshold was applied, and that was described as
AML. It was not. Three things were missing, and they are the three things the work actually
consists of.

**A list.** Sanctions and politically exposed person screening is a name-matching problem against a
published list. A system with no list is not screening; it is asserting. And the matching is hard in
exactly the ways that matter: transliteration (Volkanov, Volkanoff), word order, dropped middle
names, honorifics, company suffixes.

**A case.** A hit is not a decision. Somebody picks it up, writes down what they concluded and why,
and either clears it or escalates it. An alert with no case file behind it cannot be audited and
cannot be defended.

**A report.** The output of an escalation is a suspicious transaction report: a structured document
naming the subject, the transaction, the grounds for suspicion and whoever filed it. Until that
artefact exists, "we report suspicious activity" is a sentence rather than a capability.

## How matching works

Names are normalised first: lowercased, punctuation removed, honorifics dropped (`Mr`, `Shri`,
`Dr`), whitespace collapsed. Each name is then compared as a bag of tokens against the primary name
and every alias on each list entry. Every token of the shorter name is paired with its best partner
in the longer one by edit distance, and the result is scaled by how much of the longer name was
covered, so a lone surname cannot score as a hit against a full name.

Two thresholds, published on the status endpoint rather than buried:

| Similarity | What happens |
| --- | --- |
| 0.93 and above | The payment stops. A case opens. |
| 0.80 to 0.93 | The payment continues and a case opens, because a resemblance is a question rather than an answer. |
| Below 0.80 | Clear, and the response still names the list it cleared against. |

Blocking at 0.85 would stop every payment to anybody sharing a surname with a listed person, which
is how screening gets switched off in practice. Letting a near match through unexamined is the
opposite failure. The two thresholds exist so that neither is necessary.

Every match carries its score and a plain sentence explaining it ("2 of 3 name parts matched
exactly; overall similarity 0.94"). A reviewer who cannot see why something matched cannot judge
whether it should have.

## The list

The list shipped in this repository is **synthetic**. Every name in it is invented. Publishing a
copy of a real sanctions list inside a demonstration project invites somebody to rely on it, and a
stale sanctions list is worse than none at all. Every surface that touches screening says which
list is loaded and whether it is the synthetic one.

A deployment holding a licensed copy of a real list points `AML_WATCHLIST_PATH` at it. The format is
the same: name, aliases, kind (`SANCTION` or `PEP`), programme, country, source. Nothing else
changes, and the status endpoint then reports the list as configured rather than synthetic.

The list is readable by anybody. A person refused by a screen is entitled to know what they were
screened against, and a list nobody can read cannot be corrected.

## The case file

A case records the screening that caused it, the payment it relates to, and every step since, each
one timestamped and attributed:

```
OPEN  ->  UNDER_REVIEW  ->  CLEARED
                        ->  REPORTED
```

Clearing a case requires stated grounds; "cleared" with no reason recorded is exactly what an audit
finds and cannot explain. A cleared case cannot be reported afterwards, and a reported case cannot
be cleared: reopening a settled question means opening a new case, which leaves the first decision
visible rather than editing it away.

Cases and reports are supervisor-only, because they carry names and allegations. The list and the
thresholds are public.

## The report

Escalation produces a document: subject, counterparty, amount, the related payment reference, the
stated grounds, the matches that triggered it, and a narrative. It is hashed with SHA-256 and the
hash is committed to the ledger, so the copy somebody holds and the copy that was produced can be
shown to be the same one. The response says how to check it: recompute the hash over the document
with its hash field emptied, and compare it to the block.

The document says, in its own text, that it has not been filed with the Financial Intelligence Unit
or any other authority, because it has not. This project files nothing with anybody.

## Where it bites

Cross-border transfers screen the originator and the beneficiary before anything moves. Those are
the names the Travel Rule already requires above the threshold, so there is nothing extra to
collect. A listed beneficiary is refused with `ERR_UMI_AML_BLOCKED`, which is deliberately a
different code from a corridor refusal: the two have entirely different remedies. A near match lets
the payment go and leaves a case open before it lands, which is what a bank actually does.

## What this is not

It is not a compliance programme. There is no customer risk rating, no transaction monitoring
typology library, no ongoing screening of existing customers against list updates, and no
regulatory filing. The screening is name-only: no date of birth, no identity document, no
secondary-identifier scoring, all of which a real screening system uses to cut false positives.
Nothing here is a regulatory determination, and the list designates nobody.
