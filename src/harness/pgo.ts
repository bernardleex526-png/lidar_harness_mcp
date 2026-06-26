// src/harness/pgo.ts

import { execSync, type ExecSyncOptions } from "child_process"
import { existsSync } from "fs"
import path from "path"

export interface PGOConfig {
  /** Commands to run (e.g. ["npx tsc --noEmit", "npm run lint"]) */
  commands: string[]
  /** Working directory */
  cwd: string
  /** Known-safe prefixes (only commands starting with these run) */
  safePrefixes?: string[]
}

const DEFAULT_SAFE = [
  "tsc", "eslint", "biome", "deno check",
  "bun tsc", "bunx eslint", "bunx biome",
  "npm run", "npm t",
  "pnpm", "yarn",
  "npx tsc", "npx eslint", "npx biome",
  "node dist/index.js --version",
  "go build", "go vet", "cargo check", "cargo build",
  "mvn compile", "gradle build",
]

export interface PGOResult {
  /** New errors found this run (empty = no issues) */
  newErrors: string[]
  /** Running total of unique errors shown */
  totalUniqueErrors: number
  /** Whether the incremental PGO has converged (no new errors in last run) */
  converged: boolean
  /** True when error explosion triggered auto-reset (kidnapped-robot recovery) */
  autoReset: boolean
}

/** If new errors in one run exceed this, treat as kidnapped-robot: re-baseline and signal reset */
const AUTO_RESET_THRESHOLD = 15

export class PGO {
  private baselines = new Map<string, string>()
  private shownErrorSets = new Map<string, Set<string>>()
  private safePrefixes: string[]
  private cwd: string
  private commands: string[]
  private lastRunHadNewErrors = false

  constructor(config: PGOConfig) {
    this.cwd = config.cwd
    this.commands = config.commands.filter(cmd =>
      (config.safePrefixes ?? DEFAULT_SAFE).some(p => cmd.trim().startsWith(p))
    )
    this.safePrefixes = config.safePrefixes ?? DEFAULT_SAFE
  }

  /** Run initial typecheck/lint to establish baseline. Call once before the agent starts. */
  async establishBaseline(): Promise<void> {
    for (const cmd of this.commands) {
      const output = this.runCommandSync(cmd)
      this.baselines.set(cmd, output)
      this.shownErrorSets.set(cmd, new Set())
    }
  }

  /** Run incremental check. Returns only NEW errors not seen before. */
  async run(): Promise<PGOResult> {
    const allNewErrors: string[] = []

    for (const cmd of this.commands) {
      const current = this.runCommandSync(cmd)
      const sigs = this.computeErrorSigs(current, cmd)
      const shown = this.shownErrorSets.get(cmd)

      if (!shown) continue

      for (const sig of sigs) {
        if (!shown.has(sig)) {
          shown.add(sig)
          allNewErrors.push(sig)
        }
      }
    }

    // Kidnapped-robot recovery: error explosion means PGO state is stale
    // (e.g. dependency upgrade, tsconfig change). Re-baseline and signal reset.
    if (allNewErrors.length > AUTO_RESET_THRESHOLD) {
      await this.establishBaseline()
      return {
        newErrors: allNewErrors,
        totalUniqueErrors: allNewErrors.length,
        converged: false,
        autoReset: true,
      }
    }

    this.lastRunHadNewErrors = allNewErrors.length > 0

    return {
      newErrors: allNewErrors,
      totalUniqueErrors: this.totalUniqueShown(),
      converged: this.totalUniqueShown() > 0 && !this.lastRunHadNewErrors,
      autoReset: false,
    }
  }

  private totalUniqueShown(): number {
    let total = 0
    for (const set of this.shownErrorSets.values()) total += set.size
    return total
  }

  /** Normalize errors to stable signatures */
  private computeErrorSigs(output: string, cmd: string): string[] {
    const baseline = this.baselines.get(cmd) ?? ""

    return output
      .split("\n")
      .map(l => l.trimEnd())
      .filter(l => l.length > 0 && !baseline.includes(l))
      .map(l => {
        let sig = l.replace(/:\d+:\d+/g, ":N:N")  // line:col → :N:N
        sig = sig.replace(/:\d+/g, ":N")            // line → :N
        sig = sig.replace(/error TS\d+/g, "error TS_NNN")
        sig = sig.replace(/(error|warning|info)\s+/gi, "")
        // Normalize paths (Unix and Windows)
        sig = sig.replace(/\/[^\s:]+\.\w+/g, "<file>")
        sig = sig.replace(/\\([^\s:]+)\.\w+/g, "<file>")
        return sig
      })
      .filter(s => s.length > 10)
  }

  private runCommandSync(cmd: string): string {
    const shell = process.platform === "win32"
      ? (process.env.COMSPEC || "cmd.exe")
      : undefined
    const opts: ExecSyncOptions = {
      cwd: this.cwd,
      encoding: "utf-8",
      timeout: 120_000,
      ...(shell ? { shell } as ExecSyncOptions : {}),
    }
    try {
      return execSync(cmd, opts) as string
    } catch (err: any) {
      return err.stderr ?? err.stdout ?? ""
    }
  }
}
