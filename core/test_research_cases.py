"""Verify development rubrics against raw materials; this does not run an agent."""
import itertools
import json
from fractions import Fraction as F
from pathlib import Path

ROOT = Path(__file__).parent / 'fixtures' / 'research_judgment'
CASES = json.loads((ROOT / 'cases.json').read_text(encoding='utf-8'))
RUBRICS = {r['case_id']: r for r in json.loads((ROOT / 'rubrics.json').read_text(encoding='utf-8'))}


def rank(rows):
    rows = [list(map(F, row)) for row in rows]
    pivot = 0
    for col in range(len(rows[0])):
        found = next((i for i in range(pivot, len(rows)) if rows[i][col]), None)
        if found is None:
            continue
        rows[pivot], rows[found] = rows[found], rows[pivot]
        scale = rows[pivot][col]
        rows[pivot] = [v / scale for v in rows[pivot]]
        for i in range(len(rows)):
            if i != pivot:
                scale = rows[i][col]
                rows[i] = [a - scale * b for a, b in zip(rows[i], rows[pivot])]
        pivot += 1
        if pivot == len(rows):
            break
    return pivot


def check_quantities(case_id, actual):
    for key, spec in RUBRICS[case_id]['quantities'].items():
        assert key in actual, (case_id, key)
        assert abs(float(actual[key]) - spec['value']) <= spec.get('tolerance', 1e-9), (case_id, key, actual[key])


for case in CASES:
    case_id, m = case['id'], case['materials']
    if 'stations' in m:
        if m['objective'] == 'min_max_region_time':
            result = {name: max(row.values()) for name, row in m['stations'].items()}
            assert min(result, key=result.get) == RUBRICS[case_id]['expect']['decision']
        elif m['east_share'] is not None:
            w = F(str(m['east_share']))
            result = {name: w * row['east'] + (1 - w) * row['west'] for name, row in m['stations'].items()}
            assert min(result, key=result.get) == RUBRICS[case_id]['expect']['decision']
        else:
            a, b = m['stations']['A'], m['stations']['B']
            intercept = a['west'] - b['west']
            slope = a['east'] - a['west'] - b['east'] + b['west']
            threshold = -F(intercept, slope)
            assert intercept + slope * threshold == 0
            assert intercept > 0 and intercept + slope < 0
            result = {'threshold': threshold}
    elif case['family'] == 'prediction':
        baseline = m['history'][m['origin'] - 1]
        result = {'baseline_prediction': baseline, 'baseline_error': abs(baseline - m['target']['value'])}
        valid = m['feature']['available_at'] <= m['origin'] and m['preprocessing']['fitted_until'] <= m['origin']
        assert valid == (RUBRICS[case_id]['expect']['claim_scope'] == 'given_holdout_only')
        if valid:
            result.update(candidate_prediction=m['feature']['value'], candidate_error=abs(m['feature']['value'] - m['target']['value']))
    elif 'capacities' in m:
        feasible = [(sum(c * x for c, x in zip(m['costs'], xs)), xs)
                    for xs in itertools.product(*(range(cap + 1) for cap in m['capacities'])) if sum(xs) >= m['demand']]
        if feasible:
            cost, xs = min(feasible)
            result = {'x1': xs[0], 'x2': xs[1], 'cost': cost}
            assert sum(xs) >= m['demand'] and all(x <= cap for x, cap in zip(xs, m['capacities']))
        else:
            assert sum(m['capacities']) < m['demand']
            result = {'capacity_total': sum(m['capacities']), 'shortfall': m['demand'] - sum(m['capacities'])}
    elif 'samples' in m:
        sample = min(m['samples'], key=lambda row: row['value'])
        result = {'best_x': sample['x'], 'best_value': sample['value']}
        assert RUBRICS[case_id]['expect']['claim_scope'] == 'sampled_candidates_only'
        assert max(row['x'] for row in m['samples']) < m['domain'][1]
    elif case['family'] == 'mechanism-inverse':
        ratios = {F(row['y'], row['t']) for row in m['observations']}
        assert len(ratios) == 1
        product = ratios.pop()
        if 'additional_measurement' in m:
            a = F(m['additional_measurement']['value'])
            b = product / a
            matrix = [[b * row['t'], a * row['t']] for row in m['observations']] + [[1, 0]]
            result = {'a': a, 'b': b, 'product': product, 'jacobian_rank': rank(matrix)}
        else:
            witnesses = [(F(a), product / a) for a in range(1, 7) if 1 <= product / a <= 6]
            assert len(witnesses) >= 2 and len(set(witnesses)) == len(witnesses)
            for a, b in witnesses:
                assert all(a * b * row['t'] == row['y'] for row in m['observations'])
            a, b = witnesses[0]
            result = {'product': product, 'jacobian_rank': rank([[b * row['t'], a * row['t']] for row in m['observations']])}
    elif case['family'] == 'evaluation':
        a, b = m['scores']['A'], m['scores']['B']
        intercept = a['service'] - b['service']
        slope = a['quality'] - a['service'] - b['quality'] + b['service']
        threshold = -F(intercept, slope)
        result = {'threshold': threshold}
        if m['quality_weight'] is not None:
            w = F(str(m['quality_weight']))
            result.update({name: w * row['quality'] + (1 - w) * row['service'] for name, row in m['scores'].items()})
            result['quality_weight'] = w
        else:
            assert intercept < 0 and intercept + slope > 0
    else:
        raise AssertionError(case_id)
    check_quantities(case_id, result)

print(f'PASS {len(CASES)} research fixture oracles: exact arithmetic, enumeration, rank and information boundary; no agent run')
