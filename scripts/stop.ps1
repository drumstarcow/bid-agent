# 停止投标智能体后端
$root = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pidFile = Join-Path $root '.uvicorn.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host '未发现运行中的 uvicorn 进程'
    exit 0
}
$pid = [int]((Get-Content $pidFile -Raw).Trim())
try {
    Stop-Process -Id $pid -Force
    Write-Host "已停止 uvicorn (pid $pid)"
}
catch {
    Write-Host "进程 $pid 不存在或已退出"
}
Remove-Item $pidFile -Force
