import { useState } from 'react';

import { T } from '../theme';
import { login, AuthError } from '../auth';
import { t } from '../i18n';

/**
 * 登录页。整个采集端的门。
 *
 * 刻意做得极简：展台上是单手操作，代号 + 密码两个框，回车即走。
 * 没有「注册」「忘记密码」—— 账号由 `cli-adduser.ts` 在服务器上建，
 * 密码随机生成且只打印一次（D35④：凭据永不进 Twenty，也不走自助流程）。
 */
export const LoginPage = () => {
  const [userCode, setUserCode] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy || !userCode.trim() || !password) return;
    setBusy(true);
    setErr(null);
    try {
      await login(userCode, password);
      // 成功后不用做别的 —— App 订阅了登录态变化，会自己切过去
    } catch (e2) {
      setErr(e2 instanceof AuthError ? e2.message : (e2 as Error).message);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        padding: '0 28px',
        paddingTop: 'env(safe-area-inset-top)',
        paddingBottom: 'env(safe-area-inset-bottom)',
        background: T.bg,
      }}
    >
      <div style={{ marginBottom: 32 }}>
        <div style={{ fontSize: 23, fontWeight: 700, letterSpacing: -0.3 }}>{t('现场速记')}</div>
        <div style={{ fontSize: 13.5, color: T.textSoft, marginTop: 6, lineHeight: 1.6 }}>
          Boothnote
        </div>
      </div>

      <form onSubmit={(e) => void submit(e)}>
        <label style={label}>{t('代号')}</label>
        <input
          value={userCode}
          onChange={(e) => setUserCode(e.target.value)}
          // 手机键盘默认会首字母大写并尝试自动更正 —— 代号是小写标识符，全要关掉
          autoCapitalize="none"
          autoCorrect="off"
          autoComplete="username"
          spellCheck={false}
          enterKeyHint="next"
          placeholder="alex"
          style={input}
        />

        <label style={{ ...label, marginTop: 16 }}>{t('密码')}</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          enterKeyHint="go"
          placeholder="••••••••"
          style={input}
        />

        {err && (
          <div
            style={{
              marginTop: 16,
              padding: '11px 13px',
              borderRadius: 10,
              background: T.redSoft,
              color: T.red,
              fontSize: 13,
              lineHeight: 1.6,
            }}
          >
            {err}
          </div>
        )}

        <button
          type="submit"
          disabled={busy || !userCode.trim() || !password}
          style={{
            width: '100%',
            marginTop: 24,
            padding: '14px 0',
            borderRadius: 12,
            background: busy || !userCode.trim() || !password ? T.line : T.text,
            color: '#fff',
            fontSize: 15.5,
            fontWeight: 600,
          }}
        >
          {busy ? '登录中…' : t('登录')}
        </button>
      </form>

      <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 22, lineHeight: 1.7 }}>
        {t('账号由管理员创建。忘记密码找管理员重置 —— 没有自助找回。')}
      </div>
    </div>
  );
};

const label: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: T.textSoft,
  marginBottom: 6,
};

const input: React.CSSProperties = {
  width: '100%',
  padding: '13px 14px',
  fontSize: 16, // 🔴 ≥16px：iOS Safari 在更小的字号上会**自动放大整个页面**
  border: `1px solid ${T.lineLight}`,
  borderRadius: 10,
  background: T.bg,
};
