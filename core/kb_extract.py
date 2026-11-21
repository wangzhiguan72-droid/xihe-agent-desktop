# -*- coding: utf-8 -*-
# 羲和知识库离线索引器（kb_build 的后台 worker；也可独立跑：python kb_extract.py --root "<语料目录>" --out <appDir>/data/kb）
# 只做两件事：从语料目录抽文本 → 切分写索引。纯标准库 + 可选 pymupdf（PDF）。
# provenance 按路径关键词推断（目录名可用英文字段，也可用中文标记）：
#   ai-run / 纯AI / 跑稿     → agent_run  自动生成稿：看"全自动缺陷"，不当答案模板
#   own / draft / 笔记 / 草稿 → user_own   用户旧作：理性参考
#   advice / guide / 建议 / 方法 → advice   方法论与经验贴
#   official / rule / 评阅 / 规定 → reference  官方规则或参考资料
#   其余                     → exemplar   范文
# 智能体工具/工作输出子目录（codex/zcode/work/output/review-N…）即使挂在旧作语料下也按 agent_run 降权。
import sys, os, json, re, time, hashlib, zipfile, argparse, unicodedata

EXTS = {'.pdf', '.docx', '.md', '.txt', '.tex'}
PRUNE_DIRS = {
    'node_modules', '__pycache__', '.git', '.svn', 'dist-info', 'site-packages',
    'lo-profile', 'mpl-data', 'fonts', 'texmf', 'objects', 'refs', 'logs',
    'bundled_dependencies', 'skill-repos', '.claude', '.vscode', 'q2-python-deps',
    'python_deps', 'deps', 'vendor', 'build', 'dist', 'tmp', '.tmp',
}
MAX_FILE_BYTES = 80 * 1024 * 1024   # 单个源文件上限（扫描型大 PDF 之外不追）
MAX_DOC_CHARS = 400_000             # 单文档抽出的文本上限（防巨型工程 dump 灌爆索引）
CHUNK_SIZE, CHUNK_OVERLAP = 1000, 150
MIN_CHUNK = 60

def provenance(rel):
    # 只看路径关键词，不依赖特定机器的目录命名。
    # 英文关键词按词边界匹配，避免 download 含 own、notebook 含 note、network 含 work 之类子串误报。
    s = (rel or '').replace('\\', '/')
    low = s.lower()
    if re.search(r'ai[-_ ]?run|auto[-_ ]?run|agent[-_ ]?run|纯\s*ai|ai\s*跑稿|生成稿', low):
        return 'agent_run'
    segs = [p for p in low.split('/') if p]
    tool_seg = re.compile(r'^(codex|mrite|zcode|work|output|python-deps|lo-profile|latest-modeling|audit-rerun|review-?\d.*)$')
    if any(tool_seg.match(p) or re.search(r'智能体|agent|接入|跑的|输出图表', p) for p in segs):
        return 'agent_run'
    if re.search(r'(?<![a-z0-9])(own|draft|note|notes)(?![a-z0-9])|旧作|草稿|笔记|自写|自己写', low):
        return 'user_own'
    if re.search(r'(?<![a-z0-9])(advice|guide|tip|tips|method|methods)(?![a-z0-9])|建议|方法|经验', low):
        return 'advice'
    if re.search(r'(?<![a-z0-9])(official|rule|rules|reference|review)(?![a-z0-9])|评阅|规则|规定|资料', low):
        return 'reference'
    return 'exemplar'

def norm_text(t):
    t = unicodedata.normalize('NFKC', t or '')
    t = re.sub(r'[ \t]+', ' ', t)
    t = re.sub(r'\n{3,}', '\n\n', t)
    return t.strip()

def extract_pdf(path):
    try:
        import pymupdf
    except Exception:
        try:
            import fitz as pymupdf
        except Exception:
            return None, 'pymupdf 未安装'
    try:
        doc = pymupdf.open(path)
        parts = []
        for pg in doc:
            try:
                parts.append(pg.get_text())
            except Exception:
                parts.append('')
            if sum(len(p) for p in parts) > MAX_DOC_CHARS:
                break
        doc.close()
        return norm_text('\n'.join(parts)), None
    except Exception as e:
        return None, str(e)[:160]

def extract_docx(path):
    try:
        with zipfile.ZipFile(path) as z:
            xml = z.read('word/document.xml').decode('utf8', 'ignore')
    except Exception as e:
        return None, str(e)[:160]
    # 段落换行 + 去标签
    xml = re.sub(r'</w:p>', '\n', xml)
    text = re.sub(r'<[^>]+>', '', xml)
    return norm_text(text), None

def extract_text(path):
    for enc in ('utf8', 'gb18030', 'latin1'):
        try:
            with open(path, 'r', encoding=enc, errors='strict') as f:
                return norm_text(f.read()), None
        except Exception:
            continue
    try:
        with open(path, 'rb') as f:
            return norm_text(f.read().decode('utf8', 'ignore')), None
    except Exception as e:
        return None, str(e)[:160]

def extract(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == '.pdf': return extract_pdf(path)
    if ext == '.docx': return extract_docx(path)
    return extract_text(path)

# 边界感知切分：优先在段落/句号处断开，避免把一句话腰斩
def chunk(text):
    text = text[:MAX_DOC_CHARS]
    out, pos, n = [], 0, len(text)
    cid = 0
    while pos < n:
        end = min(pos + CHUNK_SIZE, n)
        if end < n:
            window = text[pos + CHUNK_SIZE - 200:end + 150] if end + 150 <= n else text[pos + CHUNK_SIZE - 200:]
            m = None
            for mm in re.finditer(r'[\n。！？；!?;]|(?<=[.])\s', window):
                m = mm
            if m:
                end = pos + CHUNK_SIZE - 200 + m.end()
        seg = text[pos:end].strip()
        if len(seg) >= MIN_CHUNK:
            # heading 猜测：取块内首个像标题的短行
            heading = ''
            for line in seg.split('\n')[:4]:
                s = line.strip()
                if 4 <= len(s) <= 60 and not s.endswith('。'):
                    heading = s[:60]; break
            out.append({'id': cid, 'heading': heading, 'text': seg})
            cid += 1
        pos = max(end - CHUNK_OVERLAP, pos + 1) if end - CHUNK_OVERLAP > pos else end
    return out

def doc_tokens(text):
    s = (text or '').lower()
    out = set(re.findall(r'[a-z0-9_]+', s))
    for m in re.finditer(r'[一-鿿]+', s):
        run = m.group(0)
        if len(run) == 1:
            out.add(run)
        else:
            out.add(run)
            for i in range(len(run) - 1):
                out.add(run[i:i + 2])
    return sorted(x for x in out if len(x) >= 2 or re.match(r'[一-鿿]', x))

def fp(text):
    return hashlib.md5(re.sub(r'[\s，。！？；：、""''（）【】《》]', '', (text or '').lower()).encode('utf8')).hexdigest()[:16]

def scan_files(roots):
    seen_fp = {}  # 同名副本去重：fp(text前4k) → 已收 rel
    for root in roots:
        root = os.path.abspath(root)
        if not os.path.isdir(root):
            print(f'[kb] 跳过不存在的根: {root}', flush=True)
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in PRUNE_DIRS and not d.startswith('.')]
            for fn in filenames:
                ext = os.path.splitext(fn)[1].lower()
                if ext not in EXTS:
                    continue
                full = os.path.join(dirpath, fn)
                try:
                    st = os.stat(full)
                except Exception:
                    continue
                if st.st_size > MAX_FILE_BYTES or st.st_size < 200:
                    continue
                rel = os.path.relpath(full, root).replace('\\', '/')
                yield {'root': root, 'abs': full, 'rel': rel, 'size': st.st_size, 'mtime': int(st.st_mtime)}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', action='append', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--full', action='store_true', help='无视缓存全量重建')
    a = ap.parse_args()
    out_dir = a.out
    os.makedirs(os.path.join(out_dir, 'chunks'), exist_ok=True)
    os.makedirs(os.path.join(out_dir, 'texts'), exist_ok=True)

    # 增量：读旧索引，(rel,size,mtime) 未变的文档直接复用旧分块文件
    old_docs = {}
    idx_path = os.path.join(out_dir, 'index.json')
    if not a.full and os.path.exists(idx_path):
        try:
            old = json.load(open(idx_path, 'r', encoding='utf8'))
            for d in old.get('docs', []):
                old_docs[(d['rel'], d.get('size'), d.get('mtime'))] = d
        except Exception:
            pass

    docs, errors, new_docs = [], [], 0
    files = list(scan_files(a.root))
    print(f'[kb] 扫描到 {len(files)} 个候选文件（{len(a.root)} 个根）', flush=True)
    seen_doc_fp = {}
    for i, f in enumerate(files):
        key = (f['rel'], f['size'], f['mtime'])
        if key in old_docs:
            docs.append(old_docs[key])
            continue
        text, err = extract(f['abs'])
        # 中文密度高：80 字符≈240 字节，足够挡住空文件/纯封面，不挡真笔记
        if err or not text or len(text) < 80:
            errors.append({'rel': f['rel'], 'error': err or '文本过短/无文本层（扫描件）'})
            continue
        # 同内容去重（多份副本只索引一份，保留最短的 rel）
        h = fp(text[:6000])
        if h in seen_doc_fp:
            continue
        seen_doc_fp[h] = f['rel']
        prov = provenance(f['rel'])
        doc_id = 'd' + hashlib.md5((f['rel'] + str(f['size'])).encode('utf8')).hexdigest()[:10]
        chunks = chunk(text)
        chunk_file = os.path.join(out_dir, 'chunks', doc_id + '.jsonl')
        with open(chunk_file, 'w', encoding='utf8') as w:
            for c in chunks:
                c['toks'] = doc_tokens(c['heading'] + ' ' + c['text'][:400]) if len(c['text']) > 400 else doc_tokens(c['heading'] + ' ' + c['text'])
                w.write(json.dumps(c, ensure_ascii=False) + '\n')
        # 全文留档（kb_read 可按需回读更多）
        try:
            with open(os.path.join(out_dir, 'texts', doc_id + '.txt'), 'w', encoding='utf8') as w:
                w.write(text)
        except Exception:
            pass
        title = ''
        for line in text.split('\n')[:8]:
            s = line.strip()
            if 6 <= len(s) <= 80:
                title = s; break
        docs.append({'id': doc_id, 'rel': f['rel'], 'root': f['root'], 'size': f['size'], 'mtime': f['mtime'],
                     'provenance': prov, 'title': title[:80], 'chunks': len(chunks)})
        new_docs += 1
        if new_docs % 20 == 0:
            print(f'[kb] 已处理 {i + 1}/{len(files)}（新索引 {new_docs}）', flush=True)

    index = {'version': 1, 'builtAt': time.strftime('%Y-%m-%d %H:%M:%S'), 'roots': [os.path.abspath(r) for r in a.root],
             'docs': docs, 'errors': errors[:500]}
    tmp = idx_path + '.tmp'
    with open(tmp, 'w', encoding='utf8') as w:
        json.dump(index, w, ensure_ascii=False, indent=1)
    os.replace(tmp, idx_path)
    prov_count = {}
    for d in docs:
        prov_count[d['provenance']] = prov_count.get(d['provenance'], 0) + 1
    print(json.dumps({'ok': True, 'docs': len(docs), 'new': new_docs, 'chunks': sum(d['chunks'] for d in docs),
                      'errors': len(errors), 'byProv': prov_count, 'out': idx_path}, ensure_ascii=False), flush=True)

if __name__ == '__main__':
    main()
