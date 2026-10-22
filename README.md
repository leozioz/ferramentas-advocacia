# Ferramentas de Advocacia

Site estático com ferramentas para o dia a dia do escritório. Tudo roda no navegador de quem usa: nenhum arquivo é enviado para servidor.

## Abas

- **Conversor**: PDF → Markdown/JPG/PNG; Markdown e imagens → PDF; em lote, com download em .zip.
  - OCR (PaddleOCR no navegador, com Tesseract de reserva): fotos viram PDF pesquisável (texto invisível por trás da imagem) e PDFs escaneados viram Markdown.
- **Transcritor**: vídeos e áudios de audiência → texto com falantes identificados e minutagem.
  - Transcrição: Whisper (transformers.js) no navegador, com placa de vídeo (WebGPU) quando houver.
  - Separação de vozes: modelo CAM++ (3D-Speaker, distribuído pelo projeto sherpa-onnx) com onnxruntime-web; papéis sugeridos pelo conteúdo.
  - Exporta `.md`, Word (`.docx`, Calibri 11, justificado, cada vídeo em página nova), `.txt` e `.srt`.
  - Dados da audiência: enviar a ata (PDF, inclusive escaneado, .docx ou .txt) ou digitar manualmente. Os nomes dos presentes viram sugestões para os falantes.
  - "Copiar para o Claude" monta o pedido de revisão de falantes e resumo dos depoimentos.
  - A última transcrição fica salva só no navegador de quem usou e pode ser recuperada.

Na primeira transcrição em cada computador, o navegador baixa os modelos (150 MB a 1,6 GB do Whisper, conforme a precisão, e 27 MB do modelo de vozes). Depois ficam em cache.

## Estrutura

```
index.html            abas e marcação das duas ferramentas
css/                  estilos
js/conversor.js       conversor de arquivos
js/ocr.js             OCR: PaddleOCR (reserva: Tesseract) e correções do texto
js/paddle-worker.js   PaddleOCR em segundo plano (onnxruntime-web)
js/transcritor.js     interface do transcritor
js/asr-worker.js      Whisper (fala → texto)
js/voz-worker.js      modelo de vozes (CAM++)
js/fbank.js           características de áudio para o modelo de vozes
js/t-audio.js         leitura do áudio, filtro de ruído, cortes
js/t-voices.js        agrupamento de vozes e sugestão de papéis
js/t-export.js        .md, .docx, .txt, .srt e texto para o Claude
js/t-ata.js           leitura da ata
models/voz/           modelo de vozes
```
