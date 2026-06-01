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


def _merge_notes(ex: RawExtraction) -> str | None:
    """Combine the §8.8 qualifier (split out of a polluted unit) with any
    footnote markers. Either, both, or neither may be present."""
    parts: list[str] = []
    if ex.notes:
        parts.append(ex.notes)
    if ex.footnotes:
        footnote_str = ", ".join(str(f) for f in ex.footnotes)
        parts.append(f"Footnote(s): [{footnote_str}]")
    return "; ".join(parts) if parts else None


def build_claim(ex: RawExtraction, m: MappedClaim) -> BuiltClaim | None:
    notes = _merge_notes(ex)

    if (m.constraint_kind == "ratio"
            and ex.parse_status == "numeric"
            and ex.denominator is not None):
        # value_kind='ratio' requires numerator + denominator (jsonb numbers)
        # and denominator_unit (jsonb string) per claim_value_shape_valid.
        value: dict[str, Any] = {
            "numerator": ex.value,
            "denominator": ex.denominator,
            "denominator_unit": ex.denominator_unit,
        }
        if ex.basis is not None:
            value["basis"] = ex.basis
        return BuiltClaim(
            rule_key=m.rule_key,
            constraint_kind="ratio",
            value_kind="ratio",
            value=value,
            scope=m.scope,
            zone_district_code=ex.zone,
            section_ref=ex.section_ref,
            source_table_id=ex.document_table_id,
            notes=notes,
        )

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
