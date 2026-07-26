"""require an outdoor audio clip before a candidate can be labeled

Verifying wind by eye is unreliable: a wind-buffeting peak and a passing truck
can look alike on a spectrogram. The reviewer has to *hear* the outside
microphone, so a candidate only enters the labeling queue once a real
``events`` row with uploaded FLAC bytes has been linked to it.

Linking is a separate step from detection because the device announces and
uploads a clip several seconds after the event ends, which is after the
detector has already created the candidate.

Revision ID: 0012
Revises: 0011
Create Date: 2026-07-25
"""

from __future__ import annotations

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID as PG_UUID


revision: str = "0012"
down_revision: Union[str, None] = "0011"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Links an outside-microphone clip whose audio interval overlaps the peak,
# preferring the clip whose start sits closest to the peak. Shared by the
# backfill below and the detector's linking pass.
LINK_SQL = """
UPDATE correlated_event_candidates AS c
SET outside_event_id = e.event_id,
    audio_state = 'linked'
FROM (
    SELECT cand.candidate_id, picked.event_id
    FROM correlated_event_candidates AS cand
    CROSS JOIN LATERAL (
        SELECT ev.event_id
        FROM events AS ev
        WHERE ev.device_id = cand.outside_device_id
          AND ev.storage_key IS NOT NULL
          AND ev.status IN ('uploaded', 'available')
          AND ev.ts < cand.outside_peak_ts + make_interval(secs => :match_window_s)
          AND ev.ts + make_interval(secs => ev.duration_s)
              > cand.outside_peak_ts - make_interval(secs => :match_window_s)
        ORDER BY abs(extract(epoch FROM (ev.ts - cand.outside_peak_ts)))
        LIMIT 1
    ) AS picked
    WHERE cand.audio_state <> 'linked'
) AS e
WHERE c.candidate_id = e.candidate_id
"""


def upgrade() -> None:
    op.add_column(
        "correlated_event_settings",
        sa.Column("audio_match_window_s", sa.Integer(), nullable=False, server_default="15"),
    )
    op.add_column(
        "correlated_event_settings",
        # An hour, not seconds: a node that loses its network spools clips to
        # disk and drains them much later, and giving up early would throw away
        # labelable audio that is still on its way.
        sa.Column("audio_grace_s", sa.Integer(), nullable=False, server_default="3600"),
    )
    op.create_check_constraint(
        "ck_correlated_event_settings_audio_match",
        "correlated_event_settings",
        "audio_match_window_s BETWEEN 1 AND 300",
    )
    op.create_check_constraint(
        "ck_correlated_event_settings_audio_grace",
        "correlated_event_settings",
        "audio_grace_s BETWEEN 10 AND 86400",
    )

    op.add_column(
        "correlated_event_candidates",
        sa.Column(
            "outside_event_id",
            PG_UUID(as_uuid=True),
            # Deleting a clip must not delete review work, so this nulls out
            # rather than cascading. The label CHECK below deliberately keys on
            # audio_state instead of this column so a clip deleted after review
            # cannot retroactively invalidate an existing label.
            sa.ForeignKey("events.event_id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "correlated_event_candidates",
        sa.Column("audio_state", sa.Text(), nullable=False, server_default="pending"),
    )
    op.create_check_constraint(
        "ck_correlated_event_candidates_audio_state",
        "correlated_event_candidates",
        "audio_state IN ('pending', 'linked', 'missing')",
    )
    op.create_index(
        "ix_correlated_event_candidates_audio",
        "correlated_event_candidates",
        ["audio_state", sa.text("outside_peak_ts DESC")],
    )

    # Backfill before adding the label guard so existing rows are classified.
    op.execute(sa.text(LINK_SQL).bindparams(match_window_s=15))
    op.execute(
        """
        UPDATE correlated_event_candidates
        SET audio_state = 'missing'
        WHERE audio_state = 'pending'
          AND outside_peak_ts < now() - make_interval(secs => 3600)
        """
    )

    # The invariant this migration exists for: no label without heard audio.
    op.create_check_constraint(
        "ck_correlated_event_candidates_label_needs_audio",
        "correlated_event_candidates",
        "label IS NULL OR audio_state = 'linked'",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_correlated_event_candidates_label_needs_audio",
        "correlated_event_candidates",
        type_="check",
    )
    op.drop_index(
        "ix_correlated_event_candidates_audio",
        table_name="correlated_event_candidates",
    )
    op.drop_constraint(
        "ck_correlated_event_candidates_audio_state",
        "correlated_event_candidates",
        type_="check",
    )
    op.drop_column("correlated_event_candidates", "audio_state")
    op.drop_column("correlated_event_candidates", "outside_event_id")
    op.drop_constraint(
        "ck_correlated_event_settings_audio_grace",
        "correlated_event_settings",
        type_="check",
    )
    op.drop_constraint(
        "ck_correlated_event_settings_audio_match",
        "correlated_event_settings",
        type_="check",
    )
    op.drop_column("correlated_event_settings", "audio_grace_s")
    op.drop_column("correlated_event_settings", "audio_match_window_s")
