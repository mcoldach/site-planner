"""Label mapper. Reads label_mapping.yaml and resolves a RawExtraction
into a (rule_key, constraint_kind, scope) tuple — or a list of them for
composite row labels — or 'ignored' for known non-rule rows — or 'unmapped'
for unrecognized labels that should be logged to the unmapped queue.
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


_FOOTNOTE_RE = re.compile(r"\s*\[\d+\]")
_PAREN_QUALIFIER_RE = re.compile(r"\s*\((minimum|maximum)\)", re.IGNORECASE)


def _normalize_category(label: str) -> str:
    out = _FOOTNOTE_RE.sub("", label)
    out = _PAREN_QUALIFIER_RE.sub("", out)
    return " ".join(out.lower().split())


def _normalize_row_label(label: str) -> str:
    return " ".join(label.lower().split())


class LabelMapper:
    def __init__(self, yaml_path: Path):
        with yaml_path.open("r") as f:
            data = yaml.safe_load(f)
        self.categories: dict[str, dict[str, Any]] = data.get("categories", {}) or {}
        self.rows: dict[str, dict[str, Any]] = data.get("rows", {}) or {}
        self.composites: dict[str, str] = data.get("composites", {}) or {}
        self.ignore_rows: set[str] = set(data.get("ignore_rows", []) or [])

    def map(self, ex: RawExtraction) -> MapOutput:
        if not ex.row_label:
            return MapOutput(MapResult.UNMAPPED, [])

        row_norm = _normalize_row_label(ex.row_label)
        if row_norm in self.ignore_rows:
            return MapOutput(MapResult.IGNORED, [])

        category_cfg = None
        if ex.label_path:
            category_norm = _normalize_category(ex.label_path[0])
            category_cfg = self.categories.get(category_norm)
        if not category_cfg:
            # Fallback: row label is self-categorizing (e.g. "Lot area (minimum)",
            # "Side (minimum)", "Corner Lot - Side Street"). Infer category from
            # leading tokens of the row label.
            row_lower = ex.row_label.lower()
            if "lot area" in row_lower or "lot width" in row_lower:
                category_cfg = self.categories.get("lot standards")
            elif "lot coverage" in row_lower:
                category_cfg = self.categories.get("lot coverage")
            elif row_lower.startswith(("side", "front", "rear", "corner lot")):
                category_cfg = self.categories.get("setbacks")
        if not category_cfg:
            return MapOutput(MapResult.UNMAPPED, [])

        category_kind: str = category_cfg.get("constraint_kind", "scalar_min")

        if row_norm in self.composites:
            fn_name = self.composites[row_norm]
            fn = COMPOSITE_REGISTRY.get(fn_name)
            if fn is None:
                return MapOutput(MapResult.UNMAPPED, [])
            tuples = fn(category_kind)
            if not tuples:
                return MapOutput(MapResult.UNMAPPED, [])
            return MapOutput(MapResult.MAPPED, [
                MappedClaim(rk, ck, sc) for (rk, ck, sc) in tuples
            ])

        row_cfg = self.rows.get(row_norm)
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
