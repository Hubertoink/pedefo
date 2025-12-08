# Build Python executables with PyInstaller
Write-Host "Installing PyInstaller..." -ForegroundColor Cyan
python -m pip install --user pyinstaller

Write-Host "`nBuilding Python executables..." -ForegroundColor Cyan

$scripts = @(
    "split_merge.py",
    "compress.py",
    "thumbnails.py",
    "utils.py"
)

# Create build directory
$buildDir = "python-scripts\build"
$distDir = "python-scripts\dist"

foreach ($script in $scripts) {
    Write-Host "`nCompiling $script..." -ForegroundColor Yellow
    
    python -m PyInstaller --onefile `
        --distpath "$distDir" `
        --workpath "$buildDir" `
        --specpath "$buildDir" `
        --hidden-import=PyPDF2 `
        --hidden-import=pycryptodome `
        --hidden-import=Crypto `
        --hidden-import=Crypto.Cipher `
        --hidden-import=Crypto.Cipher.AES `
        --clean `
        --noconfirm `
        "python-scripts\$script"
}

Write-Host "`nCleaning up build artifacts..." -ForegroundColor Cyan
Remove-Item -Recurse -Force "$buildDir" -ErrorAction SilentlyContinue

Write-Host "`nDone! Executables are in $distDir" -ForegroundColor Green
Write-Host "Copy these to electron-app/python-dist/ for bundling" -ForegroundColor Green
