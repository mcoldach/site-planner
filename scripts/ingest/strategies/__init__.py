"""
Strategy registry for table-extraction.

A strategy is a publisher-specific set of overrides on top of GenericStrategy:
the conventions of how a particular publisher (American Legal, Municode, etc.)
typesets ordinances determine how their tables come out of pdfplumber.

Detection looks at the first-page text for known publisher markers; falls
back to 'generic' when nothing matches. The strategy used is recorded on
documents.parser_strategy so we know what processed each doc.
"""
from .base import GenericStrategy, Strategy
from .amlegal import AmLegalStrategy

REGISTRY: dict[str, Strategy] = {
    "generic": GenericStrategy(),
    "amlegal": AmLegalStrategy(),
    # 'municode': written when we ingest EPC's LDC.
}


def detect_strategy(first_page_text: str) -> tuple[str, Strategy]:
    """Pick a strategy from cues in the first page's text.

    Returns (strategy_name, strategy_instance). The name gets persisted to
    documents.parser_strategy for later re-parsing or auditing.
    """
    t = (first_page_text or "").lower()
    if "american legal publishing" in t or "amlegal.com" in t:
        return "amlegal", REGISTRY["amlegal"]
    if "municode" in t or "municode.com" in t:
        # Not yet implemented; fall to generic but record the *intended* slot.
        return "municode", REGISTRY["generic"]
    return "generic", REGISTRY["generic"]
