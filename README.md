# 多策略跨市场资产筛选系统（真实数据源版）

## 启动
```bash
cd /Users/xyz/Documents/自动化策略
npm start
```
访问：`http://127.0.0.1:3000`

## 升级内容
- 真实数据源：
  - 币圈：Binance 公共行情（K线 + Top100 by 24h Quote Volume）
  - 美股：Yahoo Finance（日线 + Adjusted Close）
  - 港股：Yahoo Finance（日线 + Adjusted Close）
- 定时调度：
  - Crypto：每 4 小时扫描、每日扫描
  - US/HK：盘前 + 收盘扫描（按各自时区）
- 回测落库：
  - 扫描信号回测快照写入 `data/backtest-results.json`
  - 支持手动触发回测与读取最新快照
- 推送：
  - Telegram 3 Bot 分级推送（Alpha/Beta/System）
  - 同向 24 小时去重

## 主要接口
- `GET /api/signals?market=all|crypto|us|hk`
- `POST /api/push/run`
- `POST /api/backtest/run`
- `GET /api/backtest/latest`
- `GET /api/status`
- `POST /api/universe/refresh`

## 数据文件
- `data/config.json`：系统配置与 Bot Token
- `data/signal-log.json`：推送去重记录
- `data/backtest-results.json`：回测快照库
- `data/universe-cache.json`：成分缓存
- `data/candle-cache.json`：K线缓存
- `data/scheduler-state.json`：调度状态

## 说明
- 外部行情源不可用时，系统自动回退到本地合成K线以保证服务不中断。
- 正式实盘前请补充实盘风控、交易成本、滑点与异常市场状态处理。
