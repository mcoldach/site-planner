"""Composite row-label handlers.

When a row label fuses multiple rules or rule+scope, the YAML routes it
to a named function here. Each function returns a list of
(rule_key, constraint_kind, scope_dict) tuples. The transformer emits
one claim per tuple, all pointing at the same source_table_id with
the same value/unit (the source row only has one numeric cell).

Strict rule: if a composite can't confidently split, return [] and the
transformer logs the row to unmapped_table_labels.
"""

from __future__ import annotations
from typing import Callable


def split_front_and_side_street(category_kind: str) -> list[tuple]:
    return [
        ("setback.front",       category_kind, {}),
        ("setback.side_street", category_kind, {}),
    ]


def house_garage_adjacent_arterial(category_kind: str) -> list[tuple]:
    scope = {"adjacency": "collector_parkway_arterial"}
    return [
        ("setback.front", category_kind,
         {**scope, "building_element": "principal_building"}),
        ("setback.front", category_kind,
         {**scope, "building_element": "accessory_building"}),
    ]


def house_and_attached_garage_general(category_kind: str) -> list[tuple]:
    return [
        ("setback.front", category_kind, {"building_element": "principal_building"}),
    ]


def garage_general_from_sidewalk(category_kind: str) -> list[tuple]:
    return [
        ("setback.front", category_kind, {"building_element": "accessory_building"}),
    ]


def detached_garage_from_alley(category_kind: str) -> list[tuple]:
    return [
        ("setback.rear", category_kind, {"building_element": "accessory_building"}),
    ]


def adjacent_residential_zone_or_use(category_kind: str) -> list[tuple]:
    scope = {"adjacency": "residential_zone_or_use",
             "building_element": "principal_building"}
    return [
        ("setback.front", category_kind, scope),
        ("setback.side",  category_kind, scope),
        ("setback.rear",  category_kind, scope),
    ]


REGISTRY: dict[str, Callable[[str], list[tuple]]] = {
    "split_front_and_side_street":          split_front_and_side_street,
    "house_garage_adjacent_arterial":       house_garage_adjacent_arterial,
    "house_and_attached_garage_general":    house_and_attached_garage_general,
    "garage_general_from_sidewalk":         garage_general_from_sidewalk,
    "detached_garage_from_alley":           detached_garage_from_alley,
    "adjacent_residential_zone_or_use":     adjacent_residential_zone_or_use,
}
