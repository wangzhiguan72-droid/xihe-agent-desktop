"""Read-only file discovery. This does not discover or invoke host/MCP tools."""
import argparse
import json
from pathlib import Path
import re
import sys

DEFAULT_DICTIONARY = None

def probe(roots, registry, knowledge_root, dictionary):
    warnings, skills = [], []
    for item in registry['skills']:
        matches, seen = [], set()
        for root in roots:
            for candidate in item['candidates']:
                rel = Path(candidate)
                if rel.is_absolute() or '..' in rel.parts:
                    raise ValueError('Registry candidates must be relative paths inside skill roots')
                path = root/rel/'SKILL.md'
                if not path.is_file():
                    continue
                try:
                    resolved = str(path.resolve())
                    if resolved in seen:
                        continue
                    seen.add(resolved)
                    content = path.read_text(encoding='utf-8-sig')
                    front = re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)', content, re.S)
                    name = re.search(r'^name:\s*(.+?)\s*$', front[1], re.M) if front else None
                    declared = name[1].strip('\'"') if name else None
                    if declared not in item.get('names', [item['id']]):
                        warnings.append({'path': str(path), 'reason': 'invalid or unexpected skill name'})
                        continue
                    matches.append({'path': str(path), 'resolved_path': resolved, 'declared_name': declared})
                except (OSError, UnicodeError) as error:
                    warnings.append({'path': str(path), 'reason': type(error).__name__})
        skills.append({'id': item['id'], 'state': 'READABLE' if matches else 'MISSING',
                       'matches': matches, 'session_callable': 'NOT_CHECKED'})
    libraries = []
    for item in registry.get('libraries', []):
        rel = Path(item['candidate'])
        if rel.is_absolute() or '..' in rel.parts:
            raise ValueError('Library candidates must be relative to skill roots')
        for root in roots:
            path = root/rel
            files = {name: (path/name).is_file() for name in item['files']}
            if any(files.values()):
                libraries.append({'id': item['id'], 'path': str(path),
                                  'state': 'PRESENT_NOT_REVIEWED' if all(files.values()) else 'PARTIAL',
                                  'files': files})
    cards = {name: bool(knowledge_root) and (knowledge_root/name).is_file() for name in
             ['START.md', 'regression.md', 'time-series.md', 'optimization.md',
              'evaluation.md', 'workflow.md', 'sources.md']}
    has_dictionary = bool(dictionary) and dictionary.is_file()
    return {'schema_version': 1, 'scope': 'Local file discovery only; no tool calls, installs, or configuration changes.',
            'roots': [str(root) for root in roots], 'skills': skills, 'algorithm_libraries': libraries,
            'knowledge': {'path': str(knowledge_root) if knowledge_root else None,
                          'state': 'READABLE' if all(cards.values()) else
                          'PARTIAL' if any(cards.values()) else 'MISSING', 'files': cards},
            'dictionary': {'path': str(dictionary) if dictionary else None,
                           'state': 'PRESENT_NOT_QUERIED' if has_dictionary else 'MISSING'},
            'mcp': {'state': 'HOST_DISCOVERY_REQUIRED', 'tools': [],
                    'note': 'Discover actual server, tool names and schemas from the current host; files do not establish availability.'},
            'warnings': warnings}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, action='append', help='Repeat for allowed skill roots; replaces defaults')
    parser.add_argument('--registry', type=Path, default=Path(__file__).resolve().parents[1]/'references/capability_registry.json')
    parser.add_argument('--knowledge-root', type=Path, default=None, help='Optional path to a local method knowledge root')
    parser.add_argument('--dictionary', type=Path, default=DEFAULT_DICTIONARY, help='Optional local model dictionary .xlsx')
    args = parser.parse_args()
    roots = args.root if args.root is not None else [Path.cwd()]
    try:
        registry = json.loads(args.registry.read_text(encoding='utf-8-sig'))
        result = probe(roots, registry, args.knowledge_root, args.dictionary)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(2, f'Capability discovery failed: {type(error).__name__}\n')
    print(json.dumps(result, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    main()
