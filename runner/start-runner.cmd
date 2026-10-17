@echo off
setlocal
REM SDVsolution build runner for Windows (Docker Desktop).
REM Builds the runner image, asks for your runner token without showing it, then runs the runner.
REM Works from the repository root or from the runner folder.
if exist "%~dp0runner\Dockerfile" (cd /d "%~dp0") else (cd /d "%~dp0..")

echo Building the runner image (first time takes a few minutes)...
docker build -f runner/Dockerfile -t sdv-runner .
if errorlevel 1 (
  echo.
  echo Docker build failed. Is Docker Desktop running?
  pause
  exit /b 1
)

echo.
echo Paste your runner token and press Enter. It is hidden: you will see * instead of the token.
for /f "usebackq delims=" %%T in (`powershell -NoProfile -Command "$s = Read-Host 'Runner token' -AsSecureString; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }"`) do set "SDV_RUNNER_TOKEN=%%T"
if not defined SDV_RUNNER_TOKEN (
  echo No token entered.
  pause
  exit /b 1
)

echo.
echo Runner started. Leave this window open; close it to stop the runner.
REM The token is passed from the environment, so it never appears on screen or in the command line.
docker run --rm -e SDV_API=https://app.sdvsolution.com -e SDV_RUNNER_TOKEN sdv-runner
set "SDV_RUNNER_TOKEN="
pause
