# -*- coding: utf-8 -*-
"""
pegar_chat_id.py
Descobre o seu chat_id e salva no config.json automaticamente.
Antes de rodar: abra o bot no Telegram e mande qualquer mensagem (ex: "oi").
"""
import json, os, urllib.request

PASTA = os.path.dirname(os.path.abspath(__file__))
CFG = os.path.join(PASTA, "config.json")

def main():
    with open(CFG, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    token = cfg.get("token", "").strip()
    if not token:
        print("[ERRO] Coloque o token no config.json primeiro.")
        return

    url = f"https://api.telegram.org/bot{token}/getUpdates"
    with urllib.request.urlopen(url, timeout=20) as r:
        resp = json.loads(r.read().decode("utf-8"))

    if not resp.get("ok") or not resp.get("result"):
        print("[ATENÇÃO] Nenhuma mensagem encontrada.")
        print("Abra o bot no Telegram, clique em Iniciar/Start, mande 'oi' e rode de novo.")
        return

    # pega o chat da mensagem mais recente
    chat = None
    for upd in resp["result"]:
        msg = upd.get("message") or upd.get("edited_message")
        if msg and msg.get("chat"):
            chat = msg["chat"]
    if not chat:
        print("[ATENÇÃO] Mande uma mensagem ao bot e rode de novo.")
        return

    cfg["chat_id"] = str(chat["id"])
    with open(CFG, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

    nome = chat.get("first_name") or chat.get("title") or "voce"
    print(f"[OK] chat_id de {nome} salvo no config.json: {chat['id']}")

if __name__ == "__main__":
    main()
