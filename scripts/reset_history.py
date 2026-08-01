#!/usr/bin/env python3
"""Coordinate a safe historical-data reset across the server and field Pis."""

from __future__ import annotations

import argparse
import json
import pathlib
import shlex
import subprocess
import sys
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID


REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
DEFAULT_COMPOSE_FILE = REPO_ROOT / "docker-compose.yml"
SERVER_STOP_ORDER = ("mosquitto", "ingest", "detector", "backend")
SERVER_START_ORDER = ("mosquitto", "backend", "ingest", "detector")
DEVICE_UNITS = (
    "urban-acoustics.service",
    "urban-acoustics-cleanup.timer",
    "urban-acoustics-cleanup.service",
)
DEVICE_RESET_COMMAND = (
    "/opt/urban-acoustics/venv/bin/python -m "
    "urban_acoustics.reset_history --json"
)


class ResetError(RuntimeError):
    """Operational failure with a concise operator-facing message."""


@dataclass(frozen=True)
class DeviceTarget:
    host: str
    device_id: UUID
    report: dict[str, Any]


class CommandRunner:
    def __init__(self, compose_file: pathlib.Path, *, verbose: bool = False) -> None:
        self.compose_file = compose_file
        self.verbose = verbose

    def run(
        self,
        command: Sequence[str],
        *,
        allowed_returncodes: Iterable[int] = (0,),
        capture: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        if self.verbose:
            print(f"+ {shlex.join(command)}", file=sys.stderr)
        result = subprocess.run(
            list(command), text=True, capture_output=capture, check=False
        )
        if result.returncode not in set(allowed_returncodes):
            detail = (result.stderr or result.stdout or "no command output").strip()
            raise ResetError(
                f"command failed ({result.returncode}): {shlex.join(command)}\n{detail}"
            )
        return result

    def compose(
        self, *arguments: str, capture: bool = True
    ) -> subprocess.CompletedProcess[str]:
        return self.run(
            ("docker", "compose", "-f", str(self.compose_file), *arguments),
            capture=capture,
        )

    def ssh(
        self,
        host: str,
        command: str,
        *,
        allowed_returncodes: Iterable[int] = (0,),
    ) -> subprocess.CompletedProcess[str]:
        return self.run(
            (
                "ssh",
                "-o",
                "BatchMode=yes",
                "-o",
                "ConnectTimeout=10",
                "--",
                host,
                command,
            ),
            allowed_returncodes=allowed_returncodes,
        )


def _parse_json(output: str, source: str) -> dict[str, Any]:
    lines = [line for line in output.splitlines() if line.strip()]
    if not lines:
        raise ResetError(f"{source} returned no report")
    try:
        payload = json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise ResetError(f"{source} returned an invalid report: {lines[-1]!r}") from exc
    if not isinstance(payload, dict):
        raise ResetError(f"{source} returned an invalid report")
    return payload


def _validate_host(host: str) -> None:
    if not host or host.startswith("-") or any(char.isspace() for char in host):
        raise ResetError(f"invalid SSH host: {host!r}")


def _server_command(
    runner: CommandRunner,
    *,
    execute: bool = False,
    list_devices: bool = False,
    device_ids: Sequence[UUID] = (),
) -> dict[str, Any]:
    arguments = [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--entrypoint",
        "python",
        "backend",
        "-m",
        "scripts.reset_history",
        "--json",
    ]
    if list_devices:
        arguments.append("--list-devices")
    else:
        arguments.append("--execute" if execute else "--dry-run")
        for device_id in device_ids:
            arguments.extend(("--device-id", str(device_id)))
    result = runner.compose(*arguments)
    return _parse_json(result.stdout, "server reset helper")


def _device_command(
    runner: CommandRunner, host: str, *, execute: bool = False
) -> dict[str, Any]:
    action = "--execute" if execute else "--dry-run"
    result = runner.ssh(
        host,
        f"sudo -n -u urban-acoustics {DEVICE_RESET_COMMAND} {action}",
    )
    return _parse_json(result.stdout, f"device reset helper on {host}")


def _probe_devices(runner: CommandRunner, hosts: Sequence[str]) -> list[DeviceTarget]:
    targets: list[DeviceTarget] = []
    seen: dict[UUID, str] = {}
    for host in hosts:
        _validate_host(host)
        runner.ssh(host, "sudo -n true")
        report = _device_command(runner, host)
        try:
            device_id = UUID(str(report["device_id"]))
        except (KeyError, ValueError) as exc:
            raise ResetError(f"device helper on {host} did not return a valid device ID") from exc
        if device_id in seen:
            raise ResetError(
                f"hosts {seen[device_id]} and {host} both identify as {device_id}"
            )
        seen[device_id] = host
        targets.append(DeviceTarget(host, device_id, report))
    return targets


def _server_preflight(runner: CommandRunner) -> None:
    if not runner.compose_file.is_file():
        raise ResetError(f"compose file does not exist: {runner.compose_file}")
    services = {
        line.strip()
        for line in runner.compose("config", "--services").stdout.splitlines()
        if line.strip()
    }
    required = {"postgres", "minio", "backend", *SERVER_STOP_ORDER}
    missing = required - services
    if missing:
        raise ResetError(f"compose file is missing required services: {sorted(missing)}")


def _running_services(runner: CommandRunner) -> set[str]:
    result = runner.compose("ps", "--services", "--status", "running")
    return {line.strip() for line in result.stdout.splitlines() if line.strip()}


def _unit_active(runner: CommandRunner, host: str, unit: str) -> bool:
    result = runner.ssh(
        host,
        f"sudo -n systemctl is-active --quiet {shlex.quote(unit)}",
        allowed_returncodes=(0, 1, 3, 4),
    )
    return result.returncode == 0


def _print_surfaces(title: str, report: dict[str, Any]) -> None:
    print(f"\n{title}")
    surfaces = report.get("surfaces", [])
    if not surfaces:
        print("  (none)")
        return
    width = max(len(str(row.get("name", "?"))) for row in surfaces)
    for row in surfaces:
        name = str(row.get("name", "?"))
        items = int(row.get("items", 0))
        byte_count = row.get("bytes")
        suffix = f", {_format_bytes(int(byte_count))}" if byte_count is not None else ""
        print(f"  {name:<{width}}  {items:>12,} items{suffix}")


def _format_bytes(size: int) -> str:
    value = float(size)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if value < 1024 or unit == "TiB":
            return f"{value:.0f} {unit}" if unit == "B" else f"{value:.1f} {unit}"
        value /= 1024
    raise AssertionError("unreachable")


def _assert_empty(reports: Sequence[dict[str, Any]]) -> None:
    nonzero: list[str] = []
    for report in reports:
        for row in report.get("surfaces", []):
            if int(row.get("items", 0)):
                nonzero.append(f"{row.get('name', '?')}={row['items']}")
    if nonzero:
        raise ResetError("post-reset verification failed: " + ", ".join(nonzero))


def _list_devices(runner: CommandRunner) -> None:
    payload = _server_command(runner, list_devices=True)
    devices = payload.get("devices", [])
    if not devices:
        print("No registered devices.")
        return
    print("DEVICE ID\tNAME\tLOCATION\tLAST SEEN")
    for device in devices:
        print(
            f"{device['device_id']}\t{device.get('name') or '-'}\t"
            f"{device.get('location') or '-'}\t{device.get('last_seen') or 'never'}"
        )


def _dry_run(
    runner: CommandRunner,
    *,
    server: bool,
    device: bool,
    selected: tuple[UUID, ...],
    targets: Sequence[DeviceTarget],
) -> None:
    print("DRY RUN — no data or services will be changed.")
    if server:
        report = _server_command(runner, device_ids=selected)
        _print_surfaces("Server history selected for deletion", report)
    if device:
        if not targets:
            print("\nNo --host targets supplied; no remote device will be touched.")
        for target in targets:
            _print_surfaces(
                f"Device history selected for deletion ({target.host}, {target.device_id})",
                target.report,
            )
    print("\nRun again with --execute to perform the reset.")


def _execute(
    runner: CommandRunner,
    *,
    server: bool,
    device: bool,
    selected: tuple[UUID, ...],
    targets: Sequence[DeviceTarget],
) -> None:
    print("EXECUTE — resetting selected historical data.")
    if server:
        _print_surfaces(
            "Server history selected for deletion",
            _server_command(runner, device_ids=selected),
        )
    for target in targets:
        _print_surfaces(
            f"Device history selected for deletion ({target.host}, {target.device_id})",
            target.report,
        )

    running_services = _running_services(runner) if server else set()
    device_states = {
        target.host: {
            unit: _unit_active(runner, target.host, unit) for unit in DEVICE_UNITS
        }
        for target in targets
    }
    stopped_services: list[str] = []
    stopped_units: list[tuple[str, str]] = []
    primary_error: BaseException | None = None

    try:
        for target in targets:
            for unit in DEVICE_UNITS:
                if not device_states[target.host][unit]:
                    continue
                print(f"stopping {unit} on {target.host} …")
                runner.ssh(
                    target.host, f"sudo -n systemctl stop {shlex.quote(unit)}"
                )
                stopped_units.append((target.host, unit))

        if server:
            for service in SERVER_STOP_ORDER:
                if service not in running_services:
                    continue
                print(f"stopping compose service {service} …")
                runner.compose("stop", service, capture=False)
                stopped_services.append(service)

        verification: list[dict[str, Any]] = []
        for target in targets:
            print(f"clearing queue and FLAC spool on {target.host} …")
            report = _device_command(runner, target.host, execute=True)
            if UUID(str(report.get("device_id"))) != target.device_id:
                raise ResetError(f"device identity changed while resetting {target.host}")
            verification.append(report)

        if server:
            print("clearing Postgres history, aggregates, and S3 prefixes …")
            verification.append(
                _server_command(runner, execute=True, device_ids=selected)
            )

        _assert_empty(verification)
        print("all selected history surfaces verified empty.")
    except BaseException as exc:
        primary_error = exc
        raise
    finally:
        restore_errors: list[str] = []
        if server:
            for service in SERVER_START_ORDER:
                if service not in stopped_services:
                    continue
                try:
                    print(f"starting compose service {service} …")
                    runner.compose("start", service, capture=False)
                except ResetError as exc:
                    restore_errors.append(str(exc))

        for target in targets:
            for unit in reversed(DEVICE_UNITS):
                if (target.host, unit) not in stopped_units:
                    continue
                try:
                    print(f"starting {unit} on {target.host} …")
                    runner.ssh(
                        target.host,
                        f"sudo -n systemctl start {shlex.quote(unit)}",
                    )
                except ResetError as exc:
                    restore_errors.append(str(exc))

        if restore_errors:
            message = "failed to restore one or more services:\n" + "\n".join(
                restore_errors
            )
            if primary_error is None:
                raise ResetError(message)
            print(f"WARNING: {message}", file=sys.stderr)

    print("reset complete; new frames now form the clean baseline.")


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="reset Urban Acoustics server and Pi history (dry-run by default)"
    )
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--dry-run", action="store_true", help="report only (default)")
    action.add_argument("--execute", action="store_true", help="perform the reset")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--server-only", action="store_true")
    scope.add_argument("--device-only", action="store_true")
    parser.add_argument(
        "--host",
        action="append",
        default=[],
        metavar="USER@HOST",
        help="SSH target for a Pi; repeatable and never defaulted",
    )
    parser.add_argument(
        "--device-id",
        action="append",
        type=UUID,
        default=[],
        help="limit the reset to this registered device; repeatable",
    )
    parser.add_argument(
        "--list-devices", action="store_true", help="list registered devices and exit"
    )
    parser.add_argument(
        "--compose-file", type=pathlib.Path, default=DEFAULT_COMPOSE_FILE
    )
    parser.add_argument("--verbose", action="store_true")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    server = not args.device_only
    device = not args.server_only
    hosts = tuple(dict.fromkeys(args.host))
    selected = tuple(dict.fromkeys(args.device_id))
    runner = CommandRunner(args.compose_file.resolve(), verbose=args.verbose)

    try:
        if args.list_devices:
            if args.execute or args.device_only or hosts or selected:
                raise ResetError(
                    "--list-devices cannot be combined with --execute, --device-only, "
                    "--host, or --device-id"
                )
            _server_preflight(runner)
            _list_devices(runner)
            return 0

        if args.device_only and not hosts:
            raise ResetError("--device-only requires at least one --host")
        if args.execute and server and device and not hosts:
            raise ResetError(
                "a combined reset requires at least one --host; use "
                "--server-only to intentionally reset only the server"
            )
        if server:
            _server_preflight(runner)

        probed = _probe_devices(runner, hosts) if device else []
        targets = [
            target
            for target in probed
            if not selected or target.device_id in selected
        ]
        skipped = [target for target in probed if target not in targets]
        for target in skipped:
            print(
                f"skipping {target.host}: device {target.device_id} is outside "
                "the --device-id scope",
                file=sys.stderr,
            )
        if args.device_only and selected and not targets:
            raise ResetError("none of the --host devices match the --device-id scope")

        if args.execute:
            _execute(
                runner,
                server=server,
                device=device,
                selected=selected,
                targets=targets,
            )
        else:
            _dry_run(
                runner,
                server=server,
                device=device,
                selected=selected,
                targets=targets,
            )
    except (OSError, ResetError, ValueError) as exc:
        print(f"reset_history: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
