import { Component, type ReactNode } from 'react';
import { t } from '../i18n';

/** Located below the controller: falling back cannot replay a send or discard a composer. */
export class ChatViewBoundary extends Component<{
  children: ReactNode;
  fallback: ReactNode;
  onFallback: () => void;
}, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <>{this.props.fallback}<div role="alert" style={{ padding: 10 }}>
      {t('开发测试版未能加载，已显示现行版。')}
      <button className="btn ghost sm" onClick={this.props.onFallback}>{t('使用现行版')}</button>
    </div></> : this.props.children;
  }
}
