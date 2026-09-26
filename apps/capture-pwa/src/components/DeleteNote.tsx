import { useState } from 'react';

import { T } from '../theme';
import { db, type Note } from '../db';
import { deleteNote, fetchDeletionPreview, type DeletionPreview } from '../api';
import { t } from '../i18n';
import { Backdrop } from './Backdrop';

/**
 * ══════════════════════════════════════════════════════════════════
 *  删掉一条速记 —— **全应用唯一的一份实现**（D93 · issue #25 / #34）
 *
 *  两个入口共用它：
 *    · 速记列表每一行右边那个垃圾桶（D105 · issue #34）
 *    · 单条详情页右上角那个垃圾桶（D96 · issue #27）
 *
 *  🔴 抽成一份不是为了少写几行 —— 这个仓库最贵的 bug 全是
 *     「同一件事两处实现，其中一处后来错了」。而这件事有三处很容易错：
 *       ① 先服务端后本地的顺序（反了就会「删了又自己回来」）
 *       ② 没传上去的那条**没有 stagingId**，删掉是真没了，话得说不一样
 *       ③ 已入库的要说清「CRM 里那几条不动」（维护者 明确分开的两件事）
 *
 *  ⚠️ 这个 hook **不删 CRM 里的任何东西**，一个 CRM 请求都不发。
 *     那是看板那一侧的事（`deleteRecord`，`record_deleted_at`）。
 * ══════════════════════════════════════════════════════════════════ */

/** 没有 stagingId 的那些（还没传上去）。删掉就真的没了 —— 确认框上必须说。 */
const LOCAL_ONLY: DeletionPreview = {
  status: 'local',
  noteDeletedAt: null,
  recordDeletedAt: null,
  committed: false,
  records: [],
  summary: '',
  skipped: [],
  source: 'none',
};

/** 问不到服务端（离线）。**不假装知道** —— 说明白「问不到」，让人自己决定。 */
const UNKNOWN_PREVIEW: DeletionPreview = { ...LOCAL_ONLY, status: 'unknown' };

export const useNoteDelete = ({ onDeleted }: { onDeleted?: (note: Note) => void } = {}) => {
  /** 正在问哪一条。`null` = 没在删。 */
  const [target, setTarget] = useState<Note | null>(null);
  /** `'loading'` = 正在问服务端「按下去会删掉什么」。 */
  const [preview, setPreview] = useState<DeletionPreview | null | 'loading'>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  /** 点了「删除」→ 先问服务端「按下去会牵扯到什么」，再把那句话放进确认框。 */
  const ask = async (note: Note) => {
    if (deleting) return;
    setError('');
    setTarget(note);
    // 还没传上去的没有 stagingId：那就是一条只存在于这台手机上的记录
    if (!note.stagingId) return setPreview(LOCAL_ONLY);
    setPreview('loading');
    const p = await fetchDeletionPreview(note.stagingId);
    setPreview(p ?? UNKNOWN_PREVIEW);
  };

  const confirm = async () => {
    const note = target;
    if (!note) return;
    setTarget(null);
    setPreview(null);
    setDeleting(true);
    setError('');
    try {
      /**
       * 🔴 **顺序是承重的：先服务端，后本地。**
       * 反过来的话，服务端那一步失败时本地已经删了 ——
       * 下一次 `pullInbox()` 会把它原样拉回来，人看到的是「删了又自己回来了」。
       */
      if (note.stagingId) await deleteNote(note.stagingId);
      await db.notes.delete(note.id);
      onDeleted?.(note);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDeleting(false);
    }
  };

  const cancel = () => {
    setTarget(null);
    setPreview(null);
  };

  return {
    ask,
    /** 正在删（两个入口都拿它把按钮变灰）。 */
    deleting,
    /** 删失败的原话。**调用方必须把它显示出来** —— 静默失败等于假装删掉了。 */
    error,
    setError,
    /** 确认框。渲染在页面里就行，没在删时是 `null`。 */
    sheet: target ? (
      <DeleteNoteSheet
        preview={preview === 'loading' ? null : preview}
        uploaded={Boolean(target.remoteId)}
        onCancel={cancel}
        onConfirm={() => void confirm()}
      />
    ) : null,
  };
};

/**
 * 🔴 **这个框存在的全部理由是「说清楚会发生什么」**，不是再问一次「确定吗」。
 *
 * 维护者 的要求是「删除要有 double check 的确认按钮，不能因为误触删除」。
 * 一个写着「确定删除吗？」的框拦不住误触 —— 人会条件反射地点确定。
 * 拦得住的是一个说出**这一下的后果和它的边界**的框：
 *   · 已入库的 → **CRM 里那几条不动**（维护者 明确要的），这句必须在
 *   · 没传上去的 → 只在这台手机上，删了就真没了
 *   · 传上去了的 → 原话和音频都留在服务端，随时能撤销
 */
const DeleteNoteSheet = ({
  preview,
  uploaded,
  onCancel,
  onConfirm,
}: {
  preview: DeletionPreview | null;
  uploaded: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) => {
  const localOnly = !uploaded || preview?.status === 'local';
  const committed = preview?.committed === true;

  return (
    <Backdrop onClose={onCancel}>
      <div style={{ fontSize: 15.5, fontWeight: 600, marginBottom: 8 }}>{t('删掉这条速记？')}</div>
      {!preview ? (
        <div style={{ fontSize: 13, color: T.textLight }}>{t('正在看它牵扯到什么…')}</div>
      ) : (
        <div style={{ fontSize: 12.5, color: T.textSoft, lineHeight: 1.8 }}>
          {localOnly ? (
            <b style={{ color: T.red }}>
              {t('这条还没传上去 —— 只存在于这台手机上，删掉就找不回来了。')}
            </b>
          ) : (
            <>
              {t('它会从速记列表里消失。原话和录音都留在服务端，随时可以撤销。')}
              {/* 🔴 这一句是 维护者 原话里明确分开的那件事，一个字都不能省。
                  ⚠️ 加粗用 `<b>` 而不是 `**…**` —— 这一层没有 markdown 解析，
                     星号会原样显示成字面量（issue #7 那个坑的同一个形状）。 */}
              {committed && (
                <div style={{ marginTop: 6, color: T.text }}>
                  ⚠️ {t('这条已经入库了 —— CRM 里那几条记录')}
                  <b>{t('不会')}</b>
                  {t('被删掉。')}
                  <br />
                  {t('要删 CRM 里的，去「看板」上删那一行。')}
                </div>
              )}
              {preview.status === 'unknown' && (
                <div style={{ marginTop: 6, color: T.amber }}>
                  {t('现在离线，查不到它在服务端是什么状态 —— 有网时再删比较稳妥。')}
                </div>
              )}
            </>
          )}
        </div>
      )}
      <div style={{ display: 'flex', gap: 9, marginTop: 16 }}>
        <button
          className="btn"
          style={{ flex: 1, background: T.s3, color: T.text, boxShadow: 'none' }}
          onClick={onCancel}
        >
          {t('不删')}
        </button>
        <button
          className="btn"
          style={{ flex: 1, background: T.red, color: '#fff', boxShadow: 'none' }}
          onClick={onConfirm}
        >
          {t('删除')}
        </button>
      </div>
    </Backdrop>
  );
};
