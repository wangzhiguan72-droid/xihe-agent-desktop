"""Index a legally obtained APMCM PDF archive for local, page-level reading.

Usage: python scripts/ingest_apmcm.py <archive.zip>
Only PDF members are opened; archive paths are never used as output paths.
The generated page text is for local reference and must not be redistributed.
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path

import pymupdf


OUTPUT = Path(__file__).resolve().parents[1] / "knowledge" / "apmcm"
MEMBER = re.compile(r"(20\d{2})年([A-E])题优秀论文\.pdf$", re.I)
STRUCTURE = re.compile(
    r"^\s*(?:\d+(?:\s*\.\s*\d+)*\s*[.．]?\s+|[IVX]+[.．]\s+)?"
    r"(?:abstract|summary|contents?|introduction|problem analysis|model assumptions?|"
    r"symbols?|notations?|data (?:sources?|preprocessing|processing)|"
    r"model(?:ing|ling)?|results?|validation|verification|sensitivity|"
    r"robustness|discussion|conclusions?|references?|appendix)\b",
    re.I,
)


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def member_name(info: zipfile.ZipInfo) -> str:
    """Repair legacy Chinese ZIP names when the UTF-8 flag was not set."""
    name = info.filename
    if not info.flag_bits & 0x800:
        try:
            repaired = name.encode("cp437").decode("gbk")
            if "APMCM" in repaired:
                return repaired
        except (UnicodeError, UnicodeEncodeError):
            pass
    return name


def index(archive: Path, output: Path = OUTPUT) -> dict:
    archive_bytes = archive.read_bytes()
    output.mkdir(parents=True, exist_ok=True)
    pages_dir = output / "pages"
    pages_dir.mkdir(exist_ok=True)
    records = []
    structures = []
    seen_ids = set()
    keywords = {"summary": r"\b(?:summary|abstract)\b", "contents": r"\bcontents\b",
                "assumptions": r"\bassumptions?\b", "sensitivity": r"\bsensitivity\b",
                "validation": r"\b(?:validation|verification)\b", "references": r"\breferences\b",
                "appendix": r"\bappendi(?:x|ces)\b"}
    with zipfile.ZipFile(archive) as bundle:
        for info in bundle.infolist():
            if info.is_dir() or not info.filename.lower().endswith(".pdf"):
                continue
            name = member_name(info)
            match = MEMBER.search(name)
            if not match:
                raise ValueError(f"Unexpected PDF member name: {name}")
            year, problem = match.groups()
            doc_id = f"{year}-{problem.upper()}"
            if doc_id in seen_ids:
                raise ValueError(f"Duplicate PDF identity: {doc_id}")
            seen_ids.add(doc_id)
            data = bundle.read(info)
            document = pymupdf.open(stream=data, filetype="pdf")
            pages = []
            all_text = []
            for number, page in enumerate(document, 1):
                body = page.get_text(sort=True)
                all_text.append(body)
                headings = [s.strip() for s in body.splitlines()
                            if 5 <= len(s.strip()) <= 110 and STRUCTURE.match(s.strip())]
                pages.append({"pdf_page": number, "characters": len(body),
                              "headings_heuristic": headings[:15]})
            (pages_dir / f"{doc_id}.json").write_text(
                json.dumps({"id": doc_id, "pages": [
                    {**meta, "text": body} for meta, body in zip(pages, all_text)]},
                    ensure_ascii=False, indent=2), encoding="utf-8")
            first = all_text[0] if all_text else ""
            team = re.search(r"apmcm\d{7,9}", first, re.I)
            # Page counters printed by the source may describe pages absent from this PDF.
            counters = [int(n) for body in (all_text[:2] + all_text[-2:])
                        for n in re.findall(r"(?:Page\s*\d+\s*of\s*|P\d+\s*of\s*)(\d+)", body, re.I)]
            records.append({
                "id": doc_id, "year": int(year), "problem": problem.upper(),
                "archive_member": name, "pdf_sha256": sha256(data),
                "pdf_pages_available": len(document),
                "printed_total_pages_observed": sorted(set(counters)),
                "possible_truncation": any(n > len(document) for n in counters),
                "team_id_observed": team.group(0) if team else None,
                "text_extraction": "embedded_text" if sum(len(t) > 100 for t in all_text) >= len(all_text) * .8 else "mixed_or_scan_check_ocr",
                "pages_with_under_40_chars": [n for n, t in enumerate(all_text, 1) if len(t.strip()) < 40],
                "summary_sheet_observed": bool(re.search(r"APMCM\s*summary\s*sheet", first, re.I)),
                "page_index": f"pages/{doc_id}.json", "status": "historical_user_archive_unverified_award_grade",
            })
            structures.append({"id": doc_id, "actual_pages": len(document),
                               "possible_truncation": records[-1]["possible_truncation"],
                               "keyword_page_evidence": {key: [n for n, text in enumerate(all_text, 1)
                                                               if re.search(pattern, text, re.I)]
                                                         for key, pattern in keywords.items()}})
            document.close()
    records.sort(key=lambda r: (r["year"], r["problem"]))
    catalog = {"schema_version": 1, "archive_path": str(archive),
               "archive_sha256": sha256(archive_bytes), "pdf_count": len(records),
               "total_pdf_pages_available": sum(r["pdf_pages_available"] for r in records),
               "papers": records,
               "provenance_note": "Local user-supplied archive; filenames alone do not verify award level, official rules, or document completeness."}
    (output / "catalog.json").write_text(json.dumps(catalog, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    summary = {"schema_version": 1,
               "method": "Case-insensitive English keyword detection in extracted text; keyword presence is not section or scientific validity verification. PDF page indices are 1-based.",
               "archive_sha256": catalog["archive_sha256"],
               "documents": sorted(structures, key=lambda row: row["id"]),
               "document_keyword_coverage": {key: sum(bool(row["keyword_page_evidence"][key]) for row in structures)
                                             for key in keywords}}
    (output / "structure-summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return catalog


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit('usage: python scripts/ingest_apmcm.py <archive.zip>')
    source = Path(sys.argv[1])
    result = index(source)
    print(json.dumps({"pdf_count": result["pdf_count"], "pages": result["total_pdf_pages_available"],
                      "possible_truncation": [r["id"] for r in result["papers"] if r["possible_truncation"]]}, ensure_ascii=False))
