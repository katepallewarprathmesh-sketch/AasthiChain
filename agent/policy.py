"""What the agent decides, as pure functions.

WHY THE POLICY IS SEPARATE FROM THE RUNTIME
The interesting question about an autonomous agent is never "can it make a
request". It is "what would it decide, and can you check that decision without
letting it loose on a live rail". So every judgement lives here, as functions
from a snapshot of rail state to a list of intents, with no I/O and no clock of
its own. ``runtime.py`` does the talking.

That split is what makes the harness testable: ``agent/tests/test_policy.py``
feeds these functions hand-built states and asserts on the intents, including
the ones they must refuse to form.

THE DESIGN RULE
The policy proposes; it never assumes. Every intent carries the reason it was
formed and the figure it is worth, and the runtime asks the rail whether the
mandate permits it before acting. An agent that decides it is allowed is not
operating under a mandate, it is operating under a habit.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Sequence

# Actions the rail knows how to bound.
#
# The caretaker forms only RELEASE_CONDITION intents, which is a deliberate
# limit and not an oversight: an agent that could also sell things is a
# different product with a different risk, and adding an action here should be
# somebody's decision rather than a convenience. The rest of the list is here
# so the CLI can refuse to request a mandate for an action the rail would not
# recognise, which otherwise fails at the first act rather than at setup.
KNOWN_ACTIONS: tuple[str, ...] = (
    "SETTLE_DVP",
    "PLACE_OFFER",
    "ANCHOR_DOCUMENT",
    "DELIVER_WORK",
    "RELEASE_CONDITION",
)

#: The only action this policy will ever form an intent for.
POLICY_ACTION = "RELEASE_CONDITION"


@dataclass(frozen=True)
class Intent:
    """One act the agent proposes. The rail still has to agree."""

    action: str
    condition_id: str
    asset_id: str
    credential_id: str
    amount_paise: int
    because: str


@dataclass(frozen=True)
class Skip:
    """One act the agent declined to propose, and why."""

    condition_id: str
    why: str


@dataclass(frozen=True)
class Decision:
    intents: list[Intent] = field(default_factory=list)
    skipped: list[Skip] = field(default_factory=list)


@dataclass(frozen=True)
class Limits:
    """The bounds as the mandate states them, read once per pass."""

    remaining_paise: int | None = None
    assets: Sequence[str] = ()
    actions: Sequence[str] = ()


@dataclass(frozen=True)
class Stop:
    stop: bool
    why: str = ""


def _eq(a: Any, b: Any) -> bool:
    return str(a or "").strip().lower() == str(b or "").strip().lower()


def _strip_did(issuer: Any) -> str:
    text = str(issuer or "")
    prefix = "did:aasthi:"
    return text[len(prefix):] if text.startswith(prefix) else text


def _parse_time(value: Any) -> float | None:
    """Parse an RFC3339 timestamp to epoch milliseconds, or None.

    The rail answers in RFC3339 with a trailing Z, which ``fromisoformat``
    rejected before Python 3.11. Returning None rather than raising matters:
    an unparseable deadline must not crash a pass, it must leave the agent
    unable to prove the condition is still live, and the caller treats that as
    a reason to act normally rather than a reason to act recklessly.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp() * 1000


def find_credential(credentials: Iterable[dict], condition: dict) -> tuple[str, str]:
    """Find the credential that actually satisfies a condition.

    Returns ``(credential_id, why_not)``. Every clause here is a way the agent
    could have been sloppy and released somebody's money against the wrong
    piece of paper. "A credential exists for this person" is not the claim the
    condition made, and treating the two as equivalent is the whole class of
    bug worth preventing.
    """
    want = str(condition.get("credentialType") or "").strip()
    if not want:
        return "", "the condition names no credential type, so nothing can satisfy it"

    asserter = condition.get("asserter")
    saw_type = saw_subject = saw_revoked = False

    for record in credentials or ():
        cred = (record or {}).get("credential")
        if not cred:
            continue

        types = cred.get("type")
        types = types if isinstance(types, list) else [types]
        if want not in types:
            continue
        saw_type = True

        subject = (cred.get("credentialSubject") or {}).get("id", "")
        if not _eq(subject, asserter):
            continue
        saw_subject = True

        # The asset matters. A title credential for a different property is a
        # valid credential and the wrong one.
        cred_asset = (cred.get("credentialSubject") or {}).get("assetId", "")
        if condition.get("assetId") and cred_asset and not _eq(cred_asset, condition["assetId"]):
            continue

        # If the condition named an issuer, only that issuer will do.
        # Otherwise the condition is satisfiable by anyone willing to sign,
        # which is not a condition.
        if condition.get("issuer") and not _eq(_strip_did(cred.get("issuer")), condition["issuer"]):
            continue

        if record.get("revoked"):
            saw_revoked = True
            continue

        return str(cred.get("id") or ""), ""

    if saw_revoked:
        return "", f"the only matching {want} has been revoked"
    if saw_subject:
        return "", f"a {want} for {asserter} exists but not for this asset or issuer"
    if saw_type:
        return "", f"a {want} exists but not one issued to {asserter}"
    return "", f"no {want} has been issued to {asserter}"


def decide(
    conditions: Iterable[dict],
    credentials: Iterable[dict],
    now_ms: float,
    limits: Limits,
    principal: str = "",
) -> Decision:
    """The caretaker policy.

    The agent's job is deliberately dull: a conditional settlement is money
    that has been locked against a named credential, and it sits locked until
    somebody presents that credential. Nobody watches for that, so cash stays
    reserved after the condition it was waiting for has already been satisfied,
    and expires back to the payer for no reason other than inattention.

    A dull job is the right first job for an automated actor. The failure mode
    of a clever agent is that nobody can say what it will do; the failure mode
    of this one is that a release happens a few seconds earlier than a person
    would have managed.
    """
    intents: list[Intent] = []
    skipped: list[Skip] = []
    credentials = list(credentials or ())

    def note(cond: dict, why: str) -> None:
        skipped.append(Skip(str(cond.get("conditionId") or ""), why))

    # The ceiling is spent down as intents are formed, not checked against the
    # opening figure each time. Three conditions that each fit under the
    # headroom do not all fit together, and an agent that forms all three
    # intents has the rail refuse the last one after the first two have already
    # moved somebody's money. A budget is a running total or it is not a
    # budget.
    budget = limits.remaining_paise if limits.remaining_paise is not None else None

    for cond in conditions or ():
        if not cond or cond.get("status") != "OPEN":
            continue

        # The agent presents on behalf of exactly one person. A condition
        # somebody else is entitled to assert is none of its business, even
        # when the credential happens to resolve, and the rail would refuse it
        # with ERR_UMI_CONDITION_NOT_ASSERTER. Forming the intent anyway would
        # put a refusal on a stranger's agreement and bump its refusal count.
        if principal and not _eq(cond.get("asserter"), principal):
            note(cond, f"{cond.get('asserter')} is entitled to assert this, not {principal}")
            continue

        # Expiry is the rail's business, not the agent's. Releasing a lapsed
        # condition would be the agent overriding a decision the rail has
        # already made, which is exactly what a mandate exists to prevent.
        deadline = _parse_time(cond.get("deadlineAt"))
        if deadline is not None and now_ms >= deadline:
            note(cond, "the deadline has passed; an expiry is the rail's to apply "
                       "and not an agent's to reverse")
            continue

        credential_id, why_not = find_credential(credentials, cond)
        if not credential_id:
            note(cond, why_not)
            continue

        amount = int(cond.get("cashPaise") or 0)
        if amount <= 0:
            note(cond, "no cash is locked, so there is nothing to release")
            continue

        # Local bounds are a courtesy, not the control. The rail re-checks
        # every one of these and its answer is the one that counts. Checking
        # here only saves spending the operator's attention on requests already
        # known to be refused.
        if limits.actions and POLICY_ACTION not in limits.actions:
            note(cond, f"this mandate does not cover {POLICY_ACTION}")
            continue
        if limits.assets and cond.get("assetId") and cond["assetId"] not in limits.assets:
            note(cond, f"the mandate does not cover {cond['assetId']}")
            continue
        if budget is not None and amount > budget:
            note(cond, f"needs {amount} paise and the mandate has {budget} left")
            continue
        if budget is not None:
            budget -= amount

        intents.append(Intent(
            action=POLICY_ACTION,
            condition_id=str(cond.get("conditionId") or ""),
            asset_id=str(cond.get("assetId") or ""),
            credential_id=credential_id,
            amount_paise=amount,
            because=(f"{cond.get('credentialType')} {credential_id} is issued to "
                     f"{cond.get('asserter')} and not revoked, and the condition waiting on it "
                     "is still open"),
        ))

    # Deterministic order. An agent whose behaviour depends on iteration order
    # cannot be reproduced from its log, and a log you cannot replay is not
    # evidence of anything.
    intents.sort(key=lambda i: i.condition_id)
    skipped.sort(key=lambda s: s.condition_id)
    return Decision(intents=intents, skipped=skipped)


def should_stop(
    passport: dict | None,
    mandate: dict | None,
    killed: bool = False,
    now_ms: float | None = None,
) -> Stop:
    """The stop rule, checked before every single act rather than once at startup.

    Four independent things can stop this agent, and any one is sufficient: the
    operator's kill file, the passport, the mandate, and a mismatch between the
    first two. A runtime that checks its authority once and then trusts its own
    memory of it is precisely the thing a revocation needs to defeat.
    """
    if killed:
        return Stop(True, "the operator stop file is present")
    if not passport:
        return Stop(True, "this agent is not on the register")

    # The register publishes a status string, not a boolean. Reading a boolean
    # that is not there yields None, which is falsy, which is a revoked agent
    # that keeps running: exactly the bug this check exists to prevent. So
    # match on the status, by name.
    #
    # REVOKED stops it, which is the rail's rule too.
    #
    # REVEAL_PENDING also stops it, and here this runtime is deliberately
    # stricter than the rail. A pending reveal means somebody has opened a
    # formal request to establish who is behind this pseudonym, with a stated
    # trigger. Continuing to move other people's money while that is in
    # progress is the wrong default, and pausing costs nothing that cannot be
    # resumed. The rail should not impose that on every operator; a
    # well-behaved agent should impose it on itself.
    standing = str(passport.get("status") or "").upper()
    if passport.get("revoked") is True or standing == "REVOKED":
        return Stop(True, "the passport has been withdrawn")
    if standing == "REVEAL_PENDING":
        return Stop(True, "an identification request is open against this agent; "
                          "it pauses rather than keeps spending")

    if not mandate:
        return Stop(True, "no mandate could be read")

    # The passport and the mandate must name the same identity.
    #
    # MandateRegistry.Authorise checks standing against the name written on the
    # mandate. Grant a mandate to a free-text agent name while the passport
    # lives under its generated pseudonym and Standing reports the agent as
    # unregistered, the withdrawal branch never fires, and revoking the
    # passport stops nothing: the kill switch is wired to a name nothing uses.
    # The agent refuses to run in that configuration rather than run
    # unstoppably.
    agent_id = passport.get("agentId")
    named = mandate.get("agent")
    if agent_id and named and not _eq(agent_id, named):
        return Stop(True, f"the mandate names {named} but the passport is {agent_id}; "
                          "revoking the passport would not stop this agent, so it will not start")

    if mandate.get("revoked"):
        return Stop(True, f"the mandate was revoked by {mandate.get('revokedBy') or 'somebody'}")

    expires = _parse_time(mandate.get("expiresAt"))
    if expires is not None and now_ms is not None and expires <= now_ms:
        return Stop(True, "the mandate has expired")

    headroom = int(mandate.get("limitPaise") or 0) - int(mandate.get("spentPaise") or 0)
    if headroom <= 0:
        return Stop(True, "the mandate has no headroom left")

    return Stop(False, "")
