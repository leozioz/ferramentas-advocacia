# Instala o Transcritor rápido neste computador (precisa de Python 3.10+ e, para ser rápido, placa NVIDIA).
# Cria um ambiente Python separado em %LOCALAPPDATA%\TranscritorRapido e um ícone na área de trabalho.
$ErrorActionPreference = 'Stop'
$destino = "$env:LOCALAPPDATA\TranscritorRapido"
$py = "$destino\venv\Scripts\python.exe"
$servidor = Join-Path $PSScriptRoot 'servidor.py'

if (-not (Test-Path $py)) {
  New-Item -ItemType Directory -Force $destino | Out-Null
  py -3 -m venv "$destino\venv"
}
& $py -m pip install --upgrade pip
& $py -m pip install faster-whisper nvidia-cublas-cu12 nvidia-cudnn-cu12

$atalho = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Transcritor rápido.lnk'
$s = (New-Object -ComObject WScript.Shell).CreateShortcut($atalho)
$s.TargetPath = $py
$s.Arguments = "`"$servidor`""
$s.WorkingDirectory = $PSScriptRoot
$s.Description = 'Transcrição de audiências com a placa de vídeo (usada pelo site Ferramentas de Advocacia)'
$s.IconLocation = "$env:SystemRoot\System32\SHELL32.dll,168"
$s.Save()
Write-Host "Pronto. Abra o ícone 'Transcritor rápido' na área de trabalho antes de transcrever."
