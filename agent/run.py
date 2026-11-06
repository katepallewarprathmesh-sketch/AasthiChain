#!/usr/bin/env python3
"""The harness entry point: set an agent up, or let it run.

    python3 agent/run.py setup                 register a passport and grant a mandate
    python3 agent/run.py once                  one pass, then exit
    python3 agent/run.py watch --every 15      keep going until stopped
    python3 agent/run.py stop                  write the stop file
    python3 agent/run.py start                 clear the stop file
    python3 agent/run.py log                   what it has done and been refused

Configuration is read from .agent/config.json, written by ``setup``.

WHY A SEPARATE PROCESS AND NOT A GOROUTINE IN THE RAIL
An agent that lives inside the rail is a feature of the rail, and proves
nothing about whether the rail can withstand one. This runs outside, over
HTTP, with no privileges the rail does not hand to any other caller, so every
bound it respects is a bound the rail enforced rather than one the agent chose
to honour.

RUNNING IT IS A DELIBERATE ACT
Nothing starts this automatically, no deployment runs it, and ``setup`` has to
be performed by a named principal. An autonomous actor that starts itself is
not something to add quietly.
"""

from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from policy import KNOWN_ACTIONS, POLICY_ACTION  # noqa: E402
from runtime import (  # noqa: E402
    DEFAULT_HOME, DEFAULT_LOG, DEFAULT_RAIL, DEFAULT_STOP,
    Config, Pass, call, read_log, run_once,
)

CONFIG_PATH = DEFAULT_HOME / "config.json"


class RailError(RuntimeError):
    pass


def api(cfg: Config, method: str, path: str, identity: str, role: str, body=None) -> dict:
    res = call(cfg, method, path, body, identity=identity, role=role, mandate=False)
    if not res.ok:
        detail = res.data.get("message") or res.data.get("error") or res.data
        raise RailError(f"{method} {path} -> {res.status} {detail}")
    return res.data


def setup(args: argparse.Namespace) -> int:
    if POLICY_ACTION not in KNOWN_ACTIONS:
        raise RailError(f"{POLICY_ACTION} is not an action the rail bounds")

    cfg = Config(rail=args.rail, principal=args.principal)

    # ORDER MATTERS, AND IT IS NOT THE OBVIOUS ONE.
    #
    # The passport is registered first, and the mandate is then granted to the
    # pseudonym the register just issued. Doing it the other way round, which
    # is what the passport's own mandateId field invites, produces an agent
    # whose mandate names one identity and whose passport names another. The
    # rail checks an agent's standing by the name on the mandate, so that
    # agent keeps working after its passport is revoked: the kill switch is
    # wired to a name nothing uses.
    #
    # Granting to the pseudonym makes revoking the passport inert every
    # mandate the agent holds, which is the behaviour the register promises.
    registered = api(cfg, "POST", "/umi/agents", args.principal, args.role, {
        "purpose": "Releases conditional settlements whose named credential has been "
                   "issued and not revoked.",
        "version": "1.0.0",
        "custodians": ["registrar1", "regulator1"],
        "threshold": 2,
    })
    passport = registered.get("agent") or registered

    # Note what is being granted: one action, a hard rupee ceiling, and an
    # expiry. An agent granted everything indefinitely is a second set of
    # credentials for the principal, not a delegate.
    expires = datetime.now(timezone.utc) + timedelta(hours=args.hours)
    granted = api(cfg, "POST", "/umi/mandates", args.principal, args.role, {
        "agent": passport["agentId"],
        "actions": [POLICY_ACTION],
        "limitINR": args.limit,
        "expiresAt": expires.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "purpose": "Release conditional settlements once the named credential exists.",
    })
    mandate = granted.get("mandate") or granted

    # The agent acts under its pseudonym, which is also the name on the
    # mandate. One identity, so one revocation reaches everything.
    cfg.agent_id = passport["agentId"]
    cfg.passport_id = passport["agentId"]
    cfg.mandate_id = mandate["mandateId"]
    cfg.save(CONFIG_PATH)

    print("agent ready")
    print(f"  principal   {args.principal}")
    print(f"  acts as     {cfg.agent_id}")
    print(f"  passport    {cfg.passport_id}")
    print(f"  mandate     {cfg.mandate_id}  ({POLICY_ACTION}, Rs {args.limit:,.0f}, "
          f"{args.hours}h)")
    print("  stop with   python3 agent/run.py stop")
    print(f"  or revoke   POST /umi/agents/{cfg.passport_id}/revoke as {args.principal}")
    return 0


def report(result: Pass | dict) -> None:
    data = result if isinstance(result, dict) else result.__dict__
    if data.get("stopped"):
        print(f"stopped: {data.get('why')}")
        return
    print(f"pass {data.get('at')}  considered {data.get('considered', 0)}  "
          f"acted {len(data.get('acted', []))}  refused {len(data.get('refused', []))}  "
          f"skipped {len(data.get('skipped', []))}")
    for a in data.get("acted", []):
        print(f"  acted    {a['condition_id']}  {a['amount_paise']} paise  block {a['block']}")
    for r in data.get("refused", []):
        print(f"  refused  {r['condition_id']}  at {r['stage']}: {r['railSaid']}")
    for s in data.get("skipped", []):
        print(f"  skipped  {s['condition_id']}: {s['why']}")


def once(args: argparse.Namespace) -> int:
    report(run_once(Config.load(CONFIG_PATH)))
    return 0


def watch(args: argparse.Namespace) -> int:
    cfg = Config.load(CONFIG_PATH)
    print(f"watching every {args.every}s. Stop with: python3 agent/run.py stop")
    while True:
        result = run_once(cfg)
        report(result)
        # A stop is final. Looping after one would make the stop advisory,
        # and an advisory stop is not a stop.
        if result.stopped:
            return 0
        time.sleep(args.every)


def stop(args: argparse.Namespace) -> int:
    try:
        path = Path(Config.load(CONFIG_PATH).stop_path)
    except OSError:
        path = DEFAULT_STOP
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") + "\n")
    print("stop file written. The next pass will halt.")
    return 0


def start(args: argparse.Namespace) -> int:
    Path(Config.load(CONFIG_PATH).stop_path).unlink(missing_ok=True)
    print("stop file cleared.")
    return 0


def show_log(args: argparse.Namespace) -> int:
    for entry in read_log(Config.load(CONFIG_PATH).log_path, args.limit):
        report(entry)
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="agent/run.py", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--rail", default=DEFAULT_RAIL)
    sub = parser.add_subparsers(dest="command")

    p_setup = sub.add_parser("setup", help="register a passport and grant it a mandate")
    p_setup.add_argument("--principal", default="investor1")
    p_setup.add_argument("--role", default="Investor")
    p_setup.add_argument("--limit", type=float, default=5000)
    p_setup.add_argument("--hours", type=int, default=24)
    p_setup.set_defaults(func=setup)

    sub.add_parser("once", help="one pass, then exit").set_defaults(func=once)

    p_watch = sub.add_parser("watch", help="keep going until stopped")
    p_watch.add_argument("--every", type=int, default=15)
    p_watch.set_defaults(func=watch)

    sub.add_parser("stop", help="write the stop file").set_defaults(func=stop)
    sub.add_parser("start", help="clear the stop file").set_defaults(func=start)

    p_log = sub.add_parser("log", help="what it has done and been refused")
    p_log.add_argument("--limit", type=int, default=20)
    p_log.set_defaults(func=show_log)

    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 2
    try:
        return args.func(args)
    except RailError as err:
        print(str(err), file=sys.stderr)
        return 1
    except FileNotFoundError:
        print(f"no agent is configured. Run: python3 agent/run.py setup   "
              f"(expected {CONFIG_PATH})", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\nhalted by the operator. The agent holds no state between passes.")
        return 0


if __name__ == "__main__":
    sys.exit(main())
