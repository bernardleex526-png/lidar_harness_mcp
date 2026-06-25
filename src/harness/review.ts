// src/harness/review.ts

import { execSync } from "child_process"
import { readFileSync, existsSync } from "fs"
import path from "path"

export interface ReviewFinding {
  category: "security" | "correctness" | "style"
  message: string
  file?: string
}

export interface ReviewOptions {
  cwd: string
  /** If set, limits review to these files only */
  files?: string[]
  /** Whether to run security scans on git diff */
  scanGitDiff?: boolean
}

export class MultiReview {
  private gitAvailable: boolean | null = null

  private checkGit(cwd: string): boolean {
    if (this.gitAvailable !== null) return this.gitAvailable
    try {
      execSync("git --version", { encoding: "utf-8", timeout: 3_000 })
      execSync("git rev-parse --git-dir", { cwd, encoding: "utf-8", timeout: 3_000 })
      this.gitAvailable = true
    } catch {
      this.gitAvailable = false
    }
    return this.gitAvailable
  }

  async review(opts: ReviewOptions): Promise<ReviewFinding[]> {
    const findings: ReviewFinding[] = []

    findings.push(...this.securityScan(opts))
    findings.push(...this.correctnessCheck(opts))
    findings.push(...this.styleCheck(opts))

    return findings
  }

  private scanDiffLines(lines: string[]): ReviewFinding[] {
    const findings: ReviewFinding[] = []
    const secretPatterns = [
      /(['"])?(api[_-]?key|api[_-]?secret|password|token|secret|credential)(['"])?\s*[:=]\s*['"][^'"]+['"]/i,
      /(sk-[A-Za-z0-9]{20,})/,
      /(ghp_[A-Za-z0-9]{36,})/,
    ]
    for (const line of lines) {
      for (const pattern of secretPatterns) {
        if (pattern.test(line)) {
          findings.push({
            category: "security",
            message: `Potential secret/key detected: ${line.trim().slice(0, 120)}`,
          })
        }
      }
    }
    return findings
  }

  private securityScan(opts: ReviewOptions): ReviewFinding[] {
    if (!opts.scanGitDiff) return []
    if (!this.checkGit(opts.cwd)) return []
    const findings: ReviewFinding[] = []

    try {
      const unstaged = execSync("git diff --unified=0", { cwd: opts.cwd, encoding: "utf-8", timeout: 10_000 })
      const lines = unstaged.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"))
      findings.push(...this.scanDiffLines(lines))
    } catch { /* skip */ }

    try {
      const staged = execSync("git diff --cached --unified=0", { cwd: opts.cwd, encoding: "utf-8", timeout: 10_000 })
      const lines = staged.split("\n").filter(l => l.startsWith("+") && !l.startsWith("+++"))
      findings.push(...this.scanDiffLines(lines))
    } catch { /* skip */ }

    return findings
  }

  private correctnessCheck(opts: ReviewOptions): ReviewFinding[] {
    if (!this.checkGit(opts.cwd)) return []
    const findings: ReviewFinding[] = []

    try {
      const modified = execSync("git status --porcelain", { cwd: opts.cwd, encoding: "utf-8", timeout: 5_000 })
      if (modified.trim()) {
        const count = modified.trim().split("\n").length
        if (count > 5) {
          findings.push({
            category: "correctness",
            message: `There are ${count} uncommitted files. Consider committing logical units separately.`,
          })
        }
      }
    } catch { /* skip */ }

    return findings
  }

  private styleCheck(opts: ReviewOptions): ReviewFinding[] {
    const pkgPath = path.join(opts.cwd, "package.json")
    if (!existsSync(pkgPath)) return []

    try {
      const pkg = readFileSync(pkgPath, "utf-8")
      const pkgJson = JSON.parse(pkg)
      if (pkgJson.scripts?.lint) {
        const output = execSync(pkgJson.scripts.lint, { cwd: opts.cwd, encoding: "utf-8", timeout: 120_000 })
        if (output.trim()) {
          return [{ category: "style", message: `Lint results:\n${output.trimEnd()}` }]
        }
      }
    } catch {
      return [{ category: "style", message: "Lint check failed with errors." }]
    }
    return []
  }
}
