declare module 'claude-code' {
  interface PluginState {
    callboard: {
      upkeep: {
        req: { focus: string; continuation: string; phase: 'called' | 'armed' | 'compacting' | 'compacted'; at: number; compactingAt?: number; sid: string; doneAt?: number } | null
        counters: { lastCompactMs?: number; lastNudgeMs?: number; lastNudgeKind?: 'idle' | 'working' | 'cache'; nudgeTimes?: readonly number[] }
        due: { at: number; again?: true } | null
        turnEnd?: number
        realEnd?: number
        pingAt?: number
        restAt?: number
      }
    }
  }
}
