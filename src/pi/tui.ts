import {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Editor,
  Loader,
  Markdown,
  ProcessTerminal,
  Text,
  TuiMainScreen,
  isKeyRelease,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import type { Ticket } from '../core/index.ts'
import type { TerminalController, TerminalEvent, TerminalSnapshot } from './terminal-types.ts'

export type { Terminal } from '@earendil-works/pi-tui'

const identity = (text: string) => text
const style = (open: number, close = 39) => (text: string) => `\x1b[${open}m${text}\x1b[${close}m`
const cyan = style(36)
const green = style(32)
const red = style(31)
const yellow = style(33)
const dim = style(2, 22)
const bold = style(1, 22)
const markdownTheme: MarkdownTheme = {
  heading: text => bold(cyan(text)),
  link: cyan,
  linkUrl: dim,
  code: yellow,
  codeBlock: cyan,
  codeBlockBorder: dim,
  quote: dim,
  quoteBorder: cyan,
  hr: dim,
  listBullet: cyan,
  bold,
  italic: style(3, 23),
  strikethrough: style(9, 29),
  underline: style(4, 24),
  highlightCode(code, lang) {
    if (!/^(?:[cm]?[jt]sx?|javascript|typescript|json|py|python|sh|bash|zsh)$/i.test(lang ?? '')) return code.split('\n').map(cyan)
    return code.split('\n').map(line => line.replace(
      /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*|#.*)|(\b(?:const|let|var|function|return|if|else|class|import|export|from|async|await|def|for|while|true|false|null|None|True|False)\b)|(\b\d+(?:\.\d+)?\b)/g,
      (token, string, comment, keyword) => string ? green(token) : comment ? dim(token) : keyword ? cyan(token) : yellow(token),
    ))
  },
}
const editorTheme: EditorTheme = {
  borderColor: cyan,
  selectList: {
    selectedPrefix: cyan,
    selectedText: bold,
    description: dim,
    scrollInfo: dim,
    noMatch: dim,
  },
}
const commands = [
  { name: 'tickets', description: '工单列表和历史' },
  { name: 'ticket', description: '选择工单', argumentHint: '<id>' },
  { name: 'pause', description: '暂停调度' },
  { name: 'resume', description: '恢复调度' },
  { name: 'stop', description: '停止工单', argumentHint: '<id>' },
  { name: 'retry', description: '重试工单', argumentHint: '<id>' },
  { name: 'mode', description: '切换模式', argumentHint: 'coding|tickets' },
  { name: 'shell', description: 'Shell 开关', argumentHint: 'on|off' },
  { name: 'new', description: '新建会话' },
  { name: 'tools', description: '展开或折叠工具输出', argumentHint: 'expand|collapse' },
  { name: 'help', description: '命令帮助' },
  { name: 'status', description: '当前状态' },
  { name: 'exit', description: '退出' },
]
const outputLimit = 16_000
const secretName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE/i

function stringify(value: unknown): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return '[无法显示的数据]'
  }
}

function outputText(value: unknown): string {
  if (value && typeof value === 'object' && 'content' in value && Array.isArray(value.content)) {
    return value.content.map(part => part?.type === 'text' ? String(part.text) : `[${part?.type ?? '内容'}]`).join('\n')
  }
  return stringify(value)
}

function messageText(message: AgentMessage): string {
  if (!('content' in message)) return ''
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return ''
  return message.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('')
}

function createSanitizer() {
  const secrets = new Set<string>()
  return (value: string, streaming = false): string => {
    for (const [name, secret] of Object.entries(process.env)) {
      if (secretName.test(name) && secret) {
        secrets.add(secret)
        secrets.add(encodeURIComponent(secret))
        secrets.add(encodeURI(secret))
      }
    }
    const values = [...secrets].sort((a, b) => b.length - a.length)
    let text = value
    for (const secret of values) text = text.split(secret).join('[凭据已隐藏]')
    text = stripTerminalSequences(text)
      .replace(/(?:\x1b[\]P_X^]|[\x90\x98\x9d-\x9f])[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)/g, '')
      .replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b[^\n]*/g, '')
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, '')
      .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|credentials?|authorization|cookie|token|secret)["']?\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, '$1[凭据已隐藏]')
    for (const secret of values) text = text.split(secret).join('[凭据已隐藏]')
    if (streaming) {
      let keep = 0
      for (const secret of values) {
        for (let size = 1; size < secret.length && size <= text.length; size++) {
          if (text.endsWith(secret.slice(0, size))) keep = Math.max(keep, size)
        }
      }
      if (keep) text = text.slice(0, -keep)
    }
    return text.replace(/\t/g, '    ')
  }
}

type Sanitize = ReturnType<typeof createSanitizer>

function safeRendered(text: string, sanitize: Sanitize): string {
  let marker = '\ue000'
  while (text.includes(marker)) marker += '\ue000'
  const sequences: string[] = []
  const protectedText = text.replace(/\x1b\[(?:(?:0|1|2|3|4|9|22|23|24|27|29|3[1-7]|39|49)(?:;(?:0|1|2|3|4|9|22|23|24|27|29|3[1-7]|39|49))*)?m/g, sequence => {
    sequences.push(sequence)
    return `${marker}${sequences.length - 1}${marker}`
  })
  return sanitize(protectedText).replace(new RegExp(`${marker}(\\d+)${marker}`, 'g'), (_, index) => sequences[Number(index)] ?? '')
}

function safeLines(lines: string[], width: number, sanitize: Sanitize): string[] {
  return lines.map(line => {
    const safe = safeRendered(line, sanitize)
    return visibleWidth(safe) > width ? `${truncateToWidth(safe, width, '')}\x1b[0m` : safe
  })
}

class SafeMarkdown extends Markdown {
  private source = ''
  streaming = false

  constructor(private sanitize: Sanitize, text: string, color?: (text: string) => string) {
    super('', 1, 1, markdownTheme, color ? { color } : undefined, { renderLatex: false })
    this.source = text
  }

  override setText(text: string): void {
    this.source = text
  }

  override render(width: number): string[] {
    super.setText(this.sanitize(this.source, this.streaming))
    return safeLines(super.render(width), width, this.sanitize)
  }
}

class SafeText extends Text {
  constructor(private sanitize: Sanitize, private source: () => string, private color = identity) {
    super('', 0, 0)
  }

  override render(width: number): string[] {
    this.setText(this.sanitize(this.source()).split('\n').map(line => line.startsWith('report:') ? yellow(line) : this.color(line)).join('\n'))
    return safeLines(super.render(width), width, this.sanitize)
  }
}

class SafeEditor extends Editor {
  constructor(tui: TuiMainScreen, private sanitize: Sanitize) {
    super(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 6 })
  }

  override render(width: number): string[] {
    const lines = super.render(width)
    const text = this.getExpandedText()
    const safe = this.sanitize(text)
    if (safe !== text) {
      const content = new Text(safe, 1, 0).render(width)
      if (content.length) content[content.length - 1] += CURSOR_MARKER
      return [safeRendered(lines[0] ?? '', this.sanitize), ...content, safeRendered(lines.at(-1) ?? '', this.sanitize)]
    }
    return lines.map(line => line.split(CURSOR_MARKER).map(part => safeRendered(part, this.sanitize)).join(CURSOR_MARKER))
  }
}

class ToolCard implements Component {
  name = ''
  args = ''
  output = ''
  state = '开始'
  expanded = false
  truncated = false

  constructor(readonly ticketId: string, readonly id: string, private sanitize: Sanitize) {}

  setOutput(value: unknown): void {
    const text = this.sanitize(outputText(value), this.state === '开始')
    this.truncated = text.length > outputLimit
    this.output = text.slice(0, outputLimit)
  }

  invalidate(): void {}

  render(width: number): string[] {
    const output = this.expanded ? this.output : this.output.split('\n').slice(0, 6).join('\n').slice(0, 700)
    const hidden = output.length < this.output.length
    const text = `\n工具 ${this.name} · ${this.state} · ${this.ticketId} · ${this.id}\nargs/path: ${this.args}\n${output}${hidden ? '\n[collapsed · /tools expand]' : ''}${this.truncated ? '\n[输出已截断，最多 16000 字符]' : ''}\n`
    const color = this.state === '完成' ? green : this.state === '失败' ? red : cyan
    const styled = this.sanitize(text).split('\n').map(line => line.startsWith('工具 ') ? color(line) : line).join('\n')
    return safeLines(new Text(styled, 1, 0).render(width), width, this.sanitize)
  }
}

function ticketDetails(ticket: Ticket): string {
  const report = ticket.assignments.findLast(assignment => assignment.report)?.report
  return [
    `ticket ${ticket.id} · ${ticket.title} · ${ticket.ended?.outcome ?? 'open'}`,
    `mandate: ${stringify(ticket.mandate)}`,
    `scope: ${ticket.mandate.scope}`,
    `worktree: ${ticket.execution?.directory ?? '未分配'}`,
    `assignment: ${ticket.execution?.assignment ?? '未分配'}`,
    `report: ${report ? `${report.state} · ${report.summary}` : '暂无'}`,
    ...(ticket.attention ? [`attention: ${ticket.attention.question}`] : []),
  ].join('\n')
}

export async function runTerminal(
  controller: TerminalController,
  options: { terminal?: Terminal; initialPrompt?: string } = {},
): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)
  const sanitize = createSanitizer()
  const history = new Container()
  const waiting = new Container()
  const editor = new SafeEditor(tui, sanitize)
  const tools = new Map<string, ToolCard>()
  const activeMessages = new Map<string, { component: SafeMarkdown; text: string }>()
  const endedMessages = new Set<string>()
  const restored = new Map<string, SafeMarkdown>()
  const userEchoes = new Map<string, number>()
  const activeAgents = new Set<string>()
  let snapshot: TerminalSnapshot
  let selectedTicket: string | undefined
  let localBusy = 0
  let submitTail = Promise.resolve()
  let expanded = false
  let closing = false
  let interrupting = false
  let loader: Loader | undefined
  let unsubscribe: (() => void) | undefined
  let removeInput: (() => void) | undefined
  let finish = () => {}
  const done = new Promise<void>(resolve => { finish = resolve })

  const addMessage = (role: string, text: string, ticketId?: string) => {
    const message = new SafeMarkdown(sanitize, `${role}${ticketId ? ` · ${ticketId}` : ''}\n\n${text}`)
    history.addChild(message)
    return message
  }
  const refresh = (value?: TerminalSnapshot) => {
    if (closing) return
    snapshot = value ?? controller.snapshot()
    const busy = localBusy > 0 || activeAgents.size > 0 || snapshot.running > 0 || snapshot.evaluating > 0
    if (busy && !loader) {
      loader = new Loader(tui, cyan, dim, '等待执行 / 评估 · Ctrl+C / Escape 中断 · 可输入跟进或命令')
      waiting.addChild(loader)
    } else if (!busy && loader) {
      loader.stop()
      waiting.removeChild(loader)
      loader = undefined
    }
    tui.requestRender()
  }
  const restore = () => {
    for (const ticket of snapshot.tickets) {
      for (const input of ticket.inputs) {
        if (input.kind !== 'text' && input.kind !== 'note') continue
        const key = `${ticket.id}:input:${input.id}`
        const text = `历史 ${input.kind === 'text' ? 'user' : 'note'} · ${ticket.id}\n\n${input.text}`
        if (!restored.has(key)) {
          const component = new SafeMarkdown(sanitize, text)
          restored.set(key, component)
          history.addChild(component)
        } else restored.get(key)?.setText(text)
      }
      for (const assignment of ticket.assignments) {
        if (!assignment.report) continue
        const key = `${ticket.id}:report:${assignment.id}`
        const text = `历史 report · ${ticket.id} · ${assignment.report.state}\n\n${assignment.report.summary}`
        if (!restored.has(key)) {
          const component = new SafeMarkdown(sanitize, text, yellow)
          restored.set(key, component)
          history.addChild(component)
        } else restored.get(key)?.setText(text)
      }
    }
  }
  const notice = (value: unknown) => {
    if (!closing) {
      addMessage('notice', stringify(value))
      refresh()
    }
  }
  const handleMessage = (ticketId: string, message: AgentMessage, phase: 'start' | 'update' | 'end', delta?: string) => {
    if (message.role === 'user' && ticketId === 'dialogue') return
    if (message.role !== 'assistant' && message.role !== 'user') return
    const text = messageText(message)
    const fingerprint = `${ticketId}:${message.role}:${'timestamp' in message ? message.timestamp : ''}:${text}`
    if (phase === 'end' && endedMessages.has(fingerprint)) return
    if (message.role === 'user') {
      if (phase !== 'end') return
      endedMessages.add(fingerprint)
      const echoes = userEchoes.get(text) ?? 0
      if (echoes) userEchoes.set(text, echoes - 1)
      else addMessage('user', text, ticketId)
      return
    }
    if (phase === 'start') activeMessages.delete(ticketId)
    let active = activeMessages.get(ticketId)
    if (!active) {
      active = { component: addMessage('assistant', '', ticketId), text: '' }
      activeMessages.set(ticketId, active)
    }
    active.text = text || (delta ? active.text + delta : active.text)
    active.component.streaming = phase !== 'end'
    active.component.setText(`${ticketId === 'dialogue' ? 'assistant · 对话' : `assistant · ${ticketId}`}\n\n${active.text}${phase === 'end' && 'errorMessage' in message && message.errorMessage ? `\n${message.errorMessage}` : ''}`)
    if (phase === 'end') {
      endedMessages.add(fingerprint)
      activeMessages.delete(ticketId)
    }
  }
  const eventListener = (event: TerminalEvent) => {
    if (closing) return
    try {
      if (event.type === 'snapshot') {
        snapshot = event.value
        restore()
      } else if (event.type === 'notice' || event.type === 'reply') {
        addMessage(event.type === 'reply' ? 'assistant' : 'notice', event.text, event.type === 'reply' ? event.ticketId : undefined)
      } else if (event.type === 'domain') {
        addMessage('状态', `${event.value.type}\n${stringify(event.value.data)}`)
        snapshot = controller.snapshot()
        restore()
      } else {
        const value = event.value
        if (value.type === 'agent_start') activeAgents.add(event.ticketId)
        if (value.type === 'agent_end') {
          activeAgents.delete(event.ticketId)
          for (const message of value.messages) handleMessage(event.ticketId, message, 'end')
        }
        if (value.type === 'message_start') handleMessage(event.ticketId, value.message, 'start')
        if (value.type === 'message_update') {
          handleMessage(event.ticketId, value.message, 'update', value.assistantMessageEvent.type === 'text_delta' ? value.assistantMessageEvent.delta : undefined)
        }
        if (value.type === 'message_end') handleMessage(event.ticketId, value.message, 'end')
        if (value.type === 'tool_execution_start' || value.type === 'tool_execution_update' || value.type === 'tool_execution_end') {
          const key = `${event.ticketId}:${value.toolCallId}`
          let card = tools.get(key)
          if (!card) {
            card = new ToolCard(event.ticketId, value.toolCallId, sanitize)
            card.expanded = expanded
            tools.set(key, card)
            history.addChild(card)
          }
          card.name = sanitize(value.toolName)
          if ('args' in value) card.args = sanitize(stringify(value.args)).slice(0, 3000)
          if (value.type === 'tool_execution_end') {
            card.state = value.isError ? '失败' : '完成'
            card.setOutput(value.result)
          }
          if (value.type === 'tool_execution_update') card.setOutput(value.partialResult)
        }
      }
      refresh(event.type === 'snapshot' ? event.value : undefined)
    } catch (error) {
      notice(error)
    }
  }
  const submit = (value: string) => {
    if (closing) return
    const text = value.trim()
    if (!text) return
    editor.addToHistory(sanitize(text))
    if (text.startsWith('/')) {
      const [command, argument] = text.split(/\s+/)
      if (command === '/ticket') selectedTicket = argument
      if (command === '/tools') {
        expanded = argument === 'expand' || argument === 'on' ? true : argument === 'collapse' || argument === 'off' ? false : !expanded
        for (const card of tools.values()) card.expanded = expanded
        refresh()
        return
      }
      void (async () => {
        try {
          const result = await controller.command(text)
          if (result) notice(result)
        } catch (error) {
          notice(error)
        } finally {
          if (command === '/exit') {
            closing = true
            finish()
          } else refresh()
        }
      })()
      refresh()
      return
    }
    addMessage('user', text)
    userEchoes.set(text, (userEchoes.get(text) ?? 0) + 1)
    localBusy++
    refresh()
    submitTail = submitTail.then(async () => {
      try {
        if (!closing) await controller.submit(text)
      } catch (error) {
        notice(error)
      } finally {
        localBusy--
        refresh()
      }
    })
  }

  try {
    snapshot = controller.snapshot()
    tui.addChild(new SafeText(sanitize, () => `pi-superagent · ${snapshot.model}\ncwd: ${snapshot.cwd} · mode: ${snapshot.mode}\n`, cyan))
    tui.addChild(history)
    tui.addChild(new SafeText(sanitize, () => {
      const ticket = snapshot.tickets.find(item => item.id === selectedTicket)
        ?? snapshot.tickets.find(item => item.assignments.some(assignment => assignment.state === 'running'))
        ?? snapshot.tickets.find(item => item.attention)
        ?? snapshot.tickets[0]
      return ticket ? `\n${ticketDetails(ticket)}\n` : '\n当前 ticket: 无\n'
    }))
    tui.addChild(waiting)
    tui.addChild(editor)
    tui.addChild(new SafeText(sanitize, () => [
      `评估:${snapshot.evaluating} 运行:${snapshot.running} 队列:${snapshot.queued + Math.max(0, localBusy - 1)} 回写:${snapshot.pendingReplies} attention:${snapshot.attention}`,
      `paused:${snapshot.paused ? 'on' : 'off'} shell:${snapshot.shell ? 'on' : 'off'} · /help · /tools · Shift+Enter 多行`,
      ...Object.entries(snapshot.health).map(([name, health]) => `${name}: ${health.state} ${health.detail}`),
    ].join('\n')))
    const provider = new CombinedAutocompleteProvider(commands, snapshot.cwd)
    const autocomplete: AutocompleteProvider = {
      triggerCharacters: ['/', '@'],
      async getSuggestions(lines, row, col, request) {
        let result = await provider.getSuggestions(lines, row, col, request)
        if (!result) {
          const before = (lines[row] ?? '').slice(0, col)
          const at = before.match(/(?:^|\s)(@[^\s]*)$/)?.[1]
          if (at) {
            const index = col - at.length
            const paths = [...lines]
            paths[row] = `${before.slice(0, index)}${at.slice(1)}${(lines[row] ?? '').slice(col)}`
            const files = await provider.getSuggestions(paths, row, col - 1, { ...request, force: true })
            if (files) result = { prefix: at, items: files.items.map(item => ({ ...item, value: `@${item.value}` })) }
          }
        }
        if (!result) return null
        return {
          prefix: sanitize(result.prefix),
          items: result.items.filter(item => sanitize(item.value) === item.value).map(item => ({
            ...item,
            label: sanitize(item.label),
            description: item.description ? sanitize(item.description) : undefined,
          })),
        }
      },
      applyCompletion: (...args) => provider.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) => provider.shouldTriggerFileCompletion(...args),
    }
    editor.setAutocompleteProvider(autocomplete)
    editor.onSubmit = submit
    tui.setFocus(editor)
    restore()
    unsubscribe = controller.subscribe(eventListener)
    removeInput = tui.addInputListener(data => {
      if (closing) return { consume: true }
      if (isKeyRelease(data)) return undefined
      if (!matchesKey(data, 'ctrl+c') && !matchesKey(data, 'escape')) return undefined
      if (interrupting) return { consume: true }
      interrupting = true
      const current = controller.snapshot()
      const busy = current.running > 0 || current.evaluating > 0 || localBusy > 0 || activeAgents.size > 0
      void (async () => {
        try {
          await controller.interrupt()
        } catch (error) {
          notice(error)
        } finally {
          interrupting = false
          if (!busy) {
            closing = true
            finish()
          } else refresh()
        }
      })()
      return { consume: true }
    })
    tui.start()
    refresh()
    if (options.initialPrompt) submit(options.initialPrompt)
    await done
  } finally {
    closing = true
    let failure: unknown
    const clean = async (action: () => void | Promise<void>) => {
      try {
        await action()
      } catch (error) {
        failure ??= error
      }
    }
    await clean(() => unsubscribe?.())
    await clean(() => removeInput?.())
    editor.onSubmit = undefined
    editor.onChange = undefined
    await clean(() => editor.setAutocompleteProvider({
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    }))
    await clean(() => editor.setText(''))
    await clean(() => loader?.stop())
    await clean(() => terminal.drainInput())
    await clean(() => tui.stop())
    await clean(() => controller.close())
    if (failure) throw failure
  }
}
