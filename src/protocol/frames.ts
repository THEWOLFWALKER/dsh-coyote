/**
 * Pure V3 socket protocol: frame parse/encode and command message builders.
 *
 * Frame shape and every command string below follow the official
 * DG-LAB-OPENSOURCE socket protocol (ZGQ-inc/DG-LAB-OPENSOURCE, socket/README.md):
 * - Frame: {"type","clientId","targetId","message"} JSON, max 1950 chars.
 * - Strength command: strength-{1|2}+{0|1|2}+{0..200} (numeric channel).
 * - Strength report: strength-A+B+limitA+limitB (letter channel).
 * - Pulse command: pulse-{A|B}:["hex",...] (letter channel, JSON array, max 100 entries).
 * - Clear queue: clear-{1|2} (numeric channel).
 * - Feedback: feedback-{0..9}.
 */

import { CoyoteError } from '../errors.ts'
import type { AppFeedback, Channel, DeviceStrength } from '../types.ts'

/** Socket frame types defined by the V3 protocol. */
export type FrameType = 'bind' | 'heartbeat' | 'msg' | 'break' | 'error'

/** One decoded V3 socket frame. */
export interface SocketFrame {
  type: FrameType
  clientId: string
  targetId: string
  message: string
}

/** Maximum JSON frame length accepted by the App before it drops the message. */
export const MAX_FRAME_LENGTH = 1950

/** Maximum pulse entries the App accepts in one message before dropping all. */
export const MAX_PULSE_ENTRIES = 100

/** Official V3 error codes mapped to their documented meanings. */
export const ERROR_CODES = {
  OK: '200',
  PEER_DISCONNECTED: '209',
  QR_NO_CLIENT_ID: '210',
  BIND_TIMEOUT: '211',
  ALREADY_BOUND: '400',
  TARGET_NOT_FOUND: '401',
  NOT_BOUND: '402',
  INVALID_JSON: '403',
  OFFLINE: '404',
  MESSAGE_TOO_LONG: '405',
  INTERNAL: '500',
} as const

const FRAME_TYPES: readonly FrameType[] = ['bind', 'heartbeat', 'msg', 'break', 'error']

/** Strength action: 0 decrease, 1 increase, 2 set absolute. */
export type StrengthAction = 0 | 1 | 2

/** Parse one raw JSON frame; throws CoyoteError('403') on non-frame input. */
export function parseFrame(raw: string): SocketFrame {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CoyoteError('frame is not valid JSON', ERROR_CODES.INVALID_JSON)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CoyoteError('frame is not a JSON object', ERROR_CODES.INVALID_JSON)
  }
  const record = value as Record<string, unknown>
  const { type, clientId, targetId, message } = record
  if (typeof type !== 'string' || !FRAME_TYPES.includes(type as FrameType)) {
    throw new CoyoteError('frame type must be bind|heartbeat|msg|break|error', ERROR_CODES.INVALID_JSON)
  }
  if (typeof clientId !== 'string' || typeof targetId !== 'string' || typeof message !== 'string') {
    throw new CoyoteError('frame must carry string clientId/targetId/message', ERROR_CODES.INVALID_JSON)
  }
  return { type: type as FrameType, clientId, targetId, message }
}

/** Encode one frame to its JSON wire form; throws when it exceeds 1950 chars. */
export function encodeFrame(frame: SocketFrame): string {
  const json = JSON.stringify({
    type: frame.type,
    clientId: frame.clientId,
    targetId: frame.targetId,
    message: frame.message,
  })
  if (json.length > MAX_FRAME_LENGTH) {
    throw new CoyoteError(
      `encoded frame exceeds ${MAX_FRAME_LENGTH} characters (${json.length})`,
      ERROR_CODES.MESSAGE_TOO_LONG,
    )
  }
  return json
}

const STRENGTH_DOMAIN_MAX = 200

function assertStrengthValue(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > STRENGTH_DOMAIN_MAX) {
    throw new CoyoteError(`${what} must be an integer from 0 to ${STRENGTH_DOMAIN_MAX}`)
  }
}

/** Map a letter channel to the numeric channel used by strength and clear commands. */
export function channelNumber(channel: Channel): 1 | 2 {
  return channel === 'A' ? 1 : 2
}

/** Build a strength command message: strength-{1|2}+{0|1|2}+{0..200}. */
export function strengthCommand(channel: Channel, action: StrengthAction, value: number): string {
  assertStrengthValue(value, 'strength value')
  return `strength-${channelNumber(channel)}+${action}+${value}`
}

/** Parse an App strength report `strength-A+B+limitA+limitB` in the 0-200 domain. */
export function parseStrengthReport(message: string): DeviceStrength {
  const parts = message.split('+')
  // parts[0] carries the "strength-" prefix joined to the channel A value,
  // because the protocol embeds the value directly: strength-11+7+100+35.
  if (parts.length !== 4 || !parts[0]!.startsWith('strength-')) {
    throw new CoyoteError(`malformed strength report: ${message}`)
  }
  const channelA = Number.parseInt(parts[0]!.slice('strength-'.length), 10)
  const values = [channelA, ...parts.slice(1).map(part => Number.parseInt(part, 10))]
  for (const value of values) {
    if (!Number.isInteger(value) || value < 0 || value > STRENGTH_DOMAIN_MAX) {
      throw new CoyoteError(`strength report value out of range: ${message}`)
    }
  }
  const [a, b, limitA, limitB] = values as [number, number, number, number]
  return { a, b, limitA, limitB }
}

/** Build a pulse message: pulse-{A|B}:["hex",...] with the official 100-entry cap. */
export function pulseMessage(channel: Channel, entries: readonly string[]): string {
  if (entries.length === 0) throw new CoyoteError('pulse message requires at least one entry')
  if (entries.length > MAX_PULSE_ENTRIES) {
    throw new CoyoteError(`pulse message exceeds ${MAX_PULSE_ENTRIES} entries`, ERROR_CODES.MESSAGE_TOO_LONG)
  }
  return `pulse-${channel}:${JSON.stringify(entries)}`
}

/** Parse a pulse message back into its channel and hex entries (test/mock use). */
export function parsePulseMessage(message: string): { channel: Channel; entries: string[] } {
  const colon = message.indexOf(':')
  if (colon === -1) throw new CoyoteError(`malformed pulse message: ${message}`)
  const head = message.slice(0, colon)
  if (head !== 'pulse-A' && head !== 'pulse-B') {
    throw new CoyoteError(`malformed pulse channel: ${head}`)
  }
  let entries: unknown
  try {
    entries = JSON.parse(message.slice(colon + 1))
  } catch {
    throw new CoyoteError(`pulse entries are not a JSON array: ${message}`)
  }
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) {
    throw new CoyoteError(`pulse entries are not a JSON array of strings: ${message}`)
  }
  return { channel: head === 'pulse-A' ? 'A' : 'B', entries: entries as string[] }
}

/** Build a queue-clear message: clear-{1|2} (numeric channel per protocol). */
export function clearMessage(channel: Channel): string {
  return `clear-${channelNumber(channel)}`
}

/** Recognize an App feedback message `feedback-{0..9}`; returns undefined otherwise. */
export function parseFeedback(message: string): AppFeedback | undefined {
  if (!message.startsWith('feedback-')) return undefined
  const index = Number.parseInt(message.slice('feedback-'.length), 10)
  if (!Number.isInteger(index) || index < 0 || index > 9) return undefined
  return { index, channel: index < 5 ? 'A' : 'B' }
}

/** Frame the server sends to acknowledge a successful bind (code 200). */
export function bindOkFrame(controlId: string, appClientId: string): SocketFrame {
  return { type: 'bind', clientId: controlId, targetId: appClientId, message: ERROR_CODES.OK }
}

/** Frame the server sends to report an error code to one endpoint. */
export function errorFrame(targetId: string, code: string): SocketFrame {
  return { type: 'error', clientId: '', targetId, message: code }
}

/** Frame either side sends as a heartbeat ping (official backend uses "200"). */
export function heartbeatFrame(clientId: string, targetId: string): SocketFrame {
  return { type: 'heartbeat', clientId, targetId, message: ERROR_CODES.OK }
}

/** Frame the server sends when it drops the connection. */
export function breakFrame(controlId: string, appClientId: string, code: string): SocketFrame {
  return { type: 'break', clientId: controlId, targetId: appClientId, message: code }
}
