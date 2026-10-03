"""Validação de fronteira: ausência, zero, booleano e dinheiro são distintos."""
import datetime as dt
import hashlib
import json
import math
import re
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

UTC = dt.timezone.utc
LOCAL = dt.timezone(dt.timedelta(hours=-3))  # datas legadas do painel brasileiro


class Invalido(ValueError):
    pass


class Conflito(Invalido):
    pass


def objeto(value):
    if not isinstance(value, dict):
        raise Invalido('objeto JSON obrigatório')
    return value


def texto(value, campo, vazio=False, limite=256):
    if not isinstance(value, str) or len(value) > limite or any(ord(ch) < 32 for ch in value):
        raise Invalido(campo + ' inválido')
    value = value.strip()
    if not value and not vazio:
        raise Invalido(campo + ' obrigatório')
    return value


def identidade(value, campo, vazio=False):
    # Números grandes já convertidos por JS não recuperam precisão.
    if type(value) is int and abs(value) <= 9007199254740991:
        value = str(value)
    return texto(value, campo, vazio=vazio)


def numero(value, campo, nulo=False, minimo=0, inteiro=False):
    if value is None and nulo:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        raise Invalido(campo + ' inválido')
    if isinstance(value, str) and not re.fullmatch(r'-?\d+(?:\.\d+)?', value.strip()):
        raise Invalido(campo + ' inválido')
    try:
        n = Decimal(str(value))
    except InvalidOperation:
        raise Invalido(campo + ' inválido') from None
    if not n.is_finite() or abs(n) > Decimal('1000000000000') or (minimo is not None and n < minimo):
        raise Invalido(campo + ' fora do intervalo')
    if inteiro:
        if n != n.to_integral_value():
            raise Invalido(campo + ' deve ser inteiro')
        return int(n)
    return float(n)


def dinheiro(value, campo, nulo=False, minimo=0):
    value = numero(value, campo, nulo=nulo, minimo=minimo)
    if value is None:
        return None
    n = Decimal(str(value))
    if n != n.quantize(Decimal('.01')):
        raise Invalido(campo + ' deve ter no máximo dois decimais')
    return float(n)


def centavos(value):
    return int((Decimal(str(value)) * 100).quantize(Decimal('1'), rounding=ROUND_HALF_UP))


def booleano(value, campo, nulo=False):
    if value is None and nulo:
        return None
    if value is True or value == '1' or type(value) is int and value == 1:
        return True
    if value is False or value == '0' or type(value) is int and value == 0:
        return False
    raise Invalido(campo + ' deve ser booleano')


def agora():
    return dt.datetime.now(UTC).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def instante(value, campo='data', nulo=False):
    if value is None or value == '':
        if nulo:
            return None
        raise Invalido(campo + ' obrigatório')
    try:
        if type(value) in (int, float):
            if not math.isfinite(value):
                raise ValueError()
            stamp = value / 1000 if abs(value) > 100000000000 else value
            parsed = dt.datetime.fromtimestamp(stamp, UTC)
        else:
            value = texto(value, campo, limite=64)
            parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=LOCAL)
        return parsed.astimezone(UTC).isoformat(timespec='microseconds').replace('+00:00', 'Z')
    except (ValueError, TypeError, OverflowError, OSError):
        raise Invalido(campo + ' inválido') from None


def serializar(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def hash_json(value):
    # O envelope atravessa JSON.parse/stringify no navegador. 100 e 100.0,
    # -0 e 0, notação decimal/científica representam o mesmo Number binário.
    # Tokens tipados evitam colisão entre um número e texto/lista de mesmo conteúdo.
    def canonical(item):
        if item is None:
            return ['null']
        if isinstance(item, bool):
            return ['boolean', item]
        if isinstance(item, (int, float)):
            number = float(item)
            if not math.isfinite(number):
                raise Invalido('número não finito no documento')
            return ['number', (0.0 if number == 0 else number).hex()]
        if isinstance(item, str):
            return ['string', item]
        if isinstance(item, list):
            return ['array', [canonical(v) for v in item]]
        if isinstance(item, dict):
            return ['object', [[k, canonical(v)] for k, v in sorted(item.items())]]
        raise Invalido('tipo não JSON no documento')
    return hashlib.sha256(serializar(canonical(value)).encode('utf-8')).hexdigest()


def contexto(value):
    if value is None:
        return {}
    objeto(value)
    out = {}
    for key in ('instalacao_id', 'tab_id', 'frame_id', 'geracao'):
        if key in value and value[key] is not None:
            out[key] = identidade(value[key], key)
    return out
