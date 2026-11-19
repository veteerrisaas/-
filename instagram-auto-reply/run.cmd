@echo off
rem Usado pelo Agendador de Tarefas do Windows.
cd /d "%~dp0"
node src\index.js
exit /b %ERRORLEVEL%
