# PowerShell 备份脚本 — Instatic CMS on Fly.io
# 用法: .\backup-fly.ps1 [-AppName <name>] [-BackupDir <dir>] [-KeepDays <days>]

param(
    [string]$AppName = "instatic-cms",
    [string]$BackupDir = "./backups",
    [int]$KeepDays = 7
)

$ErrorActionPreference = "Stop"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupFile = Join-Path $BackupDir "instatic-backup-${Timestamp}.tar.gz"

Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  Instatic CMS — Fly.io 自动备份" -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""

# 创建备份目录
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null
}

# 在容器内打包
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 在容器内打包数据..." -ForegroundColor Gray
flyctl ssh console -a $AppName -C "tar -czf /tmp/backup.tar.gz -C /app data uploads"
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 打包失败" -ForegroundColor Red
    exit 1
}

# 下载到本地
Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 下载备份文件..." -ForegroundColor Gray
flyctl ssh sftp get "/tmp/backup.tar.gz" $BackupFile -a $AppName 2>$null

if (Test-Path $BackupFile) {
    $Size = [math]::Round((Get-Item $BackupFile).Length / 1MB, 2)
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ✅ 备份完成: $BackupFile ($Size MB)" -ForegroundColor Green
} else {
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] ❌ 备份失败: 文件未生成" -ForegroundColor Red
    exit 1
}

# 清理容器内临时文件
flyctl ssh console -a $AppName -C "rm -f /tmp/backup.tar.gz" 2>$null

# 清理旧备份
$OldFiles = Get-ChildItem -Path $BackupDir -Filter "instatic-backup-*.tar.gz" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) }

if ($OldFiles.Count -gt 0) {
    $OldFiles | Remove-Item -Force
    Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 已清理 $($OldFiles.Count) 个超过 $KeepDays 天的旧备份" -ForegroundColor Gray
}

Write-Host ""
Write-Host "当前备份列表:" -ForegroundColor Green
Get-ChildItem -Path $BackupDir -Filter "instatic-backup-*.tar.gz" |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 10 |
    Format-Table Name, @{N='Size(MB)';E={[math]::Round($_.Length/1MB,2)}}, LastWriteTime -AutoSize
