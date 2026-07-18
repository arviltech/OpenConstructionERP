# DDC-CWICR-OE: DataDrivenConstruction · OpenConstructionERP
# Copyright (c) 2026 Artem Boiko / DataDrivenConstruction
"""Takeoff document - one row per (project, source document).

``POST /documents/from-source/{id}`` is a find-or-create with no lock and no
unique constraint, so two concurrent opens of the same Project-Files PDF could
both miss the SELECT and insert, minting duplicate ``oe_takeoff_document`` rows
for one source. Measurements attach to whichever row their session resolved to,
while a later reload resolves to the oldest row, so the measurements silently
disappear from view (they are not deleted, just stranded on a document id the
open path no longer returns).

This migration closes that in two steps:

1. Collapse any existing duplicate ``(project_id, source_document_id)`` groups
   (source_document_id NOT NULL): keep the oldest row as canonical, carry a
   duplicate's document-level ``page_scales`` calibration onto the canonical row
   when the canonical has none, re-point every ``oe_takeoff_measurement`` and
   ``oe_ai_takeoff_run`` that references a duplicate onto the canonical id, then
   delete the duplicate rows. The duplicates' copied PDF files on disk are not
   removed here (a DB migration has no filesystem access); they are harmless
   orphans.
2. Add a partial unique index on ``(project_id, source_document_id)`` WHERE
   ``source_document_id IS NOT NULL`` so the duplicate becomes impossible at the
   database level. The partial predicate leaves direct uploads (null source)
   unconstrained.

The dedup runs only on PostgreSQL (the supported engine; it uses window
functions and ``UPDATE ... FROM``). On other engines the step is skipped and
only the index is created. Chained after ``v3250_merge_open_heads`` (the current
single head). Idempotent: the dedup no-ops once collapsed, and the index is
inspector-guarded.

Revision ID: v3251_takeoff_source_unique_index
Revises: v3250_merge_open_heads
Create Date: 2026-07-18
"""

from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision: str = "v3251_takeoff_source_unique_index"
down_revision: Union[str, Sequence[str], None] = "v3250_merge_open_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


_TABLE = "oe_takeoff_document"
_INDEX = "uq_takeoff_document_project_source"

# Oldest row per (project, source) is canonical; every other row in the group is
# a duplicate to fold into it.
_RANKED_CTE = """
    WITH ranked AS (
        SELECT
            id,
            project_id,
            source_document_id,
            page_scales,
            updated_at,
            first_value(id) OVER (
                PARTITION BY project_id, source_document_id
                ORDER BY created_at ASC, id ASC
            ) AS canonical_id
        FROM oe_takeoff_document
        WHERE source_document_id IS NOT NULL AND project_id IS NOT NULL
    )
"""


def _has_table(inspector: sa.engine.reflection.Inspector, name: str) -> bool:
    return name in inspector.get_table_names()


def _has_index(inspector: sa.engine.reflection.Inspector, table: str, index: str) -> bool:
    if not _has_table(inspector, table):
        return False
    return any(ix["name"] == index for ix in inspector.get_indexes(table))


def _dedupe_existing(bind: sa.engine.Connection) -> None:
    """Collapse existing duplicate (project, source) groups before the index."""
    # Carry a duplicate's calibration onto the canonical row when it has none, so
    # a scale set on the row that later lost the race is not dropped.
    op.execute(
        _RANKED_CTE
        + """,
        donor AS (
            SELECT DISTINCT ON (canonical_id) canonical_id, page_scales
            FROM ranked
            WHERE id <> canonical_id AND page_scales IS NOT NULL
            ORDER BY canonical_id, updated_at DESC, id DESC
        )
        UPDATE oe_takeoff_document d
        SET page_scales = donor.page_scales
        FROM donor
        WHERE d.id = donor.canonical_id AND d.page_scales IS NULL;
        """
    )
    # Re-point measurements and AI plan-read runs off the duplicates. Both store
    # the takeoff-document id as a free-form String, and the measurement API
    # accepts any UUID spelling (uppercase, unhyphenated), persisting it as sent.
    # Compare on the normalized (lowercased, hyphen-stripped) form so a
    # non-canonical id still matches r.id::text (canonical lowercase-hyphenated)
    # and is repointed before its duplicate row is deleted. Legacy filename rows
    # normalize to a non-UUID string and simply do not match, which is correct.
    op.execute(
        _RANKED_CTE
        + """
        UPDATE oe_takeoff_measurement m
        SET document_id = r.canonical_id::text
        FROM ranked r
        WHERE replace(lower(m.document_id), '-', '') = replace(lower(r.id::text), '-', '')
          AND r.id <> r.canonical_id;
        """
    )
    op.execute(
        _RANKED_CTE
        + """
        UPDATE oe_ai_takeoff_run a
        SET document_id = r.canonical_id::text
        FROM ranked r
        WHERE replace(lower(a.document_id), '-', '') = replace(lower(r.id::text), '-', '')
          AND r.id <> r.canonical_id;
        """
    )
    # Delete the now-orphaned duplicate rows.
    op.execute(
        _RANKED_CTE
        + """
        DELETE FROM oe_takeoff_document d
        USING ranked r
        WHERE d.id = r.id AND r.id <> r.canonical_id;
        """
    )


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if not _has_table(inspector, _TABLE):
        # Base table not created yet - nothing to alter. Degrade silently so a
        # re-run after a manual fix stays non-destructive.
        return

    if bind.dialect.name == "postgresql":
        _dedupe_existing(bind)

    if not _has_index(inspector, _TABLE, _INDEX):
        op.create_index(
            _INDEX,
            _TABLE,
            ["project_id", "source_document_id"],
            unique=True,
            postgresql_where=sa.text("source_document_id IS NOT NULL"),
        )


def downgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    if _has_index(inspector, _TABLE, _INDEX):
        op.drop_index(_INDEX, table_name=_TABLE)
