/**
 * Email rendering — minimal SMTP client + simple template variable substitution.
 *
 * We use the `smtp-tls` package's connection via raw sockets for portability
 * (no native deps). For production at scale, point the SMTP host at a
 * transactional email provider (SendGrid, Postmark, Mailgun, SES) and
 * disable the bundled sender.
 *
 * Template variables use {{name}} syntax, case-sensitive. Unknown variables
 * are left as-is (never throw — bad data should not block delivery).
 */

import { createConnection } from 'node:net'
import { createHash, createHmac, createPrivateKey, createPublicKey, randomBytes } from 'node:crypto'
import { promisify } from 'node:util'

export interface SmtpConfig {
  host: string
  port: number
  user: string
  password: string
  fromAddress: string
  fromName: string
}

export function renderTemplate(body: string, vars: Record<string, unknown>): string {
  return body.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const parts = key.split('.')
    let value: unknown = vars
    for (const p of parts) {
      if (value && typeof value === 'object' && p in value) {
        value = (value as Record<string, unknown>)[p]
      } else {
        return match  // leave unchanged
      }
    }
    return value === undefined || value === null ? match : String(value)
  })
}

/**
 * Send an email via SMTP. Returns the SMTP server's response message id
 * (when available) or null.
 *
 * This is a deliberately simple SMTP-AUTH-LOGIN implementation suitable
 * for low-volume transactional email. For high volume, swap with the
 * provider's HTTP API (e.g. SendGrid) by adding another channel type.
 */
export async function sendEmail(
  config: SmtpConfig,
  args: { to: string; subject: string; body: string; isHtml: boolean },
): Promise<{ messageId: string | null }> {
  if (!config.host) throw new Error('SMTP host not configured')
  const socket = createConnection({ host: config.host, port: config.port })
  const conn = new SmtpConnection(socket)
  try {
    await conn.connect()
    if (config.user) await conn.auth(config.user, config.password)
    await conn.mail(config.fromAddress)
    await conn.rcpt(args.to)
    const mime = buildMimeMessage({
      from: `${config.fromName} <${config.fromAddress}>`,
      to: args.to,
      subject: args.subject,
      body: args.body,
      isHtml: args.isHtml,
    })
    const response = await conn.data(mime)
    await conn.quit()
    return { messageId: extractMessageId(response) }
  } finally {
    socket.destroy()
  }
}

function buildMimeMessage(args: { from: string; to: string; subject: string; body: string; isHtml: boolean }): string {
  const boundary = `----=_Part_${randomBytes(8).toString('hex')}`
  const headers = [
    `From: ${args.from}`,
    `To: ${args.to}`,
    `Subject: ${encodeHeader(args.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `Message-ID: <${randomBytes(16).toString('hex')}@instatic.local>`,
  ]
  const parts = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    args.isHtml ? stripHtml(args.body) : args.body,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    args.isHtml ? args.body : `<p>${escapeHtml(args.body)}</p>`,
    `--${boundary}--`,
    ``,
  ]
  return [...headers, ``, ...parts].join('\r\n')
}

function encodeHeader(s: string): string {
  // RFC 2047 encoded-word for non-ASCII
  if (/^[\x20-\x7E]*$/.test(s)) return s
  return `=?UTF-8?B?${Buffer.from(s, 'utf-8').toString('base64')}?=`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c] ?? c))
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}

function extractMessageId(response: string): string | null {
  const match = response.match(/<([^>]+)>/)
  return match ? match[1] : null
}

// ─── Minimal SMTP client ──────────────────────────────────────────────────

class SmtpConnection {
  private buffer = ''
  private resolver: ((value: string) => void) | null = null

  constructor(private socket: ReturnType<typeof createConnection>) {
    socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf-8')
      // SMTP responses end with \r\n — only resolve when we have a complete line
      if (this.resolver && this.buffer.includes('\r\n')) {
        const line = this.buffer.split('\r\n')[0]
        this.buffer = this.buffer.slice(line.length + 2)
        const resolver = this.resolver
        this.resolver = null
        resolver(line)
      }
    })
  }

  private async command(cmd: string, expectCode = 250): Promise<string> {
    return new Promise((resolve, reject) => {
      this.resolver = (line) => {
        const code = parseInt(line.slice(0, 3), 10)
        if (code >= expectCode && code < 400) {
          resolve(line)
        } else {
          reject(new Error(`SMTP error: ${line}`))
        }
      }
      this.socket.write(`${cmd}\r\n`)
    })
  }

  async connect(): Promise<string> {
    return await this.command('', 220)
  }

  async ehlo(domain: string): Promise<string> {
    return await this.command(`EHLO ${domain}`, 250)
  }

  async auth(user: string, password: string): Promise<string> {
    return await this.command(`AUTH LOGIN ${Buffer.from(user).toString('base64')}`, 334)
      .then(() => this.command(Buffer.from(password).toString('base64'), 235))
  }

  async mail(from: string): Promise<string> {
    return await this.command(`MAIL FROM:<${from}>`, 250)
  }

  async rcpt(to: string): Promise<string> {
    return await this.command(`RCPT TO:<${to}>`, 250)
  }

  async data(payload: string): Promise<string> {
    return await this.command('DATA', 354).then(() => this.command(payload + '\r\n.', 250))
  }

  async quit(): Promise<string> {
    return await this.command('QUIT', 221)
  }
}