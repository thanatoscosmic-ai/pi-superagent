import type { Agent, AgentMessage, AgentTool } from '@earendil-works/pi-agent-core'
import type { Candidate, Ticket } from '../core/index.ts'
import type { RoleModel } from '../policy.ts'

export interface AgentOptions {
  systemPrompt: string
  tools?: AgentTool[]
  messages?: AgentMessage[]
  cwd?: string
  roleModel?: RoleModel | null
}

export type AgentFactory = (options: AgentOptions) => Agent

export interface RuntimeConfig {
  stateDir: string
  repositoryDirectory: string
  allowShell?: boolean
  maxTurns?: number
  agentFactory?: AgentFactory
  assess?: (candidate: Candidate) => Promise<import('../policy.ts').Assessment>
  onResult?: (ticket: Ticket) => void
}
