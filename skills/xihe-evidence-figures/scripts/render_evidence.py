"""Draw declared fields from a real result JSON; never synthesize measurements."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager


def inside(root, relative):
    p = Path(relative)
    if p.is_absolute() or p.drive or '..' in p.parts or not str(relative).strip():
        raise ValueError('Use a workspace-relative path without parent traversal')
    full = (root / p).resolve()
    if full == root or root not in full.parents:
        raise ValueError('Path escapes workspace')
    return full


def read_json(file):
    if file.stat().st_size > 2_000_000:
        raise ValueError('JSON exceeds 2MB')
    raw = file.read_bytes()
    if len(raw) > 2_000_000:
        raise ValueError('JSON exceeds 2MB')
    return json.loads(raw.decode('utf-8')), hashlib.sha256(raw).hexdigest()


def at(data, field):
    if not isinstance(field, str) or any(p in ('', '__proto__', 'constructor', 'prototype') for p in field.split('.')):
        raise ValueError('Invalid result field')
    for part in field.split('.'):
        if not isinstance(data, dict) or part not in data:
            raise ValueError('Missing result field: ' + field)
        data = data[part]
    return data


def numbers(value):
    if not isinstance(value, list) or not 1 <= len(value) <= 2000:
        raise ValueError('Expected 1-2000 actual numeric values')
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in value):
        raise ValueError('Missing, nonnumeric or nonfinite data; do not impute for plotting')
    return value


def digest(file):
    return hashlib.sha256(file.read_bytes()).hexdigest()


def render(root, recipe_name, output):
    root = Path(root).resolve()
    recipe_path = inside(root, recipe_name)
    recipe, recipe_hash = read_json(recipe_path)
    if recipe.get('schema_version') != 1 or recipe.get('locale', 'en') not in ('zh', 'en'):
        raise ValueError('Unsupported recipe schema/locale')
    source = inside(root, recipe['source'])
    data, source_hash = read_json(source)
    panels = recipe.get('panels')
    if not isinstance(panels, list) or not 1 <= len(panels) <= 4:
        raise ValueError('Choose 1-4 panels with a stated purpose')
    width = recipe.get('width_mm', 168)
    if isinstance(width, bool) or not isinstance(width, (int, float)) or not 80 <= width <= 210:
        raise ValueError('Set final width_mm in 80-210')
    names = {font.name for font in font_manager.fontManager.ttflist}
    font = 'DejaVu Sans'
    if recipe.get('locale') == 'zh':
        font = next((name for name in ('Noto Sans CJK SC', 'Microsoft YaHei', 'SimSun', 'SimHei') if name in names), None)
        if font is None:
            raise ValueError('No supported Chinese font installed')
    plt.rcParams.update({'font.family': font, 'font.size': 9, 'axes.titlesize': 10, 'axes.labelsize': 9,
                         'pdf.fonttype': 42, 'axes.unicode_minus': False})
    columns = min(2, len(panels)); rows = math.ceil(len(panels) / columns)
    fig, axes_grid = plt.subplots(rows, columns, figsize=(width / 25.4, rows * 2.5), squeeze=False)
    axes = list(axes_grid.flat)
    palette = ['#246B8E', '#C66C24', '#38856B', '#815A9D', '#656565']
    records, groups, ids = [], {}, set()
    for ax, p in zip(axes, panels):
        kind, pid = p.get('kind'), p.get('id')
        if kind not in ('bar', 'paired', 'line') or not isinstance(pid, str) or not pid or pid in ids:
            raise ValueError('Panel needs unique id and supported kind')
        ids.add(pid)
        if not isinstance(p.get('unit'), str) or not p['unit'].strip() or not p.get('title'):
            raise ValueError('Panel title and explicit unit are required')
        series = p.get('series')
        if not isinstance(series, list) or not 1 <= len(series) <= 5 or (kind == 'paired' and len(series) != 2):
            raise ValueError('Invalid number of series')
        resolved = []
        for s in series:
            if not s.get('label') or ('field' in s) == ('fields' in s):
                raise ValueError('Series needs label and exactly one field/fields mapping')
            fields = s.get('fields')
            if fields is not None:
                if not isinstance(fields, list) or not fields:
                    raise ValueError('fields must list actual scalar result fields')
                values = numbers([at(data, f) for f in fields])
            else:
                fields = [s['field']]; values = numbers(at(data, s['field']))
            resolved.append({'label': str(s['label']), 'fields': fields, 'values': values})
        count = len(resolved[0]['values'])
        if any(len(s['values']) != count for s in resolved):
            raise ValueError('Series lengths differ')
        if kind == 'line':
            x = numbers(at(data, p.get('x_field')))
            if len(x) != count or any(x[i] >= x[i + 1] for i in range(len(x) - 1)):
                raise ValueError('Parameter values must be actual strictly increasing result data')
            for i, s in enumerate(resolved):
                ax.plot(x, s['values'], marker='o', markersize=3, color=palette[i], label=s['label'])
            ax.set_xlabel(p.get('xlabel', p['x_field']))
        else:
            labels = p.get('categories')
            if not isinstance(labels, list) or len(labels) != count or count > 40 or any(not isinstance(s, str) or not s for s in labels):
                raise ValueError('Supply matching category labels (at most 40)')
            x = list(range(count))
            if kind == 'bar':
                bar_width = .75 / len(resolved)
                for i, s in enumerate(resolved):
                    ax.bar([v + (i - (len(resolved) - 1) / 2) * bar_width for v in x], s['values'], width=bar_width, color=palette[i], label=s['label'])
                ax.set_xticks(x, labels)
            else:
                for j in x:
                    ax.plot([resolved[0]['values'][j], resolved[1]['values'][j]], [j, j], color='#AAAAAA', zorder=1)
                for i, s in enumerate(resolved):
                    ax.scatter(s['values'], x, color=palette[i], label=s['label'], zorder=2)
                ax.set_yticks(x, labels); ax.invert_yaxis()
        axis_label = p.get('ylabel', 'Value') + ' (' + p['unit'] + ')'
        (ax.set_xlabel if kind == 'paired' else ax.set_ylabel)(axis_label)
        ax.set_title(p['title'], loc='left'); ax.spines[['top', 'right']].set_visible(False)
        ax.legend(frameon=False, fontsize=8)
        values = [v for s in resolved for v in s['values']]
        limits = [min(0, min(values)), max(0, max(values))]
        span = limits[1] - limits[0] or 1
        limits[1] += .12 * span
        if limits[0] < 0:
            limits[0] -= .05 * span
        group = p.get('scale_group', pid)
        existing = groups.setdefault(group, {'unit': p['unit'], 'axes': [], 'limits': limits, 'paired': kind == 'paired'})
        if existing['unit'] != p['unit'] or existing['paired'] != (kind == 'paired'):
            raise ValueError('Shared scale requires matching units and axis orientation')
        existing['axes'].append(ax)
        existing['limits'] = [min(existing['limits'][0], limits[0]), max(existing['limits'][1], limits[1])]
        records.append({'id': pid, 'kind': kind, 'title': p['title'], 'unit': p['unit'], 'transform': 'identity',
                        'series': resolved, 'x_field': p.get('x_field'), 'categories': p.get('categories'), 'scale_group': group})
    for group in groups.values():
        for ax in group['axes']:
            (ax.set_xlim if group['paired'] else ax.set_ylim)(group['limits'])
    for record in records:
        record['axis_limits'] = groups[record['scale_group']]['limits']
    for ax in axes[len(panels):]:
        ax.set_visible(False)
    fig.tight_layout()
    targets = {ext: inside(root, output + ext) for ext in ('.pdf', '.png', '.figure.json')}
    if any(p in (source, recipe_path) for p in targets.values()):
        raise ValueError('Output would overwrite source/recipe')
    for file in targets.values():
        file.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(targets['.pdf']); fig.savefig(targets['.png'], dpi=220); plt.close(fig)
    if digest(source) != source_hash or digest(recipe_path) != recipe_hash:
        raise ValueError('Source/recipe changed while drawing; rerun with stable inputs')
    record = {'schema_version': 1, 'source': {'path': recipe['source'], 'sha256': source_hash},
              'recipe': {'path': recipe_name, 'sha256': recipe_hash}, 'font': font, 'width_mm': width, 'panels': records,
              'figures': [{'path': p.relative_to(root).as_posix(), 'sha256': digest(p)} for ext, p in targets.items() if ext != '.figure.json'],
              'limits': 'File/field provenance only. Lines connect computed points; no new samples, uncertainty or scientific improvement is established.'}
    targets['.figure.json'].write_text(json.dumps(record, ensure_ascii=False, indent=2), encoding='utf-8')
    return record


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', default='.')
    parser.add_argument('--recipe', required=True)
    parser.add_argument('--output', required=True)
    arguments = parser.parse_args()
    result = render(arguments.root, arguments.recipe, arguments.output)
    print(json.dumps({'figures': result['figures'], 'source': result['source']}, ensure_ascii=False))
