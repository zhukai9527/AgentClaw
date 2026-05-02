param(
    [switch]$NoBuild
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3100
$LogDir = Join-Path $Root "logs"
$CorepackHome = Join-Path $Root "data\corepack"
$CorepackShimDir = Join-Path $Root "data\corepack-shims"

function Find-Mise {
    $candidates = @()
    $cmd = Get-Command "mise.exe" -ErrorAction SilentlyContinue
    if ($cmd) {
        $candidates += $cmd.Source
    }
    if ($env:USERPROFILE) {
        $candidates += (Join-Path $env:USERPROFILE ".local\bin\mise.exe")
    }
    $candidates += "C:\Users\voroj\.local\bin\mise.exe"

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    return $null
}

function Initialize-MiseEnvironment {
    param([string]$MiseExe)

    if (-not $MiseExe) {
        return
    }

    $binDir = Split-Path -Parent $MiseExe
    $localDir = Split-Path -Parent $binDir
    $userRoot = Split-Path -Parent $localDir
    $localAppData = Join-Path $userRoot "AppData\Local"
    $shimsDir = Join-Path $localAppData "mise\shims"

    if (Test-Path -LiteralPath $localAppData) {
        $env:USERPROFILE = $userRoot
        $env:HOME = $userRoot
        $env:LOCALAPPDATA = $localAppData
    }

    $pathParts = @($binDir, $shimsDir)
    foreach ($part in $pathParts) {
        if ($part -and (Test-Path -LiteralPath (Split-Path -Parent $part))) {
            $env:PATH = "$part;$env:PATH"
        }
    }
}

function Get-ProjectPackageManager {
    $packageJson = Join-Path $Root "package.json"
    $pkg = Get-Content -LiteralPath $packageJson -Raw | ConvertFrom-Json
    $packageManager = $pkg.packageManager
    if ([string]::IsNullOrWhiteSpace($packageManager)) {
        throw "package.json is missing packageManager."
    }

    $name = ($packageManager -split '@')[0]
    if ($name -ne "pnpm") {
        throw "Only pnpm is supported by restart.ps1, packageManager=$packageManager."
    }

    return $packageManager
}

function Invoke-PnpmBuild {
    $pmSpec = Get-ProjectPackageManager
    Write-Host "[2/3] Building with $pmSpec..." -ForegroundColor Cyan

    $miseExe = Find-Mise
    Initialize-MiseEnvironment $miseExe

    $corepack = Get-Command "corepack.cmd" -ErrorAction SilentlyContinue
    if (-not $corepack) {
        $corepack = Get-Command "corepack" -ErrorAction SilentlyContinue
    }
    if ($miseExe -or $corepack) {
        New-Item -ItemType Directory -Force -Path $CorepackHome | Out-Null
        New-Item -ItemType Directory -Force -Path $CorepackShimDir | Out-Null
        $pnpmShim = Join-Path $CorepackShimDir "pnpm.cmd"
        if ($miseExe) {
            $shimContent = @(
                "@echo off",
                "set `"COREPACK_HOME=$CorepackHome`"",
                "`"$miseExe`" exec -- corepack $pmSpec %*"
            )
        } else {
            $shimContent = @(
                "@echo off",
                "set `"COREPACK_HOME=$CorepackHome`"",
                "`"$($corepack.Source)`" $pmSpec %*"
            )
        }
        Set-Content -LiteralPath $pnpmShim -Value $shimContent -Encoding ASCII

        $oldCorepackHome = $env:COREPACK_HOME
        $oldPath = $env:PATH
        $env:COREPACK_HOME = $CorepackHome
        $env:PATH = "$CorepackShimDir;$oldPath"
        try {
            & $pnpmShim build | ForEach-Object { Write-Host $_ }
            $buildExitCode = $LASTEXITCODE
            return $buildExitCode
        } finally {
            $env:COREPACK_HOME = $oldCorepackHome
            $env:PATH = $oldPath
        }
    }

    $pnpm = Get-Command "pnpm.cmd" -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        $pnpm = Get-Command "pnpm" -ErrorAction SilentlyContinue
    }
    if ($pnpm) {
        & $pnpm.Name build | ForEach-Object { Write-Host $_ }
        $buildExitCode = $LASTEXITCODE
        return $buildExitCode
    }

    throw "Cannot find corepack or pnpm. Install pnpm or enable Node.js corepack."
}

function Stop-GatewayOnPort {
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if (-not $conn) {
        Write-Host "[1/3] No process on port $Port, skipping." -ForegroundColor Gray
        return
    }

    $procId = $conn.OwningProcess | Select-Object -First 1
    Write-Host "[1/3] Stopping process $procId on port $Port..." -ForegroundColor Yellow
    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $still = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if (-not $still) {
            return
        }
    }

    throw "Port $Port was not released within 10 seconds."
}

function Start-Gateway {
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stdout = Join-Path $LogDir "gateway-$stamp.out.log"
    $stderr = Join-Path $LogDir "gateway-$stamp.err.log"
    $miseExe = Find-Mise
    Initialize-MiseEnvironment $miseExe

    Write-Host "[3/3] Starting gateway..." -ForegroundColor Green
    if ($miseExe) {
        $command = "cd /d `"$Root`" && `"$miseExe`" exec -- node packages\gateway\dist\index.js >> `"$stdout`" 2>> `"$stderr`""
    } else {
        $command = "cd /d `"$Root`" && node packages\gateway\dist\index.js >> `"$stdout`" 2>> `"$stderr`""
    }
    $shell = New-Object -ComObject WScript.Shell
    $runner = "cmd.exe /d /c `"$command`""
    $null = $shell.Run($runner, 0, $false)

    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $check = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($check) {
            $gatewayPid = $check.OwningProcess | Select-Object -First 1
            Write-Host "Gateway running on port $Port (PID: $gatewayPid)" -ForegroundColor Green
            Write-Host "stdout: $stdout" -ForegroundColor DarkGray
            Write-Host "stderr: $stderr" -ForegroundColor DarkGray
            return
        }
    }

    Write-Host "Gateway failed to start!" -ForegroundColor Red
    if (Test-Path $stderr) {
        Get-Content -LiteralPath $stderr -Tail 80
    }
    exit 1
}

Push-Location $Root
try {
    Stop-GatewayOnPort

    if ($NoBuild) {
        Write-Host "[2/3] Skipping build (-NoBuild)." -ForegroundColor Gray
    } else {
        $code = Invoke-PnpmBuild
        if ($code -ne 0) {
            Write-Host "Build failed!" -ForegroundColor Red
            exit $code
        }
    }

    Start-Gateway
} finally {
    Pop-Location
}
