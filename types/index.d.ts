export type Totals = { input: number; output: number; cache: number };

export type Snapshot = {
  pct5h?: number;
  reset5h?: number;
  pct7d?: number;
  reset7d?: number;
  contextPct?: number;
};

declare module 'claude-code' {
  interface PluginState {
    'claude-mod-status': {
      totals: Totals;
      snapshot: Snapshot;
      warned5h: number[];
      warned7d: number[];
      reset5h: string | null;
      reset7d: string | null;
    };
  }
}
