"""Procedural preview generator: deterministic + 90-second loop invariants."""

from __future__ import annotations

from app.preview import (
    LIVE_LOOP_SECONDS,
    SPECT_BANDS,
    preview_anomalies,
    preview_forecast,
    preview_sources,
    preview_spect,
    preview_summary_daily,
    preview_tick,
)


def test_tick_loops_on_90_seconds() -> None:
    """preview_tick(t) and preview_tick(t + 90) must produce identical
    LAeq/LAFmax values — the live stream loops cleanly."""
    for t in (0.0, 10.0, 27.3, 45.0, 88.9):
        a = preview_tick(t)
        b = preview_tick(t + LIVE_LOOP_SECONDS)
        assert a["laeq"] == b["laeq"], f"laeq mismatch at t={t}"
        assert a["lafmax"] == b["lafmax"], f"lafmax mismatch at t={t}"


def test_spect_loops_on_90_seconds() -> None:
    for t in (1.0, 30.0, 60.0):
        a = preview_spect(t)
        b = preview_spect(t + LIVE_LOOP_SECONDS)
        assert a["bands"] == b["bands"], f"bands mismatch at t={t}"


def test_spect_band_count_and_range() -> None:
    s = preview_spect(12.0)
    assert len(s["bands"]) == SPECT_BANDS
    # All bands should land in a plausible dB range. Floor is well above
    # silence (because the mock has a constant rumble floor), ceiling well
    # below clipping.
    for v in s["bands"]:
        assert 20.0 < v < 110.0


def test_tick_envelope_shape() -> None:
    msg = preview_tick(0.0)
    assert msg["type"] == "tick"
    assert isinstance(msg["laeq"], float)
    assert isinstance(msg["lafmax"], float)
    # LAFmax must be at or above LAeq — the peak detector can't read lower
    # than the average.
    assert msg["lafmax"] >= msg["laeq"]


def test_dashboard_rollups_are_deterministic() -> None:
    """Year heatmap and friends use a fixed seed so reloading the page
    returns the same numbers."""
    a = preview_summary_daily()
    b = preview_summary_daily()
    assert a["days"] == b["days"]

    assert preview_anomalies()["points"] == preview_anomalies()["points"]
    assert preview_forecast()["points"] == preview_forecast()["points"]
    assert preview_sources()["sources"] == preview_sources()["sources"]


def test_preview_anomalies_expose_measured_event_delta() -> None:
    points = preview_anomalies()["points"]
    for point in points:
        assert point["delta_db"] == round(
            point["peak_db"] - point["baseline_mean_db"], 1
        )
        assert point["baseline_n"] >= 8


def test_summary_daily_has_365_days_with_24h_each() -> None:
    r = preview_summary_daily()
    assert len(r["days"]) == 365
    for d in r["days"]:
        assert len(d["hours"]) == 24
        assert 0 <= d["dow"] <= 6
        assert 0 <= d["peak_hour"] <= 23


def test_sources_pcts_sum_to_about_100() -> None:
    r = preview_sources()
    total_pct = sum(s["pct"] for s in r["sources"])
    assert 99.5 < total_pct < 100.5
