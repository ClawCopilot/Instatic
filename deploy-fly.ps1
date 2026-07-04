# PowerShell 一键部署脚本 — Instatic CMS on Fly.io
# 用法: .\deploy-fly.ps1 [-AppName <name>] [-Region <region>] [-SkipBackup]
# 首次运行会引导完成所有配置，后续运行自动执行部署

param(
    [string]$AppName = "instatic-cms",
    [string]$Region = "nrt",
    [switch]$SkipBackup = $false
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host @"
========================================
  Instatic CMS — Fly.io 一键部署
========================================
  应用名 : $AppName
  区域   : $Region
  内存   : 2GB RAM / shared-cpu-2x
  存储   : 100GB 持久卷
========================================
"@ -ForegroundColor Cyan

# ============================================================
# 1. 环境检查
# ============================================================
Write-Host "`n[1/8] 检查环境..." -ForegroundColor Yellow

# 检查 flyctl
$fly = Get-Command flyctl -ErrorAction SilentlyContinue
if (-not $fly) {
    Write-Host "❌ 未找到 flyctl，请先安装:" -ForegroundColor Red
    Write-Host "   iwr https://fly.io/install.ps1 -useb | iex" -ForegroundColor Gray
    Write-Host "   安装后重启终端，然后重新运行此脚本" -ForegroundColor Gray
    exit 1
}
Write-Host "   ✅ flyctl 已安装: $(flyctl version)" -ForegroundColor Green

# 检查登录状态
$loginCheck = flyctl auth whoami 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "`n   未登录 Fly.io，正在打开登录页面..." -ForegroundColor Yellow
    flyctl auth login
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 登录失败" -ForegroundColor Red
        exit 1
    }
}
Write-Host "   ✅ 已登录" -ForegroundColor Green

# 检查 Docker
$docker = Get-Command docker -ErrorAction SilentlyContinue
if (-not $docker) {
    Write-Host "❌ 未找到 Docker，请先安装 Docker Desktop" -ForegroundColor Red
    exit 1
}
Write-Host "   ✅ Docker 已安装" -ForegroundColor Green

# ============================================================
# 2. 检查/创建 Fly 应用
# ============================================================
Write-Host "`n[2/8] 检查 Fly 应用..." -ForegroundColor Yellow

$appExists = $false
$appList = flyctl apps list 2>&1 | Out-String
if ($appList -match $AppName) {
    $appExists = $true
}

if ($appExists) {
    Write-Host "   ✅ 应用 '$AppName' 已存在" -ForegroundColor Green
} else {
    Write-Host "   创建新应用: $AppName ..." -ForegroundColor Yellow
    flyctl apps create $AppName --org personal
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 创建应用失败" -ForegroundColor Red
        exit 1
    }
    Write-Host "   ✅ 应用已创建" -ForegroundColor Green
}

# ============================================================
# 3. 创建持久化存储卷
# ============================================================
Write-Host "`n[3/8] 配置持久化存储卷..." -ForegroundColor Yellow

# 检查卷是否存在
$volumes = flyctl volumes list -a $AppName 2>&1 | Out-String
$dataExists = $volumes -match "instatic_data"
$uploadsExists = $volumes -match "instatic_uploads"

if (-not $dataExists) {
    Write-Host "   创建卷: instatic_data (50GB)..." -ForegroundColor Yellow
    flyctl volumes create instatic_data --size 50 --region $Region -a $AppName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 创建卷失败" -ForegroundColor Red
        exit 1
    }
    Write-Host "   ✅ instatic_data 已创建" -ForegroundColor Green
} else {
    Write-Host "   ✅ instatic_data 已存在" -ForegroundColor Green
}

if (-not $uploadsExists) {
    Write-Host "   创建卷: instatic_uploads (50GB)..." -ForegroundColor Yellow
    flyctl volumes create instatic_uploads --size 50 --region $Region -a $AppName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 创建卷失败" -ForegroundColor Red
        exit 1
    }
    Write-Host "   ✅ instatic_uploads 已创建" -ForegroundColor Green
} else {
    Write-Host "   ✅ instatic_uploads 已存在" -ForegroundColor Green
}

# ============================================================
# 4. 生成并设置密钥
# ============================================================
Write-Host "`n[4/8] 配置安全密钥..." -ForegroundColor Yellow

$secrets = flyctl secrets list -a $AppName 2>&1 | Out-String
$keyExists = $secrets -match "INSTATIC_SECRET_KEY"
$originExists = $secrets -match "PUBLIC_ORIGIN"

if (-not $keyExists) {
    # 生成 64 字节随机密钥
    $secretKey = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 64 | ForEach-Object { [char]$_ })
    Write-Host "   生成 INSTATIC_SECRET_KEY..." -ForegroundColor Yellow
    flyctl secrets set INSTATIC_SECRET_KEY="$secretKey" -a $AppName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 设置密钥失败" -ForegroundColor Red
        exit 1
    }
    Write-Host "   ✅ INSTATIC_SECRET_KEY 已设置" -ForegroundColor Green
} else {
    Write-Host "   ✅ INSTATIC_SECRET_KEY 已存在" -ForegroundColor Green
}

if (-not $originExists) {
    $publicOrigin = "https://$AppName.fly.dev"
    Write-Host "   设置 PUBLIC_ORIGIN=$publicOrigin..." -ForegroundColor Yellow
    flyctl secrets set PUBLIC_ORIGIN="$publicOrigin" -a $AppName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "❌ 设置 PUBLIC_ORIGIN 失败" -ForegroundColor Red
        exit 1
    }
    Write-Host "   ✅ PUBLIC_ORIGIN 已设置" -ForegroundColor Green
} else {
    Write-Host "   ✅ PUBLIC_ORIGIN 已存在" -ForegroundColor Green
}

# 检查是否设置了 TRUSTED_PROXY_CIDRS
if ($secrets -notmatch "TRUSTED_PROXY_CIDRS") {
    Write-Host "   设置 TRUSTED_PROXY_CIDRS..." -ForegroundColor Yellow
    flyctl secrets set TRUSTED_PROXY_CIDRS="fdaa::/16" -a $AppName
    Write-Host "   ✅ TRUSTED_PROXY_CIDRS 已设置" -ForegroundColor Green
}

# ============================================================
# 5. 部署应用
# ============================================================
Write-Host "`n[5/8] 部署应用..." -ForegroundColor Yellow

Write-Host "   正在构建 Docker 镜像并部署到 Fly.io..." -ForegroundColor Gray
Write-Host "   这可能需要几分钟，请耐心等待..." -ForegroundColor Gray

flyctl deploy --ha=false -a $AppName
if ($LASTEXITCODE -ne 0) {
    Write-Host "❌ 部署失败，请查看上方错误信息" -ForegroundColor Red
    exit 1
}
Write-Host "   ✅ 部署成功" -ForegroundColor Green

# ============================================================
# 6. 分配 IPv4（可选但推荐）
# ============================================================
Write-Host "`n[6/8] 配置网络..." -ForegroundColor Yellow

$ipList = flyctl ips list -a $AppName 2>&1 | Out-String
if ($ipList -notmatch "v4") {
    Write-Host "   分配独立 IPv4 地址..." -ForegroundColor Yellow
    flyctl ips allocate-v4 -a $AppName --shared 2>&1 | Out-Null
    # shared IPv4 免费，dedicated 收费 $2/月
    Write-Host "   ✅ IPv4 已分配" -ForegroundColor Green
} else {
    Write-Host "   ✅ IPv4 已存在" -ForegroundColor Green
}

# ============================================================
# 7. 健康检查
# ============================================================
Write-Host "`n[7/8] 健康检查..." -ForegroundColor Yellow

Write-Host "   等待应用启动..." -ForegroundColor Gray
Start-Sleep -Seconds 10

$status = flyctl status -a $AppName 2>&1 | Out-String
if ($status -match "running") {
    Write-Host "   ✅ 应用运行正常" -ForegroundColor Green
} else {
    Write-Host "   ⚠️ 应用状态异常，查看日志:" -ForegroundColor Yellow
    flyctl logs -a $AppName | Select-Object -Last 20
}

# ============================================================
# 8. 输出结果
# ============================================================
Write-Host "`n[8/8] 部署完成！" -ForegroundColor Yellow
Write-Host @"
========================================
  🎉 部署成功！
========================================
  访问地址 : https://$AppName.fly.dev/admin/
  应用名称 : $AppName
  区域     : $Region
  内存     : 2GB RAM / shared-cpu-2x
  存储卷   : instatic_data (50GB) + instatic_uploads (50GB)

  首次访问会自动跳转到初始化页面。
  请立即创建管理员账号！

========================================
  常用命令
========================================
  flyctl logs -a $AppName            # 查看日志
  flyctl status -a $AppName          # 查看状态
  flyctl ssh console -a $AppName     # SSH 进入容器
  flyctl secrets list -a $AppName    # 查看密钥
  .\backup-fly.ps1                   # 手动备份

========================================
"@ -ForegroundColor Cyan

# 询问是否设置自定义域名
Write-Host "是否要设置自定义域名？(y/n): " -NoNewline -ForegroundColor Yellow
$setDomain = Read-Host
if ($setDomain -eq "y" -or $setDomain -eq "Y") {
    Write-Host "请输入域名（如 cms.example.com）: " -NoNewline
    $domain = Read-Host
    if ($domain) {
        flyctl certs create $domain -a $AppName
        flyctl secrets set PUBLIC_ORIGIN="https://$domain" -a $AppName
        Write-Host "`n请在 DNS 服务商添加以下记录:" -ForegroundColor Yellow
        Write-Host "  类型: CNAME  名称: $($domain.Split('.')[0])  值: $AppName.fly.dev" -ForegroundColor Gray
        Write-Host "`n证书验证通过后，重新部署:" -ForegroundColor Yellow
        Write-Host "  flyctl deploy -a $AppName" -ForegroundColor Gray
    }
}
