# Ferramentas de Advocacia

Site estático com ferramentas para o dia a dia do escritório. Tudo roda no navegador de quem usa: nenhum arquivo é enviado para servidor.

## Abas

- **Conversor**: PDF → Markdown/JPG/PNG; Markdown e imagens → PDF; em lote, com download em .zip.
- **Transcritor**: vídeos e áudios de audiência → texto com falantes identificados e minutagem.
  - Motor: Whisper (transformers.js) rodando no navegador, com placa de vídeo (WebGPU) quando houver.
  - Separação de vozes: impressão digital de voz (WavLM) + agrupamento; papéis sugeridos pelo conteúdo.
  - Exporta `.md` no padrão da skill `transcricao-audiencia`, Word (`.docx`, Calibri 11, justificado, cada vídeo em página nova, rodapé do escritório), `.txt` e `.srt`.
  - Dados da audiência: enviar a ata (PDF, .docx ou .txt) preenche processo, juízo, tipo, data, local, partes e presentes; ou digitar manualmente. Os nomes dos presentes viram sugestões para os falantes.
  - "Copiar para o Claude" monta o pedido de revisão de falantes e resumo dos depoimentos (com o texto da ata, se enviada).
  - A última transcrição fica salva no navegador e pode ser recuperada.

Na primeira transcrição em cada computador, o navegador baixa os modelos (150 MB a 1,6 GB, conforme a precisão, mais ≈380 MB para separar vozes). Depois ficam em cache.

## Estrutura

```
index.html            abas e marcação das duas ferramentas
css/app.css           tokens de cor e estilos do conversor
css/transcritor.css   abas e transcritor
js/tabs.js            troca de abas
js/conversor.js       conversor de arquivos
js/transcritor.js     interface do transcritor
js/asr-worker.js      worker com os modelos de IA
js/t-audio.js         leitura do áudio, filtro de ruído, cortes
js/t-voices.js        agrupamento de vozes e sugestão de papéis
js/t-export.js        .md, .docx, .txt, .srt e texto para o Claude
js/t-ata.js           leitura da ata e extração dos dados da audiência
tools/servidor-local.ps1  servidor para testar no computador
```

## Testar no computador

```
powershell -ExecutionPolicy Bypass -File tools\servidor-local.ps1
```

Depois abra http://localhost:8770. Abrir o `index.html` com dois cliques não funciona para o transcritor (o navegador bloqueia o worker em arquivos locais).

## Testes com gabarito

Arquivos reais ficam em `testes/` (fora do Git, têm dados de clientes).

- Atas: `testes/atas/NOME.pdf` + `NOME.gabarito.json`. No console de http://localhost:8770:
  `(await import('/tools/testar-atas.js')).testar(['NOME.pdf'])`
- Audiências: transcreva em http://localhost:8770/?dev#transcritor, salve com
  `(await import('/tools/testar-audiencia.js')).salvar('NOME')` e meça com `.avaliar('NOME', { threshold })`.
  O gabarito (`testes/audiencias/NOME.gabarito.json`) traz um papel e um horário de início por fala.

Resultados (audiência real, 7 min, 5 pessoas; 3 atas):

| Versão | Voz certa | Papel certo |
|---|---|---|
| WavLM, limite 0,84 | 42% | 46% |
| WavLM, limite 0,90 | 72% | 69% |
| **CAM++ (sherpa-onnx), limite 0,55** | **87%** | **87%** |

Atas: 43/43 itens. O modelo de voz é o CAM++ do 3D-Speaker (`models/voz/campplus.onnx`, 27 MB, release
`speaker-recongition-models` do sherpa-onnx), rodando com onnxruntime-web no processador (`js/voz-worker.js`) sobre
fbank Kaldi calculado em `js/fbank.js`. O juiz é a voz da fala de abertura (e outras vozes com falas típicas de juiz);
testemunha × advogado pela proporção de perguntas.

## Publicar

O site é publicado pelo GitHub Pages a partir da branch `main` (pasta raiz).
