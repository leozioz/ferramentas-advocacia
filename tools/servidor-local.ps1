# Servidor local para testar o app sem publicar: powershell -ExecutionPolicy Bypass -File tools\servidor-local.ps1
# Depois abra http://localhost:8770 no navegador.
param([string]$Root = (Split-Path -Parent $PSScriptRoot), [int]$Port = 8770)
$mime = @{ '.html'='text/html; charset=utf-8'; '.js'='text/javascript; charset=utf-8'; '.css'='text/css; charset=utf-8'; '.svg'='image/svg+xml'; '.png'='image/png'; '.json'='application/json'; '.webmanifest'='application/manifest+json'; '.wav'='audio/wav'; '.mp3'='audio/mpeg'; '.mp4'='video/mp4'; '.md'='text/markdown; charset=utf-8' }
$l = New-Object System.Net.HttpListener
$l.Prefixes.Add("http://localhost:$Port/")
$l.Start()
Write-Host "Abra http://localhost:$Port"
while ($l.IsListening) {
  $c = $l.GetContext()
  try {
    $p = [Uri]::UnescapeDataString($c.Request.Url.AbsolutePath).TrimStart('/')
    if ($p -eq '') { $p = 'index.html' }
    # usado só em testes: POST /__salvar/nome grava o corpo em tools\_saida\nome
    if ($c.Request.HttpMethod -eq 'POST' -and $p.StartsWith('__salvar/')) {
      $dir = Join-Path $Root 'tools\_saida'; New-Item -ItemType Directory -Force $dir | Out-Null
      $fs = [System.IO.File]::Create((Join-Path $dir (Split-Path -Leaf $p))); $c.Request.InputStream.CopyTo($fs); $fs.Close()
      continue
    }
    $f = Join-Path $Root $p
    if (Test-Path $f -PathType Leaf) {
      $b = [System.IO.File]::ReadAllBytes($f)
      $ext = [System.IO.Path]::GetExtension($f).ToLower()
      $c.Response.ContentType = $(if ($mime[$ext]) { $mime[$ext] } else { 'application/octet-stream' })
      $c.Response.Headers.Add('Cache-Control', 'no-store')
      $c.Response.OutputStream.Write($b, 0, $b.Length)
    } else { $c.Response.StatusCode = 404 }
  } catch {} finally { try { $c.Response.Close() } catch {} }
}
