"""Tests for the EventIntentRequest prelim fields and the classification-
overwrite guard in the events API."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from app.api.v1.events import _can_overwrite_classification
from app.contracts import EventIntentRequest


_BASE_PAYLOAD = {
    "event_id": "5b8e9b1c-1c8a-4c3d-9e0a-72c1d2e3f4a5",
    "ts": 1745673612.45,
    "duration_s": 15.0,
    "peak_db": 92.1,
    "sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    "size": 1572864,
    "content_type": "audio/flac",
    "nonce": "f3a9c2b1e4d5a6b7",
}


def test_intent_request_accepts_no_prelim() -> None:
    """Older firmware sends no prelim fields — must still validate."""
    req = EventIntentRequest.model_validate(_BASE_PAYLOAD)
    assert req.prelim_classification is None
    assert req.prelim_confidence is None
    assert req.prelim_model_version is None


def test_intent_request_accepts_complete_prelim() -> None:
    payload = {
        **_BASE_PAYLOAD,
        "prelim_classification": "motorcycle",
        "prelim_confidence": 0.91,
        "prelim_model_version": "pi-v1",
    }
    req = EventIntentRequest.model_validate(payload)
    assert req.prelim_classification == "motorcycle"
    assert req.prelim_confidence == 0.91
    assert req.prelim_model_version == "pi-v1"


@pytest.mark.parametrize(
    "missing",
    [
        ("prelim_confidence", "prelim_model_version"),
        ("prelim_classification", "prelim_model_version"),
        ("prelim_classification", "prelim_confidence"),
    ],
)
def test_intent_request_rejects_partial_prelim(missing: tuple[str, ...]) -> None:
    full = {
        **_BASE_PAYLOAD,
        "prelim_classification": "wind",
        "prelim_confidence": 0.7,
        "prelim_model_version": "pi-v1",
    }
    for key in missing:
        full.pop(key)
    with pytest.raises(ValidationError):
        EventIntentRequest.model_validate(full)


def test_intent_request_rejects_invalid_label() -> None:
    payload = {
        **_BASE_PAYLOAD,
        "prelim_classification": "not_a_label",
        "prelim_confidence": 0.7,
        "prelim_model_version": "pi-v1",
    }
    with pytest.raises(ValidationError):
        EventIntentRequest.model_validate(payload)


@pytest.mark.parametrize("bad_conf", [-0.01, 1.01])
def test_intent_request_rejects_out_of_range_confidence(bad_conf: float) -> None:
    payload = {
        **_BASE_PAYLOAD,
        "prelim_classification": "wind",
        "prelim_confidence": bad_conf,
        "prelim_model_version": "pi-v1",
    }
    with pytest.raises(ValidationError):
        EventIntentRequest.model_validate(payload)


class TestCanOverwriteClassification:
    """Pi prelim must never regress a backend (Track 2) classification."""

    def test_no_existing_can_overwrite(self) -> None:
        assert _can_overwrite_classification(None, "pi-v1") is True

    def test_pi_can_overwrite_older_pi_version(self) -> None:
        assert _can_overwrite_classification("pi-v1", "pi-v2") is True

    def test_pi_can_replace_same_version(self) -> None:
        # A retry must succeed (idempotent endpoint).
        assert _can_overwrite_classification("pi-v1", "pi-v1") is True

    def test_pi_cannot_regress_to_older_pi_version(self) -> None:
        assert _can_overwrite_classification("pi-v3", "pi-v1") is False

    def test_pi_cannot_overwrite_backend_version(self) -> None:
        # "v3" is Track 2 — Pi prelim arriving on retry must lose.
        assert _can_overwrite_classification("v3", "pi-v9") is False

    def test_pi_cannot_overwrite_backend_version_when_incoming_unknown(self) -> None:
        assert _can_overwrite_classification("v1", None) is False
