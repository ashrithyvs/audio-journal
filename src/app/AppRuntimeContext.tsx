import React, {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
  useState,
} from 'react';

import type {
  HybridAiGateway,
  HybridAiInitialization,
} from '../platform/hybrid-ai/HybridAiGateway';

type RuntimeState = { state: 'initializing' } | HybridAiInitialization;

const RuntimeContext = createContext<RuntimeState>({ state: 'initializing' });

export function AppRuntimeProvider({
  children,
  hybridAI,
}: PropsWithChildren<{ hybridAI: HybridAiGateway }>) {
  const [runtime, setRuntime] = useState<RuntimeState>({
    state: 'initializing',
  });

  useEffect(() => {
    let live = true;
    hybridAI.initialize().then(result => {
      if (live) {
        setRuntime(result);
      }
    });
    return () => {
      live = false;
    };
  }, [hybridAI]);

  return (
    <RuntimeContext.Provider value={runtime}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useAppRuntime(): RuntimeState {
  return useContext(RuntimeContext);
}
