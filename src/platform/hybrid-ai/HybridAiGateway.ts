export type HybridAiInitialization =
  | { state: 'ready'; capabilityCount: number; packageVersion: string }
  | { state: 'unavailable'; code: string; packageVersion: string };

export interface HybridAiGateway {
  initialize(): Promise<HybridAiInitialization>;
}
