from __future__ import annotations

from uuid import UUID

import pytest

from scripts.reset_history import _belongs_to_device, _s3_objects


DEVICE_A = UUID("00000000-0000-4000-8000-00000000000a")
DEVICE_B = UUID("00000000-0000-4000-8000-00000000000b")


class _Storage:
    async def list_objects(self, prefix: str) -> list[dict]:
        return [
            {
                "Key": f"{prefix}2026/08/01/{DEVICE_A}/one.bin",
                "Size": 12,
            },
            {
                "Key": f"{prefix}2026/08/01/{DEVICE_B}/two.bin",
                "Size": 30,
            },
        ]


def test_object_scope_matches_a_complete_key_segment() -> None:
    selected = frozenset({str(DEVICE_A)})

    assert _belongs_to_device(f"events/2026/08/01/{DEVICE_A}/x.flac", selected)
    assert not _belongs_to_device(f"events/2026/08/01/{DEVICE_B}/x.flac", selected)
    assert not _belongs_to_device(f"events/2026/08/01/prefix-{DEVICE_A}/x", selected)


@pytest.mark.asyncio
async def test_s3_report_and_keys_are_device_scoped() -> None:
    counts, keys = await _s3_objects(_Storage(), (DEVICE_A,))  # type: ignore[arg-type]

    assert [row.items for row in counts] == [1, 1]
    assert [row.bytes for row in counts] == [12, 12]
    assert keys == [
        f"events/2026/08/01/{DEVICE_A}/one.bin",
        f"spectrograms/2026/08/01/{DEVICE_A}/one.bin",
    ]
