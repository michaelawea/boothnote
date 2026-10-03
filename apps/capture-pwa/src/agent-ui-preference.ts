import { useSyncExternalStore } from 'react';
import { browserStore, type DraftStore } from './draft';

export type AgentUi = 'current' | 'development';
export const assistantUiAvailable = import.meta.env.VITE_ASSISTANT_UI_ENABLED !== '0';
export const agentUiKey = (userCode: string) => `boothnote-agent-ui:${userCode}`;

/** A local display preference, never an authorization or a data sandbox. */
export const readAgentUi = (store: DraftStore | undefined, userCode: string, enabled = true): AgentUi => {
  try {
    return enabled && store?.getItem(agentUiKey(userCode)) === 'development' ? 'development' : 'current';
  } catch {
    return 'current';
  }
};

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());
export const writeAgentUi = (store: DraftStore | undefined, userCode: string, next: AgentUi): boolean => {
  try {
    if (!store) return false;
    store.setItem(agentUiKey(userCode), next);
    notify();
    return true;
  } catch {
    return false;
  }
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};
export const useAgentUi = (userCode: string): AgentUi =>
  useSyncExternalStore(subscribe, () => readAgentUi(browserStore(), userCode, assistantUiAvailable), () => 'current');
