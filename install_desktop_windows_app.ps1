# 生成 Windows 桌面版：优先用 PyInstaller 打包成独立 exe；
# 没有 PyInstaller 时，退回创建桌面快捷方式（带图标）。
$ErrorActionPreference = "Stop"
$AppDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$AppName = "Codex合并台桌面版"
Set-Location $AppDir

function New-Shortcut {
    $Desktop = [Environment]::GetFolderPath("Desktop")
    $Shell = New-Object -ComObject WScript.Shell
    $Lnk = $Shell.CreateShortcut("$Desktop\$AppName.lnk")
    $Pythonw = (Get-Command pythonw -ErrorAction SilentlyContinue).Source
    if ($Pythonw) {
        $Lnk.TargetPath = $Pythonw
        $Lnk.Arguments = "`"$AppDir\windows_app.py`""
    } else {
        $Lnk.TargetPath = "$AppDir\$AppName.bat"
    }
    $Lnk.WorkingDirectory = $AppDir
    $Lnk.IconLocation = "$AppDir\AppIcon.ico"
    $Lnk.Save()
    Write-Host "已创建桌面快捷方式：$Desktop\$AppName.lnk"
}

$PyInstaller = Get-Command pyinstaller -ErrorAction SilentlyContinue
if ($PyInstaller) {
    pyinstaller --noconfirm --clean --windowed --onefile `
        --name $AppName `
        --icon "$AppDir\AppIcon.ico" `
        --add-data "$AppDir\index.html;." `
        --add-data "$AppDir\app.js;." `
        --add-data "$AppDir\styles.css;." `
        --add-data "$AppDir\AppIcon.ico;." `
        "$AppDir\windows_app.py"
    Copy-Item "$AppDir\dist\$AppName.exe" "$AppDir\$AppName.exe" -Force
    Write-Host "已生成 $AppDir\$AppName.exe"
} else {
    Write-Host "未检测到 PyInstaller（可用 pip install pyinstaller 安装后生成独立 exe）。"
    New-Shortcut
}
