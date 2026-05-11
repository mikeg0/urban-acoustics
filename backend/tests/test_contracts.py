"""Golden-fixture tests for Phase 1 contracts.

Every fixture under tests/fixtures/<schema>/ named ``valid*.json`` must
``model_validate`` cleanly; every fixture named ``invalid_*.json`` must
raise ``ValidationError``. This is the build-time check that the schemas
in ``app.contracts`` and the wire examples in ``plans/phase-1-contracts.md``
have not drifted.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import BaseModel, ValidationError

from app.contracts import (
    CommandEnvelope,
    DeviceIdentity,
    EventAnnounce,
    EventDone,
    EventIntentRequest,
    EventStatus,
    Health,
    LabelRequest,
    LastWill,
    Telemetry,
    is_valid_event_transition,
)


FIXTURES = Path(__file__).parent / "fixtures"

SCHEMAS: dict[str, type[BaseModel]] = {
    "telemetry": Telemetry,
    "health": Health,
    "event_announce": EventAnnounce,
    "event_done": EventDone,
    "last_will": LastWill,
    "command": CommandEnvelope,
    "event_intent_request": EventIntentRequest,
    "label_request": LabelRequest,
    "device_identity": DeviceIdentity,
}


def _collect(prefix: str) -> list[tuple[str, type[BaseModel], Path]]:
    out: list[tuple[str, type[BaseModel], Path]] = []
    for name, model in SCHEMAS.items():
        for path in sorted((FIXTURES / name).glob(f"{prefix}*.json")):
            out.append((name, model, path))
    return out


@pytest.mark.parametrize(
    ("schema_name", "model", "fixture"),
    _collect("valid"),
    ids=lambda x: x.name if isinstance(x, Path) else str(x),
)
def test_valid_fixtures_parse(schema_name: str, model: type[BaseModel], fixture: Path) -> None:
    payload = json.loads(fixture.read_text())
    model.model_validate(payload)


@pytest.mark.parametrize(
    ("schema_name", "model", "fixture"),
    _collect("invalid_"),
    ids=lambda x: x.name if isinstance(x, Path) else str(x),
)
def test_invalid_fixtures_rejected(schema_name: str, model: type[BaseModel], fixture: Path) -> None:
    payload = json.loads(fixture.read_text())
    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_every_schema_has_at_least_one_valid_and_one_invalid_fixture() -> None:
    for name in SCHEMAS:
        d = FIXTURES / name
        assert any(d.glob("valid*.json")), f"{name} has no valid fixture"
        assert any(d.glob("invalid_*.json")), f"{name} has no invalid fixture"


def test_event_state_machine_transitions() -> None:
    assert is_valid_event_transition(EventStatus.ANNOUNCED, EventStatus.UPLOAD_INTENT_CREATED)
    assert is_valid_event_transition(EventStatus.UPLOAD_INTENT_CREATED, EventStatus.UPLOADED)
    assert is_valid_event_transition(EventStatus.UPLOADED, EventStatus.AVAILABLE)
    assert is_valid_event_transition(EventStatus.FAILED, EventStatus.UPLOAD_INTENT_CREATED)
    assert is_valid_event_transition(EventStatus.ANNOUNCED, EventStatus.ANNOUNCED)

    assert not is_valid_event_transition(EventStatus.ANNOUNCED, EventStatus.AVAILABLE)
    assert not is_valid_event_transition(EventStatus.AVAILABLE, EventStatus.UPLOADED)
    assert not is_valid_event_transition(EventStatus.UPLOADED, EventStatus.ANNOUNCED)
