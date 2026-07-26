"""use the EventLabel source taxonomy for two-mic candidates

Revision ID: 0013
Revises: 0012
"""

from typing import Union

from alembic import op


revision: str = "0013"
down_revision: Union[str, None] = "0012"
branch_labels: Union[str, tuple[str, ...], None] = None
depends_on: Union[str, tuple[str, ...], None] = None


EVENT_LABELS_SQL = (
    "'motorcycle', 'car', 'truck', 'construction', 'helicopter', "
    "'airplane', 'siren', 'horn', 'dog', 'voice', 'trash pickup', "
    "'wind', 'rain', 'thunder', 'other'"
)


def upgrade() -> None:
    op.drop_constraint(
        "ck_correlated_event_candidates_label",
        "correlated_event_candidates",
        type_="check",
    )

    # A legacy "real" review proves the peak was not wind, but it does not tell
    # us which source made it. Guessing a source (including "other") would keep
    # the same grab-bag training class under a new name, so return those rows to
    # the review queue. "unsure" was never a training label and is likewise no
    # longer part of the source taxonomy. Existing wind reviews remain valid.
    op.execute(
        """
        UPDATE correlated_event_candidates
        SET label = NULL
        WHERE label IN ('real', 'unsure')
        """
    )

    op.create_check_constraint(
        "ck_correlated_event_candidates_label",
        "correlated_event_candidates",
        f"label IS NULL OR label IN ({EVENT_LABELS_SQL})",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_correlated_event_candidates_label",
        "correlated_event_candidates",
        type_="check",
    )

    # Collapse the source taxonomy back to the old binary verdict before
    # restoring its narrower constraint. Rain and thunder belong to the same
    # suppression-negative bucket as wind; every other source is genuine.
    op.execute(
        """
        UPDATE correlated_event_candidates
        SET label = CASE
            WHEN label IN ('wind', 'rain', 'thunder') THEN 'wind'
            ELSE 'real'
        END
        WHERE label IS NOT NULL
        """
    )

    op.create_check_constraint(
        "ck_correlated_event_candidates_label",
        "correlated_event_candidates",
        "label IS NULL OR label IN ('real', 'wind', 'unsure')",
    )
