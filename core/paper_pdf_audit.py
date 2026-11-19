# 论文 PDF 版面审计（v2.5 交接清单 F-3 / F-9 / F-13）
# 由 tools.js 的 buildPaper 直接 spawn（不经 pyguard：这是引擎自带脚本，与 xelatex 同级信任）。
# 只读，输出单行 JSON 到 stdout。文本提取不能代替视觉终检（F-12 仍要逐页 vision_read）。
import json
import sys
import re
from pathlib import Path

try:
    import pymupdf
except ImportError:  # 兼容旧包名
    import fitz as pymupdf


def paper_policy(value):
    if isinstance(value, dict):
        return value
    if not isinstance(value, str):
        return {}
    if value.startswith('{'):
        return json.loads(value)
    # Compatibility for callers passing a package id.
    if re.fullmatch(r'[a-z0-9-]+', value):
        rules = Path(__file__).resolve().parent.parent / 'contest_packages' / value / 'rules.json'
        if rules.is_file():
            return json.loads(rules.read_text(encoding='utf-8')).get('paper', {})
    return {}


def page_boundaries(texts, policy=None):
    """Local contract: abstract first, body through references, appendices separate.

    Require a heading line; prose such as '程序见附录' must not shorten the body.
    Text extraction is heuristic and the boundary remains subject to visual QA.
    """
    n = len(texts)
    policy = paper_policy(policy)
    has_abstract = n and (policy.get('abstract_first_page') or re.search(r'^\s*(?:摘\s*要|Abstract)\b', texts[0], re.I | re.M))
    abstract_pages = min(n, 1) if has_abstract else 0
    if abstract_pages and n > 1 and not re.search(r'关键词|关键字|Key\s*words', texts[0], re.I) and re.search(r'关键词|关键字|Key\s*words', texts[1], re.I):
        abstract_pages = 2
    toc_pages = 0
    if n > abstract_pages:
        pos = abstract_pages
        if re.search(r'^\s*目\s*录\s*$', texts[pos], re.M):
            toc_pages = 1
            # Continuation pages must have TOC leader/page patterns. Ambiguous
            # boundaries remain visual-QA work, never subtract arbitrary pages.
            while pos + toc_pages < n:
                nxt = texts[pos + toc_pages]
                if len(re.findall(r'(?:\.{3,}|…{2,}|·{3,})\s*\d+\s*$', nxt, re.M)) < 2:
                    break
                toc_pages += 1
    front_pages = abstract_pages + toc_pages
    appendix_page = None
    shared_page = False
    for i in range(front_pages, n):
        lines = texts[i][:600].splitlines()
        for j, line in enumerate(lines):
            titles = policy.get('appendix_heading_titles', [])
            headings = [r'附\s*录(?:\s*[A-Z一二三四五六七八九十\d]+)?(?:\s*[:：]\s*[^。！？]{1,60}|\s+[^。！？]{1,60})?', '支撑材料文件列表', '完整源程序代码']
            headings += [re.escape(title) for title in titles if isinstance(title, str) and title and title != '附录']
            pattern = r'^\s*(?:[A-Z\d]+[.、]?\s+)?(?:' + '|'.join(headings) + r')\s*$'
            split_heading = j > 0 and re.fullmatch(r'\s*[A-Z\d]+\s*', lines[j - 1]) and re.fullmatch(r'\s*(?:' + '|'.join(headings) + r')\s*', line)
            if re.match(pattern, line) or split_heading:
                appendix_page = i
                shared_page = any(s.strip() and not re.fullmatch(r'\s*[A-Z\d]+\s*', s) for s in lines[:j])
                break
        if appendix_page is not None:
            break
    return {
        'body_pages': max(0, (appendix_page + int(shared_page) if appendix_page is not None else n) - front_pages),
        'toc_pages': toc_pages,
        'abstract_pages': abstract_pages,
        'appendix_start_page': appendix_page + 1 if appendix_page is not None else None,
        'appendix_pages': n - appendix_page if appendix_page is not None else 0,
        'shared_body_appendix_page': shared_page,
        'page_count_basis': '摘要与目录单列；正文到附录起始前；附录另计（标题文本识别，须视觉核对）',
    }


def mcm_pdf_metadata(doc):
    """Conservative physical-page facts for the COMAP-specific policy gate."""
    headings = []
    headers = []
    small_text = []
    for index, page in enumerate(doc):
        header = []
        blocks = page.get_text('dict').get('blocks', [])
        all_spans = [span for block in blocks for line in block.get('lines', []) for span in line.get('spans', [])]
        for block in blocks:
            for line in block.get('lines', []):
                title_spans = [span for span in line.get('spans', []) if span.get('text', '').strip()]
                if title_spans and all(span.get('size', 0) >= 13.5 for span in title_spans):
                    title = ' '.join(' '.join(span.get('text', '').split()) for span in title_spans).strip()
                    top = min(span.get('bbox', [0, 0, 0, 0])[1] for span in title_spans)
                    prior = any(85 <= prior_span.get('bbox', [0, 0, 0, 0])[1] < top - 2
                                and prior_span.get('text', '').strip() for prior_span in all_spans)
                    if title and len(title) <= 180:
                        headings.append({'page': index + 1, 'text': title, 'size': round(max(span.get('size', 0) for span in title_spans), 1), 'prior_body': prior})
                for span in line.get('spans', []):
                    value = ' '.join(span.get('text', '').split())
                    if not value:
                        continue
                    size = span.get('size', 0)
                    top = span.get('bbox', [0, 0, 0, 0])[1]
                    if top < 85:
                        header.append(value)
                    # Page numbers, headers and math subscripts do not set the prose font size.
                    if 85 <= top <= page.rect.height - 55 and len(re.findall(r'[A-Za-z]', value)) >= 4 and size < 11.7:
                        if len(small_text) < 20:
                            small_text.append({'page': index + 1, 'text': value[:80], 'size': round(size, 1)})
        headers.append(' '.join(header)[:500])
    return {'headings': headings[:500], 'headers': headers, 'undersized_text': small_text,
            'first_page_text': doc[0].get_text()[:8000] if doc.page_count else ''}


def audit(pdf_path, policy=None):
    doc = pymupdf.open(pdf_path)
    n = doc.page_count
    p1 = doc[0].get_text() if n else ''
    # 摘要+关键词是否落在第 1 页（2026 规范：摘要含题目与关键词，原则上一页）
    kw_on_p1 = ('关键词' in p1) or ('关键字' in p1) or ('Key words' in p1) or ('Keywords' in p1)
    # 摘要是否溢出（第 1 页没有关键词，但第 2 页有 → 明确溢出）
    kw_on_p2 = n > 1 and (('关键词' in doc[1].get_text()) or ('关键字' in doc[1].get_text()))
    # 每页内容到达高度（排除页脚页码区 70pt）；<0.6 视为半空页
    fills = []
    for p in doc:
        H = p.rect.height
        ys = [b[3] for b in p.get_text('blocks') if b[3] < H - 70]
        try:
            ys += [d['rect'].y1 for d in p.get_drawings() if d['rect'].y1 < H - 70]
        except Exception:
            pass
        fills.append(round(max(ys) / (H - 70), 2) if ys else 0.0)
    half = [i + 1 for i, f in enumerate(fills[:-1]) if f < 0.6]
    boundaries = page_boundaries([p.get_text() for p in doc], policy)
    # 逐页是否出现超宽内容（公式/表格溢出）
    overflow = []
    for i, p in enumerate(doc):
        W = p.rect.width
        for b in p.get_text('blocks'):
            if b[2] > W - 20:
                overflow.append(i + 1)
                break
    # 最后一页是否为空
    tail_blank = n > 1 and fills[-1] < 0.15
    return {
        'pages': n,
        'kw_on_p1': kw_on_p1,
        'kw_on_p2': kw_on_p2,
        'fills': fills,
        'half_pages': half,
        **boundaries,
        'overflow_pages': overflow,
        'tail_blank': tail_blank,
        'mcm': mcm_pdf_metadata(doc) if paper_policy(policy).get('mcm_layout') else None,
    }


if __name__ == '__main__':
    try:
        print(json.dumps(audit(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else 'generic'), ensure_ascii=False))
    except Exception as e:  # 审计失败不能阻塞编译主流程
        print(json.dumps({'error': str(e)}, ensure_ascii=False))
