"""S3/MinIO storage abstraction.

Phase 1 uses MinIO inside the dev cluster; Phase 3 swaps to R2 by changing
the endpoint and credentials — nothing in the API layer should reach past
this module. Presigned URLs are generated against the internal endpoint by
the SDK and then host-swapped to the public endpoint so devices/clients can
resolve them outside the cluster network.
"""

from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timezone
from functools import lru_cache
from urllib.parse import urlparse, urlunparse
from uuid import UUID

import boto3
from botocore.client import Config
from botocore.exceptions import ClientError

from .settings import Settings, get_settings


@dataclass(slots=True)
class PresignedPut:
    url: str
    storage_key: str
    required_headers: dict[str, str]
    expires_at: float


@dataclass(slots=True)
class PresignedGet:
    url: str
    expires_at: float


class Storage:
    """Thin wrapper over boto3. Presign calls are CPU-only (no network), but
    head_bucket/head_object hit the network — call those via ``to_thread``."""

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._client = boto3.client(
            "s3",
            endpoint_url=settings.S3_ENDPOINT,
            aws_access_key_id=settings.S3_ACCESS_KEY,
            aws_secret_access_key=settings.S3_SECRET_KEY,
            region_name=settings.S3_REGION,
            # SigV4 is what MinIO and R2 both speak; path-style is what MinIO
            # serves on its endpoint, and presigned URLs must agree.
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    # --- key allocation ---------------------------------------------------

    @staticmethod
    def event_key(device_id: UUID, event_id: UUID, ts: datetime) -> str:
        ts_utc = ts.astimezone(timezone.utc) if ts.tzinfo else ts.replace(tzinfo=timezone.utc)
        return (
            f"events/{ts_utc:%Y/%m/%d}/{device_id}/{event_id}.flac"
        )

    # --- presigning -------------------------------------------------------

    def presign_put(
        self,
        key: str,
        *,
        sha256_hex: str,
        size: int,
        ttl_seconds: int,
        content_type: str = "audio/flac",
    ) -> PresignedPut:
        # S3 / MinIO want the base64 of the raw 32-byte digest in
        # `x-amz-checksum-sha256`. The device computes hex (it's what fits in
        # the contract's SHA256Hex type), so we convert here. The header
        # pinning is what gives us tamper resistance — the device cannot
        # upload a different blob without changing the signed checksum.
        sha256_b64 = base64.b64encode(bytes.fromhex(sha256_hex)).decode("ascii")
        headers = {
            "Content-Type": content_type,
            "x-amz-checksum-sha256": sha256_b64,
        }
        url = self._client.generate_presigned_url(
            "put_object",
            Params={
                "Bucket": self._settings.S3_BUCKET,
                "Key": key,
                "ContentType": content_type,
                "ChecksumSHA256": sha256_b64,
            },
            ExpiresIn=ttl_seconds,
            HttpMethod="PUT",
        )
        return PresignedPut(
            url=self._rewrite_to_public(url),
            storage_key=key,
            required_headers=headers,
            expires_at=_now_unix() + ttl_seconds,
        )

    def presign_get(self, key: str, *, ttl_seconds: int) -> PresignedGet:
        url = self._client.generate_presigned_url(
            "get_object",
            Params={"Bucket": self._settings.S3_BUCKET, "Key": key},
            ExpiresIn=ttl_seconds,
            HttpMethod="GET",
        )
        return PresignedGet(url=self._rewrite_to_public(url), expires_at=_now_unix() + ttl_seconds)

    # --- bucket / object operations --------------------------------------

    async def bucket_ready(self) -> bool:
        """True when the configured bucket is reachable and exists. Idempotent."""

        def _check() -> bool:
            try:
                self._client.head_bucket(Bucket=self._settings.S3_BUCKET)
                return True
            except ClientError:
                return False

        return await asyncio.to_thread(_check)

    async def ensure_bucket(self) -> None:
        """Create the bucket if missing. minio-init also does this; calling
        from the backend on startup makes the API self-sufficient."""

        def _ensure() -> None:
            try:
                self._client.head_bucket(Bucket=self._settings.S3_BUCKET)
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "")
                if code not in {"404", "NoSuchBucket", "NotFound"}:
                    raise
                self._client.create_bucket(Bucket=self._settings.S3_BUCKET)

        await asyncio.to_thread(_ensure)

    async def head_object(self, key: str) -> dict | None:
        """Return object metadata if present, else None."""

        def _head() -> dict | None:
            try:
                return self._client.head_object(Bucket=self._settings.S3_BUCKET, Key=key)
            except ClientError as exc:
                code = exc.response.get("Error", {}).get("Code", "")
                if code in {"404", "NoSuchKey", "NotFound"}:
                    return None
                raise

        return await asyncio.to_thread(_head)

    # --- helpers ---------------------------------------------------------

    def _rewrite_to_public(self, url: str) -> str:
        """Swap the internal MinIO host with S3_PUBLIC_ENDPOINT.

        Presigned URLs are bound to the request host, but SigV4 places the host
        in the signed `Host` header, not the signature itself when the
        ``Host`` header matches the request. Re-pointing the URL to the
        public endpoint works as long as Traefik forwards the same path/query
        unchanged — which it does for the audio host.
        """
        public = urlparse(self._settings.S3_PUBLIC_ENDPOINT)
        parsed = urlparse(url)
        return urlunparse(parsed._replace(scheme=public.scheme, netloc=public.netloc))


def _now_unix() -> float:
    return datetime.now(timezone.utc).timestamp()


@lru_cache(maxsize=1)
def get_storage() -> Storage:
    return Storage(get_settings())
