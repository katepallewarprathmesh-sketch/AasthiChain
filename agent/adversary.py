#!/usr/bin/env python3
"""The adversarial harness: an agent that tries to exceed its mandate.

    python3 agent/adversary.py                 (RAIL=http://localhost:21100)

WHY THIS IS SEPARATE FROM THE CARETAKER
The caretaker in ``runtime.py`` is well behaved. It checks its own limits
before acting and stops when told, which makes it good evidence that the
happy path works and almost no evidence for the claim this rail actually
makes: that the *rail* enforces the bounds and the agent does not merely
choose to honour them. A well-behaved agent cannot distinguish a real control
from a politely observed convention.

So this one is deliberately badly behaved. It skips its own checks, presents
things it has no business presenting, reuses other people's authority,
replays what already worked, and keeps going after it has been stopped. Every
attack below is an attempt to move money the mandate does not cover.

WHY PYTHON AND HTTP RATHER THAN GO AND IN-PROCESS
Because the claim is about an outsider. An in-process test can reach fields
no caller can reach, and would prove something about the package rather than
about the rail. This one holds nothing but an identity header, a mandate id
and a socket, which is exactly what a real hostile agent would hold.

WHAT IT CANNOT TEST, STATED PLAINLY
Identity forgery. The rail trusts the X-Fabric-Identity header because
authentication happens at the proxy in front of it, so an attacker who can
already speak to the rail directly can claim to be anyone. That is a real
property of the deployment and not something this harness can refute, so it
does not pretend to: see the FORGERY note in the report.

Exit status is 0 only if every bound held.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

RAIL = os.environ.get("RAIL", "http://localhost:21100")
ASSET = "PROP-GREEN-VALLEY-PUNE-001"
OTHER_ASSET = "PROP-NOT-IN-THE-MANDATE"
TIMEOUT = 10

held = 0
breached = 0
notes: list[str] = []


@dataclass
class Reply:
    status: int
    body: dict

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300

    def says(self, *fragments: str) -> bool:
        text = json.dumps(self.body).lower()
        return any(f.lower() in text for f in fragments)


def rail(method: str, path: str, identity: str, role: str, body=None, mandate: str = "") -> Reply:
    headers = {
        "Content-Type": "application/json",
        "X-Fabric-Identity": identity,
        "X-Identity-Role": role,
    }
    if mandate:
        headers["X-Agent-Mandate"] = mandate
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(RAIL + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return Reply(res.status, _json(res.read()))
    except urllib.error.HTTPError as err:
        return Reply(err.code, _json(err.read()))
    except Exception as err:  # noqa: BLE001 - an unreachable rail is a result too
        return Reply(0, {"error": "ERR_UNREACHABLE", "message": str(err)})


def _json(raw: bytes) -> dict:
    text = (raw or b"").decode("utf-8", "replace")
    if not text:
        return {}
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text[:300]}
    return value if isinstance(value, dict) else {"data": value}


def attack(name: str, blocked: bool, detail: str = "") -> None:
    """Record one attempt. `blocked` is True when the rail refused it."""
    global held, breached
    if blocked:
        held += 1
        print(f"  held     {name}")
    else:
        breached += 1
        print(f"  BREACHED {name}" + (f"\n           {detail}" if detail else ""))


def note(text: str) -> None:
    notes.append(text)


def quote(value: str) -> str:
    return urllib.parse.quote(value, safe="")


# --------------------------------------------------------------------------


def issue_credential() -> str:
    res = rail("POST", "/umi/credentials", "registrar1", "Registrar", {
        "type": "TitleValidationCredential", "subject": "investor1",
        "assetId": ASSET, "claims": {"finding": "clear title"},
    })
    record = res.body.get("credential") or res.body
    inner = record.get("credential") if isinstance(record.get("credential"), dict) else record
    return inner.get("id", "")


def open_condition(tokens: int = 2, asserter: str = "investor1") -> dict:
    res = rail("POST", "/umi/conditions", "investor2", "Investor", {
        "assetId": ASSET, "seller": "originator1", "buyer": "investor2",
        "tokens": tokens, "pricePerTokenINR": 500,
        "credentialType": "TitleValidationCredential", "asserter": asserter,
    })
    return res.body.get("condition") or {}


def main() -> int:
    print(f"\nAdversarial agent against {RAIL}\n")

    health = rail("GET", "/umi/credentials", "investor1", "Investor")
    if health.status == 0:
        print(f"  the rail is not reachable: {health.body.get('message')}")
        print("  start it with: bash scripts/dev-stack.sh --no-evm\n")
        return 1

    credential_id = issue_credential()
    if not credential_id:
        print("  could not issue the credential the attacks need")
        return 1

    # A passport and a deliberately small mandate: one action, Rs 1,000, one
    # asset. Everything below tries to get more than that.
    passport = rail("POST", "/umi/agents", "investor1", "Investor", {
        "purpose": "an agent that will try to exceed what it was given",
        "version": "adversary-1.0.0",
        "custodians": ["registrar1", "regulator1"], "threshold": 2,
    }).body.get("agent", {})
    agent_id = passport.get("agentId", "")

    expires = (datetime.now(timezone.utc) + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    mandate = rail("POST", "/umi/mandates", "investor1", "Investor", {
        "agent": agent_id, "actions": ["RELEASE_CONDITION"],
        "limitINR": 1000, "assets": [ASSET], "expiresAt": expires,
        "purpose": "deliberately narrow, so that exceeding it is visible",
    }).body.get("mandate", {})
    mandate_id = mandate.get("mandateId", "")

    if not agent_id or not mandate_id:
        print("  could not set the adversary up; is the rail seeded?")
        return 1
    print(f"  acting as {agent_id}")
    print(f"  mandate   {mandate_id}  (RELEASE_CONDITION, Rs 1,000, {ASSET})\n")

    def as_agent(method, path, body=None, mandate_id_override=None):
        return rail(method, path, agent_id, "Agent", body,
                    mandate=mandate_id if mandate_id_override is None else mandate_id_override)

    # --- 1. the ceiling ----------------------------------------------------
    # Rs 5,000 of locked cash against a Rs 1,000 mandate. The caretaker would
    # skip this; the adversary presents it anyway.
    big = open_condition(tokens=10)
    res = as_agent("POST", f"/umi/conditions/{quote(big['conditionId'])}/present",
                   {"credentialId": credential_id})
    attack("a single act above the ceiling", not res.ok, json.dumps(res.body)[:200])

    # --- 2. the ceiling, in slices ----------------------------------------
    # Each act is within the limit. Together they are not. This is the one a
    # per-request check waves through.
    slices = [open_condition(tokens=1) for _ in range(4)]  # Rs 500 each, Rs 2,000 total
    for cond in slices:
        as_agent("POST", f"/umi/conditions/{quote(cond['conditionId'])}/present",
                 {"credentialId": credential_id})
    after = rail("GET", f"/umi/mandates/{quote(mandate_id)}", "investor1", "Investor")
    spent = int((after.body.get("mandate") or {}).get("spentPaise", 0))
    attack("the ceiling bounds the total, not each request", spent <= 100000,
           f"spent {spent} paise against a 100000 paise ceiling")

    # --- 3. the same ceiling, all at once ---------------------------------
    # The slices above are sequential, which any check survives. These go out
    # together, which is where a check-then-act gap lives.
    racers = [open_condition(tokens=1) for _ in range(8)]
    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(
            lambda c: as_agent("POST", f"/umi/conditions/{quote(c['conditionId'])}/present",
                               {"credentialId": credential_id}),
            racers,
        ))
    after = rail("GET", f"/umi/mandates/{quote(mandate_id)}", "investor1", "Investor")
    spent = int((after.body.get("mandate") or {}).get("spentPaise", 0))
    attack("the ceiling holds when the acts are simultaneous", spent <= 100000,
           f"spent {spent} paise against a 100000 paise ceiling")

    # --- 4. one condition, many presenters --------------------------------
    # Not about the ceiling: about whether a condition can pay out twice.
    #
    # This needs its own richly funded mandate. Run on the narrow one above
    # and the ceiling, already exhausted, refuses every caller: the assertion
    # "it settled at most once" then passes because it settled zero times,
    # which is a test that reports success for having done nothing. Two
    # controls in series means the second one is never exercised.
    rich_passport = rail("POST", "/umi/agents", "investor1", "Investor", {
        "purpose": "a second adversary, with room to do damage",
        "custodians": ["registrar1", "regulator1"], "threshold": 2,
    }).body.get("agent", {})
    rich_id = rich_passport.get("agentId", "")
    rich_mandate = rail("POST", "/umi/mandates", "investor1", "Investor", {
        "agent": rich_id, "actions": ["RELEASE_CONDITION"],
        "limitINR": 100000, "assets": [ASSET], "expiresAt": expires,
        "purpose": "wide enough that only the settlement logic can refuse it",
    }).body.get("mandate", {}).get("mandateId", "")

    def as_rich(method, path, body=None):
        return rail(method, path, rich_id, "Agent", body, mandate=rich_mandate)

    twice = open_condition(tokens=1)
    with ThreadPoolExecutor(max_workers=8) as pool:
        replies = list(pool.map(
            lambda _: as_rich("POST", f"/umi/conditions/{quote(twice['conditionId'])}/present",
                              {"credentialId": credential_id}),
            range(8),
        ))
    settled = sum(1 for r in replies if r.ok)
    # Exactly one, not at most one. Zero would mean the attack never reached
    # the code it is aiming at.
    attack("a condition settles exactly once under a stampede", settled == 1,
           f"it settled {settled} times")

    # --- 5. replay ---------------------------------------------------------
    if settled:
        again = as_rich("POST", f"/umi/conditions/{quote(twice['conditionId'])}/present",
                        {"credentialId": credential_id})
        attack("a settled condition cannot be presented again", not again.ok,
               json.dumps(again.body)[:200])
        paid = rail("GET", f"/umi/conditions/{quote(twice['conditionId'])}",
                    "investor1", "Investor")
        condition = paid.body.get("condition") or {}
        attack("and the record shows one release, not several",
               condition.get("status") == "RELEASED" and int(condition.get("cashPaise", 0)) == 50000,
               json.dumps(condition)[:200])
    else:
        attack("a settled condition cannot be presented again", False,
               "nothing settled, so the replay attack had no target: the harness, not the rail, "
               "is at fault and this is a failure rather than a pass")

    # --- 6. an asset outside the allowlist --------------------------------
    stray = rail("POST", "/umi/mandates/" + quote(mandate_id) + "/check", agent_id, "Agent",
                 {"action": "RELEASE_CONDITION", "assetId": OTHER_ASSET, "amountINR": 1},
                 mandate=mandate_id)
    attack("an asset outside the allowlist is refused",
           stray.ok and stray.body.get("allowed") is False, json.dumps(stray.body)[:200])

    # --- 7. an action it was never granted --------------------------------
    wrong_action = rail("POST", "/umi/mandates/" + quote(mandate_id) + "/check", agent_id, "Agent",
                        {"action": "SETTLE_DVP", "assetId": ASSET, "amountINR": 1},
                        mandate=mandate_id)
    attack("an action outside the mandate is refused",
           wrong_action.ok and wrong_action.body.get("allowed") is False,
           json.dumps(wrong_action.body)[:200])

    # --- 8. no mandate at all ---------------------------------------------
    bare = open_condition(tokens=1)
    naked = rail("POST", f"/umi/conditions/{quote(bare['conditionId'])}/present",
                 agent_id, "Agent", {"credentialId": credential_id})
    attack("presenting with no mandate is refused", not naked.ok, json.dumps(naked.body)[:200])

    # --- 9. somebody else's mandate ---------------------------------------
    other_passport = rail("POST", "/umi/agents", "investor2", "Investor", {
        "purpose": "a second agent, belonging to somebody else",
        "custodians": ["registrar1", "regulator1"], "threshold": 2,
    }).body.get("agent", {})
    other_mandate = rail("POST", "/umi/mandates", "investor2", "Investor", {
        "agent": other_passport.get("agentId", ""), "actions": ["RELEASE_CONDITION"],
        "limitINR": 100000, "assets": [ASSET], "expiresAt": expires,
    }).body.get("mandate", {})
    if other_mandate.get("mandateId"):
        borrowed = open_condition(tokens=1)
        stolen = as_agent("POST", f"/umi/conditions/{quote(borrowed['conditionId'])}/present",
                          {"credentialId": credential_id},
                          mandate_id_override=other_mandate["mandateId"])
        attack("using a mandate granted to another agent is refused", not stolen.ok,
               json.dumps(stolen.body)[:200])

    # --- 10. a mandate that does not exist --------------------------------
    ghost = open_condition(tokens=1)
    invented = as_agent("POST", f"/umi/conditions/{quote(ghost['conditionId'])}/present",
                        {"credentialId": credential_id},
                        mandate_id_override="MANDATE-9999-agent:aasthi:0000000000000000")
    attack("an invented mandate id is refused", not invented.ok, json.dumps(invented.body)[:200])

    # --- 11. granting itself authority ------------------------------------
    # The principal is always taken from the caller, never the body, so an
    # agent writing "principal": "investor1" into a grant should get a
    # mandate from itself, which is worth nothing against investor1's
    # conditions.
    self_grant = rail("POST", "/umi/mandates", agent_id, "Agent", {
        "agent": agent_id, "actions": ["RELEASE_CONDITION"],
        "limitINR": 10000000, "assets": [ASSET], "expiresAt": expires,
        "principal": "investor1",
    }, mandate=mandate_id)
    forged_id = (self_grant.body.get("mandate") or {}).get("mandateId", "")
    if not forged_id:
        attack("an agent cannot grant itself authority", True)
    else:
        target = open_condition(tokens=1)
        used = as_agent("POST", f"/umi/conditions/{quote(target['conditionId'])}/present",
                        {"credentialId": credential_id}, mandate_id_override=forged_id)
        attack("a self-granted mandate cannot act for somebody else", not used.ok,
               json.dumps(used.body)[:200])

    # --- 12. a credential it was not given --------------------------------
    wrong_cred = open_condition(tokens=1)
    nonsense = as_agent("POST", f"/umi/conditions/{quote(wrong_cred['conditionId'])}/present",
                        {"credentialId": "urn:aasthi:credential:" + "f" * 32})
    attack("an invented credential is refused", not nonsense.ok, json.dumps(nonsense.body)[:200])

    # --- 13. reading other people's business ------------------------------
    book = rail("GET", "/umi/conditions", agent_id, "Agent", mandate=mandate_id)
    visible = book.body.get("conditions") or []
    foreign = [c for c in visible if c.get("asserter", "").lower() != "investor1"]
    attack("the agent sees only what its principal may see", not foreign,
           f"{len(foreign)} conditions belonging to others were visible")

    someone_else = rail("GET", "/umi/wallets/investor2", agent_id, "Agent", mandate=mandate_id)
    attack("the agent cannot read a stranger's wallet", not someone_else.ok,
           json.dumps(someone_else.body)[:200])

    # --- 14. acting after it has been stopped ------------------------------
    rail("POST", f"/umi/agents/{quote(agent_id)}/revoke", "investor1", "Investor", {})
    final = open_condition(tokens=1)
    zombie = as_agent("POST", f"/umi/conditions/{quote(final['conditionId'])}/present",
                      {"credentialId": credential_id})
    attack("a revoked agent cannot act", not zombie.ok, json.dumps(zombie.body)[:200])
    attack("and it is told the real reason", zombie.says("withdraw"),
           json.dumps(zombie.body)[:200])

    stopped_check = rail("POST", "/umi/mandates/" + quote(mandate_id) + "/check", agent_id, "Agent",
                         {"action": "RELEASE_CONDITION", "assetId": ASSET, "amountINR": 1},
                         mandate=mandate_id)
    attack("every mandate it holds is inert once the passport is gone",
           stopped_check.ok and stopped_check.body.get("allowed") is False,
           json.dumps(stopped_check.body)[:200])

    # --- 15. the thing this harness cannot test ---------------------------
    note("FORGERY: the rail trusts X-Fabric-Identity because authentication happens at "
         "the proxy in front of it. Anything that can reach the rail directly can claim "
         "any identity, so this harness cannot and does not test identity forgery. The "
         "control for that is network placement, not the mandate layer.")

    print()
    for n in notes:
        print(f"  note     {n}")
    print(f"\n  {held} bounds held, {breached} breached\n")
    return 1 if breached else 0


if __name__ == "__main__":
    sys.exit(main())
