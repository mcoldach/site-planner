"""
LM Studio embedder.

Posts batches to LM Studio's OpenAI-compatible /v1/embeddings endpoint.
LM Studio's quirk: it returns HTTP 200 with {'error': ...} on bad
endpoint or model. We check for that explicitly.
"""
from __future__ import annotations
import os
from typing import Iterable

import requests

BATCH_SIZE = 32
TIMEOUT = 120

LM_STUDIO_URL = os.environ.get("LM_STUDIO_URL", "http://localhost:1234/v1")
EMBEDDING_MODEL = os.environ.get(
    "EMBEDDING_MODEL", "text-embedding-nomic-embed-text-v1.5"
)


def _endpoint() -> str:
    return LM_STUDIO_URL.rstrip("/") + "/embeddings"


def embed_batch(texts: list[str]) -> list[list[float]]:
    """Embed a batch of strings, returning their 768-d vectors in order."""
    if not texts:
        return []
    r = requests.post(
        _endpoint(),
        json={"model": EMBEDDING_MODEL, "input": texts},
        timeout=TIMEOUT,
    )
    body = r.json() if "application/json" in r.headers.get("content-type", "") else None
    if r.status_code != 200 or not body or "error" in body:
        msg = body.get("error") if body else r.text[:300]
        raise RuntimeError(f"LM Studio embed failed: {msg}")
    if "data" not in body or len(body["data"]) != len(texts):
        raise RuntimeError(
            f"LM Studio embed returned wrong count: expected {len(texts)}, "
            f"got {len(body.get('data', []))}"
        )
    return [item["embedding"] for item in body["data"]]


def embed_all(texts: list[str]) -> Iterable[tuple[int, list[float]]]:
    """Embed a list of strings in batches, yielding (index, vector) pairs
    as each batch completes. Caller can write progressively."""
    for i in range(0, len(texts), BATCH_SIZE):
        batch = texts[i : i + BATCH_SIZE]
        vectors = embed_batch(batch)
        for j, vec in enumerate(vectors):
            yield i + j, vec
