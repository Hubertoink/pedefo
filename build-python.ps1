param(
    [ValidateSet('auto','x64','arm64')]
    [string]$Arch = 'auto'
)

# Build Python executables with PyInstaller
function Get-PythonInvocation {
    param([string]$Arch)

    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py -and $Arch -eq 'x64') {
        # Prefer the latest Python 3.x 64-bit (x64) using combined flag
        return @{ Cmd = 'py'; Args = @('-3-64') }
    }
    if ($py -and $Arch -eq 'arm64') {
        # No reliable selector for ARM64; fall back to default launcher Python
        return @{ Cmd = 'py'; Args = @('-3') }
    }
    if ($py -and $Arch -eq 'auto') {
        return @{ Cmd = 'py'; Args = @('-3') }
    }

    return @{ Cmd = 'python'; Args = @() }
}

$pyInvoke = Get-PythonInvocation -Arch $Arch
$PY = $pyInvoke.Cmd
$PYARGS = $pyInvoke.Args

Write-Host "Installing PyInstaller..." -ForegroundColor Cyan
& $PY @PYARGS -m pip install --user pyinstaller

Write-Host "Installing Python runtime dependencies..." -ForegroundColor Cyan
& $PY @PYARGS -m pip install -r "python-scripts\requirements.txt"

if ($Arch -ne 'auto') {
    $pyArch = & $PY @PYARGS -c "import platform; print(platform.machine())" 2>$null
    if ($Arch -eq 'x64' -and ($pyArch -notmatch 'AMD64|x86_64')) {
        Write-Host "ERROR: Aktives Python ist '$pyArch' (nicht x64)." -ForegroundColor Red
        Write-Host "Für x64-EXEs: installiere ein x64-Python und starte den Build damit (oder baue auf einem x64-PC)." -ForegroundColor Yellow
        exit 1
    }
    if ($Arch -eq 'arm64' -and ($pyArch -notmatch 'ARM64')) {
        Write-Host "ERROR: Aktives Python ist '$pyArch' (nicht ARM64)." -ForegroundColor Red
        exit 1
    }
}

Write-Host "`nBuilding Python executables..." -ForegroundColor Cyan

$scripts = @(
    "split_merge.py",
    "compress.py",
    "thumbnails.py",
    "utils.py",
    "ocr.py"
)

# Create build directory
$buildDir = "python-scripts\build"
# Output directly into the folder that electron-builder bundles
$distDir = "python-dist"

if (-not (Test-Path $distDir)) {
    New-Item -ItemType Directory -Path $distDir | Out-Null
}

foreach ($script in $scripts) {
    Write-Host "`nCompiling $script..." -ForegroundColor Yellow
    
    & $PY @PYARGS -m PyInstaller --onefile `
        --distpath "$distDir" `
        --workpath "$buildDir" `
        --specpath "$buildDir" `
        --hidden-import=PyPDF2 `
        --hidden-import=Crypto `
        --hidden-import=Crypto.Cipher `
        --hidden-import=Crypto.Cipher.AES `
        --hidden-import=PIL `
        --hidden-import=pytesseract `
        --clean `
        --noconfirm `
        "python-scripts\$script"
}

Write-Host "`nCleaning up build artifacts..." -ForegroundColor Cyan
Remove-Item -Recurse -Force "$buildDir" -ErrorAction SilentlyContinue

Write-Host "`nDone! Executables are in $distDir" -ForegroundColor Green
Write-Host "electron-builder bundles this folder automatically." -ForegroundColor Green
