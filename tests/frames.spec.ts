import { describe, expect, it } from 'vitest'
import { CoyoteError } from '../src/errors.ts'
import {
  ERROR_CODES,
  bindOkFrame,
  clearMessage,
  encodeFrame,
  heartbeatFrame,
  parseFeedback,
  parseFrame,
  parsePulseMessage,
  parseStrengthReport,
  pulseMessage,
  strengthCommand,
} from '../src/protocol/frames.ts'

describe('frames', () => {
  it('round-trips every frame type through parse and encode', () => {
    const frame = { type: 'bind' as const, clientId: 'c-1', targetId: 'a-1', message: '200' }
    expect(parseFrame(encodeFrame(frame))).toEqual(frame)
    const hb = heartbeatFrame('c-1', 'a-1')
    expect(hb.type).toBe('heartbeat')
    expect(parseFrame(encodeFrame(hb))).toEqual(hb)
  })

  it('rejects non-JSON and non-frame input with the 403 concept', () => {
    expect(() => parseFrame('not json')).toThrow(CoyoteError)
    expect(() => parseFrame('[]')).toThrow(/JSON object/)
    expect(() => parseFrame('{"type":"nope","clientId":"","targetId":"","message":""}')).toThrow(/frame type/)
    expect(() => parseFrame('{"type":"msg","clientId":1,"targetId":"","message":""}')).toThrow(/string/)
  })

  it('refuses to encode frames over the 1950-character limit', () => {
    const frame = { type: 'msg' as const, clientId: '', targetId: '', message: 'x'.repeat(2000) }
    expect(() => encodeFrame(frame)).toThrow(/1950/)
  })

  it('builds strength commands with numeric channels and validated values', () => {
    expect(strengthCommand('A', 2, 35)).toBe('strength-1+2+35')
    expect(strengthCommand('B', 0, 20)).toBe('strength-2+0+20')
    expect(strengthCommand('A', 1, 5)).toBe('strength-1+1+5')
    expect(() => strengthCommand('A', 2, 201)).toThrow(/0 to 200/)
    expect(() => strengthCommand('A', 2, 1.5)).toThrow(/0 to 200/)
    expect(() => strengthCommand('B', 2, -1)).toThrow(/0 to 200/)
  })

  it('parses the documented strength report example', () => {
    expect(parseStrengthReport('strength-11+7+100+35')).toEqual({ a: 11, b: 7, limitA: 100, limitB: 35 })
    expect(() => parseStrengthReport('strength-11+7+100')).toThrow(/malformed/)
    expect(() => parseStrengthReport('strength-11+7+201+35')).toThrow(/range/)
  })

  it('builds pulse messages as JSON arrays and caps at 100 entries', () => {
    expect(pulseMessage('A', ['0a0a0a0a000a141e'])).toBe('pulse-A:["0a0a0a0a000a141e"]')
    expect(pulseMessage('B', ['a'.repeat(16), 'b'.repeat(16)])).toBe('pulse-B:["aaaaaaaaaaaaaaaa","bbbbbbbbbbbbbbbb"]')
    expect(() => pulseMessage('A', [])).toThrow(/at least one/)
    const hundred = Array.from({ length: 101 }, () => '0a0a0a0a000a141e')
    expect(() => pulseMessage('A', hundred)).toThrow(/100 entries/)
  })

  it('parses pulse messages back', () => {
    expect(parsePulseMessage('pulse-A:["0a0a0a0a000a141e","0a0a0a0a000a141e"]')).toEqual({
      channel: 'A',
      entries: ['0a0a0a0a000a141e', '0a0a0a0a000a141e'],
    })
    expect(() => parsePulseMessage('pulse-C:[]')).toThrow(/channel/)
    expect(() => parsePulseMessage('pulse-A:not-json')).toThrow(/JSON array/)
  })

  it('builds clear commands with the numeric channel the protocol requires', () => {
    expect(clearMessage('A')).toBe('clear-1')
    expect(clearMessage('B')).toBe('clear-2')
  })

  it('recognizes feedback buttons and maps them to channels', () => {
    expect(parseFeedback('feedback-0')).toEqual({ index: 0, channel: 'A' })
    expect(parseFeedback('feedback-5')).toEqual({ index: 5, channel: 'B' })
    expect(parseFeedback('strength-1+2+3+4')).toBeUndefined()
    expect(parseFeedback('feedback-10')).toBeUndefined()
    expect(parseFeedback('feedback-x')).toBeUndefined()
  })

  it('exposes the documented error code table', () => {
    expect(ERROR_CODES.OK).toBe('200')
    expect(ERROR_CODES.QR_NO_CLIENT_ID).toBe('210')
    expect(ERROR_CODES.MESSAGE_TOO_LONG).toBe('405')
    expect(bindOkFrame('c', 'a').message).toBe('200')
  })
})
