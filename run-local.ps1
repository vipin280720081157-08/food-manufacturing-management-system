param(
    [switch]$NoMigration
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Backend = Join-Path $ProjectRoot "backend"
$Frontend = Join-Path $ProjectRoot "frontend"
$Python = Join-Path $Backend ".venv\Scripts\python.exe"
$LogDir = Join-Path $ProjectRoot ".tmp\runtime-logs"

if (-not (Test-Path -LiteralPath $Python)) {
    throw "Backend virtual environment is missing. Create it and install backend/requirements.txt first."
}
if (-not (Test-Path -LiteralPath (Join-Path $Frontend "node_modules"))) {
    throw "Frontend dependencies are missing. Run npm install in frontend first."
}
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

if (-not $NoMigration) {
    Push-Location $Backend
    try {
        & $Python -m alembic upgrade head
        if ($LASTEXITCODE -ne 0) { throw "Database migration failed with exit code $LASTEXITCODE." }
    }
    finally { Pop-Location }
}

$BackendOut = Join-Path $LogDir "backend.stdout.log"
$BackendErr = Join-Path $LogDir "backend.stderr.log"
$FrontendOut = Join-Path $LogDir "frontend.stdout.log"
$FrontendErr = Join-Path $LogDir "frontend.stderr.log"

Start-Process -FilePath $Python `
    -ArgumentList @("-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--reload") `
    -WorkingDirectory $Backend -WindowStyle Hidden `
    -RedirectStandardOutput $BackendOut -RedirectStandardError $BackendErr | Out-Null

Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("run", "dev", "--", "--host", "127.0.0.1") `
    -WorkingDirectory $Frontend -WindowStyle Hidden `
    -RedirectStandardOutput $FrontendOut -RedirectStandardError $FrontendErr | Out-Null

Write-Host "Backend:  http://127.0.0.1:8000"
Write-Host "Frontend: http://127.0.0.1:5173"
Write-Host "Logs:     $LogDir"
