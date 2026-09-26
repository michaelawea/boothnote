import { useState } from 'react';

import { T } from '../theme';
import { probe } from '../recorder';
import { IconMic, IconShare } from '../icons';
import { t } from '../i18n';

const KEY = 'boothnote-onboarded';

export const needsOnboarding = () => !localStorage.getItem(KEY);
export const markOnboarded = () => localStorage.setItem(KEY, '1');

/**
 * 首次引导。**只有两屏，而且两屏都是「不做会出事」的那种。**
 *
 * 这两屏不是产品经理想加的欢迎流程 —— 它们各自对应一个具体的失败：
 *
 *   ① 不装到主屏幕 → 每次都要在 Safari 里找那个网址。展馆里没人会找，
 *      结果就是不用。装了之后它是一个 App 图标，和微信一样点开就用。
 *
 *   ② 麦克风：**iOS 在你点了「不允许」之后，不会再问第二次。**
 *      要恢复得进设置里翻。所以必须在弹出系统对话框**之前**先解释一句，
 *      不能让人在毫无预期时看到那个框然后随手点掉。这一屏挽回的是
 *      「这台手机再也录不了音」——它是不可逆的。
 */
export const Onboarding = ({ onDone }: { onDone: () => void }) => {
  const [step, setStep] = useState(0);
  const [micState, setMicState] = useState<'idle' | 'ok' | 'denied'>('idle');
  const d = probe();

  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true;

  const askMic = async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      setMicState('ok');
    } catch {
      setMicState('denied');
    }
  };

  const finish = () => {
    markOnboarded();
    onDone();
  };

  return (
    <div
      style={{
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        padding: '0 26px',
        paddingTop: 'calc(env(safe-area-inset-top) + 60px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 28px)',
        background: T.bg,
      }}
    >
      {step === 0 && (
        <>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.6 }}>{t('先装到主屏幕')}</div>
          <div style={{ fontSize: 15, color: T.textSoft, lineHeight: 1.85, marginTop: 14 }}>
            {t('展馆里你不会想在浏览器里找网址。装完它就是一个图标，点开就录。')}
          </div>

          {standalone ? (
            <div style={{ ...tip, background: T.greenSoft, color: T.green, marginTop: 22 }}>
              {t('已经装好了 —— 你现在就是从主屏幕打开的。')}
            </div>
          ) : isIOS ? (
            <div style={{ ...tip, marginTop: 22 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <IconShare size={18} />
                <b>{t('底部的分享键')}</b>
              </div>
              {t('往下翻，点「添加到主屏幕」，再点右上角「添加」。')}
              <div style={{ color: T.textLight, marginTop: 8, fontSize: 12.5 }}>
                {t('必须用 Safari。从微信或邮件里打开的话，先点右上角在 Safari 中打开。')}
              </div>
            </div>
          ) : (
            <div style={{ ...tip, marginTop: 22 }}>
              {t('地址栏右边有个「安装」图标，点它。没有的话，浏览器菜单里也有「安装应用」。')}
            </div>
          )}

          <div style={{ flex: 1 }} />
          <button className="btn" style={{ width: '100%' }} onClick={() => setStep(1)}>
            {t('装好了，下一步')}
          </button>
          <button
            style={{ marginTop: 12, fontSize: 13, color: T.textLight, width: '100%' }}
            onClick={() => setStep(1)}
          >
            {t('先跳过')}
          </button>
        </>
      )}

      {step === 1 && (
        <>
          <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: -0.6 }}>{t('接下来会问麦克风')}</div>
          <div style={{ fontSize: 15, color: T.textSoft, lineHeight: 1.85, marginTop: 14 }}>
            {t('这个应用的主要用法是')}<b>{t('按一下说话')}</b>{t('，所以要用麦克风。')}
          </div>
          <div style={{ ...tip, background: T.amberSoft, color: T.amber, marginTop: 18 }}>
            🔴 <b>{t('点「允许」。')}</b>
            <div style={{ marginTop: 6, lineHeight: 1.8 }}>
              {t('iPhone 在你点过一次「不允许」之后')}<b>{t('不会再问第二次')}</b>
              {t(' —— ')}
              {t('要恢复得进「设置 → Safari → 麦克风」里翻出来。所以这一下别点错。')}
            </div>
          </div>

          {!d.secureContext && (
            <div style={{ ...tip, background: T.redSoft, color: T.red, marginTop: 12 }}>
              {t('当前不是 https，浏览器根本不会给麦克风。把地址换成 https 的那个。')}
            </div>
          )}

          {micState === 'ok' && (
            <div style={{ ...tip, background: T.greenSoft, color: T.green, marginTop: 12 }}>
              {t('麦克风好了。容器：')}
              {d.chosen ?? t('（协商中）')}
            </div>
          )}
          {micState === 'denied' && (
            <div style={{ ...tip, background: T.redSoft, color: T.red, marginTop: 12 }}>
              {t('被拒了。进「设置 → Safari → 麦克风」改成允许，然后重新打开这个应用。')}
              <div style={{ marginTop: 6 }}>{t('在那之前，打字和上传附件照常能用。')}</div>
            </div>
          )}

          <div style={{ flex: 1 }} />
          {micState === 'idle' ? (
            <button className="btn" style={{ width: '100%' }} onClick={() => void askMic()}>
              <IconMic size={18} /> {t('现在授权')}
            </button>
          ) : (
            <button className="btn" style={{ width: '100%' }} onClick={finish}>
              {t('开始用')}
            </button>
          )}
          <button
            style={{ marginTop: 12, fontSize: 13, color: T.textLight, width: '100%' }}
            onClick={finish}
          >
            {t('以后再说')}
          </button>
        </>
      )}
    </div>
  );
};

const tip: React.CSSProperties = {
  background: T.s2,
  borderRadius: 14,
  padding: '14px 16px',
  fontSize: 14,
  lineHeight: 1.8,
  color: T.textSoft,
};
