// src/harness/pgo.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest"
import { PGO } from "./pgo.js"

// Stub execSync so tests never shell out
vi.mock("child_process", () => ({
  execSync: vi.fn(),
}))

import { execSync } from "child_process"
const mockExec = vi.mocked(execSync)

function makePGO(baselineOutput = "") {
  mockExec.mockReturnValue(baselineOutput as any)
  const pgo = new PGO({ commands: ["npx tsc --noEmit"], cwd: "/fake" })
  return pgo
}

describe("PGO — incremental baseline", () => {
  beforeEach(() => vi.clearAllMocks())

  it("returns no new errors on first clean run after baseline", async () => {
    const pgo = makePGO("")
    await pgo.establishBaseline()

    mockExec.mockReturnValue("" as any)
    const r = await pgo.run()
    expect(r.newErrors).toHaveLength(0)
    expect(r.converged).toBe(false) // totalUniqueShown = 0
    expect(r.autoReset).toBe(false)
  })

  it("surfaces only errors not in baseline", async () => {
    const baseline = "src/a.ts:1:1 - error TS2304: Cannot find name 'x'."
    const pgo = makePGO(baseline)
    await pgo.establishBaseline()

    // New error not in baseline
    mockExec.mockReturnValue(
      (baseline + "\nsrc/b.ts:5:3 - error TS2322: Type 'string' is not assignable.") as any
    )
    const r = await pgo.run()
    expect(r.newErrors).toHaveLength(1)
    expect(r.newErrors[0]).toContain("TS_NNN") // normalized
    expect(r.autoReset).toBe(false)
  })

  it("converged = true once seen errors stop growing", async () => {
    const pgo = makePGO("")
    await pgo.establishBaseline()

    const err = "src/x.ts:2:2 - error TS2304: Cannot find name 'foo'."
    mockExec.mockReturnValue(err as any)
    await pgo.run() // first run: 1 new error

    mockExec.mockReturnValue(err as any)
    const r2 = await pgo.run() // same error, already shown
    expect(r2.newErrors).toHaveLength(0)
    expect(r2.converged).toBe(true)
    expect(r2.autoReset).toBe(false)
  })
})

describe("PGO — kidnapped-robot auto-reset (fix 1)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("auto-resets and sets autoReset=true when new errors > threshold", async () => {
    const pgo = makePGO("")
    await pgo.establishBaseline()

    // 16 distinct new errors (> AUTO_RESET_THRESHOLD = 15)
    const explosion = Array.from({ length: 16 }, (_, i) =>
      `src/f${i}.ts:1:1 - error TS200${i}: Something went wrong ${i}.`
    ).join("\n")

    mockExec.mockReturnValue(explosion as any)
    const r = await pgo.run()

    expect(r.autoReset).toBe(true)
    expect(r.newErrors.length).toBeGreaterThan(15)
    expect(r.converged).toBe(false)
  })

  it("after auto-reset, next run starts fresh from new baseline", async () => {
    const pgo = makePGO("")
    await pgo.establishBaseline()

    const explosion = Array.from({ length: 16 }, (_, i) =>
      `src/f${i}.ts:1:1 - error TS200${i}: Something.`
    ).join("\n")

    // Trigger auto-reset; establishBaseline will re-run and record explosion as new baseline
    mockExec.mockReturnValue(explosion as any)
    await pgo.run()

    // Same explosion is now the baseline — next run should show 0 new errors
    mockExec.mockReturnValue(explosion as any)
    const r2 = await pgo.run()
    expect(r2.autoReset).toBe(false)
    expect(r2.newErrors).toHaveLength(0)
  })
})

describe("PGO — output schema stability (fix 2)", () => {
  beforeEach(() => vi.clearAllMocks())

  it("result always contains the same top-level keys regardless of state", async () => {
    const pgo = makePGO("")
    await pgo.establishBaseline()

    const EXPECTED_KEYS = ["newErrors", "totalUniqueErrors", "converged", "autoReset"].sort()

    mockExec.mockReturnValue("" as any)
    const r1 = await pgo.run()
    expect(Object.keys(r1).sort()).toEqual(EXPECTED_KEYS)

    mockExec.mockReturnValue("src/x.ts:1:1 - error TS2304: Cannot find 'x'." as any)
    const r2 = await pgo.run()
    expect(Object.keys(r2).sort()).toEqual(EXPECTED_KEYS)
  })
})
