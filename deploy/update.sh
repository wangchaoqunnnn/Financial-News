#!/usr/bin/env bash
# ============================================================
# 财讯雷达 · 云服务器一键更新脚本
# 用法（在服务器上）：
#   chmod +x deploy/update.sh
#   ./deploy/update.sh
# 功能：拉取 GitHub 最新代码 -> 重启服务（优先 systemd，否则直接起进程）
# ============================================================
set -e
cd "$(dirname "$0")/.."            # 进入仓库根目录

echo "[1/3] git pull 拉取最新代码..."
git pull origin main

echo "[2/3] 重启服务..."
if command -v systemctl >/dev/null 2>&1 && systemctl list-units --type=service 2>/dev/null | grep -q 'financial-news'; then
  systemctl restart financial-news
  echo "已通过 systemd 重启（systemctl status financial-news 查看状态）"
else
  pkill -f "server/server.js" 2>/dev/null || true
  sleep 1
  mkdir -p logs
  SITE_URL="${SITE_URL:-https://wangchaoqun.top/news}" nohup node server/server.js >> logs/server.log 2>&1 &
  echo "已直接启动新进程（日志 logs/server.log）"
fi

echo "[3/3] 验证版本..."
sleep 3
curl -s http://127.0.0.1:8899/api/meta || true
echo ""
echo "完成。请与 GitHub 最新 commit 比对 meta 中的 version 字段。"
