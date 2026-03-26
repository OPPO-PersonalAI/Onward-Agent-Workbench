@echo off
REM Pack source code for release, excluding build artifacts and dependencies.
REM Usage: double-click or run from project root.

cd /d "%~dp0\.."

set "PROJECT_DIR=%cd%"
for %%I in ("%PROJECT_DIR%") do set "FOLDER_NAME=%%~nxI"
set "OUTPUT=%PROJECT_DIR%\..\Onward2-source.tar.gz"

echo Packing source code...
echo Source:  %PROJECT_DIR%
echo Output:  %OUTPUT%

tar czf "%OUTPUT%" --exclude="node_modules" --exclude=".git" --exclude="out" --exclude="release" --exclude="dist" --exclude="*.log" -C "%PROJECT_DIR%\.." "%FOLDER_NAME%"

if %ERRORLEVEL% equ 0 (
    echo.
    echo Done! Archive: %OUTPUT%
    for %%A in ("%OUTPUT%") do echo Size: %%~zA bytes
) else (
    echo.
    echo Failed to create archive.
)

pause
