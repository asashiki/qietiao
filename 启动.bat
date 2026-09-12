@echo off
chcp 65001 >nul
set PYTHONUTF8=1
cd /d "%~dp0"

python -c "import fastapi, uvicorn, multipart" 2>nul
if errorlevel 1 (
  echo 正在安装依赖…
  python -m pip install -r requirements.txt
  if errorlevel 1 (
    echo 依赖安装失败。
    pause
    exit /b 1
  )
)

echo.
echo 切条已启动： http://127.0.0.1:8765
echo 关掉这个窗口就会停止服务。
echo.
python app.py
pause
