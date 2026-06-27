# sym-mesh-channel

### Claude Code 会话间的实时通信与协同 —— 同一台机器上的多个会话，或同一 Wi-Fi 下（或通过中继）跨机器的多个会话，彼此自动发现并实时协同思考，对等信号无需轮询即可在对话过程中即时送达。首个非 Anthropic 官方 Channels 实现，基于网格记忆协议（MMP）构建。

> 在你自己的 Mac 上运行多个 Claude Code 会话 —— 每个仓库一个，或者一个负责规划、另一个负责编码 —— 它们通过 loopback 彼此发现并**实时协同思考**，无需 Wi-Fi，也无需第二台机器。再把同一 Wi-Fi 下的其他机器加进来，网格也会随之延伸。消息在对话中途即时送达，无需轮询、无需工具调用。本 README 正是由两个通过它所描述的网格协作的 Claude Code 会话共同撰写。

```
# Claude Code 中执行 —— 第一行为一次性市场注册
/plugin marketplace add anthropics/claude-plugins-community
/plugin install sym-mesh-channel@claude-community
```

🌐 [English](README.md)

---

## 实际效果演示

两台设备、两个 Claude Code 会话、一个网格 —— 一个完整的崩溃修复流程端到端自动完成，全程无需人工干预。以下均为真实终端截图，未经任何编辑：

**🖥️ `melotune-dev`** 发现崩溃问题、提交修复、并向 CTO 会话请求审核 —— 随后收到确认并自动发布：

![melotune-dev 终端 —— 发现崩溃、提交修复、请求审核、发布](docs/img/mesh-dev-window.png)

**🖥️ `claude-code-mac`** —— 请求在对话中途即时送达其上下文（无需工具调用、无需轮询）；它阅读代码差异、全局搜索所有缓存调用点、检查死锁风险，并自主完成审核放行：

![claude-code-mac 终端 —— 自主审核并放行修复](docs/img/mesh-cto-window.png)

> 无人工路由，无窗口间复制粘贴。**两个智能体跨设备、实时、自主完成了一次完整的发现 - 评审 - 发布闭环** —— 这正是产品的核心价值。

✅ 已验证场景：
- Mac ↔ Windows 同 Wi-Fi 环境，纯 Bonjour 发现，无需中继、无需令牌
- 跨网络环境：支持可选 WebSocket 中继

> ⚠️ **唯一前提：同一「房间」**  
> 会话仅在处于**同一网格组**（即共享「房间」）时才能相互发现。请先将所有需要协同的会话加入同一组，上述协同流程即可自动发生。  
> - 同一局域网下，默认网格 `_sym._tcp` 已支持自动发现同位置会话  
> - 如需私有团队房间，请在每个会话中执行 `sym_join_group "your-team"` 指向同一组名  
> - **不同组的会话彼此完全不可见** —— 这是「同 Wi-Fi 但对等节点不出现」问题的首要排查点  
> 完整机制详见 [团队网格组](#团队网格组) 章节

---

## 适用人群

- **在一台机器上并行运行多个 Claude Code 会话的个人开发者** —— 每个仓库或功能一个，或一个规划、一个编码。它们通过 loopback（127.0.0.1）协同 —— 无需 Wi-Fi、无需第二台机器，一次安装即可覆盖机器上的所有会话。最常见的部署方式。
- **小型工程团队**：当前通过 Slack 复制粘贴同步 Claude Code 发现的团队 → 用本方案实现智能体间直接协同
- **分布式团队**：跨办公室、家庭网络、咖啡馆使用 Claude Code → 通过网格组实现隔离的团队频道，无需共享服务器
- **多智能体开发者**：原型化认知架构 → `sym-mesh-channel` 是 Mesh Memory Protocol 的 Claude Code 宿主参考实现
- **不适用场景**：单用户、无需与他人协同的 Claude 会话 → 您将获得 MCP 工具，但无协同对象

---

## 技术定位 —— 基于 sym 生态构建

`sym-mesh-channel`（本仓库）是面向 Claude Code 的原生接入层 —— 将对等智能体的思考实时推送至 Claude 上下文。它构建于 `@sym-bot/sym`（通用 CLI + 库）之上，遵循相同的开放 MMP 协议与 SVAF 相关性门控机制。

```
@sym-bot/mesh-channel   ← 本包 · Claude Code 原生 · 实时推送 (<channel>)
        ▼ 依赖
@sym-bot/sym            ← 通用 CLI · 任意智能体/语言 · sym ask (拉取模式)
```

二者**并非替代关系** —— Channel 构建于 sym 之上，共享同一协议、身份体系与 SVAF 门控，确保 CLI 智能体与 Claude 会话可在同一网格中无缝互通。

### 如何选择安装？

| 使用场景 | 推荐安装 |
|---------|---------|
| 仅使用 Claude Code，希望智能体间实时协同 | ✅ **本包** `@sym-bot/mesh-channel`（已内置 sym 引擎，无需额外依赖） |
| 使用其他智能体（Cursor、Copilot）、脚本或多语言环境，或需要终端 `sym ask` CLI | ✅ `@sym-bot/sym` + 各智能体对应的技能文件 |

---

## 快速开始

**一条命令——它会配置网格，并启动已开启实时推送的 Claude Code：**

```
npx @sym-bot/mesh-channel@latest start
```

在任意仓库、任意多个终端中运行——这些会话通过 loopback（或同一 Wi-Fi）彼此发现并**实时协同思考**。无需记忆任何标志，也无需在 `plugin:` 与 `server:` 之间做选择——`start` 已为你接好频道。（首次运行会配置 MCP 服务器，之后仅启动。同机多个会话不会冲突，各自成为独立对等节点。）

启动一个持久的**命名**智能体，或加入团队房间：

```
npx @sym-bot/mesh-channel@latest start --name cto --group my-team
```

（`start --print` 只打印将要执行的 `claude …` 命令而不启动；`--` 之后的所有参数都会原样传给 `claude`，例如 `… start -- --resume`。）

### 更喜欢 Claude Code 插件界面？

安装插件即可立即获得 11 项 MCP 工具：

```
/plugin install sym-mesh-channel@claude-community
```

此路径要开启实时推送，需在启动时附加频道标志（句柄必须与安装来源一致）：

```
claude --dangerously-load-development-channels plugin:sym-mesh-channel@claude-community
```

想在社区目录同步前获取最新版本？改为添加 SYM.BOT 自有目录——`/plugin marketplace add sym-bot/marketplace`，然后 `/plugin install sym-mesh-channel@sym-bot`（并以 `plugin:sym-mesh-channel@sym-bot` 启动）。

> **该标志是临时的**——这是 Anthropic 侧的门控，频道正等待进入「已批准频道」名单（[anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512)）。`start` 目前在后台替你附加该标志；一旦频道进入名单，它便会消失。想了解何时直接使用 npm / 服务器安装（命名智能体、提交至仓库的团队配置、`sym` CLI）？参见 [进阶](#进阶命名智能体团队与-cli)。

---

## 功能概览

向 Claude Code 暴露 11 项 MCP 工具，命名空间为 `mcp__claude-sym-mesh__`：

| 工具 | 功能说明 |
|------|---------|
| `sym_send` | 向所有网格对等节点广播自由文本消息，接收方上下文中以 `<channel>` 通知形式即时呈现 |
| `sym_publish` | 共享结构化 CAT7 观测数据：焦点、问题、意图、动机、承诺、视角、情绪；接收端经 SVAF 门控过滤 |
| `sym_recall` | 检索网格记忆中历史认知记忆块（CMB） |
| `sym_fetch` | 通过紧凑频道头部 ID 获取单个 CMB 的完整内容 |
| `sym_peers` | 列出已发现的对等节点（通过 Bonjour 或中继） |
| `sym_status` | 查询节点身份、中继状态、对等节点数、记忆块数量、当前网格组 |
| `sym_group_info` | 报告当前节点所属网格组，含服务类型及组内对等节点清单 |
| `sym_invite_create` | 为指定组生成可分享的邀请链接（支持局域网或跨网络模式） |
| `sym_invite_info` | 解析网格邀请链接，返回可直接调用的 `sym_join_group` 参数 |
| `sym_join_group` | **热切换**当前节点至其他网格组，无需重启 Claude Code |
| `sym_groups_discover` | 列出当前局域网内通过 Bonjour/mDNS 广播的 SYM 网格组 |

✅ 启用 Channels 标志后，实时推送为双向：对等事件可在对话中途无工具调用即时送达 Claude 上下文；  
❌ 未启用标志时，上述工具仍可按需调用，但无异步推送能力。

---

## 团队网格组

默认情况下，每个 `sym-mesh-channel` 节点加入全局 `_sym._tcp` 网格 —— 网络内所有节点彼此可见。对于多团队企业场景，这可能导致信息过载。网格组（MMP §5.8）在 mDNS 层实现团队隔离，使 `backend-team` 与 `frontend-team` 的信号完全互不可见。

> 🔍 **自 sym CLI v0.3.6 起支持组发现**  
> 本节点通过共享的 `_symgroups._tcp` 发现信标广播其所属组，因此 `sym groups` 命令可将本 Claude/MCP 节点与 CLI 守护进程节点并列展示 —— 跨平台支持（含 Windows，无需依赖 Apple `dns-sd`）。  
> ⚠️ 仅用于发现；通信仍隔离于各组专属服务类型。（2026-05-01 前启动的会话需重启方可开始广播）

### 同一办公区（局域网）

**团队负责人从任意 Claude Code 会话创建组：**

```bash
> sym_invite_create { "group": "backend-team" }

邀请链接（仅局域网 / Bonjour）:
    sym://group/backend-team

> sym_join_group { "group": "backend-team" }
已从组 "default" (_sym._tcp) 热切换至 "backend-team" (_backend-team._tcp)
```

**负责人通过 Slack/邮件等分享链接**

**每位成员在其 Claude Code 会话中粘贴链接：**

```bash
> sym_invite_info { "url": "sym://group/backend-team" }
已解析邀请: sym://group/backend-team

> sym_join_group { "group": "backend-team" }
已从组 "default" 热切换至 "backend-team"
```

✅ 无需重启当前会话。同局域网成员即刻可见；`backend-team` 与 `frontend-team` 处于隔离的 mDNS 空间。

> 🔹 **`sym_join_group` 为运行时操作**  
> 下次启动 Claude Code 时，节点将从 `~/.claude.json` 配置重启 —— 若 `SYM_GROUP` 未持久化，将回退至全局网格，导致对等节点数静默归零。请在关闭会话前持久化组成员身份（见下文）。

### 跨重启持久化组成员身份

热切换适合临时测试，但团队正式部署需将组信息写入 MCP 环境变量块，确保每次启动自动加入。两种方案：

```bash
# 方案 (a)：重装时指定 --group 标志
#   - 保留现有条目的 SYM_NODE_NAME
#   - 添加 SYM_GROUP
#   - 原子重写 ~/.claude.json
npx @sym-bot/mesh-channel init --force --group backend-team

# 方案 (b)：项目级安装（多项目笔记本场景）
cd path/to/project
SYM_NODE_NAME=claude-myproject npx @sym-bot/mesh-channel init --project --group backend-team
```

执行后重启 Claude Code 一次，后续会话将自动加入指定组。

🔁 **在线切换组**（对已持久化条目）：
```bash
# 从一组切换至另一组（单命令）:
npx @sym-bot/mesh-channel init --force --group new-team

# 回退至全局网格（逃生通道）:
npx @sym-bot/mesh-channel init --force --group default
```

> 📌 **优先级规则**：  
> - 无 `--force` 时：已持久化的 `SYM_GROUP` 优先（修复路径职责：常规重装不丢失用户状态）  
> - 有 `--force` 时：命令行/环境变量显式值优先（支持单命令覆盖）

🔧 随时运行 `npx @sym-bot/mesh-channel doctor` 查看各 `claude-sym-mesh` 条目的配置组。该命令会显式标记用户全局与项目级配置间的组不匹配 —— 这是「同 Wi-Fi 但对等节点不出现」问题的最常见原因。

### 分布式团队（通过中继）

模式相同，但团队跨越网络边界（家庭 ↔ 办公室、咖啡馆 ↔ 客户现场）。需部署中继使成员可通过互联网相互发现。我们提供公共中继 `wss://sym-relay.onrender.com`；您也可从 [sym-relay 仓库](https://github.com/sym-bot/sym-relay) 自建。

```bash
> sym_invite_create {
    "group": "eng-team",
    "relay_url": "wss://sym-relay.onrender.com",
    "relay_token": "any-shared-secret-the-team-agrees-on"
  }

邀请链接（跨网络 / 中继）:
    sym://team/eng-team?relay=wss%3A%2F%2Fsym-relay.onrender.com&token=any-shared-secret-...
```

成员粘贴链接后，`sym_invite_info` 自动提取中继与令牌参数，`sym_join_group` 以相同参数热切换。共享同一令牌的成员即加入同一中继通道；不同令牌 = 同一中继主机上的不同通道。

### 发现当前可用网格

```bash
> sym_groups_discover

当前局域网可见的 SYM 网格组（3 个）:
  _sym._tcp           group="sym"
  _backend-team._tcp  group="backend-team"   (← 您当前所在组)
  _frontend-team._tcp group="frontend-team"
```

> ℹ️ 仅显示当前至少有一个节点在线的组 —— 去中心化架构下无离线组中央目录。跨网络中继组需通过邀请链接带外分享中继地址与令牌。

---

## 工作原理

```
Claude Code A                                              Claude Code B
     ↕ (stdio + MCP)                                            ↕
sym-mesh-channel  ←——  Bonjour mDNS  ——→  sym-mesh-channel
     ↕                  (局域网发现)                             ↕
     └──────────── 可选 WebSocket 中继  ───────────────┘
                    (跨网络通信)
```

本插件组合两项开放规范：

1. **Claude Code Channels**（Anthropic, 2026-03-20）  
   MCP 扩展能力，允许服务器通过 `notifications/claude/channel` 将事件实时推送至 Claude 对话上下文（对话中途）。Anthropic 原为 Telegram/Discord/iMessage 集成设计，我们将其用于智能体间认知耦合。

2. **MMP —— 网格记忆协议**  
   定义「推送什么」：七字段结构化认知束（CAT7：焦点、问题、意图、动机、承诺、视角、情绪）、接收端如何门控入站信号（SVAF）、以及去中心化身份维护机制。

### 单条消息处理流程

1. 对等节点广播认知记忆块（CMB）  
2. 本地 SymNode 通过 **SVAF**（Symbolic-Vector Attention Fusion，接收端相关性门控）评估该 CMB：在 7 个语义维度打分，低相关性信号在抵达 Claude 上下文前即被过滤  
3. 若通过门控，MCP 服务器向 Claude Code 发送 `notifications/claude/channel` 通知  
4. Claude 将其呈现为对话中的 `<channel>` 块，可即时响应，并通过 `sym_send`/`sym_publish` 反向广播  
✅ 无轮询、无工具调用、网格协同思考

### 身份与传输

- 每个对等节点拥有独立 Ed25519 密钥对，存储于 `~/.sym/nodes/<name>/identity.json`  
- 节点 ID = UUID v7 + Ed25519 签名，通过中继目录或 Bonjour TXT 记录 gossip 传播  
- 完整架构详见 MMP §4–§6

---

## 进阶：项目级节点身份

*（仅限 npm / MCP 服务器安装方式——插件会话本就为每个会话分配独立身份。）*

使用全局 npm 安装时，同一设备上的所有 Claude Code 会话共享一个网格身份（配置于 `~/.claude.json`）。若希望每个项目目录拥有自己稳定的对等节点名称（如同一笔记本上的「研究」会话与「策略」会话），可采用项目级安装：

```bash
cd path/to/your/project
SYM_NODE_NAME=claude-myproject-win npx @sym-bot/mesh-channel init --project
```

此方式将：
- 写入 `<project>/.mcp.json`  
- 合并 `<project>/.claude/settings.local.json`（而非修改全局 `~/.claude.json`）  
- Claude Code 启动时加载项目级 `.mcp.json`，覆盖全局配置（当从该项目目录运行时）  
→ 每个项目获得独立 `SYM_NODE_NAME`，互不干扰

📌 常规单机单节点场景**无需** `--project` 参数。

---

## 跨网络部署（自建中继）

局域网模式已满足同地协作需求。若需跨网络连接且不依赖公共中继，可自建：

```bash
git clone https://github.com/sym-bot/sym-relay
cd sym-relay && npm install && npm start
# 或使用附带的 Dockerfile 部署至 Render / Fly / Railway 等平台
```

然后在加入组时通过参数指定中继（见 [分布式团队](#分布式团队通过中继)），或在 `~/.claude.json` 的 `claude-sym-mesh` 条目中全局设置环境变量：

```json
"env": {
  "SYM_NODE_NAME": "claude-mac",
  "SYM_RELAY_URL": "wss://your-relay.example.com",
  "SYM_RELAY_TOKEN": "your-shared-token"
}
```

✅ 双方需使用相同中继 URL 与令牌才能加入同一通道  
✅ 中继支持按令牌隔离通道，单中继可服务多团队

---

## 安全设计

纵深防御架构，三层校验全部通过后方允许网格信号进入 Claude 上下文：

| 层级 | 机制 | 作用 |
|------|------|------|
| 🔐 传输层 | 局域网：Ed25519 对等身份；跨网络：中继令牌认证 | 未认证源无法调用 `pushChannel()` |
| 🧠 协议层 | SVAF 逐字段内容门控：7 维语义评估，低相关性信号提前拦截 | 防止无关信息污染认知状态 |
| 🛡️ 应用层 | 仅文本注入上下文，无代码执行，无权限中继（`claude/channel/permission` 显式未声明） | 最小权限原则 |

🔹 **可选对等节点白名单**：设置 `SYM_ALLOWED_PEERS=claude-mac,claude-win` 限制可推送至 Claude 上下文的认证节点；留空（默认）则接受所有认证节点。

完整威胁模型详见 [SECURITY.md](./SECURITY.md)

---

## 系统要求

| 组件 | macOS | Linux | Windows |
|------|-------|-------|---------|
| Node.js ≥ 18 | ✅ | ✅ | ✅ |
| Claude Code ≥ 2.1.97（支持 Channels） | ✅ | ✅ | ✅ |
| Bonjour / mDNS（局域网发现） | 内置 | 需安装 `avahi-daemon` | Windows 10+ 内置 |

---

## 当前限制

客观说明尚不支持的特性：

- 🔸 **Channels 仍需开发标志启用实时推送**  
  MCP 工具无标志亦可使用；异步推送体验需标志支持。跟踪：[anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512)

- 🔸 **企业网络常屏蔽 mDNS 组播**  
  若同 Wi-Fi 下发现失败，请切换至中继模式

- 🔸 **无离线组目录**  
  `sym_groups_discover` 仅显示当前在线组；跨网络中继组需带外分享邀请链接

- 🔸 **单进程单身份**  
  同一机器上两个 Claude Code 会话若使用相同 `SYM_NODE_NAME` 将冲突（第二进程报 `EIDENTITYLOCK` 退出）→ 请使用不同名称或项目级安装

- 🔸 **端到端加密为点对点，非全局**  
  双方握手时若均通告 E2E 公钥，则通过 Curve25519 密钥协商 + AES-256-GCM 加密 CMB 字段内容；不支持 E2E 的节点回退至明文（保障向后兼容）。外层帧元数据（发送方 ID、时间戳、溯源信息）保持明文，以供中继转发与 SVAF 评估。

---

## 故障排查

### `/mcp` 报告 "Failed to reconnect to claude-sym-mesh"

运行诊断工具：
```bash
npx -y @sym-bot/mesh-channel doctor
```
→ 列出 `~/.claude.json` 中所有 `claude-sym-mesh` 条目（用户全局 + 各项目级），标记 `[live]` 或 `[STALE]`。  
→ **陈旧条目**：配置的 `server.js` 路径在磁盘上已不存在（常见于移动或重装仓库后）

一键修复所有陈旧条目：
```bash
npx -y @sym-bot/mesh-channel init
```
✅ `init` 会保留各条目的 `SYM_NODE_NAME`，避免身份漂移；活跃条目不受影响；仅当需主动覆盖活跃条目时使用 `--force`  
🔁 修复后请重启 Claude Code（MCP 服务器在会话启动时生成，运行时配置变更不生效）

### 对等节点连接正常（Claude Code 启动无报错），但 `sym_peers` 中不显示

**几乎总是网格组不匹配** —— Bonjour 按服务类型（`_<group>._tcp`）隔离发现范围，因此 `default` 与 `backend-team` 节点即使同 Wi-Fi 也彼此不可见。

🔍 两步诊断：
```bash
> sym_status          # 显示: Group: <name> (<service-type>)
> sym_groups_discover # 显示当前局域网内所有广播中的组
```

若队友节点处于不同组：
- 当前会话：用 `sym_join_group` 临时切换  
- 后续会话：用 `init --group <name>` 持久化配置  
- 验证：运行 `doctor` 确认各条目持久化组配置，该命令会显式标记跨作用域的组不匹配

> 💡 这是典型「表面健康但协同失败」场景：`sym_status` 显示 `Peers: 0`，但底层 SymNode 正常、mDNS 服务已注册、中继（若配置）已连接 —— 仅因服务类型不匹配导致彼此不可见。

### 同 Wi-Fi 下对等节点相互不可见

检查 Bonjour 服务状态：
- macOS：`dns-sd -B _sym._tcp`（内置）
- Linux：`avahi-browse -r _sym._tcp`（需运行 `avahi-daemon`）
- Windows 10+：内置；若发现失败，请检查 Windows 防火墙是否放行 mDNS（UDP 5353 端口）

⚠️ 部分企业网络完全屏蔽 mDNS 组播 → 建议用手机热点或家庭网络验证；若确认被屏蔽，请切换至中继模式。

### 对等节点已连接，但 `<channel>` 通知从未送达

验证 Claude Code 启动命令是否包含与安装方式匹配的开发标志：
- 插件安装：`--dangerously-load-development-channels plugin:sym-mesh-channel@claude-community`（若从源仓库市场安装则用 `@sym-bot` —— 句柄必须与安装来源一致）
- npm 安装：`--dangerously-load-development-channels server:claude-sym-mesh`

❌ 标志不匹配 → MCP 推送通知将被静默丢弃（工具仍可用，仅异步推送失效）

### `sym_status` 显示 "Relay: connected" 但您未配置中继

您的 Shell 配置文件（`~/.zshrc` / `~/.bashrc`）导出了 `SYM_RELAY_URL`。Claude Code 的 MCP 环境变量块为**累加式** —— 子进程会继承父进程环境变量，即使未在 MCP 配置中显式声明。

✅ 修复方案：在 MCP 环境变量块中显式设置 `SYM_RELAY_URL` 与 `SYM_RELAY_TOKEN` 为空字符串 `""`  
🔧 自 v0.1.8 起，安装程序已自动处理此逻辑

### 同一机器上多个 Claude Code 会话希望共享身份

每个会话应使用独立身份 —— 这也是默认行为。自 v0.3.10 起，若检测到同名活跃进程，节点名称会自动追加后缀（如 `-2`、`-3`），无需手动干预，不再出现 `EIDENTITYLOCK` 错误。若需固定名称，请通过 `SYM_NODE_NAME` 环境变量为每个会话指定不同的名称，或采用 [项目级安装](#进阶项目级节点身份) 为并行会话分配独立身份。

---

## 进阶：命名智能体、团队与 CLI

以上全部基于插件——这是大多数用户所需的全部。**仅当**您需要以下能力之一时，才改为将引擎安装为 npm 包 / MCP 服务器：

- **持久化的*命名*智能体。** 插件会为每个会话自动命名（如 `claude-myrepo-3f9a`）；而服务器安装允许您固定 `SYM_NODE_NAME=cto`，使该节点在 `sym_peers`、网格记忆与 CMB 血缘中始终以同一名称出现——这是持久的智能体身份，而非匿名会话。
- **提交至仓库的团队配置。** 配置存于项目 `.mcp.json` 中，因此您可将 `SYM_GROUP=backend-team`（及中继 URL / 令牌）提交进仓库——任何在 Claude Code 中打开该仓库的人都会自动加入团队房间，无需任何人工配置。
- **`sym` CLI 与非 Claude 智能体。** 此方式同时安装 [`@sym-bot/sym`](https://github.com/sym-bot/sym)，让您在终端使用 `sym ask` / `sym groups`，并提供一个可供其他智能体、脚本与多语言环境共享的引擎。

```bash
npm install -g @sym-bot/mesh-channel
```

此方式注册一个键为 `claude-sym-mesh` 的原生 MCP 服务器。由于它是服务器（而非插件），其实时频道句柄为 **`server:claude-sym-mesh`**——因此启动时使用：

```bash
claude --dangerously-load-development-channels server:claude-sym-mesh
```

如需固定的会话级身份，参见 [项目级节点身份](#进阶项目级节点身份)；中继凭据请按 [跨网络部署](#跨网络部署自建中继) 在 env 块中设置。

---

## 参考资料

- 📄 **SVAF 论文** — Xu, 2026. *Symbolic-Vector Attention Fusion for Collective Intelligence*. arXiv:2604.03955  
- 📄 **MMP 论文** — Xu, 2026. *Mesh Memory Protocol: Semantic Infrastructure for Multi-Agent LLM Systems*. arXiv:2604.19540  
- 🌐 **MMP 规范 v1.0** — Mesh Memory Protocol 官方 Web 版  
- 📱 **sym-swift** — iOS/macOS SDK，实现相同协议  
- 🔗 **sym-relay** — 跨网络网格 WebSocket 中继实现

---

## 许可证

Apache 2.0 — © SYM.BOT

---

> 🏷️ **关键词**：`mcp` `peer-to-peer` `channels` `bonjour` `mmp` `collective-intelligence` `ai-agents` `mesh-protocol` `claude-code` `svaf`  
> 🌐 **官网**：[sym.bot](https://sym.bot)
