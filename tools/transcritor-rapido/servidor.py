"""Transcritor rápido: transcrição com a placa NVIDIA deste computador (faster-whisper).

O site (aba Transcritor) procura este programa em http://127.0.0.1:8771. Se estiver aberto, manda o
áudio para cá em vez de transcrever no navegador. Só aceita conexões deste computador, e o áudio
não sai dele. Para desligar, feche a janela.
"""
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

PORTA = 8771
ORIGENS = ('https://leozioz.github.io', 'http://localhost:8770', 'http://127.0.0.1:8770')
MODELO = 'large-v3-turbo'

# avisos técnicos do Hugging Face que só assustam quem usa
os.environ.setdefault('HF_HUB_DISABLE_SYMLINKS_WARNING', '1')
os.environ.setdefault('HF_HUB_VERBOSITY', 'error')

# As bibliotecas da NVIDIA (cuBLAS, cuDNN) vêm em pacotes do pip: avisa o Windows onde estão as DLLs
_nv = os.path.join(sys.prefix, 'Lib', 'site-packages', 'nvidia')
if os.path.isdir(_nv):
    for pacote in os.listdir(_nv):
        pasta = os.path.join(_nv, pacote, 'bin')
        if os.path.isdir(pasta):
            os.add_dll_directory(pasta)
            os.environ['PATH'] = pasta + os.pathsep + os.environ['PATH']

import numpy as np  # noqa: E402
from faster_whisper import WhisperModel  # noqa: E402

print('Carregando o modelo de transcrição (na primeira vez baixa ~1,6 GB)...', flush=True)
try:
    modelo = WhisperModel(MODELO, device='cuda', compute_type='float16')
    DISPOSITIVO = 'cuda'
except Exception as e:  # sem placa NVIDIA utilizável: usa o processador
    print('Placa NVIDIA indisponível (%s); usando o processador.' % e, flush=True)
    modelo = WhisperModel(MODELO, device='cpu', compute_type='int8')
    DISPOSITIVO = 'cpu'
trava = threading.Lock()  # uma transcrição por vez na placa


class Pedido(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.0'

    def log_message(self, *a):
        pass

    def _cabecalhos(self):
        origem = self.headers.get('Origin', '')
        if origem in ORIGENS:
            self.send_header('Access-Control-Allow-Origin', origem)
            self.send_header('Vary', 'Origin')
            self.send_header('Access-Control-Allow-Private-Network', 'true')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type')

    def _origem_ok(self):
        origem = self.headers.get('Origin')
        return origem is None or origem in ORIGENS

    def do_OPTIONS(self):
        self.send_response(204 if self._origem_ok() else 403)
        self._cabecalhos()
        self.end_headers()

    def do_GET(self):
        if urlparse(self.path).path != '/status' or not self._origem_ok():
            self.send_response(404); self.end_headers(); return
        corpo = json.dumps({'ok': True, 'modelo': MODELO, 'dispositivo': DISPOSITIVO}).encode()
        self.send_response(200)
        self._cabecalhos()
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(corpo)

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != '/transcrever' or not self._origem_ok():
            self.send_response(404); self.end_headers(); return
        q = {k: v[0] for k, v in parse_qs(url.query).items()}
        n = int(self.headers.get('Content-Length', 0))
        audio = np.frombuffer(self.rfile.read(n), dtype='<f4')  # 16 kHz, mono
        duracao = len(audio) / 16000
        self.send_response(200)
        self._cabecalhos()
        self.send_header('Content-Type', 'application/x-ndjson')
        self.end_headers()

        def linha(obj):
            self.wfile.write((json.dumps(obj, ensure_ascii=False) + '\n').encode())
            self.wfile.flush()

        try:
            with trava:
                t0 = time.time()
                segs, _ = modelo.transcribe(
                    audio, language=q.get('language') or None, task=q.get('task', 'transcribe'),
                    beam_size=5, vad_filter=True, condition_on_previous_text=False,
                )
                out = []
                for s in segs:
                    out.append({'start': round(s.start, 2), 'end': round(s.end, 2), 'text': s.text})
                    linha({'progresso': min(1, s.end / duracao) if duracao else 1})
                print('Transcrito: %.0f s de áudio em %.0f s' % (duracao, time.time() - t0), flush=True)
            linha({'segmentos': out})
        except Exception as e:
            linha({'erro': str(e)})


if __name__ == '__main__':
    servidor = ThreadingHTTPServer(('127.0.0.1', PORTA), Pedido)
    print('Transcritor rápido ligado (%s). Pode usar o site normalmente.' % ('placa NVIDIA' if DISPOSITIVO == 'cuda' else 'processador'), flush=True)
    print('Para desligar, feche esta janela.', flush=True)
    servidor.serve_forever()
