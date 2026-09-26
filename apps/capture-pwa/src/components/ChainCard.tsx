import { useEffect, useState } from 'react';

import { T } from '../theme';
import { linkChain, resolveChain, type ChainLevel } from '../api';
import type { Company } from '../db';
import { IconCheck, IconPlus } from '../icons';
import { CompanyPicker } from './CompanyPicker';
import { t } from '../i18n';

/**
 * 渠道链（D54）—— `distributor → subDistributor → dealer → subDealer → endUser`。
 *
 * 🔴 **这根轴和集团树是两回事。** 那份远程支持报告里写的
 * `KESSEL GmbH（终端）→ KWR Reisemobile（经销商）→ Rovena（整车厂）→ Voltline`
 * 是渠道链 —— KWR 并不拥有 Rovena。混进 `parentCompany` 那棵树之后，
 * 「这个集团下面有几个品牌」和「这家经销商下面有几个终端客户」会同时算错。
 *
 * ⚠️ **agent 只提议，不建。** 名单里没有的那几层，是人在这里点「新建」才建的
 * —— 而且走的是和别处同一套强制查重（§4.2 第3条）。
 */
/** 存中文规范形式，渲染时才过 `t()`（D80 判据）—— 模块级 `t()` 在 import 时就定死语言了。 */
const ROLE_LABEL: Record<string, string> = {
  DISTRIBUTOR: '分销商',
  SUB_DISTRIBUTOR: '二级分销商',
  DEALER: '经销商',
  SUB_DEALER: '二级经销商',
  END_USER: '终端客户',
};

export const ChainCard = ({ chain }: { chain: Array<{ name: string; role: string }> }) => {
  const [levels, setLevels] = useState<ChainLevel[] | null>(null);
  /** 人在这里补上的（新建或从候选里挑的），按下标覆盖 matched。 */
  const [picked, setPicked] = useState<Record<number, Company>>({});
  const [creating, setCreating] = useState<number | null>(null);
  const [msg, setMsg] = useState('');
  const [linked, setLinked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void resolveChain(chain).then(setLevels);
  }, [JSON.stringify(chain)]);

  if (!levels?.length) return null;

  const idOf = (i: number) => picked[i]?.id ?? levels[i]!.matched?.id ?? null;
  const allResolved = levels.every((_, i) => idOf(i));

  const doLink = async () => {
    setBusy(true);
    setMsg('');
    try {
      const n = await linkChain(levels.map((_, i) => idOf(i)!));
      setLinked(true);
      setMsg(t('已建立 {a} 段链路', { a: n }));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (creating !== null) {
    return (
      <div style={wrap}>
        <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 8 }}>
          {t('新建「{a}」（{b}）', {
            a: levels[creating]!.name,
            b: t(ROLE_LABEL[levels[creating]!.role] ?? levels[creating]!.role),
          })}
        </div>
        <CompanyPicker
          suggested={levels[creating]!.name}
          onPick={(c) => {
            setPicked((p) => ({ ...p, [creating]: c }));
            setCreating(null);
          }}
        />
        <button className="btn ghost sm" style={{ width: '100%', marginTop: 10 }} onClick={() => setCreating(null)}>
          {t('取消')}
        </button>
      </div>
    );
  }

  return (
    <div style={wrap}>
      <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 8 }}>
        {t('渠道链')}
        <span style={{ color: T.textLight }}> {t('—— 上游在前，终端客户在最后')}</span>
      </div>

      {levels.map((lv, i) => {
        const got = picked[i] ?? lv.matched;
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0' }}>
            <span style={{ fontSize: 11, color: T.textLight, width: 62, flexShrink: 0 }}>
              {t(ROLE_LABEL[lv.role] ?? lv.role)}
            </span>
            <span style={{ flex: 1, fontSize: 14 }}>{got?.name ?? lv.name}</span>
            {got ? (
              <span style={{ color: T.green, display: 'flex' }}>
                <IconCheck size={15} />
              </span>
            ) : (
              <button className="chip" style={{ height: 26, fontSize: 12 }} onClick={() => setCreating(i)}>
                <IconPlus size={13} /> {t('名单里没有')}
              </button>
            )}
          </div>
        );
      })}

      {msg && (
        <div style={{ fontSize: 12, color: linked ? T.green : T.red, marginTop: 8 }}>{msg}</div>
      )}

      {!linked && (
        <button
          className="btn ghost sm"
          style={{ width: '100%', marginTop: 10 }}
          disabled={!allResolved || busy}
          onClick={() => void doLink()}
        >
          {allResolved ? '建立这条链路' : t('还有没对上的')}
        </button>
      )}
    </div>
  );
};

const wrap: React.CSSProperties = {
  background: T.s2,
  borderRadius: 14,
  padding: '12px 14px',
  marginBottom: 12,
};
