from __future__ import annotations

from types import SimpleNamespace

import pytest

from app.storage import Storage


class _Paginator:
    def __init__(self, pages: list[dict]) -> None:
        self.pages = pages
        self.calls: list[dict] = []

    def paginate(self, **kwargs):
        self.calls.append(kwargs)
        return iter(self.pages)


class _Client:
    def __init__(self, pages: list[dict] | None = None) -> None:
        self.paginator = _Paginator(pages or [])
        self.deletes: list[dict] = []

    def get_paginator(self, name: str) -> _Paginator:
        assert name == "list_objects_v2"
        return self.paginator

    def delete_objects(self, **kwargs) -> dict:
        self.deletes.append(kwargs)
        return {}


def _storage(client: _Client) -> Storage:
    storage = object.__new__(Storage)
    storage._client = client
    storage._settings = SimpleNamespace(S3_BUCKET="history")
    return storage


@pytest.mark.asyncio
async def test_list_objects_follows_every_page() -> None:
    client = _Client(
        [
            {"Contents": [{"Key": "events/a", "Size": 10}]},
            {},
            {"Contents": [{"Key": "events/b", "Size": 20}]},
        ]
    )

    objects = await _storage(client).list_objects("events/")

    assert [row["Key"] for row in objects] == ["events/a", "events/b"]
    assert client.paginator.calls == [{"Bucket": "history", "Prefix": "events/"}]


@pytest.mark.asyncio
async def test_delete_objects_batches_at_s3_limit() -> None:
    client = _Client()
    keys = [f"events/{index}" for index in range(2001)]

    deleted = await _storage(client).delete_objects(keys)

    assert deleted == 2001
    assert [len(call["Delete"]["Objects"]) for call in client.deletes] == [1000, 1000, 1]
    assert all(call["Delete"]["Quiet"] for call in client.deletes)


@pytest.mark.asyncio
async def test_delete_objects_does_not_call_s3_for_empty_input() -> None:
    client = _Client()

    assert await _storage(client).delete_objects([]) == 0
    assert client.deletes == []
