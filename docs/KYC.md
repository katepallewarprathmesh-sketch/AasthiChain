# Electronic KYC: the flow, and the data this system refuses to hold

## What was wrong before

A wallet's KYC tier was a string in the request that opened it. The holder was `MIN_KYC` or
`FULL_KYC` because the caller said so, which made every ceiling built on top of that tier
decoration: the ₹10,000 holding cap and the ₹2,00,000 full-tier cap were enforced faithfully
against a fact nobody had checked.

A tier is now the output of a verification that has a route, evidence, an expiry and an audit
trail. It can no longer be asserted.

## What the rules say

The Reserve Bank repealed the consolidated 2016 Master Direction on 28 November 2025 and replaced
it with Directions for each type of regulated entity. The shape implemented here follows the
published position at that replacement.

**Five routes**, four of which are also the permitted ways to establish identity inside a video
session: OTP-based Aadhaar e-KYC, offline verification of Aadhaar, a record fetched from the
Central KYC Records Registry against the holder's KYC Identifier, an equivalent e-document of an
officially valid document (including one from DigiLocker), and the video process itself.

**Only the video process is treated as equal to meeting somebody.** A customer identified that way
carries no annual debit ceiling and no enhanced due diligence purely for being remote. It has
conditions, and this implementation enforces them rather than assuming them: an identified official
conducting the session, a liveness check, the PAN shown on the call, and the holder's live location
inside India. Miss one and the verification is refused with the list of what was missing.

**OTP-based Aadhaar e-KYC alone is non-face-to-face**, so it carries a ₹1,00,000 cumulative annual
debit ceiling and enhanced due diligence until it is converted, typically through a video session.

**An offline Aadhaar file goes stale in three working days.** Submit one generated earlier and the
verification is refused, naming the age of the file.

**Periodic updation**: two years for high risk, eight for medium, ten for low. Every record carries
its own expiry and reports itself as lapsed once it passes.

**The registry upload window is ten days**, with the KYC Identifier handed back to the holder so the
next institution can fetch the record instead of asking for everything again.

## The rule that changed the data model

The Aadhaar number must not be stored. Section 8A(4) of the Aadhaar Act bars an offline
verification entity from collecting it at all; an authentication user agency that does receive one
must keep it in a separate encrypted vault, reference it elsewhere by a key, and display at most the
last four digits.

This project is not a licensed user agency and operates no vault. So the honest implementation is
not "store it carefully", it is to refuse it:

> Submit a twelve-digit number in any field and the request is rejected with
> `ERR_UMI_KYC_AADHAAR_NOT_ACCEPTED`, explaining that this system does not accept, store or
> transmit Aadhaar numbers.

Refusing is better than silently dropping, which would hide the rule instead of enforcing it. What
is accepted instead is what the offline route actually produces: a reference identifier carrying
the last four digits and a timestamp, with no Aadhaar number behind it. A test asserts that no
block written by this layer contains a twelve-digit number at all.

The same restraint applies to everything else: evidence is kept as a SHA-256 hash, a PAN is kept as
its last four characters after its format is checked, and no document image or video exists.

## What is simulated, and said so everywhere

There is no UIDAI authentication call, no upload to the registry, no live video session, no face
match and no liveness check. Those need licences and counterparties this project does not have.
Every response carries that sentence.

What is real: the routes and what each one permits, the refusals and the rule behind each one, the
ceilings that follow from the route rather than from a request field, the expiry, and the fact that
the wallet tier is now written by the verification.

## What this is not

No customer risk scoring beyond the band the caller states, no sanctions screening (that is
`docs/AML.md`, and the two would be wired together in a real institution), no re-KYC reminders, no
registry reconciliation, no document forgery detection, and no handling of the cases that make real
onboarding hard: minors, non-residents, companies with beneficial owners, and holders who decline
Aadhaar entirely and are entitled to be onboarded anyway.
