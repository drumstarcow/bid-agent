# 投标智能体中台 · 投标智能体

东浩兰生集团「探索 AI 赋能投标」项目配套的智能体（Agent）工程演示。
以 **FastAPI + SQLite** 后端承载真实的业务工具，前端通过 API 驱动 7 大投标场景模块，
并提供一个**规则驱动 + 可选 LLM 工具调用**的对话式智能体；所有工具调用与人工确认均在后端留痕（可审计）。

## 特性
- **真实后端**：FastAPI 提供 REST API，SQLite 持久化证照 / 业绩 / 方案 / 标讯 / 知识库与审计日志。
- **业务工具化**：标讯匹配、招标体检、知识库 RAG、建议书生成、资质巡检、推送建议等 8 个真实查库工具。
- **对话式智能体**
  - 规则模式（默认，离线可跑）：确定性意图分流 → 调用真实工具 → 合成回答。
  - LLM 模式（可选）：配置 OpenAI 兼容 Chat Completions + function tools 后，由模型自主选择并调用工具；API 不可用时**透明降级规则模式，绝不伪造模型执行**。
- **全程可审计**：每次工具调用写入 `tool_logs`，业务变更 / 人工确认写入 `events`，可在「执行与审计」页追溯。
- **人工确认闭环**：推送仅生成待确认建议，须 **HR 角色**在界面确认后才写入推送记录（`member` 角色被拒绝）。
- **测试**：pytest 覆盖匹配梯度、证照状态、体检、RAG、建议书、推送人工确认闭环、角色白名单与工具校验，共 14 项。

## 目录结构
```
backend/                 FastAPI 后端
  app/db.py              Schema、连接、播种、事件
  app/engine.py          业务引擎（匹配 / 体检 / RAG / 统计）
  app/proposal.py        投标建议书九段式 HTML 生成
  app/agent_tools.py     8 个业务工具 + 统一参数校验 / 角色白名单 / 审计
  app/agent.py           智能体内核（规则 / LLM + 审计）
  app/main.py            API 路由 + 前端静态托管
  tests/                 pytest 测试
frontend/                纯静态前端（由后端 API 驱动）
  index.html
  assets/api.js          从 /api/bootstrap 拉取数据并映射为前端全局变量
  assets/app.js          7 大业务视图渲染
  assets/agent.js        对话客户端 + 审计视图 + 推送人工确认 + 启动逻辑
  assets/styles.css
```

## 快速开始（Windows PowerShell）
1. 准备 Python 3.11+ 虚拟环境并安装依赖：
   ```powershell
   cd 投标智能体平台
   python -m venv .venv
   .venv\Scripts\Activate.ps1
   pip install -r requirements.txt
   ```
2. 启动后端（同时静态托管前端）：
   ```powershell
   .\scripts\start.ps1
   ```
3. 浏览器打开 http://127.0.0.1:8000
4. 停止： `.\scripts\stop.ps1`

## 配置 LLM 模式（可选）
复制 `.env.example` 为 `.env`，设置 `LLM_ENABLED=true` 及 `LLM_API_KEY` / `LLM_MODEL` / `LLM_BASE_URL`，
重启后端即可启用 LLM 工具调用模式（无 key 时自动降级规则模式，能力不缺失）。

## 主要 API
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET  | `/api/health` | 健康检查（返回当前模式 `rules` / `llm`） |
| GET  | `/api/bootstrap` | 一次性加载前端全部基础数据 |
| POST | `/api/agent/chat` | 对话入口 `{message, role}` |
| GET  | `/api/agent/logs` | 工具执行审计日志 |
| GET  | `/api/events` | 业务事件流 |
| GET  | `/api/tenders/{id}/proposal` | 生成九段式投标建议书 HTML |
| POST | `/api/agent/tools/{name}` | 直接调用业务工具（同样走校验与审计） |
| POST | `/api/push/suggestions/{sid}/confirm` | HR 人工确认推送 |
| POST | `/api/push/suggestions/{sid}/discard` | 忽略推送建议 |

## 测试
```powershell
pytest backend/tests        # 14 项通过
```

## 演示限制说明
- 推送渠道（飞书 / 企业微信）为**演示模拟**，确认后仅写库、不实际发送。
- 演示数据为集团级虚构样例；涉及真实报价底价 / 涉密信息请勿输入外部模型（见知识库 K-14 规范）。
- LLM 模式需自备兼容服务端；未配置时完全以规则模式演示，能力不缺失。
