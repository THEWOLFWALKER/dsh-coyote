/** Channel and state vocabulary shared by every layer of dsh-coyote. */

/** Physical output channel of the Coyote host. */
export type Channel = 'A' | 'B'

/** Channel addressing accepted by tools and the GUI. */
export type ChannelSelection = 'A' | 'B' | 'both'

/** Waveform playback mode. */
export type PlayMode = 'once' | 'loop'

/** Connection lifecycle of the transport. */
export type ConnectionState = 'idle' | 'waiting-app' | 'bound'

/**
 * Device-reported strengths in the raw 0-200 protocol domain.
 * Values arrive from the App as `strength-A+B+limitA+limitB` reports.
 */
export interface DeviceStrength {
  /** Channel A current strength. */
  a: number
  /** Channel B current strength. */
  b: number
  /** Channel A hard limit configured on the App side. */
  limitA: number
  /** Channel B hard limit configured on the App side. */
  limitB: number
}

/** App-side icon feedback button index (A: 0-4, B: 5-9). */
export interface AppFeedback {
  /** Zero-based button index in the range 0-9. */
  index: number
  /** Channel the button belongs to. */
  channel: Channel
}
