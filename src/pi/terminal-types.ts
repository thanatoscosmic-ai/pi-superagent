import type { AgentEvent } from '@earendil-works/pi-agent-core'
import type { DomainEvent, Ticket } from '../core/index.ts'

/** One earlier exchange, replayed when a session resumes. */
export interface TranscriptEntry {
  key: string
  role: 'user' | 'assistant' | 'note'
  text: string
}

export interface TerminalSnapshot {
  mode: 'tickets' | 'coding'
  cwd: string
  model: string
  shell: boolean
  paused: boolean
  tickets: Ticket[]
  evaluating: number
  queued: number
  pendingReplies: number
  running: number
  attention: number
  health: Record<string, { state: string; detail: string }>
  /** Conversation so far, oldest first; only what a person or the agent actually said. */
  history: TranscriptEntry[]
  /** Token usage of the agent the person is talking to, and how full its context window is. */
  usage: { input: number; output: number; cacheRead: number; total: number; context: number; window: number }
}

export interface TerminalController {
  snapshot(): TerminalSnapshot
  submit(text: string): Promise<void>
  command(text: string): Promise<string | void>
  interrupt(): Promise<void>
  close(): Promise<void>
  subscribe(listener: (event: TerminalEvent) => void): () => void
}

export type TerminalEvent =
  | { type: 'snapshot'; value: TerminalSnapshot }
  | { type: 'domain'; value: DomainEvent }
  | { type: 'agent'; ticketId: string; value: AgentEvent }
  | { type: 'notice'; text: string }
  | { type: 'reply'; text: string; ticketId?: string }
