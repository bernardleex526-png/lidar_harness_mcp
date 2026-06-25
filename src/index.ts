// src/index.ts

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { PGO } from "./harness/pgo.js"
import { MultiReview } from "./harness/review.js"
import { ComplexityGate } from "./harness/gate.js"
import { existsSync, readFileSync } from "fs"
import path from "path"

const VERSION = "0.1.1"

// ── Session State ──────────────────────────────────────────────
// A single MCP process typically serves one client session.
// We keep a PGO instance per cwd so state persists across tool calls.

interface SessionState {
  pgo: PGO | null
  gate: ComplexityGate
  complexity: "simple" | "complex" | "unknown"
  initialized: boolean
  pgoConfigured: boolean
}

let state: SessionState = {
  pgo: null,
  gate: new ComplexityGate(),
  complexity: "unknown",
  initialized: false,
  pgoConfigured: false,
}

// ── Helpers ────────────────────────────────────────────────────

function detectCommands(cwd: string): { commands: string[]; label: string } {
  const autoDetected: string[] = []
  let label = ""

  // Detect TypeScript
  if (existsSync(path.join(cwd, "tsconfig.json"))) {
    try {
      const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf-8"))
      const scripts = pkg.scripts || {}
      if (scripts.typecheck) {
        autoDetected.push(`npm run typecheck`)
        label = "typecheck"
      } else if (scripts.tsc) {
        autoDetected.push(`npm run tsc`)
        label = "tsc"
      }
      if (scripts.lint) {
        autoDetected.push(`npm run lint`)
        label = label ? "typecheck + lint" : "lint"
      }
    } catch {
      autoDetected.push("npx tsc --noEmit")
      label = "tsc"
    }
  } else if (existsSync(path.join(cwd, "go.mod"))) {
    autoDetected.push("go vet ./...")
    label = "go vet"
  } else if (existsSync(path.join(cwd, "Cargo.toml"))) {
    autoDetected.push("cargo check")
    label = "cargo check"
  } else if (existsSync(path.join(cwd, "pom.xml"))) {
    autoDetected.push("mvn compile -q")
    label = "mvn compile"
  } else if (existsSync(path.join(cwd, "build.gradle"))) {
    autoDetected.push("gradle build -q")
    label = "gradle build"
  }

  return { commands: autoDetected, label }
}

function formatErrors(errors: string[]): string {
  if (errors.length === 0) return ""
  const grouped: Record<string, string[]> = { PGO: [] }
  for (const e of errors) grouped.PGO.push(e)
  return Object.entries(grouped)
    .map(([cat, msgs]) => `## ${cat}\n\n${msgs.map(m => `- \`${m}\``).join("\n")}`)
    .join("\n\n")
}

// ── MCP Server ─────────────────────────────────────────────────

const server = new Server(
  { name: "lidar-harness", version: VERSION },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "harness_init",
      description: `Initialize LiDAR Harness for a project: detect typecheck/lint commands, establish baselines, classify task complexity.

Call this ONCE at the start of a session. Provide the user's task message for complexity classification.

Returns: session info with detected commands, complexity, and PGO readiness.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory (default: cwd of MCP process)" },
          taskMessage: { type: "string", description: "User's task description for complexity classification" },
          commands: {
            type: "array",
            items: { type: "string" },
            description: "Override auto-detected commands (e.g. [\"npx tsc --noEmit\", \"npm run lint\"])",
          },
        },
      },
    },
    {
      name: "harness_classify",
      description: `Classify a task as "simple" (question, explanation) or "complex" (implementation, refactor, fix).

Simple tasks skip PGO and review overhead entirely. Call before starting work.`,
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string", description: "User's task description" },
        },
        required: ["message"],
      },
    },
    {
      name: "harness_pgo",
      description: `Run incremental PGO (Pose Graph Optimization) typecheck/lint verification.

KEY CONCEPT: Only returns NEW errors not seen in previous calls. If you call it 10 times, each call only shows errors that appeared SINCE the last call. When it returns 0 new errors, the code compiles cleanly.

Use after each agent turn that modifies code to verify incrementally.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory" },
        },
      },
    },
    {
      name: "harness_review",
      description: `Run multi-perspective code review: security scan (secrets in git diff), correctness (uncommitted changes), style (lint results).

Call periodically (e.g. every 3rd turn) to catch issues the agent might miss.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory" },
          scanGitDiff: {
            type: "boolean",
            description: "Scan git diff for hardcoded secrets/keys (default: false)",
          },
          files: {
            type: "array",
            items: { type: "string" },
            description: "Limit review to specific files (optional)",
          },
        },
      },
    },
    {
      name: "harness_reset",
      description: `Reset PGO baselines and shown-errors state for a fresh start.

Call when switching to a new task or after significant dependency changes.`,
      inputSchema: {
        type: "object",
        properties: {
          cwd: { type: "string", description: "Working directory" },
          commands: {
            type: "array",
            items: { type: "string" },
            description: "Re-detect or override commands (optional)",
          },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  switch (name) {
    // ── init ─────────────────────────────────────────────
    case "harness_init": {
      const cwd = (args?.cwd as string) ?? process.cwd()
      const taskMessage = (args?.taskMessage as string) ?? ""
      const overrideCommands = args?.commands as string[] | undefined

      // Detect commands
      const detected = overrideCommands?.length
        ? { commands: overrideCommands, label: "custom" }
        : detectCommands(cwd)

      // Initialize PGO
      if (detected.commands.length > 0) {
        state.pgo = new PGO({ commands: detected.commands, cwd })
        await state.pgo.establishBaseline()
        state.pgoConfigured = true
      } else {
        state.pgo = null
        state.pgoConfigured = false
      }

      // Classify complexity
      if (taskMessage) {
        state.complexity = state.gate.classify(taskMessage)
      }

      state.initialized = true

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            version: VERSION,
            cwd,
            pgoConfigured: state.pgoConfigured,
            pgoCommands: detected.commands,
            pgoLabel: detected.label,
            complexity: state.complexity,
            message: state.pgoConfigured
              ? `PGO configured with ${detected.commands.length} command(s): ${detected.commands.join(", ")}`
              : "No typecheck/lint commands detected. PGO will be skipped.",
          }, null, 2),
        }],
      }
    }

    // ── classify ─────────────────────────────────────────
    case "harness_classify": {
      const message = args?.message as string
      if (!message) {
        return { content: [{ type: "text", text: "Error: message is required" }] }
      }

      const result = state.gate.classify(message)
      state.complexity = result

      return {
        content: [{ type: "text", text: result }],
      }
    }

    // ── pgo ──────────────────────────────────────────────
    case "harness_pgo": {
      if (!state.pgo) {
        // Attempt lazy init
        const cwd = (args?.cwd as string) ?? process.cwd()
        const detected = detectCommands(cwd)
        if (detected.commands.length > 0) {
          state.pgo = new PGO({ commands: detected.commands, cwd })
          await state.pgo.establishBaseline()
          state.pgoConfigured = true
        }
      }

      if (!state.pgo) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ newErrors: [], totalUniqueErrors: 0, converged: true, message: "No typecheck/lint commands configured. PGO skipped." }),
          }],
        }
      }

      const result = await state.pgo.run()

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            newErrors: result.newErrors,
            totalUniqueErrors: result.totalUniqueErrors,
            converged: result.converged,
            formatted: result.newErrors.length > 0
              ? `[Harness PGO] Found ${result.newErrors.length} new issue(s):\n\`\`\`\n${result.newErrors.join("\n")}\n\`\`\``
              : "[Harness PGO] No new issues. Code looks clean.",
          }),
        }],
      }
    }

    // ── review ───────────────────────────────────────────
    case "harness_review": {
      const cwd = (args?.cwd as string) ?? process.cwd()
      const scanGitDiff = (args?.scanGitDiff as boolean) ?? false
      const files = args?.files as string[] | undefined

      const review = new MultiReview()
      const findings = await review.review({ cwd, scanGitDiff, files })

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            count: findings.length,
            findings,
            formatted: findings.length > 0
              ? `[Harness Review] ${findings.length} finding(s):\n${findings.map(f => `  [${f.category}] ${f.message}`).join("\n\n")}`
              : "[Harness Review] No issues found.",
          }),
        }],
      }
    }

    // ── reset ────────────────────────────────────────────
    case "harness_reset": {
      const cwd = (args?.cwd as string) ?? process.cwd()
      const overrideCommands = args?.commands as string[] | undefined

      const detected = overrideCommands?.length
        ? { commands: overrideCommands, label: "custom" }
        : detectCommands(cwd)

      if (detected.commands.length > 0) {
        state.pgo = new PGO({ commands: detected.commands, cwd })
        await state.pgo.establishBaseline()
        state.pgoConfigured = true
      } else {
        state.pgo = null
        state.pgoConfigured = false
      }

      state.complexity = "unknown"
      state.initialized = true

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            message: "PGO state reset. Baselines re-established.",
            commands: detected.commands,
          }),
        }],
      }
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }] }
  }
})

// ── Startup ────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`[LiDAR Harness MCP] v${VERSION} running (stdio transport)`)
}

main().catch((err) => {
  console.error("[LiDAR Harness MCP] Fatal:", err)
  process.exit(1)
})
