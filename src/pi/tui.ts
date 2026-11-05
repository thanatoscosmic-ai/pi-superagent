import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename } from 'node:path'
import {
  CombinedAutocompleteProvider,
  Container,
  CURSOR_MARKER,
  Editor,
  Markdown,
  ProcessTerminal,
  Spacer,
  Text,
  TuiMainScreen,
  getTerminalColorMode,
  isKeyRelease,
  matchesKey,
  parseColor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  type AutocompleteProvider,
  type Color,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
  type SelectListTheme,
  type Terminal,
} from '@earendil-works/pi-tui'
import type { AgentMessage } from '@earendil-works/pi-agent-core'
import { UserError } from '../core/index.ts'
import type { Ticket } from '../core/index.ts'
import type { TerminalController, TerminalEvent, TerminalSnapshot } from './terminal-types.ts'

export type { Terminal } from '@earendil-works/pi-tui'

const outputLimit = 16_000
const secretName = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|COOKIE/i
const internalTool = /^(?:orchestrator_report|trigger_handback|orchestrator_read|orchestrator_ack|thread_unrelated|thread_follow|thread_bind_own_pr)$/
/** Ticket inputs are protocol envelopes (mandate JSON, restart notes, status requests); only a person's words belong in the transcript. */
const internalInput = (text: string) =>
  /^\s*(?:工单输入|开始执行本工单|The host restarted during this ticket\.|Report the current ticket status with orchestrator_report\.|\[\{|\{)/.test(text)
const readVersion = (): string => {
  // Resolved from source (src/pi/*.ts) and from the bundled output (dist/*.js).
  for (const path of ['../../package.json', '../package.json']) {
    try {
      const data = JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')) as { name?: string; version?: string }
      if (data.name === 'pi-superagent' && data.version) return data.version
    } catch {}
  }
  return '0.0.0'
}

const VERSION = readVersion()

type Rgb = { kind: string; r: number; g: number; b: number; index?: number }

function resolve(color: Color | string): Rgb {
  return (typeof color === 'string' ? parseColor(color) : color) as Rgb
}

function foreground(color: Color | string): string {
  const value = resolve(color)
  return value.kind === 'indexed' ? `\x1b[38;5;${value.index}m` : `\x1b[38;2;${value.r};${value.g};${value.b}m`
}

function backgroundCode(color: Color | string): string {
  const value = resolve(color)
  return value.kind === 'indexed' ? `\x1b[48;5;${value.index}m` : `\x1b[48;2;${value.r};${value.g};${value.b}m`
}

function paint(color: Color | string): (text: string) => string {
  const code = foreground(color)
  return text => `${code}${text}\x1b[39m`
}

function fill(color: Color | string): (text: string) => string {
  const code = backgroundCode(color)
  return text => `${code}${text}\x1b[49m`
}

const identity = (text: string) => text
const bold = (text: string) => `\x1b[1m${text}\x1b[22m`
const italic = (text: string) => `\x1b[3m${text}\x1b[23m`

/** Colors mirror pi's dark theme so both CLIs look like the same product. */
const palette = {
  accent: paint('okhsl(295 50% 67%)'),
  success: paint('okhsl(159 59% 67%)'),
  error: paint('okhsl(20 72% 67%)'),
  warning: paint('okhsl(83 88% 67%)'),
  muted: paint('okhsl(229 6% 67%)'),
  text: paint('okhsl(234 3% 89%)'),
  dim: paint('okhsl(229 8% 56%)'),
  userBg: fill('okhsl(233 41% 24%)'),
  toolPendingBg: fill('okhsl(229 5% 24%)'),
  toolSuccessBg: fill('okhsl(158 46% 25%)'),
  toolErrorBg: fill('okhsl(19 54% 25%)'),
}

const markdownTheme: MarkdownTheme = {
  heading: text => bold(palette.warning(text)),
  link: palette.accent,
  linkUrl: palette.dim,
  code: palette.accent,
  codeBlock: palette.success,
  codeBlockBorder: palette.dim,
  quote: palette.muted,
  quoteBorder: palette.muted,
  hr: palette.muted,
  listBullet: palette.accent,
  bold,
  italic,
  strikethrough: text => `\x1b[9m${text}\x1b[29m`,
  underline: text => `\x1b[4m${text}\x1b[24m`,
  highlightCode(code, lang) {
    const script = /^(?:[cm]?[jt]sx?|javascript|typescript|json|py|python|sh|bash|zsh|go|rs|java)$/i.test(lang ?? '')
    return code.split('\n').map(line => {
      if (!script) return palette.success(line)
      return line.replace(
        /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\/\/.*|#.*)|(\b(?:const|let|var|function|return|if|else|class|import|export|from|async|await|def|for|while|true|false|null|None|True|False|new|type|interface)\b)|(\b\d+(?:\.\d+)?\b)/g,
        (token, string, comment, keyword) => string ? palette.warning(token) : comment ? palette.dim(token) : keyword ? palette.accent(token) : palette.success(token),
      )
    })
  },
}

const selectListTheme: SelectListTheme = {
  selectedPrefix: palette.accent,
  selectedText: palette.accent,
  description: palette.muted,
  scrollInfo: palette.muted,
  noMatch: palette.muted,
}

const editorTheme: EditorTheme = { borderColor: palette.dim, selectList: selectListTheme }

/** `/ticket`, `/stop` and `/retry` complete against the tickets that exist, matching an id prefix. */
const ticketCommands = new Set(['ticket', 'stop', 'retry'])
const commands = [
  { name: 'tickets', description: '工单列表和历史' },
  { name: 'ticket', description: '查看工单详情', argumentHint: '<id>' },
  { name: 'pause', description: '暂停调度' },
  { name: 'resume', description: '恢复调度' },
  { name: 'stop', description: '停止并撤销工单授权', argumentHint: '<id>' },
  { name: 'retry', description: '重试工单', argumentHint: '<id>' },
  { name: 'mode', description: '切换模式', argumentHint: 'coding|tickets' },
  { name: 'shell', description: 'Shell 开关', argumentHint: 'on|off' },
  { name: 'new', description: '新建会话' },
  { name: 'tools', description: '展开或折叠工具输出', argumentHint: 'expand|collapse' },
  { name: 'debug', description: '本地调试事件和详情', argumentHint: 'on|off' },
  { name: 'help', description: '命令帮助' },
  { name: 'status', description: '当前状态' },
  { name: 'exit', description: '退出' },
]

function stringify(value: unknown, sanitize?: (text: string) => string): string {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value, sanitize ? (_, part) => typeof part === 'string' ? sanitize(part) : part : undefined) ?? ''
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
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]/g, '')
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

/** Only styling this file produces may pass through; anything else is dropped. */
const permittedSgr = /^\x1b\[(?:0|1|2|3|4|9|22|23|24|27|29|39|49|38;5;\d{1,3}|48;5;\d{1,3}|38;2;\d{1,3};\d{1,3};\d{1,3}|48;2;\d{1,3};\d{1,3};\d{1,3})m$/

/**
 * Render one line through the sanitizer.
 * @param keepCursor - Keep the TUI's own cursor protocol. The editor paints its caret as `\x1b_pi:fc`…`\x1b_pi:/fc` beside the
 * zero-width hardware marker; treating those as untrusted escapes removes the visible caret while typing.
 */
function safeRendered(text: string, sanitize: Sanitize, keepCursor = false): string {
  // A private-use character that cannot occur in terminal output; grow it until it is absent from the line.
  let marker = '\ue000'
  while (text.includes(marker)) marker += '\ue000'
  const sequences: string[] = []
  const protect = (sequence: string) => { sequences.push(sequence); return `${marker}${sequences.length - 1}${marker}` }
  // Protect styling first, and the TUI's cursor protocol with it: both must survive a sanitizer meant for untrusted text.
  let protectedText = text.replace(/\x1b\[[0-9;]*m/g, protect)
  if (keepCursor) protectedText = protectedText.replace(/\x1b_pi:(?:c|fc|\/fc)\x07/g, protect)
  const restored = sanitize(protectedText).replace(new RegExp(`${marker}(\\d+)${marker}`, 'g'), (_, index) => {
    const sequence = sequences[Number(index)] ?? ''
    if (permittedSgr.test(sequence)) return sequence
    if (keepCursor && /^\x1b_pi:(?:c|fc|\/fc)\x07$/.test(sequence)) return sequence === '\x1b_pi:c\x07' ? CURSOR_MARKER : sequence
    return ''
  })
  return restored
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

  constructor(
    private sanitize: Sanitize,
    text: string,
    paddingY = 0,
    defaultStyle?: { color?: (text: string) => string; bgColor?: (text: string) => string },
  ) {
    super('', 1, paddingY, markdownTheme, defaultStyle, { renderLatex: false })
    this.source = text
  }

  override setText(text: string): void {
    this.source = text
  }

  override render(width: number): string[] {
    const text = this.sanitize(this.source, this.streaming)
    if (!text.trim()) return []
    super.setText(text)
    return safeLines(super.render(width), width, this.sanitize)
  }
}

class SafeText extends Text {
  constructor(private sanitize: Sanitize, private source: () => string, private color = identity, private maxLines?: number) {
    super('', 0, 0)
  }

  /** Points the line at new text, which the next render picks up. */
  setSource(source: () => string): void {
    this.source = source
  }

  override render(width: number): string[] {
    const text = this.sanitize(this.source())
    if (!text.trim()) return []
    this.setText(text.split('\n').map(line => this.color(truncateToWidth(line, width, '…'))).join('\n'))
    const lines = safeLines(super.render(width), width, this.sanitize)
    return this.maxLines === undefined ? lines : lines.slice(0, this.maxLines)
  }
}

/** Wraps preformatted command output without reinterpreting it as Markdown. */
class Preformatted implements Component {
  constructor(
    private sanitize: Sanitize,
    private text: string,
    private color: (text: string) => string = identity,
    private indent = 0,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const text = this.sanitize(this.text).replace(/\r/g, '')
    if (!text.trim()) return []
    const content = Math.max(1, width - 1 - this.indent)
    const lines = text.split('\n').flatMap(line => {
      // The label sits at the start, so wrapped text continues under it rather than under the field name.
      const wrapped = new Text(line, 0, 0).render(content)
      const pad = ' '.repeat(this.indent)
      return wrapped.map((part, index) => this.color(index === 0 ? ` ${part}` : ` ${pad}${part}`))
    })
    return safeLines(lines, width, this.sanitize)
  }
}

const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

class SafeEditor extends Editor {
  private frame = 0
  private timer?: ReturnType<typeof setInterval>
  private working?: string

  constructor(tui: TuiMainScreen, private sanitize: Sanitize) {
    super(tui, editorTheme, { paddingX: 1, autocompleteMaxVisible: 8 })
  }

  /** True when the editor holds only whitespace; Ctrl+D exits only then, as in pi. */
  isEmpty(): boolean { return this.getText().trim().length === 0 }

  /** Shows pi's in-border working indicator and highlights the border while busy. */
  setWorking(message?: string): void {
    if (message === this.working) return
    this.working = message
    if (message) {
      this.borderColor = palette.accent
      // A static message has no spinner, so it does not need a repaint timer either.
      if (message.startsWith('已暂停')) {
        if (this.timer) clearInterval(this.timer)
        this.timer = undefined
      } else {
        this.timer ??= setInterval(() => {
          this.frame = (this.frame + 1) % spinner.length
          this.tui.requestRender()
        }, 80)
      }
    } else {
      if (this.timer) clearInterval(this.timer)
      this.timer = undefined
      this.borderColor = palette.dim
    }
    this.tui.requestRender()
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    if (!this.working || width < 12) return super.renderTopBorder(width, hiddenLineCount)
    const dots = hiddenLineCount > 0 ? ` ↑${hiddenLineCount} ` : ''
    const indicator = (this.working ?? '').startsWith('已暂停') ? palette.warning('⏸') : palette.accent(spinner[this.frame] ?? '⠋')
    const status = `${indicator} ${palette.muted(this.working ?? '')}`
    const statusWidth = visibleWidth(status)
    const left = 3
    if (left + statusWidth + 2 + visibleWidth(dots) > width) {
      return this.borderColor('─'.repeat(width))
    }
    const rest = width - left - statusWidth - 1
    const fillWidth = Math.max(0, rest - visibleWidth(dots))
    return `${this.borderColor('── ')}${status}${this.borderColor(` ${dots}${'─'.repeat(fillWidth)}`)}`
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
    // The editor's own cursor is a protocol sequence of the TUI, not user text: keep the hardware-cursor marker and the
    // fake-cursor cell that paints it, or the caret disappears while typing.
    return lines.map(line => safeRendered(line, this.sanitize, true))
  }
}

function pad(text: string, width: number): string {
  const visible = visibleWidth(stripTerminalSequences(text))
  return `${text}${' '.repeat(Math.max(0, width - visible))}`
}

/** Token counts as pi's footer shows them: `820`, `8.2k`, `128k`, `1.0M`. */
function formatTokens(count: number): string {
  if (count < 1_000) return String(count)
  if (count < 10_000) return `${(count / 1_000).toFixed(1)}k`
  if (count < 1_000_000) return `${Math.round(count / 1_000)}k`
  return `${(count / 1_000_000).toFixed(1)}M`
}

function formatDuration(ms: number): string {
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const total = Math.floor(seconds)
  return `${Math.floor(total / 60)}m ${total % 60}s`
}

/**
 * One tool row, rendered the way pi renders the same tool: a bold title with the object it acts on,
 * then a preview whose depth depends on the tool. Successful and failed rows carry a different
 * background, and the row reports how long the call took.
 */
class ToolCard implements Component {
  name = ''
  args: Record<string, unknown> = {}
  rawArgs = ''
  output = ''
  state: 'running' | 'done' | 'failed' = 'running'
  expanded = false
  truncated = false
  private started = Date.now()
  private elapsed?: number

  constructor(readonly ticketId: string, readonly id: string, private sanitize: Sanitize) {}

  start(): void {
    this.started = Date.now()
    this.elapsed = undefined
  }

  /** A short id shown in the expanded row, as pi shows a tool call's id in details. */
  shortId(): string { return this.id.slice(0, 8) }

  setArgs(value: unknown): void {
    this.rawArgs = this.sanitize(stringify(value, this.sanitize)).slice(0, outputLimit)
    this.args = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  }

  /**
   * `streaming` is true only for a partial result: the sanitizer holds back a trailing fragment then, because it may be
   * the beginning of a secret split across deltas. A final result is complete and must keep every character.
   */
  setOutput(value: unknown, streaming = false): void {
    const text = this.sanitize(outputText(value), streaming)
    this.truncated = text.length > outputLimit
    this.output = text.slice(0, outputLimit)
  }

  finish(failed: boolean): void {
    this.state = failed ? 'failed' : 'done'
    this.elapsed = Date.now() - this.started
  }

  invalidate(): void {}

  private text(key: string): string | undefined {
    const value = this.args[key]
    return typeof value === 'string' ? this.sanitize(value) : undefined
  }

  private number(key: string): number | undefined {
    const value = this.args[key]
    return typeof value === 'number' ? value : undefined
  }

  private path(): string | undefined {
    const value = this.text('path') ?? this.text('file_path') ?? this.text('filePath')
    return value === undefined ? undefined : shortPath(value)
  }

  /** The title line: `name object…`, matching pi's per-tool call renderers. */
  private title(): string {
    const name = bold(palette.text(this.name))
    const path = this.path()
    switch (this.name) {
      case 'read': {
        const offset = this.number('offset') ?? 1
        const limit = this.number('limit')
        const range = this.args.offset !== undefined || limit !== undefined ? `:${offset}${limit === undefined ? '' : `-${offset + limit - 1}`}` : ''
        return `${name} ${palette.accent(path ?? '…')}${palette.warning(range)}`
      }
      case 'edit':
      case 'write':
        return `${name} ${palette.accent(path ?? '…')}`
      case 'bash':
        return `${name} ${palette.warning(truncateToWidth(this.text('command') ?? '…', 120, '…'))}`
      case 'glob':
        return `${name} ${palette.accent(this.text('pattern') ?? '…')}${palette.dim(` in ${this.path() ?? '.'}`)}`
      case 'grep':
        return `${name} ${palette.accent(`/${this.text('pattern') ?? ''}/`)}${palette.dim(` in ${this.path() ?? '.'}`)}`
      case 'ls':
        return `${name} ${palette.accent(path ?? '.')}`

      default: {
        const keys = Object.entries(this.args)
          .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
          .slice(0, 3)
          .map(([key, value]) => `${key}=${String(value)}`)
          .join(' ')
        return `${name}${keys ? ` ${palette.dim(truncateToWidth(keys, 80, '…'))}` : ''}`
      }
    }
  }

  /** Body lines for a collapsed row, following each tool's own preview rules. */
  private preview(width: number): string[] {
    const clip = (lines: string[], limit: number): string[] => {
      const kept = lines.slice(0, limit)
      const hidden = lines.length - kept.length
      // pi ends the preview with its own last line plus an inline hint, instead of a line of its own.
      if (hidden > 0) {
        const last = kept.pop() ?? ''
        kept.push(`${last}  ${palette.dim(`… 还有 ${hidden} 行 · Ctrl+O 展开`)}`)
      }
      return kept
    }
    const raw = this.output.split('\n').map(line => line.trimEnd())
    // A failed call explains itself in the error color, as pi's rows do.
    const output = this.state === 'failed' ? raw.map(line => palette.error(line)) : raw
    switch (this.name) {
      case 'read':
        // Like pi, a collapsed read row shows no body: the file is on disk or in the editor. Only a failure explains itself.
        return this.state === 'failed' ? clip(output.filter(Boolean), 6) : []
      case 'write': {
        const content = this.text('content')
        if (content === undefined) return []
        return clip(content.split('\n').map(line => palette.success(line)), 8)
      }
      case 'edit': {
        const lines: string[] = []
        const oldText = this.text('oldText')
        const newText = this.text('newText')
        if (oldText !== undefined) for (const line of oldText.split('\n').slice(0, 6)) lines.push(palette.error(`- ${line}`))
        if (newText !== undefined) for (const line of newText.split('\n').slice(0, 6)) lines.push(palette.success(`+ ${line}`))
        if (lines.length) return clip(lines, 8)
        return clip(output.filter(Boolean), 6)
      }
      case 'bash':
        return clip(output.filter((line, index) => line.trim() || index < output.length - 1).slice(-5), 5)
      case 'glob':
      case 'grep':
      case 'ls':
        return clip(output.filter(line => line.trim()), 8)
      default:
        return clip(output.filter(Boolean), 4)
    }
  }

  render(width: number): string[] {
    const tone = this.state === 'failed' ? palette.toolErrorBg : this.state === 'done' ? palette.toolSuccessBg : palette.toolPendingBg
    // The row is padded one column on each side, so its content must leave room for both.
    const inner = Math.max(1, width - 2)
    const body: string[] = []
    if (this.expanded) {
      body.push(...new Text(this.sanitize(`args: ${this.rawArgs}`), 0, 0).render(inner).map(line => palette.dim(line)))
      const output = this.output.split('\n').map(line => palette.muted(line))
      body.push(...output)
      if (this.truncated) body.push(palette.warning('[输出已截断，最多 16000 字符]'))
    } else {
      body.push(...this.preview(inner))
    }
    // pi shows a clock line while a result streams and the total after a slow call; quick calls stay quiet.
    if (this.state === 'running' && this.output) body.push(palette.dim(`Elapsed ${formatDuration(Date.now() - this.started)}`))
    if (this.elapsed !== undefined && this.elapsed >= 1_000) body.push(palette.dim(`Took ${formatDuration(this.elapsed)}`))
    // pi's rows are a single padded box: one blank line above and below, body lines between when there are any.
    const lines = [tone(pad('', width)), tone(pad(` ${this.title()}`, width))]
    // A body line of its own, so the title never touches the edit preview or shell output.
    if (body.length) lines.push(tone(pad('', width)))
    for (const line of body) {
      const safe = visibleWidth(line) > width - 2 ? truncateToWidth(line, width - 2, '…') : line
      lines.push(tone(pad(` ${safe}`, width)))
    }
    lines.push(tone(pad('', width)))
    return safeLines(lines, width, this.sanitize)
  }
}

/** pi's half-block logo, with a text fallback on terminals that cannot draw it. */
class Header implements Component {
  private readonly top: string
  private readonly bottom: string

  constructor() {
    if (getTerminalColorMode() === 'truecolor') {
      const coral = '\x1b[38;2;228;138;122m'
      const blue = '\x1b[38;2;79;142;179m'
      const blueBg = '\x1b[48;2;79;142;179m'
      const yellow = '\x1b[38;2;234;182;93m'
      const reset = '\x1b[0m'
      this.top = `${coral}${blueBg}▀${reset}${coral}▀█${reset}`
      this.bottom = `${blue}█▀${reset} ${yellow}█${reset}`
    } else {
      this.top = palette.accent('▐▛')
      this.bottom = `${palette.accent('▝')}${palette.warning('▜▘')}`
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    const title = `${this.top} ${bold('pi-superagent')} ${palette.dim(VERSION ? `v${VERSION}` : '')}`
    // Like pi's startup line, the hints drop from the end so a narrow terminal keeps the essentials.
    const hints = [
      ['Esc', '中断'],
      ['/', '命令'],
      ['@', '文件'],
      ['Ctrl+O', '工具'],
      ['Shift+Enter', '换行'],
      ['/help', '帮助'],
    ]
    let line = this.bottom
    for (const [key, label] of hints) {
      const next = `${line} ${palette.dim(key!)} ${palette.muted(label!)}`
      if (visibleWidth(next) > width) break
      line = next
    }
    return [truncateToWidth(title, width, '…'), truncateToWidth(line, width, '…')]
  }
}

/** pi's two-line footer: cwd + model, then status stats. */
class Footer implements Component {
  constructor(
    private readonly sanitize: Sanitize,
    private readonly data: () => { left: string; right: string; stats: string; alert: string },
  ) {}
  invalidate(): void {}
  render(width: number): string[] {
    const { left, right, stats, alert } = this.data()
    const leftText = truncateToWidth(left, width, '…')
    const rightText = truncateToWidth(right, Math.max(0, width - visibleWidth(leftText) - 2), '…')
    const gap = ' '.repeat(Math.max(1, width - visibleWidth(leftText) - visibleWidth(rightText)))
    const status = alert ? `${stats}  ${palette.error(alert)}` : stats
    return safeLines([`${palette.dim(leftText)}${gap}${palette.dim(rightText)}`, palette.muted(status)], width, this.sanitize)
  }
}

/** Reads the current Git branch without spawning Git, for the footer's `dir (branch)` line. */
function gitBranch(cwd: string): string | undefined {
  try {
    let directory = cwd
    for (let depth = 0; depth < 8; depth++) {
      const head = `${directory}/.git/HEAD`
      if (existsSync(head)) {
        const match = /ref:\s*refs\/heads\/(.+)/.exec(readFileSync(head, 'utf8'))
        if (match) return match[1]!.trim()
        return undefined
      }
      const parent = directory.replace(/\/[^/]+$/, '')
      if (!parent || parent === directory) break
      directory = parent
    }
  } catch {}
  return undefined
}

function shortPath(path: string): string {
  const home = homedir()
  return path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

function modeLabel(mode: TerminalSnapshot['mode']): string {
  return mode === 'coding' ? '编码' : '工单'
}

function ticketState(ticket: Ticket): string {
  if (ticket.ended) {
    const labels: Record<string, string> = { completed: '已完成', failed: '已失败', stopped: '已停止', blocked: '已阻塞', merged: '已合并', closed: '已关闭', dropped: '已放弃' }
    return labels[ticket.ended.outcome] ?? ticket.ended.outcome
  }
  if (ticket.attention) return '待人工'
  if (ticket.assignments.some(assignment => assignment.state === 'running')) return '运行中'
  if (ticket.assignments.some(assignment => assignment.state === 'pending')) return '排队中'
  return '待处理'
}

function ticketDetails(ticket: Ticket): string {
  const report = ticket.assignments.findLast(assignment => assignment.report)?.report
  return [
    `工单    ${ticket.id}`,
    `标题    ${ticket.title}`,
    `状态    ${ticketState(ticket)}`,
    `范围    ${ticket.mandate.scope.replace(/\s+/g, ' ')}`,
    `目录    ${ticket.execution?.directory ?? '未分配'}`,
    `任务    ${ticket.execution?.assignment?.replace(/\s+/g, ' ') ?? '未分配'}`,
    `报告    ${report ? `${report.state} · ${report.summary.replace(/\s+/g, ' ')}` : '暂无'}`,
    ...(ticket.attention ? [`待办    ${ticket.attention.question.replace(/\s+/g, ' ')}`] : []),
  ].join('\n')
}

function ticketSummary(ticket: Ticket): string {
  return `${truncateToWidth(ticket.title, 72, '…')}  ${palette.dim(ticketState(ticket))}`
}

function statusReport(value: TerminalSnapshot): string {
  const healthy = Object.entries(value.health)
    .filter(([, health]) => !/unavailable|failed|error/i.test(health.state))
    .map(([name]) => name)
  return [
    `模式    ${modeLabel(value.mode)}`,
    `目录    ${value.cwd}`,
    `模型    ${value.model}`,
    `Shell   ${value.shell ? '已开启（非沙箱）' : '已关闭'}`,
    `调度    ${value.paused ? '已暂停（对话仍可回答，编码请求排队）' : '运行中'}`,
    `在办    评估 ${value.evaluating} · 运行 ${value.running} · 队列 ${value.queued} · 回写 ${value.pendingReplies} · 待人工 ${value.attention}`,
    `工单    ${value.tickets.length} 个${value.tickets.length ? `（未结束 ${value.tickets.filter(ticket => !ticket.ended).length}）` : ''}`,
    `健康    ${healthy.length ? `正常：${healthy.join('、')}` : '无组件上报'}`,
    `上下文  ${value.usage.window
      ? `${formatTokens(value.usage.context)} / ${formatTokens(value.usage.window)}（${Math.round((value.usage.context / value.usage.window) * 100)}%）`
      : '模型未报告窗口'}`,
    `用量    输入 ${formatTokens(value.usage.input)} · 输出 ${formatTokens(value.usage.output)} · 缓存读 ${formatTokens(value.usage.cacheRead)}`,
  ].join('\n')
}

function ticketTable(tickets: Ticket[]): string {
  if (!tickets.length) return '当前没有工单。'
  return tickets.map(ticket => {
    const age = ticket.ended ? `结束 ${ticket.ended.outcome}` : `更新 ${ticket.updatedAt.slice(5, 16).replace('T', ' ')}`
    return `${ticket.id.slice(0, 8)}  ${ticketState(ticket).padEnd(4, '　')}  ${truncateToWidth(ticket.title, 44, '…')}  ${age}`
  }).join('\n')
}

export async function runTerminal(
  controller: TerminalController,
  options: { terminal?: Terminal; initialPrompt?: string } = {},
): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal()
  const tui = new TuiMainScreen(terminal)
  const sanitize = createSanitizer()
  const history = new Container()
  const editor = new SafeEditor(tui, sanitize)
  const tools = new Map<string, ToolCard>()
  const activeMessages = new Map<string, { component: SafeMarkdown; text: string }>()
  const endedMessages = new Set<string>()
  const shownInputs = new Set<string>()
  const shownReports = new Map<string, SafeMarkdown>()
  const recentAssistant: { text: string; at: number }[] = []
  const userEchoes = new Map<string, number>()
  /** Texts already in the transcript, so replaying a stored history never shows a line twice. */
  const displayed = new Map<string, number>()
  const remember = (text: string) => {
    const key = text.trim()
    if (key) displayed.set(key, (displayed.get(key) ?? 0) + 1)
  }
  const alreadyShown = (text: string): boolean => {
    const key = text.trim()
    const count = displayed.get(key) ?? 0
    if (!count) return false
    if (count === 1) displayed.delete(key)
    else displayed.set(key, count - 1)
    return true
  }
  const activeAgents = new Set<string>()
  let snapshot: TerminalSnapshot
  let selectedTicket: string | undefined
  let localBusy = 0
  let submitTail = Promise.resolve()
  let expanded = false
  let debug = false
  const debugEvents: string[] = []
  const cacheEvent = (text: string) => {
    debugEvents.push(sanitize(text).slice(0, outputLimit))
    if (debugEvents.length > 50) debugEvents.shift()
  }
  let closing = false
  let interrupting = false
  let programState = ''
  let lastClear = 0
  let unsubscribe: (() => void) | undefined
  let removeInput: (() => void) | undefined
  let finish = () => {}
  const done = new Promise<void>(resolve => { finish = resolve })

  const close = () => {
    if (closing) return
    closing = true
    finish()
  }
  /** Stops running work; Escape and Ctrl+C both reach here while something is busy. */
  const interrupt = (request: boolean) => {
    if (interrupting) return
    interrupting = true
    void (async () => {
      try {
        if (request) await controller.interrupt()
      } catch (error) {
        notice(error)
      } finally {
        interrupting = false
        refresh()
      }
    })()
  }
  /** pi's Ctrl+O: expand or collapse every tool row. */
  const toggleTools = () => {
    expanded = !expanded
    for (const card of tools.values()) card.expanded = expanded
    refresh()
  }
  const append = (component: Component, gap = true) => {
    if (gap && history.children.length) history.addChild(new Spacer(1))
    history.addChild(component)
    return component
  }
  const addUser = (text: string): SafeMarkdown => {
    remember(text)
    return append(new SafeMarkdown(sanitize, text, 1, { color: identity, bgColor: palette.userBg })) as SafeMarkdown
  }
  /**
   * Adds assistant text unless the same text was just rendered: a ticket report arrives both as a source reply
   * and as ticket state. The window is short, so a later identical answer still shows.
   */
  const addAssistantUnique = (text: string): SafeMarkdown | undefined => {
    const trimmed = text.trim()
    if (!trimmed) return undefined
    const now = Date.now()
    while (recentAssistant.length && now - recentAssistant[0]!.at > 2_000) recentAssistant.shift()
    if (recentAssistant.some(entry => entry.text === trimmed)) return undefined
    recentAssistant.push({ text: trimmed, at: now })
    remember(text)
    return append(new SafeMarkdown(sanitize, text, 0)) as SafeMarkdown
  }
  const addNotice = (text: string) => append(new SafeText(sanitize, () => text, palette.warning))
  /** Command output: preformatted so Markdown is not reinterpreted, with an optional hanging indent. */
  const addPre = (text: string, color = palette.muted, indent = 0) => append(new Preformatted(sanitize, text, color, indent))
  const addMeta = (text: () => string) => {
    const margin = history.children.length ? new Spacer(1) : undefined
    if (margin) history.addChild(margin)
    history.addChild(new SafeText(sanitize, text, palette.dim, 1))
    return margin
  }
  const refresh = (value?: TerminalSnapshot) => {
    if (closing) return
    snapshot = value ?? controller.snapshot()
    const active = localBusy > 0 || activeAgents.size > 0 || snapshot.running > 0 || snapshot.evaluating > 0
    // A paused host never starts work on its own, so it must say so even when nothing is running.
    const busy = active && !snapshot.paused
    editor.setWorking(snapshot.paused
      ? '已暂停 · 工单调度冻结；对话仍可回答（/resume 恢复）'
      : busy ? (snapshot.evaluating ? '评估中 (Esc 中断)' : '工作中 (Esc 中断)') : undefined)
    const state = busy ? 'working' : snapshot.paused ? 'idle' : snapshot.attention || Object.values(snapshot.health).some(health => /unavailable|failed|error/i.test(health.state)) ? 'blocked' : 'idle'
    if (state !== programState) {
      programState = state
      try { terminal.setProgramStatus({ state } as Parameters<Terminal['setProgramStatus']>[0]) } catch {}
    }
    tui.requestRender()
  }
  const restore = () => {
    for (const entry of snapshot.history) {
      if (shownInputs.has(entry.key)) continue
      shownInputs.add(entry.key)
      // The live stream already painted this line; the stored copy only fills in what was missed.
      if (alreadyShown(entry.text)) continue
      if (entry.role === 'user') addUser(entry.text)
      else if (entry.role === 'assistant') addAssistantUnique(entry.text)
      else addNotice(entry.text)
    }
    for (const ticket of snapshot.tickets) {
      for (const input of ticket.inputs) {
        if (input.kind !== 'text' && input.kind !== 'note') continue
        const key = `${ticket.id}:input:${input.id}`
        if (shownInputs.has(key)) continue
        shownInputs.add(key)
        if (input.kind !== 'text') continue
        // Tickets' text inputs are status requests and notes, not what a person typed; the transcript carries that.
        if (internalInput(input.text)) continue
        if (alreadyShown(input.text)) continue
        addUser(input.text)
      }
      for (const assignment of ticket.assignments) {
        const report = assignment.report
        if (!report) continue
        const key = `${ticket.id}:report:${assignment.id}`
        const text = report.summary.trim()
        const existing = shownReports.get(key)
        if (existing) existing.setText(text)
        else {
          const added = addAssistantUnique(text)
          if (added) shownReports.set(key, added)
        }
      }
    }
  }
  /** Refusals from the domain core carry an English message; word the ones a person hits by hand. */
  const errorText = (error: unknown): string => {
    if (error instanceof UserError) {
      if (error.code === 'unknownTicket') return '找不到这个工单。用 /tickets 查看当前工单。'
      if (error.code === 'ticketEnded') return '这个工单已经结束；新的请求会创建新工单。'
      if (error.code === 'notRetryable') return '这个工单当前不能重试：只有执行失败或受阻、且之后没有人再发消息的工单可以重试。'
      if (error.code === 'ticketStopped') return '这个工单已被人停止，需要重新发起请求。'
      if (error.code === 'mandateRevoked') return '当前策略已不再支持这个工单的授权，需要重新发起请求。'
      if (error.code === 'evalFinished') return '这次评估已经结束，请重新发送请求。'
      if (error.code === 'assignmentEnded') return '这个工单已由更新的执行接手。'
      return error.message
    }
    return stringify(error)
  }
  let lastNotice: { text: string; count: number; component: SafeText } | undefined
  const notice = (value: unknown) => {
    if (closing || /^决策 ignore：/.test(stringify(value))) return
    const text = errorText(value)
    // The same message twice in a row is one line with a count, not two identical lines.
    if (lastNotice && lastNotice.text === text) {
      lastNotice.count++
      const count = lastNotice.count
      const component = lastNotice.component
      component.setSource(() => `${text}  (${count})`)
    } else {
      const state = { text, count: 1 } as { text: string; count: number; component: SafeText }
      state.component = addNotice('') as SafeText
      state.component.setSource(() => (state.count > 1 ? `${text}  (${state.count})` : text))
      lastNotice = state
    }
    refresh()
  }
  const handleMessage = (ticketId: string, message: AgentMessage, phase: 'start' | 'update' | 'end', delta?: string) => {
    if (message.role === 'user' && ticketId === 'dialogue') return
    if (message.role !== 'assistant' && message.role !== 'user') return
    // A ticket worker's transcript is internal: its progress shows as tool cards and its outcome as the report.
    if (snapshot.tickets.some(ticket => ticket.id === ticketId)) return
    const text = messageText(message)
    const fingerprint = `${ticketId}:${message.role}:${'timestamp' in message ? message.timestamp : ''}:${text}`
    if (phase === 'end' && endedMessages.has(fingerprint)) return
    if (message.role === 'user') {
      if (phase !== 'end') return
      endedMessages.add(fingerprint)
      if (internalInput(text)) return
      const echoes = userEchoes.get(text.trim()) ?? 0
      if (echoes) userEchoes.set(text.trim(), echoes - 1)
      else addUser(text)
      return
    }
    if (phase === 'start') activeMessages.delete(ticketId)
    let active = activeMessages.get(ticketId)
    if (!active) {
      const created = append(new SafeMarkdown(sanitize, '', 0)) as SafeMarkdown
      active = { component: created, text: '' }
      activeMessages.set(ticketId, active)
    }
    const current = active
    current.text = text || (delta ? current.text + delta : current.text)
    current.component.streaming = phase !== 'end'
    const body = `${current.text}${phase === 'end' && 'errorMessage' in message && message.errorMessage ? `\n\n${message.errorMessage}` : ''}`
    current.component.setText(body)
    if (phase === 'end') {
      // The finished text is on screen; a replayed history must not paint it again.
      remember(current.text)
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
        if (event.type === 'reply') {
          if (!/^决策 ignore：/.test(event.text)) addAssistantUnique(event.text)
        } else if (/^决策 ignore：/.test(event.text)) cacheEvent(event.text)
        else notice(event.text)
      } else if (event.type === 'domain') {
        cacheEvent(`${event.value.type}\n${stringify(event.value.data, sanitize)}`)
        snapshot = controller.snapshot()
        const data = event.value.data
        if (event.value.type === 'ticket.created' || event.value.type === 'ticket.ended') {
          const id = 'ticketId' in data ? String(data.ticketId) : ''
          const label = event.value.type === 'ticket.created' ? '已创建工单' : '已结束工单'
          const kind = event.value.type
          addMeta(() => {
            const ticket = snapshot.tickets.find(item => item.id === id)
            if (!ticket) return `${label} · ${id.slice(0, 8)}`
            // A created line should not keep saying 排队中 once the work has moved on.
            return kind === 'ticket.created' ? `${label} · ${truncateToWidth(ticket.title, 72, '…')}` : `${label} · ${ticketSummary(ticket)}`
          })
        }
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
          if (internalTool.test(value.toolName)) {
            // Report/handback tools are protocol plumbing; keep only their short outcome.
            refresh()
            return
          }
          const key = `${event.ticketId}:${value.toolCallId}`
          let card = tools.get(key)
          if (!card) {
            card = new ToolCard(event.ticketId, value.toolCallId, sanitize)
            card.expanded = expanded
            card.start()
            tools.set(key, card)
            // The card paints its own leading padding line, as pi's tool rows do.
            append(card, false)
          }
          card.name = sanitize(value.toolName)
          if ('args' in value) card.setArgs(value.args)
          if (value.type === 'tool_execution_end') {
            card.setOutput(value.result)
            card.finish(value.isError)
          }
          if (value.type === 'tool_execution_update') card.setOutput(value.partialResult, true)
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
      const [rawCommand, ...rest] = text.split(/\s+/)
      const command = rawCommand!.toLowerCase()
      const argument = rest[0]
      // A short id the person typed is resolved here, so the controller only ever sees a full id.
      const resolved = argument && ['/stop', '/retry', '/ticket'].includes(command)
        ? snapshot.tickets.find(item => item.id === argument)
          ?? snapshot.tickets.find(item => item.id.startsWith(argument.toLowerCase()))
        : undefined
      const forwarded = resolved ? `${command} ${resolved.id}` : text
      if (command === '/stop' && argument) {
        if (!resolved) {
          notice(`未知工单：${argument}`)
          refresh()
          return
        }
        if (resolved.ended) {
          notice(`这个工单已经结束（${ticketState(resolved)}），不需要再停止。`)
          refresh()
          return
        }
      }
      if (command === '/retry' && argument && !resolved) {
        notice(`未知工单：${argument}`)
        refresh()
        return
      }
      if (command === '/ticket') {
        if (argument) selectedTicket = resolved?.id ?? argument
        const ticket = argument
          ? resolved
          : snapshot.tickets.find(item => item.id === selectedTicket)
            ?? snapshot.tickets.find(item => !item.ended && item.assignments.some(assignment => assignment.state === 'running'))
            ?? snapshot.tickets.filter(item => !item.ended).at(-1)
            ?? snapshot.tickets.at(-1)
        if (argument && !ticket) notice(`未知工单：${argument}`)
        else if (!ticket) notice('当前没有工单。')
        else addPre(ticketDetails(ticket), identity, 4)
        refresh()
        return
      }
      if (command === '/tickets') {
        addPre(ticketTable(snapshot.tickets), identity)
        refresh()
        return
      }
      if (command === '/status') {
        addPre(statusReport(snapshot), identity)
        refresh()
        return
      }
      if (command === '/debug') {
        if (argument === 'on' || argument === 'off') debug = argument === 'on'
        else notice('用法：/debug on|off')
        refresh()
        return
      }
      if (command === '/tools') {
        expanded = argument === 'expand' || argument === 'on' ? true : argument === 'collapse' || argument === 'off' ? false : !expanded
        for (const card of tools.values()) card.expanded = expanded
        refresh()
        return
      }
      void (async () => {
        try {
          const result = await controller.command(forwarded)
          if (command === '/new') {
            const keep = history.children.length
            for (let index = keep - 1; index >= 0; index--) history.removeChild(history.children[index]!)
            tools.clear()
            activeMessages.clear()
            endedMessages.clear()
            shownInputs.clear()
            shownReports.clear()
            recentAssistant.length = 0
            userEchoes.clear()
            displayed.clear()
          }
          if (result) addPre(result, identity)
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
    addUser(text)
    userEchoes.set(text, (userEchoes.get(text) ?? 0) + 1)
    // While paused the domain stores the message and starts nothing; say so instead of looking unanswered.
    // Conversation is answered even while paused; a work request waits for the resume.
    if (snapshot.paused) notice('工单调度已暂停：对话会正常回答，编码请求会排队，输入 /resume 后处理。')
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
    tui.addChild(new Header())
    tui.addChild(new Spacer(1))
    tui.addChild(history)
    tui.addChild(new SafeText(sanitize, () => debug ? [
      '调试 · 最近 50 事件',
      ...debugEvents,
      ...Object.entries(snapshot.health).map(([name, health]) => `${name}: ${health.state} ${health.detail}`),
      ...snapshot.tickets.filter(ticket => !selectedTicket || ticket.id === selectedTicket).map(ticketDetails),
    ].join('\n') : ''))
    tui.addChild(editor)
    tui.addChild(new Footer(sanitize, () => {
      const ticket = snapshot.tickets.find(item => item.id === selectedTicket)
        ?? snapshot.tickets.find(item => item.attention)
        ?? snapshot.tickets.find(item => item.assignments.some(assignment => assignment.state === 'running'))
        ?? snapshot.tickets.at(-1)
      const counts = [
        ['评估', snapshot.evaluating], ['运行', snapshot.running],
        ['队列', snapshot.queued + Math.max(0, localBusy - 1)], ['回写', snapshot.pendingReplies], ['待办', snapshot.attention],
      ].filter(([, count]) => count !== 0).map(([name, count]) => `${name} ${count}`)
      const flags = [modeLabel(snapshot.mode), snapshot.paused ? '已暂停' : '', snapshot.shell ? 'shell 开' : ''].filter(Boolean)
      const alert = Object.entries(snapshot.health)
        .filter(([, health]) => /unavailable|failed|error/i.test(health.state))
        .map(([name, health]) => `${name}: ${health.state}`).join(' · ')
      const state = counts.join('  ') || (localBusy || activeAgents.size ? '执行中' : '就绪')
      const parts = [`${flags.join(' · ')} · ${state}`]
      if (ticket) parts.push(ticketSummary(ticket))
      const branch = gitBranch(snapshot.cwd)
      // Like pi's footer: the model on the right, with its context window and how full it is.
      const { usage } = snapshot
      const percent = usage.window ? Math.round((usage.context / usage.window) * 100) : undefined
      const window = usage.window ? formatTokens(usage.window) : undefined
      const context = percent === undefined ? '' : percent > 90 ? palette.error(`${percent}%/${window}`) : percent > 70 ? palette.warning(`${percent}%/${window}`) : `${percent}%/${window}`
      return {
        left: `${shortPath(snapshot.cwd)}${branch ? ` (${branch})` : ''}`,
        right: context ? `${snapshot.model} ${context}` : snapshot.model,
        stats: parts.filter(Boolean).join('   '),
        alert,
      }
    }))
    const slash = commands.map(command => ticketCommands.has(command.name)
      ? {
          ...command,
          getArgumentCompletions(prefix: string) {
            const items = snapshot.tickets
              .map(ticket => ({ value: ticket.id, label: ticket.id.slice(0, 10), description: `${ticketState(ticket)} · ${truncateToWidth(ticket.title, 48, '…')}` }))
              .filter(item => !prefix || item.value.startsWith(prefix) || item.description.includes(prefix))
            return items.length ? items : null
          },
        }
      : command)
    const provider = new CombinedAutocompleteProvider(slash, snapshot.cwd)
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
      const current = controller.snapshot()
      // A paused run has nothing to interrupt.
      const busy = !current.paused && (current.running > 0 || current.evaluating > 0 || localBusy > 0 || activeAgents.size > 0)

      // Ctrl+O expands or collapses every tool row, as it does in pi.
      if (matchesKey(data, 'ctrl+o')) {
        toggleTools()
        return { consume: true }
      }

      // Escape interrupts work; with nothing running it exits, as the header advertises.
      if (matchesKey(data, 'escape')) {
        // Text or an open completion menu belongs to the editor; Escape cancels that first.
        if (editor.isShowingAutocomplete() || editor.getText().length > 0) return undefined
        if (busy) interrupt(true)
        else close()
        return { consume: true }
      }

      if (matchesKey(data, 'ctrl+d')) {
        // Exit on Ctrl+D only when the editor is empty, as pi does.
        if (editor.isEmpty()) { close() ; return { consume: true } }
        return undefined
      }

      if (!matchesKey(data, 'ctrl+c')) return undefined
      // Ctrl+C stops running work, otherwise it clears an unsent draft; a second press exits.
      if (busy) { interrupt(true); return { consume: true } }
      if (!editor.isEmpty()) {
        editor.setText('')
        lastClear = Date.now()
        return { consume: true }
      }
      if (Date.now() - lastClear < 600) { close(); return { consume: true } }
      lastClear = Date.now()
      notice('再按一次 Ctrl+C 退出（Ctrl+D 也可）。')
      return { consume: true }
    })
    tui.start()
    // pi puts the session in the terminal title: name first, then the directory.
    try { terminal.setTitle(`${basename(snapshot.cwd)} · pi-superagent`) } catch {}
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
    editor.dispose()
    await clean(() => editor.setAutocompleteProvider({
      getSuggestions: async () => null,
      applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
    }))
    await clean(() => editor.setText(''))
    await clean(() => terminal.drainInput())
    await clean(() => tui.stop())
    await clean(() => controller.close())
    if (failure) throw failure
  }
}
