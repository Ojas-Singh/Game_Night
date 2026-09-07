"""Validation/lowering for additive v2 syntax; execution remains IRState."""
from __future__ import annotations
from copy import deepcopy
import math
from .expressions import validate_expression


def lower_for_validation(doc):
    result = deepcopy(doc)
    result['schemaVersion'] = 1
    utility = doc.get('utilities', {})
    if utility.get('type') not in ('zero_sum', 'general_sum', 'cooperative'):
        raise ValueError('v2 requires explicit utility type')
    if not all(type(utility.get(k)) in (int, float) and math.isfinite(utility[k]) for k in ('min', 'max')) or utility['min'] > utility['max']:
        raise ValueError('invalid utility bounds')
    if 'values' in utility:
        if len(utility['values']) != doc['players']['count']:
            raise ValueError('utility values must match player count')
        for expr in utility['values']:
            validate_expression(expr)
    zones = {z['id'] for z in doc['zones']}
    variables = {v['id'] for v in doc['vars']}
    def expression(expr, parameters=None):
        validate_expression(expr)
        if isinstance(expr, dict):
            if 'var' in expr and expr['var'] not in variables:
                raise ValueError('undefined expression variable')
            if 'cell' in expr and expr['cell']['zone'] not in zones:
                raise ValueError('undefined cell zone')
            if 'param' in expr and expr['param'] not in (parameters or {}):
                raise ValueError('undefined action parameter')
            for key, value in expr.items():
                if key == 'cell': expression(value['index'], parameters)
                elif isinstance(value, list):
                    for x in value: expression(x, parameters)
                elif isinstance(value, dict): expression(value, parameters)
    for zone in doc['zones']:
        if 'initial' in zone:
            if not isinstance(zone['initial'], list) or len(zone['initial']) > 256 or not all(type(x) is int for x in zone['initial']):
                raise ValueError('indexed zone initial values must be up to 256 integers')
    for variable in doc['vars']:
        if variable.get('type', 'number') not in ('number', 'integer', 'boolean'):
            raise ValueError('unsupported variable type')
        if variable.get('visibility', 'public') not in ('public', 'owner', 'hidden'):
            raise ValueError('invalid variable visibility')
        if variable.get('visibility') == 'owner' and variable.get('owner') not in range(doc['players']['count']):
            raise ValueError('owner variable requires a seat')
    first_var = doc['vars'][0]['id']
    def effects(items, parameters):
        for effect in items:
            if effect['op'] == 'setCell':
                if effect['zone'] not in zones:
                    raise ValueError('unknown indexed zone')
                expression(effect['index'], parameters); expression(effect['value'], parameters)
                effect.clear(); effect.update(op='set', var=first_var, value=0)
            elif effect['op'] == 'revealVar':
                if effect.get('var') not in variables:
                    raise ValueError('undefined variable to reveal')
                effect.clear(); effect.update(op='set', var=first_var, value=0)
            elif effect['op'] == 'set':
                expression(effect['value'], parameters); effect['value'] = 0
            elif effect['op'] == 'compareGoto':
                expression(effect['a'], parameters); expression(effect['b'], parameters)
                effect['a'] = effect['b'] = 0
    for ph in result['phases']:
        if ph['kind'] == 'chance' and 'outcomes' in ph['chance']:
            outcomes = ph['chance']['outcomes']
            if not 1 <= len(outcomes) <= 256 or len({o['id'] for o in outcomes}) != len(outcomes):
                raise ValueError('invalid chance outcome ids')
            for o in outcomes:
                if type(o['id']) is not int or not 0 <= o['id'] <= 1000 or type(o['weight']) not in (int, float) or not math.isfinite(o['weight']) or o['weight'] <= 0:
                    raise ValueError('invalid finite chance outcome')
                effects(o.get('effects', []), {})
            ph['kind'] = 'decision'
            ph['decision'] = {'actor': 0, 'actions': [{'id': f'outcome{o["id"]}', 'effects': o.get('effects', []), **({'goto': ph['goto']} if 'goto' in ph else {})} for o in outcomes]}
        for action in ph.get('decision', ph.get('reaction', {})).get('actions', []):
            parameters = action.get('parameters', {})
            if not isinstance(parameters, dict) or len(parameters) > 3 or any(not isinstance(v, list) or not v or len(v) > 32 or any(type(x) is not int for x in v) for v in parameters.values()):
                raise ValueError('invalid finite action parameters')
            if math.prod(len(v) for v in parameters.values()) > 128:
                raise ValueError('parameter expansion exceeds 128 actions')
            if action.get('visibility', 'public') not in ('public', 'owner'):
                raise ValueError('invalid action visibility')
            if 'expr' in action.get('requires', {}):
                expression(action['requires']['expr'], parameters)
                action['requires'] = {'var': first_var, 'eq': 0}
            effects(action.get('effects', []), parameters)
    return result
