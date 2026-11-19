@echo off
rem Modo contínuo, usado pelo Agendador de Tarefas ao fazer logon no Windows.
cd /d "%~dp0"
node src\index.js --watch
exit /b %ERRORLEVEL%
