@echo off
title ApexScorpio Streamlabs Overlay Suite
cd /d "%~dp0"
echo =======================================================
echo     ApexScorpio Streamlabs Overlay Suite
echo =======================================================
echo.
echo A verificar dependencias...
call npm install --no-audit --no-fund
echo.
echo A abrir o painel visual no navegador...
start http://localhost:3000
echo.
echo =======================================================
echo 📌 LINKS RECOMENDADOS PARA O STREAMLABS OBS (SEM AVISOS):
echo.
echo  💻 NO PC DE SECRETARIA (ONDE RODA O SERVIDOR):
echo     - Viewers: http://localhost:3000/viewers.html
echo     - Chat:    http://localhost:3000/chat.html
echo.
echo  💻 NO PORTATIL (LIGADO AO MESMO WI-FI/REDE):
echo     - Viewers: http://192.168.1.50:3000/viewers.html
echo     - Chat:    http://192.168.1.50:3000/chat.html
echo =======================================================
echo.
call npm start
pause
