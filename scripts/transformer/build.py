"""Claim builder. Combines a RawExtraction + a MappedClaim into a complete
claim record matching the ontology. The database CHECK constraint
(claim_value_shape_valid) validates shape at insert time."""

from __future__ import annotations
from dataclasses import dataclass
from typing import Any

from extract import RawExtraction
from mapping import MappedClaim


@dataclass
class BuiltClaim:
    rule_key: str
    constraint_kind: str
    value_kind: str
    value: dict[str, Any]
    scope: dict[str, str]
    zone_district_code: str | None
    section_ref: str
    source_table_id: str
    notes: str | None


def build_claim(ex: RawExtraction, m: MappedClaim) -> BuiltClaim | None:
    notes: str | None = None
    if ex.footnotes:
        footnote_str = ", ".join(str(f) for f in ex.footnotes)
        notes = f"Footnote(s): [{footnote_str}]"

    if ex.parse_status == "numeric":
        unit = ex.unit
        if unit in ("%", "percent"):
            value_kind = "percent"
            value = {"n": ex.value}
        elif unit:
            value_kind = "number"
            value = {"n": ex.value, "unit": unit}
        else:
            return None

        return BuiltClaim(
            rule_key=m.rule_key,
            constraint_kind=m.constraint_kind,
            value_kind=value_kind,
            value=value,
            scope=m.scope,
            zone_district_code=ex.zone,
            section_ref=ex.section_ref,
            source_table_id=ex.document_table_id,
            notes=notes,
        )

    if ex.parse_status == "non_numeric":
        if not isinstance(ex.value, str):
            return None
        return BuiltClaim(
            rule_key=m.rule_key,
            constraint_kind="prose_deferred",
            value_kind="prose_deferred",
            value={"prose": ex.value},
            scope=m.scope,
            zone_district_code=ex.zone,
            section_ref=ex.section_ref,
            source_table_id=ex.document_table_id,
            notes=notes,
        )

    return None
