@echo off
chcp 65001 >nul
title 邻传 - 配置局域网访问
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\允许局域网访问.ps1"
pause
