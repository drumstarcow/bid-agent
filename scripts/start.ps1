# 启动投标智能体后端（同时静态托管前端）
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $root

$venv = Join-Path $root '.venv\Scripts\python.exe'
$py = if (Test-Path $venv) { $venv } else { 'python' }

$pidFile = Join-Path $root '.uvicorn.pid'
$logFile = Join-Path $root 'uvicorn.log'

if (Test-Path $pidFile) {
    $old = (Get-Content $pidFile -Raw).Trim()
    Write-Host "uvicorn 似乎已在运行 (pid $old)。如需重启请先运行 .\scripts\stop.ps1"
    exit 0
}

Write-Host "正在启动 uvicorn（python=$py）..."
$job = Start-Process -FilePath $py -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--app-dir', 'backend', '--host', '127.0.0.1', '--port', '8000') `
    -RedirectStandardOutput $logFile -RedirectStandardError $logFile -PassThru -WindowStyle Hidden
$job.Id | Out-File $pidFile -Encoding ascii
Start-Sleep -Seconds 2
Write-Host "uvicorn 已启动 (pid $($job.Id))，日志见 uvicorn.log"
Write-Host "请浏览器访问 http://127.0.0.1:8000"
