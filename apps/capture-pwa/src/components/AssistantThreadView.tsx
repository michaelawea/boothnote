import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useExternalStoreRuntime } from '@assistant-ui/react';
import { useEffect, type ReactNode } from 'react';
import type { ChatEntry } from '../message-projection';

export type AssistantThreadViewProps = {
  entries: ChatEntry[];
  running: boolean;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  renderMessage: (entry: ChatEntry) => ReactNode;
  children: ReactNode;
  onReady: (dispatch: ((text: string) => void) | null) => void;
};
const convertMessage = (entry: ChatEntry) => ({
  id: entry.key,
  role: entry.message.role === 'agent' ? 'assistant' as const : entry.message.role,
  content: [{ type: 'text' as const, text: entry.message.text }],
  createdAt: new Date(entry.message.created_at),
});

/** Only a view runtime. The gateway, outbox and all business actions remain host-owned. */
export default function AssistantThreadView({ entries, running, onSend, onCancel, renderMessage, children, onReady }: AssistantThreadViewProps) {
  const runtime = useExternalStoreRuntime<ChatEntry>({
    messages: entries,
    isRunning: running,
    convertMessage,
    onNew: async (message) => {
      const text = message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
      await onSend(text);
    },
    onCancel,
    // No setMessages/onDelete/onReload: immutable history and CRM corrections are host operations.
  });
  useEffect(() => {
    onReady((text) => runtime.thread.append({ role: 'user', content: [{ type: 'text', text }] }));
    return () => onReady(null);
  }, [runtime, onReady]);
  const byId = new Map(entries.map((entry) => [entry.key, entry]));
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadPrimitive.Root className="assistant-thread" data-agent-ui="development" style={{ display: 'flex', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <ThreadPrimitive.Viewport style={{ flex: 1, overflowY: 'auto', padding: '16px 14px' }}>
          <div style={{ maxWidth: 820, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <ThreadPrimitive.Messages>{({ message }) => {
              const entry = byId.get(message.id);
              // The host's WorkLog is the only running placeholder.
              return entry ? <MessagePrimitive.Root data-message-id={entry.key}>{renderMessage(entry)}</MessagePrimitive.Root> : null;
            }}</ThreadPrimitive.Messages>
            {children}
          </div>
        </ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
