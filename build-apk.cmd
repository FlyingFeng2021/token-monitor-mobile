@echo off
rem ---------------------------------------------------------------
rem Token Monitor Android - one-line local build (debug APK)
rem Prereqs (2 lightweight tools only):
rem   1. JDK 21            scoop install java/temurin21-jdk
rem   2. Android cmdline-tools + sdk (see DELIVERY.md section 2)
rem Usage:  build-apk.cmd          (debug APK)
rem         build-apk.cmd assembleRelease
rem ---------------------------------------------------------------
setlocal
if "%ANDROID_HOME%"=="" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not exist "%ANDROID_HOME%" (
  echo [ERROR] Android SDK not found at %ANDROID_HOME%
  echo         Install cmdline-tools first - see DELIVERY.md section 2.
  exit /b 1
)
set "JAVA_TOOL_OPTIONS="
cd /d "%~dp0android"
if "%~1"=="" (
  call gradlew.bat assembleDebug --no-daemon %~2 %~3
) else (
  call gradlew.bat %* --no-daemon
)
if errorlevel 1 exit /b 1
echo.
echo [OK] APK output:
dir /b app\build\outputs\apk\debug\app-debug.apk 2>nul && echo   %~dp0android\app\build\outputs\apk\debug\app-debug.apk
dir /b app\build\outputs\apk\release\app-release.apk 2>nul && echo   %~dp0android\app\build\outputs\apk\release\app-release.apk
endlocal
