import { describe, expect, it } from 'vitest'
import { CoyoteError } from '../src/errors.ts'
import { buildQrPayload, parseQrPayload } from '../src/protocol/qr.ts'

describe('qr payload', () => {
  it('builds the exact three-segment shape the App requires', () => {
    expect(buildQrPayload('ws://192.168.1.5:54321', 'ctl-1234'))
      .toBe('https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://192.168.1.5:54321/ctl-1234')
  })

  it('round-trips through the parser', () => {
    const payload = buildQrPayload('wss://example.com/ws', 'id-42')
    expect(parseQrPayload(payload)).toEqual({ wsUrl: 'wss://example.com/ws', controlId: 'id-42' })
  })

  it('rejects payloads that would break App scanning', () => {
    expect(() => buildQrPayload('http://x', 'id')).toThrow(/ws:\/\//)
    expect(() => buildQrPayload('ws://a#b', 'id')).toThrow(/#/)
    expect(() => buildQrPayload('ws://a', 'id/1')).toThrow(/# or \//)
    expect(() => buildQrPayload('ws://a', '')).toThrow(/empty/)
    expect(() => parseQrPayload('https://evil.example#DGLAB-SOCKET#ws://a/1')).toThrow(/malformed/)
    expect(() => parseQrPayload('https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#ws://a')).toThrow(/wsUrl\/controlId/)
  })
})
