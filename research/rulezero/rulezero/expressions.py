"""Bounded data expressions used by GameSpec v2; no eval or generated code."""
from __future__ import annotations
import math

OPS = {'var', 'cell', 'actor', 'sumRank', 'add', 'sub', 'mul', 'eq', 'lt', 'gt', 'and', 'or', 'not'}


def validate_expression(expr, depth=0):
    if depth > 12:
        raise ValueError('expression nesting exceeds 12')
    if isinstance(expr, (int, float, bool)):
        if not math.isfinite(expr):
            raise ValueError('nonfinite expression')
        return
    if not isinstance(expr, dict) or len(expr) != 1 or next(iter(expr)) not in OPS | {'param'}:
        raise ValueError('unsupported expression')
    op, value = next(iter(expr.items()))
    if op in ('var', 'sumRank', 'param'):
        if not isinstance(value, str):
            raise ValueError('reference must be a string')
    elif op == 'cell':
        if not isinstance(value, dict) or set(value) != {'zone', 'index'} or not isinstance(value['zone'], str):
            raise ValueError('cell requires zone and index')
        validate_expression(value['index'], depth + 1)
    elif op == 'actor':
        if value is not True:
            raise ValueError('actor expression must be true')
    elif op == 'not':
        validate_expression(value, depth + 1)
    else:
        if not isinstance(value, list) or not 1 <= len(value) <= 32:
            raise ValueError('operator requires 1..32 arguments')
        if op in ('sub', 'eq', 'lt', 'gt') and len(value) != 2:
            raise ValueError('binary operator requires two arguments')
        for item in value:
            validate_expression(item, depth + 1)


def evaluate(expr, state):
    if isinstance(expr, (int, float, bool)):
        return expr
    op, value = next(iter(expr.items()))
    from .gamespec_runtime import _resolve
    if op == 'actor':
        return state.actor
    if op == 'var':
        return state.vars[value]
    if op == 'sumRank':
        return sum(state.zones[_resolve(value, state.actor, state.n)])
    if op == 'cell':
        index = evaluate(value['index'], state)
        zone = state.zones[_resolve(value['zone'], state.actor, state.n)]
        if type(index) is not int or not 0 <= index < len(zone):
            raise ValueError('cell index out of range')
        return zone[index]
    if op == 'not':
        return not evaluate(value, state)
    args = [evaluate(x, state) for x in value]
    if op == 'add': return sum(args)
    if op == 'sub': return args[0] - args[1]
    if op == 'mul': return math.prod(args)
    if op == 'eq': return args[0] == args[1]
    if op == 'lt': return args[0] < args[1]
    if op == 'gt': return args[0] > args[1]
    if op == 'and': return all(args)
    if op == 'or': return any(args)
    raise ValueError('unsupported expression')
