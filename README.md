# Pi Web Agent

把 [pi](https://pi.dev)（终端编码 agent）包装成一个 **Codex / ChatGPT 风格的网页应用**（也可以一键用 Electron 变成桌面应用）。

它复用了 pi 的 `--mode rpc` 协议：一个零依赖的 Node.js 服务启动 `pi --mode rpc` 子进程，把 agent 的事件通过 **SSE** 实时推送到浏览器，浏览器通过少量 JSON POST 接口回发命令。前端是纯 HTML/CSS/JS，没有构建步骤。

```
浏览器 UI  ── SSE（事件流）──▶  Node server  ── JSONL stdin/stdout ──▶  pi --mode rpc
            ◀── POST /api/* ──                ◀────────────────────────
```

## 快速开始

前置条件：已安装 Node 18+ 和 pi CLI（`npm i -g @earendil-works/pi-coding-agent`），并已配置好模型登录（`pi /login`）或 API key。

### 方式一：双击图标运行（Windows，推荐）

双击项目里的 **`启动.bat`** 即可：它会自动检查 Node / pi、启动服务、并在浏览器打开 <http://127.0.0.1:8420>。

| 文件 | 用途 |
|------|------|
| `启动.bat` | 双击启动（带日志窗口，关闭窗口即停止） |
| `后台启动.vbs` | 双击启动（隐藏窗口，更像 App；用 `停止.bat` 停止） |
| `停止.bat` | 停止服务（按端口找到并结束进程树） |

> 想要一个桌面图标：右键 `启动.bat` → 发送到 → 桌面快捷方式，之后在桌面双击即可；也可在快捷方式属性里加参数（如 `--model sonnet`）。

### 方式二：命令行启动

```bash
# 1) 进入本项目
cd 项目1

# 2) 启动（默认 http://127.0.0.1:8420）
npm start

# 或者直接
node server.js

# 启动后自动打开浏览器
node server.js --open
```

打开浏览器访问 <http://127.0.0.1:8420> 即可对话。

### 常用启动参数

```bash
# 指定工作目录（agent 的 read/bash/edit/write 作用在该目录）
node server.js --cwd /path/to/project

# 指定模型 / 提供商 / 思考强度
node server.js --provider anthropic --model sonnet --thinking high

# API key（覆盖环境变量）
node server.js --api-key sk-ant-...

# 加载扩展（可重复 -e）
node server.js -e ./my-extension.ts

# 自定义端口 / 监听地址
node server.js --port 9000 --host 0.0.0.0

# 查看全部选项
node server.js --help
```

所有 `pi` 的 provider/model/tools/resources 选项都可以透传（`--provider`、`--model`、`--thinking`、`--models`、`--tools`、`--exclude-tools`、`--no-builtin-tools`、`--no-tools`、`--session-dir`、`--no-session`、`--no-extensions`、`--no-skills`、`--no-context-files` 等）。

## 功能

- **Codex 风格聊天 UI**：Markdown 渲染、代码块高亮容器 + 复制按钮、流式输出。
- **思考块（Thinking）**：可折叠，短内容默认展开。
- **工具调用卡片**：`read / bash / edit / write / grep / find / ls` 等，展示参数与实时输出，可折叠、按状态着色（运行中/成功/出错）。
- **会话管理**：侧边栏列出本项目的所有历史会话，点击切换；一键新会话。
- **模型切换**：下拉选择可用模型；**思考强度**切换（off→max）。
- **状态栏**：当前模型、思考强度、token 用量、成本、上下文占用百分比。
- **图片输入**：粘贴图片到输入框即可作为附件发送。
- **流式打断 / 排队**：运行中可点 Stop 中断；也可继续输入并按 Enter 排队（follow-up）。
- **扩展 UI 支持**：扩展里的 `select / confirm / input / editor / notify` 会弹成网页对话框（对应 pi 的 `extension_ui_request` 协议）。
- **一键关闭服务**：顶栏的「关闭服务」按钮可直接停止整个服务（等价于 `停止.bat`），无需关控制台窗口。
- **`/` 命令菜单**：输入 `/` 自动弹出扩展命令 / prompt 模板 / skill 的补全列表。

## 桌面应用（Electron）

项目自带一个最小的 Electron 外壳，把上面的网页 UI 装进原生窗口：

```bash
npm install            # 会安装 electron（较大）
npm run desktop
```

`electron/main.js` 会：在随机本地端口启动 `server.js` → 等待就绪 → 打开 `BrowserWindow` 加载 UI。你也可以用同样的思路换成 Tauri / WebView 外壳（前端不依赖 Node，纯静态即可打包）。

> 想真正“打包成可分发 exe / dmg”，在 `electron/main.js` 基础上加 `electron-builder` / `electron-packager` 即可；pi 本身仍作为外部依赖（需要在目标机器上已安装 pi，或打包时把 pi 的 CLI 一起带上）。

## 架构说明

| 文件 | 作用 |
|------|------|
| `server.js` | HTTP 服务 + SSE 广播 + 静态文件 + 少量 API |
| `lib/rpc-client.js` | `pi --mode rpc` 子进程客户端：JSONL 编解码、请求/响应按 id 关联、事件分发 |
| `lib/spawn.js` | 跨平台启动 pi（Windows 下解决 `.cmd` shim 无法直接 spawn 的问题，含进程树清理） |
| `lib/sessions.js` | 从磁盘读取 `~/.pi/agent/sessions/...` 的 JSONL，生成侧边栏会话列表 |
| `public/` | 前端（`index.html` / `style.css` / `app.js`），纯静态、零依赖 |
| `electron/main.js` | 可选桌面外壳 |
| `启动.bat` / `后台启动.vbs` / `停止.bat` | Windows 双击启动/停止脚本 |

### 为什么用 RPC 而不是 SDK？

- **进程隔离**：agent 跑在独立进程里，崩溃/重启不影响 UI 服务。
- **语言无关**：前端和后端不 import pi 的内部 API，靠稳定的 JSONL 协议通信（见 `docs/rpc.md`）。
- **复用已安装的 pi**：登录、模型目录、扩展、skills 都沿用你现有的 `~/.pi` 配置。

如果你想要更深的定制（直接访问 agent 状态、自定义工具、同进程内嵌），可以改用 SDK：`createAgentSession()`（见 pi 的 `docs/sdk.md`），把 `server.js` 里的 RPC 层替换成 SDK 即可，前端无需改动。

## API 一览（供二次开发）

- `GET /events` — SSE 事件流
- `GET /api/config` / `/api/state` / `/api/messages` / `/api/models` / `/api/thinking-levels` / `/api/commands` / `/api/sessions` / `/api/session-stats`
- `POST /api/rpc` — 通用 RPC 透传（`{type:"prompt", message:"..."}` 等）
- `POST /api/ui-response` — 回答扩展的对话框请求
- `POST /api/restart` — 重启 pi 子进程
- `POST /api/shutdown` — 关闭整个服务（网页顶栏「关闭服务」按钮调用）
- `POST /api/export` — 导出会话为 HTML

## 关于 API Key（安全说明）

本项目**不存储任何密钥**。pi 的模型凭据只有两种来源：

1. 环境变量（推荐）——由 pi 自己读取，本服务从不接触：

   ```bash
   # Anthropic
export ANTHROPIC_API_KEY="sk-ant-..."
   # OpenAI
export OPENAI_API_KEY="sk-..."
   ```

2. `--api-key <key>` 启动参数——会被透传给 `pi` 子进程。

> **不要**把密钥写进代码、`.gitignore` 之外的文件或提交到仓库。

通过 `--api-key` 传入的密钥会被**强制脱敏**：

- `GET /api/config` 返回的 `piArgs` 中密钥显示为 `***`，不会下发到浏览器；
- 启动日志里的 `pi args:` 同样显示为 `***`。

因此前端页面、浏览器 DevTools、以及服务日志中都不会出现明文密钥。

在共享/远程机器上使用时，请保持监听地址为默认的 `127.0.0.1`（不要暴露 `--host 0.0.0.0`），并避免把密钥通过命令行参数传递（同机其他用户可能从进程列表看到），优先使用环境变量。

## 更换背景图

当前壁纸是 `public/BHIEEDIFJCEID-CXJTEhAAtf.png`（通过 `public/style.css` 里的 `--bg-image` 引用）。两种换法：

1. **直接替换文件**：把新图片放到 `public/` 下，然后改 `--bg-image` 指向它（如 `url("my-wallpaper.jpg")`）。
2. **调遮罩/透明度**：在 `public/style.css` 的 `:root` 里改这几个变量：

```css
--bg-image: url("BHIEEDIFJCEID-CXJTEhAAtf.png");
--bg-overlay-top: rgba(14, 17, 22, 0.38);    /* 图片上方的暗色遮罩（上） */
--bg-overlay-bottom: rgba(14, 17, 22, 0.66); /* 图片上方的暗色遮罩（下） */
--glass-blur: 12px;                          /* 毛玻璃模糊强度：越大，水珠里的「清晰窗口」反差越强 */
--panel: rgba(21, 26, 33, 0.72);             /* 侧边栏/顶栏/输入区面板透明度 */
```

调大 `--bg-overlay-*` 的 alpha 值 → 背景图更暗、文字更清晰；调小 `--panel` 的 alpha 值 → 面板更透，背景图更明显。

### 毛玻璃 + 雨滴

壁纸上方有一层毛玻璃（`#glass`，噪点纹理 + `backdrop-filter` 模糊/饱和/提亮），还有一层会不断滑落的雨滴（`#rain` / `.drop`）。

**水滴为什么能看清背景**：每颗水珠直接绘制和页面同一张、`fixed` 定位的壁纸（`background-attachment: fixed`），并和页面背景居中对齐，所以水珠处是**锐利的原图**，周围则是毛玻璃模糊——和真水滴在磨砂玻璃上的效果一致。（`backdrop-filter` 做不到这点，因为它只能采样已经被磨砂层模糊过的画面。）

- **想要壁纸更清晰** → 把 `--glass-blur` 调小（如 `3px`，甚至 `0px`）。
- **想要水珠的「清晰窗口」更明显 / 毛玻璃感更强** → 把 `--glass-blur` 调大（如 `16px`、`20px`）。
- **水珠形状/大小/数量/水痕**：在 `public/app.js` 的 `initRain()` 里改 `count`、`w`、`h`、`trail`、`duration`。
- **雨滴运动**：`public/style.css` 的 `@keyframes rainfall / rainfall2 / rainfall3`（三套不同的「粘滞—滑动」节奏，随机分配给每颗雨滴）。注意：为保持水珠与背景对齐，运动用 `top`/`margin-left` 而不是 `transform`。
- **系统开了「减少动态效果」** 时会自动隐藏雨滴（`prefers-reduced-motion`）。

> 小提示：这张图是 518×290 的小图，用 `cover` 铺满大屏会被放大。想要真正清晰建议换更大的图；或把 `html, body` 背景里的 `cover` 改成 `contain`（完整显示、四周留黑）、`auto`（原始尺寸）或 `repeat`（平铺）。

## 安全说明

本工具在本地运行，等于把 `pi` 的完整能力（含 `bash` 执行）暴露给浏览器 UI。默认只监听 `127.0.0.1`。**不要**把它绑定到公网或不可信网络；如需局域网访问，请自行加认证/反向代理，并意识到这是给本机用户的高权限工具。

## 参考

- pi 官方文档：`node_modules/@earendil-works/pi-coding-agent/README.md`
- RPC 协议：`docs/rpc.md`，SDK：`docs/sdk.md`，扩展：`docs/extensions.md`
