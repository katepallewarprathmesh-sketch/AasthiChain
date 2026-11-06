"""The agent harness: what it refuses, and whether it can be stopped.

An autonomous actor that moves other people's money is only as good as the
things it declines to do, so most of this file is refusals. The policy module
is pure on purpose, which means every one of these is a cheap, deterministic
unit test rather than a scenario against a live rail.

The three bugs that already happened here, all found by running the thing
rather than reasoning about it, are pinned at the bottom.

Run directly, or through the repository gate:

    python3 -m unittest discover -s agent/tests
    node tests/agentharness.test.mjs
"""

import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from policy import (  # noqa: E402
    KNOWN_ACTIONS, POLICY_ACTION, Limits, decide, find_credential, should_stop,
)

HOUR_MS = 3600 * 1000
NOW = datetime(2026, 11, 6, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000
ASSET = "PROP-GREEN-VALLEY-PUNE-001"


def credential(**over):
    cred = {
        "id": "urn:aasthi:credential:" + "a" * 32,
        "type": ["VerifiableCredential", "TitleValidationCredential"],
        "issuer": "did:aasthi:registrar1",
        "credentialSubject": {"id": "investor1", "assetId": ASSET},
    }
    cred.update(over.pop("credential", {}))
    record = {"credential": cred, "issuedBy": "registrar1", "revoked": False}
    record.update(over)
    return record


def condition(**over):
    base = {
        "conditionId": "COND-20261106-0001",
        "assetId": ASSET,
        "credentialType": "TitleValidationCredential",
        "asserter": "investor1",
        "status": "OPEN",
        "cashPaise": 200000,
        "deadlineAt": "2026-11-07T12:00:00Z",
    }
    base.update(over)
    return base


def limits(**over):
    base = {"actions": ("RELEASE_CONDITION",), "remaining_paise": 500000, "assets": ()}
    base.update(over)
    return Limits(**base)


def run(conditions=None, credentials=None, lim=None, principal="investor1", now=NOW):
    return decide(
        conditions=conditions if conditions is not None else [condition()],
        credentials=credentials if credentials is not None else [credential()],
        now_ms=now,
        limits=lim or limits(),
        principal=principal,
    )


class TheHappyPath(unittest.TestCase):
    def test_releases_a_condition_whose_credential_stands(self):
        out = run()
        self.assertEqual(out.skipped, [])
        self.assertEqual(len(out.intents), 1)
        intent = out.intents[0]
        self.assertEqual(intent.condition_id, "COND-20261106-0001")
        self.assertEqual(intent.action, "RELEASE_CONDITION")
        self.assertEqual(intent.amount_paise, 200000)
        self.assertTrue(intent.credential_id.startswith("urn:aasthi:credential:"))

    def test_release_condition_is_the_only_thing_it_knows_how_to_want(self):
        # A caretaker that could also sell things is a different product with
        # a different risk. If that changes it should be a decision, so it is
        # pinned here.
        self.assertEqual(POLICY_ACTION, "RELEASE_CONDITION")
        self.assertIn("RELEASE_CONDITION", KNOWN_ACTIONS)
        out = run(conditions=[condition(conditionId="C1"), condition(conditionId="C2")])
        self.assertTrue(all(i.action == "RELEASE_CONDITION" for i in out.intents))


class TheRefusals(unittest.TestCase):
    def test_will_not_act_on_a_condition_it_was_not_delegated_to_assert(self):
        out = run(conditions=[condition(asserter="investor2")])
        self.assertEqual(out.intents, [])
        self.assertIn("entitled to assert", out.skipped[0].why)

    def test_will_not_act_on_a_condition_that_is_not_open(self):
        for status in ("RELEASED", "REFUNDED", "EXPIRED"):
            with self.subTest(status=status):
                self.assertEqual(run(conditions=[condition(status=status)]).intents, [])

    def test_will_not_reverse_an_expiry_the_rail_has_already_applied(self):
        # Presenting after the deadline refunds rather than settles, so an
        # agent that tries is not being helpful: it is closing somebody's
        # agreement on the wrong terms, autonomously, after the window they
        # agreed to.
        out = run(conditions=[condition(deadlineAt="2026-11-06T11:00:00Z")])
        self.assertEqual(out.intents, [])
        self.assertIn("deadline", out.skipped[0].why)

    def test_stays_inside_the_money_it_was_given(self):
        out = run(lim=limits(remaining_paise=150000))
        self.assertEqual(out.intents, [])
        self.assertIn("150000", out.skipped[0].why)

    def test_stops_at_the_ceiling_across_a_batch_rather_than_spending_it_twice(self):
        # Each condition passes the limit alone. Together they do not, and the
        # rail would refuse the third after the first two had already moved
        # money.
        out = run(conditions=[
            condition(conditionId="C1", cashPaise=200000),
            condition(conditionId="C2", cashPaise=200000),
            condition(conditionId="C3", cashPaise=200000),
        ], lim=limits(remaining_paise=500000))
        self.assertLessEqual(sum(i.amount_paise for i in out.intents), 500000)
        self.assertEqual(len(out.intents), 2)

    def test_respects_an_asset_allowlist(self):
        out = run(lim=limits(assets=("PROP-SOMETHING-ELSE",)))
        self.assertEqual(out.intents, [])
        self.assertIn(ASSET, out.skipped[0].why)

    def test_does_nothing_without_the_action_on_its_mandate(self):
        out = run(lim=limits(actions=("SETTLE_DVP",)))
        self.assertEqual(out.intents, [])
        self.assertTrue(out.skipped)

    def test_will_not_release_a_condition_locking_nothing(self):
        out = run(conditions=[condition(cashPaise=0)])
        self.assertEqual(out.intents, [])
        self.assertIn("nothing to release", out.skipped[0].why)


class ResolvingTheNamedCredential(unittest.TestCase):
    def test_right_person_wrong_asset_is_not_the_claim_that_was_named(self):
        wrong = [credential(credential={"credentialSubject": {"id": "investor1",
                                                              "assetId": "PROP-OTHER"}})]
        self.assertEqual(find_credential(wrong, condition())[0], "")

    def test_wrong_type_is_not_the_claim_that_was_named(self):
        wrong = [credential(credential={"type": ["VerifiableCredential", "KYCCredential"]})]
        self.assertEqual(find_credential(wrong, condition())[0], "")

    def test_a_revoked_credential_is_not_a_credential(self):
        found, why = find_credential([credential(revoked=True)], condition())
        self.assertEqual(found, "")
        self.assertIn("revoked", why)

    def test_when_an_issuer_is_named_another_issuer_will_not_do(self):
        self.assertEqual(find_credential([credential()], condition(issuer="registrar2"))[0], "")

    def test_with_no_issuer_named_any_issuer_satisfies_it(self):
        self.assertTrue(find_credential([credential()], condition(issuer=""))[0])

    def test_a_condition_naming_no_credential_type_can_never_be_satisfied(self):
        found, why = find_credential([credential()], condition(credentialType=""))
        self.assertEqual(found, "")
        self.assertIn("names no credential type", why)


class TheStopRule(unittest.TestCase):
    def live_mandate(self, **over):
        base = {
            "revoked": False, "limitPaise": 500000, "spentPaise": 0,
            "expiresAt": "2026-11-06T13:00:00Z",
        }
        base.update(over)
        return base

    def test_an_unregistered_agent_does_not_act(self):
        self.assertTrue(should_stop(None, {}, now_ms=NOW).stop)

    def test_a_revoked_status_stops_it_though_there_is_no_boolean_to_read(self):
        # Bug 1. The view publishes status, not revoked. Reading the boolean
        # that is not there gave a falsy value, which kept a revoked agent
        # running against a live rail. Found by revoking a real passport.
        out = should_stop({"status": "REVOKED"}, self.live_mandate(), now_ms=NOW)
        self.assertTrue(out.stop)
        self.assertIn("withdrawn", out.why)

    def test_an_open_identification_request_pauses_it(self):
        # Stricter than the rail, on purpose.
        out = should_stop({"status": "REVEAL_PENDING"}, self.live_mandate(), now_ms=NOW)
        self.assertTrue(out.stop)
        self.assertIn("identification", out.why)

    def test_an_active_passport_with_a_live_mandate_keeps_going(self):
        out = should_stop({"status": "ACTIVE"}, self.live_mandate(), now_ms=NOW)
        self.assertFalse(out.stop, out.why)

    def test_a_revoked_or_expired_or_exhausted_mandate_stops_it(self):
        cases = {
            "revoked": self.live_mandate(revoked=True),
            "expired": self.live_mandate(expiresAt="2026-11-06T11:00:00Z"),
            "exhausted": self.live_mandate(spentPaise=500000),
        }
        for name, mandate in cases.items():
            with self.subTest(case=name):
                self.assertTrue(should_stop({"status": "ACTIVE"}, mandate, now_ms=NOW).stop)

    def test_the_local_kill_file_stops_it_without_the_rail_answering(self):
        # The rail being unreachable must never be the reason an operator
        # cannot stop their own agent.
        out = should_stop({"status": "ACTIVE"}, self.live_mandate(), killed=True, now_ms=NOW)
        self.assertTrue(out.stop)

    def test_the_passport_and_the_mandate_must_name_the_same_identity(self):
        # Bug 2. MandateRegistry.Authorise checks standing against the name on
        # the mandate. Grant to a free-text agent name while the passport
        # lives under its pseudonym and Standing reports unregistered, the
        # withdrawal branch never fires, and revoking the passport does not
        # stop anything.
        out = should_stop(
            {"agentId": "agent:aasthi:5f7f4b8557668c5c", "status": "ACTIVE"},
            self.live_mandate(agent="agent-caretaker-1"),
            now_ms=NOW,
        )
        self.assertTrue(out.stop, "a mandate naming a different identity must halt the agent")
        self.assertIn("passport", out.why)

    def test_an_unparseable_timestamp_does_not_crash_a_pass(self):
        # Bug 3, and this one is Python's. The rail answers RFC3339 with a
        # trailing Z, which fromisoformat rejected before 3.11, so a direct
        # port would have thrown on every pass on an older interpreter. A
        # timestamp the agent cannot read is a reason to be careful, never a
        # reason to fall over.
        out = should_stop({"status": "ACTIVE"}, self.live_mandate(expiresAt="not a date"),
                          now_ms=NOW)
        self.assertFalse(out.stop, out.why)
        self.assertEqual(run(conditions=[condition(deadlineAt="whenever")]).intents[0].amount_paise,
                         200000)

    def test_a_z_suffixed_timestamp_is_understood_on_every_supported_version(self):
        expired = should_stop({"status": "ACTIVE"},
                              self.live_mandate(expiresAt="2026-11-06T11:00:00Z"), now_ms=NOW)
        self.assertTrue(expired.stop)
        self.assertIn("expired", expired.why)


if __name__ == "__main__":
    unittest.main(verbosity=2)
