"""Label mapper. Resolves a RawExtraction into one or more
(rule_key, constraint_kind, scope) tuples — or 'ignored' / 'unmapped'.

Shape-aware: the YAML may define a top-level `per_zone_matrix:` block with
its own categories/rows/composites/ignore_rows. The dimensional vocabulary
stays at the top level and is the default. The mapper selects the block from
ex.shape, so the two table shapes can assign different meaning to the same
label string without colliding (e.g. 'maximum' is a divider in dimensional
but a real lot.coverage rule in the matrix).
"""

from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any
import re

import yaml

from extract import RawExtraction
from composites import REGISTRY as COMPOSITE_REGISTRY


class MapResult(str, Enum):
    MAPPED = "mapped"
    IGNORED = "ignored"
    UNMAPPED = "unmapped"


@dataclass
class MappedClaim:
    rule_key: str
    constraint_kind: str
    scope: dict[str, str]


@dataclass
class MapOutput:
    result: MapResult
    claims: list[MappedClaim]


@dataclass
class _Block:
    categories: dict[str, dict[str, Any]]
    rows: dict[str, dict[str, Any]]
    composites: dict[str, str]
    ignore_rows: set[str]


_FOOTNOTE_RE = re.compile(r"\s*\[\d+\]")
_PAREN_QUALIFIER_RE = re.compile(r"\s*\((minimum|maximum)\)", re.IGNORECASE)


def _normalize_category(label: str) -> str:
    out = _FOOTNOTE_RE.sub("", label)
    out = _PAREN_QUALIFIER_RE.sub("", out)
    return " ".join(out.lower().split())


def _normalize_row_label(label: str) -> str:
    out = _FOOTNOTE_RE.sub("", label)
    return " ".join(out.lower().split())


class LabelMapper:
    def __init__(self, yaml_path: Path):
        with yaml_path.open("r") as f:
            data = yaml.safe_load(f) or {}
        self._default = self._load_block(data)
        matrix_data = data.get("per_zone_matrix")
        self._matrix = self._load_block(matrix_data) if matrix_data else None
        per_use_ratio_data = data.get("per_use_ratio")
        self._per_use_ratio = (
            self._load_block(per_use_ratio_data) if per_use_ratio_data else None
        )
        per_use_loading_data = data.get("per_use_loading")
        self._per_use_loading = (
            self._load_block(per_use_loading_data) if per_use_loading_data else None
        )

    @staticmethod
    def _load_block(data: dict[str, Any] | None) -> _Block:
        data = data or {}
        return _Block(
            categories=data.get("categories", {}) or {},
            rows=data.get("rows", {}) or {},
            composites=data.get("composites", {}) or {},
            ignore_rows=set(data.get("ignore_rows", []) or []),
        )

    def _block_for(self, shape: str) -> _Block:
        if shape == "per_zone_matrix" and self._matrix is not None:
            return self._matrix
        if shape == "per_use_ratio" and self._per_use_ratio is not None:
            return self._per_use_ratio
        if shape == "per_use_loading" and self._per_use_loading is not None:
            return self._per_use_loading
        return self._default

    def map(self, ex: RawExtraction) -> MapOutput:
        block = self._block_for(getattr(ex, "shape", ""))

        if not ex.row_label:
            return MapOutput(MapResult.UNMAPPED, [])

        row_norm = _normalize_row_label(ex.row_label)
        if row_norm in block.ignore_rows:
            return MapOutput(MapResult.IGNORED, [])

        # Category gate. Blocks that define categories (default, matrix) require
        # label_path[0] to resolve to a category before any row maps. A row-only
        # block (per_use_ratio, no categories) skips the gate — the row label is
        # the use category itself and carries its own constraint_kind.
        category_kind: str = "scalar_min"
        if block.categories:
            category_cfg = None
            if ex.label_path:
                category_norm = _normalize_category(ex.label_path[0])
                category_cfg = block.categories.get(category_norm)
            if not category_cfg:
                # Fallback: row label is self-categorizing.
                row_lower = ex.row_label.lower()
                if "lot area" in row_lower or "lot width" in row_lower:
                    category_cfg = (block.categories.get("lot standards")
                                    or block.categories.get("lot area"))
                elif "lot coverage" in row_lower:
                    category_cfg = block.categories.get("lot coverage")
                elif row_lower.startswith(("side", "front", "rear", "corner lot")):
                    category_cfg = block.categories.get("setbacks")
            if not category_cfg:
                return MapOutput(MapResult.UNMAPPED, [])
            category_kind = category_cfg.get("constraint_kind", "scalar_min")

        if row_norm in block.composites:
            fn_name = block.composites[row_norm]
            fn = COMPOSITE_REGISTRY.get(fn_name)
            if fn is None:
                return MapOutput(MapResult.UNMAPPED, [])
            tuples = fn(category_kind)
            if not tuples:
                return MapOutput(MapResult.UNMAPPED, [])
            return MapOutput(MapResult.MAPPED, [
                MappedClaim(rk, ck, sc) for (rk, ck, sc) in tuples
            ])

        row_cfg = block.rows.get(row_norm)
        if not row_cfg:
            return MapOutput(MapResult.UNMAPPED, [])

        rule_key = row_cfg.get("rule_key")
        if not rule_key:
            return MapOutput(MapResult.UNMAPPED, [])

        constraint_kind = row_cfg.get("constraint_kind", category_kind)
        scope = dict(row_cfg.get("scope") or {})

        return MapOutput(MapResult.MAPPED, [
            MappedClaim(rule_key, constraint_kind, scope)
        ])
