// @vitest-environment happy-dom
import { act, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { ChatViewBoundary } from '../components/ChatViewBoundary';

it('a failed experimental render mounts current once while the owning draft and queue survive', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const send = vi.fn(); const mounted = vi.fn(); const changeView = vi.fn();
  const Current = () => { useEffect(() => { mounted(); }, []); return <div data-current>current history</div>; };
  const Broken = (): never => { throw new Error('experimental render failed'); };
  const Controller = () => {
    const [text] = useState('unsent draft with attachments');
    return <><textarea value={text} readOnly /><button onClick={send}>send</button>
      <ChatViewBoundary fallback={<Current />} onFallback={changeView}><Broken /></ChatViewBoundary></>;
  };
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<Controller />));
    expect(node.querySelector('textarea')!.value).toBe('unsent draft with attachments');
    expect(node.querySelectorAll('[data-current]')).toHaveLength(1);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled(); expect(changeView).not.toHaveBeenCalled();
    expect(node.querySelector('[role="alert"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount()); node.remove(); errors.mockRestore(); vi.unstubAllGlobals();
  }
});
