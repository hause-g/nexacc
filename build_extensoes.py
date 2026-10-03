"""Pacotes reproduzÃ­veis; nÃ£o inclui banco, capturas, credenciais ou arquivos temporÃ¡rios."""
from pathlib import Path
import hashlib
import json
import re
import shutil
import subprocess
import zipfile
import os

BASE = Path(__file__).resolve().parent

def _conferir_fontes(paths, source, folder):
    """Byte de controle cru vira arquivo binario para o git (o diff some da revisao) e node --check
    pega erro de sintaxe antes de o pacote chegar ao Chrome, onde a falha e silenciosa."""
    node = shutil.which('node')
    for p in paths:
        if p.suffix != '.js':
            continue
        conteudo = p.read_bytes()
        for i, b in enumerate(conteudo):
            if b < 0x20 and b not in (9, 10, 13):
                raise ValueError('%s/%s: byte de controle 0x%02x no offset %d: use o escape'
                                 % (folder, p.relative_to(source).as_posix(), b, i))
        if node:
            check = subprocess.run([node, '--check', str(p)], capture_output=True, text=True)
            if check.returncode:
                raise ValueError('%s/%s nao passa em node --check: %s'
                                 % (folder, p.relative_to(source).as_posix(), (check.stderr or '').strip()[:200]))


def _conferir_versao(anterior, folder, versao, hashes):
    """Conteudo diferente com a MESMA versao inutiliza o diagnostico por versao do painel: dois
    perfis rodando '1.28' com codigos distintos, e o operador sem como saber qual e qual."""
    velho = (anterior or {}).get(folder)
    if not velho or velho.get('versao') != versao:
        return
    mudou = sorted(k for k in set(velho.get('arquivos', {})) | set(hashes)
                   if velho.get('arquivos', {}).get(k) != hashes.get(k))
    if mudou:
        raise ValueError('%s: conteudo mudou e a versao continua %s: suba a versao no manifest. '
                         'Arquivos: %s' % (folder, versao, ', '.join(mudou[:6])))

_NOME_COM_VERSAO = re.compile(r"\s+v?\d+(?:\.\d+)+\s*$")


def _versionar_nome(source, manifest):
    """O Chrome so mostra o NOME na lista de extensoes. Sem a versao ali o operador instala a
    errada em um dos perfis e o teste seguinte nao prova nada. O nome e derivado da versao a
    cada build, entao os dois nao tem como divergir."""
    versao = manifest["version"]
    alvo = _NOME_COM_VERSAO.sub("", manifest["name"]).strip() + " " + versao
    if manifest["name"] == alvo:
        return alvo
    arquivo = source / "manifest.json"
    # bytes, nao read_text/write_text: no Windows a escrita traduz as quebras de linha e o
    # manifest inteiro viraria CRLF — conteudo diferente sem ninguem ter mudado nada.
    crus = arquivo.read_bytes()
    marca = crus[:3] == b"\xef\xbb\xbf"
    bruto = crus.decode("utf-8-sig")
    novo, trocas = re.subn(r'("name"\s*:\s*)"(?:[^"\\]|\\.)*"',
                           lambda m: m.group(1) + json.dumps(alvo, ensure_ascii=False),
                           bruto, count=1)
    if trocas != 1:
        raise ValueError("%s: nao achei o campo name para versionar" % source.name)
    arquivo.write_bytes((b"\xef\xbb\xbf" if marca else b"") + novo.encode("utf-8"))
    manifest["name"] = alvo
    return alvo


def build(base=BASE):
    result = {}
    anterior = None
    manifesto = base / 'build' / 'manifesto-extensoes.json'
    if manifesto.exists():
        try:
            anterior = json.loads(manifesto.read_text(encoding='utf-8'))
        except ValueError:
            anterior = None
    crypto = (base / "shared" / "cryptolib.js").read_bytes()
    for folder in ("extensao", "extensao_agente"):
        (base / folder / "cryptolib.js").write_bytes(crypto)
        for artifact in ('origem_main.js','origem_bridge.js'):
            (base/folder/artifact).write_bytes((base/'shared/origem.js').read_bytes())
    # Chrome deduplica o mesmo caminho de content script entre MAIN e ISOLATED.
    # Fontes únicas, artefatos distintos para cada mundo: não manter cópias à mão.
    for folder, source, target in (("extensao", "normalizar.js", "normalizar_bridge.js"),
                                   ("extensao_agente", "core_agente.js", "core_bridge.js")):
        (base / folder / target).write_bytes((base / folder / source).read_bytes())
    for folder in ('extensao', 'extensao_agente'):
        source = base / folder
        manifest = json.loads((source / 'manifest.json').read_text(encoding='utf-8-sig'))
        _versionar_nome(source, manifest)
        paths = sorted(p for p in source.rglob('*') if p.is_file() and
                       not any(x.startswith(('.', '_')) for x in p.relative_to(source).parts) and
                       (p.suffix in ('.js', '.png', '.svg') or p.name == 'manifest.json'))
        required = {manifest['background']['service_worker']}
        worlds = {}
        for script in manifest.get('content_scripts', []):
            required.update(script.get('js', [])); required.update(script.get('css', []))
            for name in script.get('js', []):
                world = script.get('world', 'ISOLATED')
                if name in worlds and worlds[name] != world:
                    raise ValueError('Mesmo content script em mundos distintos: ' + name)
                worlds[name] = world
        required.update(manifest.get('icons', {}).values())
        available = {p.relative_to(source).as_posix() for p in paths}
        if required - available:
            raise ValueError('Recursos ausentes: ' + str(required - available))
        _conferir_fontes(paths, source, folder)
        target = base / ('%s-%s.zip' % (folder, manifest['version']))
        temp = target.with_suffix('.zip.tmp')
        hashes = {}
        with zipfile.ZipFile(temp, 'w', zipfile.ZIP_DEFLATED) as archive:
            for p in paths:
                name = p.relative_to(source).as_posix(); content = p.read_bytes()
                entry = zipfile.ZipInfo(name, date_time=(2026, 1, 1, 0, 0, 0))
                entry.compress_type = zipfile.ZIP_DEFLATED
                archive.writestr(entry, content)
                hashes[name] = hashlib.sha256(content).hexdigest()
        with zipfile.ZipFile(temp) as archive:
            if archive.testzip() is not None:
                raise ValueError('Pacote invÃ¡lido')
        _conferir_versao(anterior, folder, manifest['version'], hashes)
        os.replace(temp, target)
        # UM pacote por extensao, sempre o atual: o ZIP sem versao e os de versoes passadas somem.
        # Pasta com varios so cria chance de instalar o errado — que e o que a versao no nome veio
        # evitar. O historico dos pacotes esta no git, nao na pasta.
        for velho in [base / (folder + '.zip')] + sorted(base.glob(folder + '-*.zip')):
            if velho != target and velho.exists():
                velho.unlink()
        result[folder] = {'versao': manifest['version'], 'nome': manifest['name'], 'arquivo': target.name,
                          'sha256': hashlib.sha256(target.read_bytes()).hexdigest(), 'arquivos': hashes}
    out = base / 'build'; out.mkdir(exist_ok=True)
    (out / 'manifesto-extensoes.json').write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    return result

if __name__ == '__main__':
    for name, info in build().items():
        print(f"{info['nome']}  ->  {info['arquivo']}  ({len(info['arquivos'])} arquivos verificados)")
