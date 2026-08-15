/**
 * QR payload assembly for App pairing.
 *
 * The App only accepts QR content of the exact shape
 * `https://www.dungeon-lab.com/app-download.php#DGLAB-SOCKET#{wsUrl}/{controlId}`
 * with exactly two `#` separators and nothing between the WebSocket URL and
 * the control id. Source: DG-LAB-OPENSOURCE socket/README.md, 终端二维码.
 */

import { CoyoteError } from '../errors.ts'

/** Official App download URL prefix required by the QR format. */
export const QR_PREFIX = 'https://www.dungeon-lab.com/app-download.php'

/** Protocol tag required by the QR format. */
export const QR_TAG = 'DGLAB-SOCKET'

/** Build the QR payload the App scans to reach this server. */
export function buildQrPayload(wsUrl: string, controlId: string): string {
  const ws = wsUrl.trim()
  if (ws.length === 0) throw new CoyoteError('wsUrl cannot be empty')
  if (!ws.startsWith('ws://') && !ws.startsWith('wss://')) {
    throw new CoyoteError('wsUrl must start with ws:// or wss://')
  }
  if (ws.includes('#')) throw new CoyoteError('wsUrl cannot contain #')
  const id = controlId.trim()
  if (id.length === 0) throw new CoyoteError('controlId cannot be empty')
  if (id.includes('#') || id.includes('/')) throw new CoyoteError('controlId cannot contain # or /')
  return `${QR_PREFIX}#${QR_TAG}#${ws}/${id}`
}

/** Split a QR payload back into its wsUrl and controlId (round-trip check). */
export function parseQrPayload(payload: string): { wsUrl: string; controlId: string } {
  const parts = payload.split('#')
  if (parts.length !== 3 || parts[0] !== QR_PREFIX || parts[1] !== QR_TAG) {
    throw new CoyoteError('malformed QR payload')
  }
  const tail = parts[2] ?? ''
  const schemeEnd = tail.indexOf('://')
  if (schemeEnd === -1) throw new CoyoteError('QR payload must carry a WebSocket URL')
  const slash = tail.lastIndexOf('/')
  if (slash <= schemeEnd + 2 || slash === tail.length - 1) {
    throw new CoyoteError('QR payload must end with wsUrl/controlId')
  }
  const wsUrl = tail.slice(0, slash)
  if (!wsUrl.startsWith('ws://') && !wsUrl.startsWith('wss://')) {
    throw new CoyoteError('QR payload wsUrl must start with ws:// or wss://')
  }
  return { wsUrl, controlId: tail.slice(slash + 1) }
}
