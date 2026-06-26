@echo off
setlocal

if "%OLLAMA_HOST%"=="" set "OLLAMA_HOST=127.0.0.1:11434"
if "%OLLAMA_MODELS%"=="" set "OLLAMA_MODELS=C:\OllamaModels"
if "%OLLAMA_EXE%"=="" set "OLLAMA_EXE=C:\Ollama\ollama.exe"
if "%OLLAMA_KEEP_ALIVE%"=="" set "OLLAMA_KEEP_ALIVE=30s"

if "%TRAINING_SERVER_ROOT%"=="" set "TRAINING_SERVER_ROOT=%~dp0"
for %%I in ("%TRAINING_SERVER_ROOT%.") do set "TRAINING_SERVER_ROOT=%%~fI"

if "%OLLAMA_LOG_DIR%"=="" set "OLLAMA_LOG_DIR=%TRAINING_SERVER_ROOT%\logs"
if not exist "%OLLAMA_LOG_DIR%" mkdir "%OLLAMA_LOG_DIR%"
set "OLLAMA_LOG=%OLLAMA_LOG_DIR%\ollama-system.log"

if "%HOME%"=="" set "HOME=%USERPROFILE%"
if "%HOME%"=="" set "HOME=C:\Windows\System32\config\systemprofile"

echo [%date% %time%] starting ollama serve host=%OLLAMA_HOST% models=%OLLAMA_MODELS% >> "%OLLAMA_LOG%"
if not exist "%OLLAMA_EXE%" (
  echo [%date% %time%] missing ollama executable: %OLLAMA_EXE% >> "%OLLAMA_LOG%"
  exit /b 2
)

"%OLLAMA_EXE%" serve >> "%OLLAMA_LOG%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"
echo [%date% %time%] ollama serve exited code=%EXIT_CODE% >> "%OLLAMA_LOG%"
exit /b %EXIT_CODE%
