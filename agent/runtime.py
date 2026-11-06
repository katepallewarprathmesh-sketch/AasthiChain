"""The runtime: the part that actually talks to the rail.

This is a real autonomous actor, not a simulation of one. It holds a passport
on the agent register, acts under a mandate its principal granted, and every
request it makes goes through the ordinary HTTP surface with its own identity
and its mandate in a header. The rail gives it no special treatment and no
private entrance. That is the point: if the guardrails only hold for
well-behaved callers they are not guardrails.

THE FOUR RULES THIS RUNTIME FOLLOWS

1. Ask before acting. Every intent goes to POST /umi/mandates/{id}/check
   first, which changes nothing and answers whether the act would be
   permitted. An agent that discovers its limits by hitting them has already
   hit them.

2. Re-read authority every cycle. Passport and mandate are fetched at the top
   of each pass, not cached from startup. A revocation has to be able to stop
   an agent that is already running, and a runtime that trusts its own memory
   of its authority is precisely what defeats one.

3. Record the refusals. The log keeps every attempt the rail turned down, with
   the rail's own reason. The refusals are the evidence that the bounds work;
   a log of successes proves only that the happy path exists.

4. Stop when told, by any of the independent means in ``policy.should_stop``,
   including an operator stop file on disk. The file is checked on every pass
   so a human with shell access can halt it without the rail's cooperation.

DEPENDENCIES
None. The standard library only, deliberately. A harness that needs a package
index to run is a harness somebody will not run, and ``urllib`` is perfectly
capable of the handful of calls this makes.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from policy import Limits, decide, should_stop

ROOT = Path(__file__).resolve().parent.parent

DEFAULT_RAIL = os.environ.get("RAIL", "http://localhost:21100")
DEFAULT_HOME = Path(os.environ.get("AGENT_HOME", ROOT / ".agent"))
DEFAULT_LOG = Path(os.environ.get("AGENT_LOG", DEFAULT_HOME / "runs.jsonl"))
DEFAULT_STOP = Path(os.environ.get("AGENT_STOP", DEFAULT_HOME / "STOP"))
TIMEOUT_SECONDS = 10


@dataclass
class Config:
    rail: str = DEFAULT_RAIL
    principal: str = ""
    agent_id: str = ""
    passport_id: str = ""
    mandate_id: str = ""
    log_path: str = str(DEFAULT_LOG)
    stop_path: str = str(DEFAULT_STOP)

    @classmethod
    def load(cls, path: Path) -> "Config":
        data = json.loads(Path(path).read_text())
        return cls(
            rail=data.get("rail", DEFAULT_RAIL),
            principal=data.get("principal", ""),
            agent_id=data.get("agentId", ""),
            passport_id=data.get("passportId", ""),
            mandate_id=data.get("mandateId", ""),
            log_path=data.get("logPath", str(DEFAULT_LOG)),
            stop_path=data.get("stopPath", str(DEFAULT_STOP)),
        )

    def save(self, path: Path) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps({
            "rail": self.rail,
            "principal": self.principal,
            "agentId": self.agent_id,
            "passportId": self.passport_id,
            "mandateId": self.mandate_id,
            "logPath": self.log_path,
            "stopPath": self.stop_path,
        }, indent=2) + "\n")


@dataclass
class Response:
    ok: bool
    status: int
    data: dict


@dataclass
class Pass:
    """One cycle's record. Returned rather than printed, so tests can assert
    on the decisions without parsing output."""

    at: str
    agent_id: str
    mandate_id: str
    stopped: bool = False
    why: str = ""
    considered: int = 0
    headroom_paise: int = 0
    acted: list[dict] = field(default_factory=list)
    refused: list[dict] = field(default_factory=list)
    skipped: list[dict] = field(default_factory=list)


def call(cfg: Config, method: str, path: str, body: Any = None,
         identity: str = "", role: str = "Agent", mandate: bool = True) -> Response:
    """One HTTP call, with the agent's identity and mandate on every request."""
    headers = {
        "Content-Type": "application/json",
        "X-Fabric-Identity": identity or cfg.agent_id,
        "X-Identity-Role": role,
    }
    if mandate and cfg.mandate_id:
        headers["X-Agent-Mandate"] = cfg.mandate_id

    payload = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(cfg.rail + path, data=payload, headers=headers, method=method)
    try:
        # A hung rail must not hang the agent. Without a timeout the loop can
        # stall for minutes on a single socket and silently stop being an
        # agent.
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as res:
            return Response(True, res.status, _decode(res.read()))
    except urllib.error.HTTPError as err:
        return Response(False, err.code, _decode(err.read()))
    except (urllib.error.URLError, TimeoutError, OSError) as err:
        return Response(False, 0, {"error": "ERR_UNREACHABLE", "message": str(err)})


def _decode(raw: bytes) -> dict:
    text = (raw or b"").decode("utf-8", "replace")
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return {"raw": text[:300]}
    return parsed if isinstance(parsed, dict) else {"data": parsed}


def observe(cfg: Config) -> dict:
    """Read everything the policy needs, in one pass, before deciding anything.

    The four reads go out together. Not for speed, which is irrelevant at this
    size, but so they describe as close to one moment as the rail will give:
    deciding from a passport read now and a condition book read a second later
    is deciding from a state that never existed.
    """
    paths = [
        ("passport", f"/umi/agents/{urllib.parse.quote(cfg.agent_id, safe='')}"),
        ("mandate", f"/umi/mandates/{urllib.parse.quote(cfg.mandate_id, safe='')}"),
        ("conditions", "/umi/conditions"),
        ("credentials", "/umi/credentials?limit=200"),
    ]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = dict(zip(
            [name for name, _ in paths],
            pool.map(lambda p: call(cfg, "GET", p[1]), paths),
        ))

    passport = results["passport"]
    mandate = results["mandate"]
    return {
        "passport": (passport.data.get("agent") or passport.data) if passport.ok else None,
        "mandate": (mandate.data.get("mandate") or mandate.data) if mandate.ok else None,
        "conditions": results["conditions"].data.get("conditions") or [],
        "credentials": results["credentials"].data.get("credentials") or [],
    }


def reason_from(data: dict | None) -> str:
    if not data:
        return "no answer"
    if data.get("message"):
        prefix = f"{data['error']}: " if data.get("error") else ""
        return prefix + str(data["message"])
    check = data.get("check")
    if isinstance(check, dict) and check.get("reason"):
        return str(check["reason"])
    if data.get("reason"):
        return str(data["reason"])
    return str(data.get("error") or "refused without a reason")


def _block_from(data: dict) -> int:
    condition = data.get("condition") if isinstance(data, dict) else None
    if isinstance(condition, dict):
        return int(condition.get("releasedBlock") or 0)
    return 0


def run_once(cfg: Config, now_ms: float | None = None) -> Pass:
    """One pass: observe, check authority, decide, ask, act, record."""
    now_ms = time.time() * 1000 if now_ms is None else now_ms
    started = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now_ms / 1000))
    result = Pass(at=started, agent_id=cfg.agent_id, mandate_id=cfg.mandate_id)

    killed = Path(cfg.stop_path).exists()
    seen = observe(cfg)

    stop = should_stop(seen["passport"], seen["mandate"], killed=killed, now_ms=now_ms)
    if stop.stop:
        result.stopped = True
        result.why = stop.why
        record(cfg, result)
        return result

    mandate = seen["mandate"]
    limits = Limits(
        remaining_paise=int(mandate.get("limitPaise") or 0) - int(mandate.get("spentPaise") or 0),
        assets=tuple(mandate.get("assets") or ()),
        actions=tuple(mandate.get("actions") or ()),
    )
    result.headroom_paise = limits.remaining_paise or 0

    decision = decide(
        conditions=seen["conditions"],
        credentials=seen["credentials"],
        now_ms=now_ms,
        limits=limits,
        principal=cfg.principal,
    )
    result.considered = len(seen["conditions"])
    result.skipped = [asdict(s) for s in decision.skipped]

    mandate_path = urllib.parse.quote(cfg.mandate_id, safe="")
    for intent in decision.intents:
        # Rule 1: ask first. A check moves nothing and costs one round trip.
        #
        # The check route is denominated in rupees and the rest of the rail in
        # paise. Converting here rather than guessing is the difference
        # between a check that bounds the act and one that waves it through a
        # hundred times too small.
        check = call(cfg, "POST", f"/umi/mandates/{mandate_path}/check", {
            "action": intent.action,
            "assetId": intent.asset_id,
            "amountINR": intent.amount_paise / 100,
        })
        body = check.data if check.ok else {}
        allowed = bool(
            check.ok and (
                body.get("allowed") is True
                or (isinstance(body.get("check"), dict) and body["check"].get("allowed") is True)
            )
        )
        if not allowed:
            result.refused.append({
                **asdict(intent), "stage": "check",
                "status": check.status, "railSaid": reason_from(check.data),
            })
            continue

        condition_path = urllib.parse.quote(intent.condition_id, safe="")
        did = call(cfg, "POST", f"/umi/conditions/{condition_path}/present",
                   {"credentialId": intent.credential_id})
        if did.ok:
            result.acted.append({**asdict(intent), "status": did.status,
                                 "block": _block_from(did.data)})
        else:
            # Rule 3: a refusal at the act is the most valuable line in the
            # log. The rail said no after saying the mandate allowed it, which
            # means something other than the mandate stopped it, and that is
            # worth keeping verbatim.
            result.refused.append({
                **asdict(intent), "stage": "act",
                "status": did.status, "railSaid": reason_from(did.data),
            })

    record(cfg, result)
    return result


def record(cfg: Config, result: Pass) -> None:
    """Append-only run log: the agent's own record of what it did and was told.

    Its own, and therefore not evidence. The /agents screen reads the register
    and the mandate book instead, because a compromised agent writes a
    flattering log and cannot edit the rail.
    """
    path = Path(cfg.log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a") as handle:
        handle.write(json.dumps(asdict(result)) + "\n")


def read_log(log_path: str | Path, limit: int = 50) -> list[dict]:
    """Read the log back, newest first."""
    try:
        lines = Path(log_path).read_text().strip().split("\n")
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        if not line:
            continue
        try:
            out.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    out.reverse()
    return out
