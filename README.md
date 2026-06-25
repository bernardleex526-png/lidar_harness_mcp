# LiDAR Harness MCP

**增量验证引擎 — 作为可插拔 MCP 中间件，用于 Claude Code、OpenCode 等代码代理。**

受 SLAM 建图中 PGO（位姿图优化）启发，LiDAR Harness 提供四层验证架构，在不增加每轮上下文负担的前提下，确保 agent 输出的代
码质量。

---

## 核心概念

大多数代码 agent 的工作方式是：每轮修改代码后，全量运行 `tsc` / `lint`，把**全部**错误注入回上下文。这在 10 轮以上的任务中
会浪费大量 token。

LiDAR Harness 的 PGO（Pose Graph Optimization）引擎采用 **增量机制**：

```
首次:  tsc --noEmit  → 发现 7 个错误  → 全部注入
第 2 轮: 修复了 3 个 → 剩余 4 个已知，0 个新增 → 不注入，agent 不被打断
第 3 轮: 引入了 1 个新错误 → 只注入这 1 个新错误
...
```

**效果**：上下文占用减少 60-80%，agent 不会被已知错误反复打断。

---

## 功能

| 工具 | 用途 | 典型时机 |
|------|------|---------|
| `harness_init` | 初始化项目，自动检测 typecheck/lint 命令，建立基线 | 会话开始一次 |
| `harness_classify` | 判断任务是 "simple"（问答）还是 "complex"（编码） | 用户发消息后 |
| `harness_pgo` | **增量检查** — 只返回新出现的 typecheck/lint 错误 | 每轮修改代码后 |
| `harness_review` | 多视角代码审查（安全扫描、正确性、风格） | 每 3 轮 |
| `harness_reset` | 重置 PGO 状态 | 切换任务时 |

### 架构

```
Model completes a turn (modifies code)
       │
       ▼
  ┌──────────────────────┐
  │ Layer 0: Gate        │  ─── 简单任务（问答/解释）→ 跳过后续所有验证
  └────────┬─────────────┘
           ▼
  ┌──────────────────────┐
  │ Layer 2: PGO         │  ─── typecheck + lint，增量注入（核心功能）
  └────────┬─────────────┘
           ▼
  ┌──────────────────────┐
  │ Layer 3: MultiReview │  ─── 安全/正确性/风格（每 3 轮）
  └──────────────────────┘
```

---

## 快速开始

### 前提

- Node.js >= 18
- 一个 MCP 客户端（Claude Code、OpenCode、或任何 MCP 兼容工具）

### 安装

```bash
git clone https://github.com/bernardleex526-png/lidar_harness_mcp.git
cd lidar_harness_mcp
npm install
npm run build
```

### 集成到 Claude Code

在项目 `.claude/settings.local.json` 中添加：

```json
{
  "mcpServers": {
    "lidar-harness": {
      "command": "node",
      "args": ["/path/to/lidar_harness_mcp/dist/index.js"]
    }
  }
}
```

重启 Claude Code 后，5 个工具会自动可用。

### 集成到 OpenCode

OpenCode 也支持 MCP Server，配置方法与 Claude Code 类似。在 OpenCode 的 MCP 配置中添加：

```json
{
  "mcpServers": {
    "lidar-harness": {
      "command": "node",
      "args": ["/path/to/lidar_harness_mcp/dist/index.js"]
    }
  }
}
```

### 直接测试

MCP Server 通过 stdio 通信，可以用 JSON 直接测试：

```bash
# 列出工具
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js

# 初始化项目
echo '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"harness_init","arguments":{"cwd":"/your/project","ta
skMessage":"fix the build"}}}' | node dist/index.js
```

---

## 工作流程示例

### 在 Claude Code 中的典型用法

```
User: 帮我重构这个模块
Claude: [调用 harness_init 初始化，检测到 tsc 和 lint]
Claude: [完成任务，调用 harness_pgo 检查]
Claude: → 编译通过，无新错误
Claude: 重构完成。

User: 添加一个 API 端点
Claude: [修改代码，调用 harness_pgo]
Claude: → 发现 2 个新类型错误，需要修复
Claude: [修复错误，再次调用 harness_pgo]
Claude: → 0 个新错误，编译通过
```

### 循环检测（可选）

PGO 还内置了单调收敛保证：
- `shownErrors` 集合只增不减
- 每轮只展示 agent 未见过的新错误
- 当 `unseenSigs.length === 0` 时停止，数学保证必然收敛

---

## 自动检测支持的语言

| 语言 | 检测文件 | 默认命令 |
|------|---------|---------|
| TypeScript | `tsconfig.json` | `npx tsc --noEmit`, `npm run lint`（如果有 lint script） |
| Go | `go.mod` | `go vet ./...` |
| Rust | `Cargo.toml` | `cargo check` |
| Java (Maven) | `pom.xml` | `mvn compile -q` |
| Java (Gradle) | `build.gradle` | `gradle build -q` |

也可以手动传入任意验证命令。

---

## 项目结构

```
lidar-harness-mcp/
├── src/
│   ├── index.ts           # MCP Server 入口，工具注册
│   └── harness/
│       ├── pgo.ts         # PGO 增量验证引擎
│       ├── review.ts      # 多视角代码审查
│       └── gate.ts        # 复杂度门控
├── package.json
├── tsconfig.json
└── README.md
```

零运行时依赖（除 `@modelcontextprotocol/sdk` 外）。

---

## License

MIT
