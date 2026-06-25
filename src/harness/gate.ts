// src/harness/gate.ts

export type Complexity = "simple" | "complex"

const COMPLEX_PATTERNS = [
  /implement|refactor|fix|add\s+|create\s+|build\s+|write\s+/i,
  /change|update|modify|remove|delete|migrate/i,
  /make\s+\w+\s+(do|work|handle|support|use)/i,
]

const SIMPLE_PATTERNS = [
  /^(what|who|where|when|why|how)\s/i,
  /^(explain|describe|show|tell|list)\s/i,
  /\?$/,
]

export class ComplexityGate {
  classify(firstUserMessage: string): Complexity {
    const text = firstUserMessage.trim().toLowerCase()

    for (const p of COMPLEX_PATTERNS) {
      if (p.test(text)) return "complex"
    }

    for (const p of SIMPLE_PATTERNS) {
      if (p.test(text)) return "simple"
    }

    return "complex"
  }
}
