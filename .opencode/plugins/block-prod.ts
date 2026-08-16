import type { Plugin } from "@opencode-ai/plugin"

const GUARDRAILS = /(^|[\\/])(AGENTS\.md|opencode\.json|\.opencode[\\/].*)$/i
const PROD_PUSH = /git\s+push\b[^\n]*\b(prod|refs\/heads\/prod|:prod\b)/i
const FORCE_PUSH = /git\s+push\b[^\n]*(-f|--force\b|--force-with-lease)/i
const PROTECTION = /gh\s+api\b[^\n]*(protection|production-branch|environments?|deployments)/i
const WRANGLER_PROD = /wrangler\s+pages\s+deploy\b[^\n]*(--branch\s+prod\b|--production\b)/i
const DESTRUCTIVE_RM =
  /(^|\b|&&\s*)(rm|del|Remove-Item|git\s+rm)\b[^\n]*(AGENTS\.md|opencode\.json|\.opencode)/i

function isProdBranch(cmd: string): boolean {
  if (/\bprod\b/.test(cmd)) return true
  if (WRANGLER_PROD.test(cmd)) return true
  return false
}

export const BlockProd: Plugin = async () => {
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && output?.args?.command) {
        const cmd: string = output.args.command

        if (PROD_PUSH.test(cmd)) {
          throw new Error("Blocked: pushing to prod is not allowed from this agent.")
        }
        if (FORCE_PUSH.test(cmd)) {
          throw new Error("Blocked: force-push is not allowed from this agent.")
        }
        if (PROTECTION.test(cmd)) {
          throw new Error("Blocked: modifying branch protection is not allowed from this agent.")
        }
        if (WRANGLER_PROD.test(cmd)) {
          throw new Error("Blocked: production deploys via wrangler are not allowed from this agent.")
        }
        if (DESTRUCTIVE_RM.test(cmd)) {
          throw new Error("Blocked: removing guardrail files is not allowed from this agent.")
        }
      }

      if (
        input.tool === "edit" &&
        output?.args?.filePath &&
        GUARDRAILS.test(output.args.filePath)
      ) {
        const cmd = (output.args.command ?? output.args.filePath) as string
        if (DESTRUCTIVE_RM.test(cmd)) {
          throw new Error("Blocked: removing guardrail files is not allowed from this agent.")
        }
      }
    },
  }
}
