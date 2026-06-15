# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

`agent-web-bridge` 是一个把本地 agent CLI 会话通过浏览器暴露出来的桥接器。它在终端里启动一个 PTY 来跑 agent（默认为 `claude`），同时把 PTY 的输入/输出经过 WebSocket 双向同步到浏览器中的 xterm.js，使得本地终端和远程网页是同一个会话的两个视图（任意一端的按键/输出都会反映到另一端）。

## 常用命令

```bash
npm start          # 启动服务器：占管当前终端，启动 claude PTY，监听 :3001
npm run dev        # 同上，使用 node --watch 热重载（适合改 server.js 时使用）
PORT=4000 npm start                       # 自定义 HTTP 端口
CLAUDE_BIN=/path/to/claude npm start      # 自定义 claude 可执行文件路径
```

没有测试套件、没有 lint 配置；改动后通过实际运行 `npm start` 并打开 `http://localhost:3001` 验证。

## 架构要点

整个项目只有 **两个文件** 承载所有逻辑：`server.js` 和 `public/index.html`。理解它们的协作关系是改动这个仓库的关键。

### 单 PTY、多镜像的设计

`server.js` 中 **只 spawn 一个** `claude` PTY 进程（`ptyProcess`），生命周期与 HTTP 服务器绑定：HTTP 启动后才启动 PTY；PTY 退出 → `shutdown()` → 关闭 `wss` / `httpServer` 并退出 Node 进程。`wsClients` 是一个 `Set<WebSocket>`，多个浏览器标签页连过来都共享同一个 PTY，看到完全相同的输出，任何一个浏览器的按键和本地终端的按键会交错写入同一条 PTY stdin。

数据流（双向）：

- **PTY → 显示**：`ptyProcess.onData` 同时写入 `process.stdout`（本地终端）和 `broadcastToWeb`（所有 WebSocket 客户端）。原始字节直接转发，不做解析。
- **输入 → PTY**：本地 `process.stdin`（raw mode）和每个 WebSocket 的 `input` 消息都直接 `ptyProcess.write`。WebSocket 多了一个 `resize` 消息类型（带 `cols`/`rows`，限制在 [2, 500]）。
- **本地终端 resize → PTY**：`process.stdout` 的 `resize` 事件同步到 PTY。浏览器侧 resize 不影响本地终端，只是 PTY 被多次 resize（最后一个赢）——这是已知的限制。

### 控制消息协议（WebSocket）

服务器 → 客户端使用 JSON：

- `{ type: 'data', data }` —— PTY 输出原文（字符串）。
- `{ type: 'exit', code, signal }` —— PTY 退出，前端弹出"已退出"覆盖层。
- `{ type: 'error', message }` —— 保留通道，目前 `server.js` 没有发出这类消息的路径。

客户端 → 服务器：`{ type: 'input', data }` 与 `{ type: 'resize', cols, rows }`。前端兜底：如果某条 WS 消息不是合法 JSON，会被当成原始终端字节直接 `term.write`。

### 关闭与终端恢复

`shutdown()` 是关键路径：先 `kill(-pid, 'SIGTERM')` 杀整个进程组（防 `claude` 拉起的子进程残留），再 `SIGHUP`；然后把本地 stdin 的 raw mode 关掉、关 servers、`process.exit`。`SIGINT`/`SIGTERM`/`exit` 都接到这里，所以 `Ctrl+C` 在本地终端 = 关掉 PTY = 同时让所有浏览器看到 `exit` 消息。

### 前端重连与 fit

`public/index.html` 用指数退避（1s 起，封顶 15s）自动重连；`fitAddon` 在 `window.resize` / `ResizeObserver` 触发时去算新的 cols/rows 并通过 WS 发出 `resize`。覆盖层（overlay）在 `data` 消息到达时才隐藏，所以连上后还得等到 `claude` 输出第一个字节才会看到终端界面。

## 已知约束

- 没有任何认证：把它跑在公开端口等于把本机 Claude 完全公开出去。生产场景前面要套反向代理 + auth。
- 只支持单 PTY 单会话；改成多会话需要重写 `wsClients` / `ptyProcess` 的关系。
- `node-pty` 是原生模块，跨 Node 大版本升级时常常需要 `npm rebuild`。
