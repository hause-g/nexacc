import sys, tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import db, servidor
from http.server import ThreadingHTTPServer
with tempfile.TemporaryDirectory(prefix='agentum-wire-') as folder:
    db.DB_PATH=str(Path(folder)/'test.db')
    servidor.LOG_DIR=str(Path(folder)/'logs')
    db.init()
    with ThreadingHTTPServer(('127.0.0.1',0),servidor.Handler) as server:
        print(server.server_port,flush=True)
        server.serve_forever()
