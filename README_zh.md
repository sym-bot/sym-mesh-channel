# sym-mesh-channel

### Claude Code 会话间的实时通信与协同 —— 不同设备上的会话通过 Bonjour 局域网（或中继）自动发现彼此，实时协同思考，对等信号无需轮询即可在对话过程中即时送达。首个非 Anthropic 官方 Channels 实现，基于网格记忆协议（MMP）构建。

> 两台不同设备上的 Claude Code 会话通过 Wi-Fi 自动发现、组建网格，**实时协同思考**。消息无需工具调用、无需轮询，即可在对话中途即时送达。本 README 正是由两个通过该网格协同工作的 Claude Code 会话共同撰写完成。

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

- **小型工程团队**：当前通过 Slack 复制粘贴同步 Claude Code 发现的团队 → 用本方案实现智能体间直接协同
- **分布式团队**：跨办公室、家庭网络、咖啡馆使用 Claude Code → 通过网格组实现隔离的团队频道，无需共享服务器
- **多智能体开发者**：原型化认知架构 → `sym-mesh-channel` 是 Mesh Memory Protocol 的官方 Claude Code 宿主参考实现
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

通过插件市场安装（Claude Code 中执行）：

```
/plugin marketplace add anthropics/claude-plugins-community
/plugin install sym-mesh-channel@claude-community
```

想直接获取源仓库的最新版本？可改为将其添加为独立市场：

```
/plugin marketplace add sym-bot/marketplace
/plugin install sym-mesh-channel@sym-bot
```

源仓库跟踪 `main` 分支，版本通常领先于社区目录（社区目录的固定版本需待下次同步才更新）。**无论从哪个市场安装，下方频道标志中的 `@<市场>` 必须与安装来源一致** —— 社区目录用 `@claude-community`，源仓库用 `@sym-bot`。两者不匹配是启动频道标志时出现 `plugin … not installed` 的首要原因。

即可获得全部 **11 项 MCP 工具 —— 无需标志、无需 npm、无需其他配置**，且**一次安装覆盖本机所有 Claude Code 会话**：每个会话自动获得独立身份，随时加入网格。第一行命令为一次性市场注册。

### 实时推送（`<channel>` 体验）

上述工具为拉取模式。若要实现**对等消息在对话中途无工具调用即时送达** —— 即上文截图所示的「Claude 与网格协同思考」体验 —— 还需在启动时附加以下标志（目前 Anthropic 频道允许名单审核中）：

```bash
claude --dangerously-load-development-channels plugin:sym-mesh-channel@claude-community
```

（若从源仓库市场安装，请改用 `plugin:sym-mesh-channel@sym-bot` —— `@<市场>` 必须与安装来源一致。）

🔹 标志为临时要求，待频道通过 Anthropic 允许名单审核后即可去除（详见 [anthropics/claude-plugins-official#1512](https://github.com/anthropics/claude-plugins-official/issues/1512)）。

---

## 功能概览

向 Claude Code 暴露 11 项 MCP 工具，命名空间为 `mcp__claude-sym-mesh__`：

| 工具 | 功能说明 |
|------|---------|
| `sym_send` | 向所有网格对等节点广播自由文本消息，接收方上下文中以 `<channel>` 通知形式即时呈现 |
| `sym_observe` | 共享结构化 CAT7 观测数据：焦点、问题、意图、动机、承诺、视角、情绪；接收端经 SVAF 门控过滤 |
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
4. Claude 将其呈现为对话中的 `<channel>` 块，可即时响应，并通过 `sym_send`/`sym_observe` 反向广播  
✅ 无轮询、无工具调用、网格协同思考

### 身份与传输

- 每个对等节点拥有独立 Ed25519 密钥对，存储于 `~/.sym/nodes/<name>/identity.json`  
- 节点 ID = UUID v7 + Ed25519 签名，通过中继目录或 Bonjour TXT 记录 gossip 传播  
- 完整架构详见 MMP §4–§6

---

## 进阶：项目级节点身份

默认情况下，同一设备上的所有 Claude Code 会话共享一个网格身份（全局配置于 `~/.claude.json`）。若您需在同一笔记本上并行运行多个项目会话（如「研究」与「策略」会话），且希望它们在网格中呈现为独立对等节点，可采用项目级安装：

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

## 其他安装方式

### 通过 Claude Code 插件市场

```bash
/plugin marketplace add anthropics/claude-plugins-community
/plugin install sym-mesh-channel@claude-community
claude --dangerously-load-development-channels plugin:sym-mesh-channel@claude-community
```

✅ 适合偏好插件市场进行安装/更新管理的用户  
✅ 对大多数用户，npm 路径更简洁直接

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
