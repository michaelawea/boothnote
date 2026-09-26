import { useEffect, useState } from 'react';
import { T } from '../theme';
import type { LocalAttachment, RemoteAttachment } from '../db';
import { attachmentBlob, humanSize, isImageMime, kindLabel } from '../attach';
import { authFetch } from '../auth';
import { t } from '../i18n';

/**
 * 附件清单 + 图片缩略图（issue #53 A1/A2）。
 *
 * 在这之前整个 PWA 没有一个 `<img>`：人拍了一张照片，能看到的最多是一行文件名，
 * 而且只在上传成功前的那几秒。两种来源走同一个组件：
 *   · 本地原件（还没传上去）—— 字节就在手边，`createObjectURL`
 *   · 服务端引用（传上去了 / 别的设备传的）—— `GET /attachments/:id/file` 带 token 取回来
 * 点缩略图在**原地**放大（这一行下面撑开一张大图），不开浮层 ——
 * 浮层叠浮层那一课（§2.46）不想再上一遍。
 */

/** 已传附件：id → object URL。一次展会几十张，不回收。失败的不留在缓存里，下次再试。 */
const remoteUrls = new Map<string, Promise<string>>();
export const remoteFileUrl = (id: string): Promise<string> => {
  let p = remoteUrls.get(id);
  if (!p) {
    p = authFetch(`/attachments/${id}/file`).then(async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return URL.createObjectURL(await res.blob());
    });
    p.catch(() => remoteUrls.delete(id));
    remoteUrls.set(id, p);
  }
  return p;
};

type Item = {
  key: string;
  kind: LocalAttachment['kind'];
  name: string;
  mime: string;
  size: number;
  /** 拿到能放进 `<img src>` 的地址；不是图片就没有。 */
  load: (() => Promise<string>) | null;
  /** 本地 object URL 用完要回收；服务端那份在缓存里，不回收。 */
  revoke: boolean;
};

const fromLocal = (a: LocalAttachment, i: number): Item => ({
  key: `l-${i}-${a.name}`,
  kind: a.kind,
  name: a.name,
  mime: a.mime,
  size: a.size,
  load: isImageMime(a.mime)
    ? () => {
        const b = attachmentBlob(a);
        return b ? Promise.resolve(URL.createObjectURL(b)) : Promise.reject(new Error('no blob'));
      }
    : null,
  revoke: true,
});

const fromRemote = (a: RemoteAttachment): Item => ({
  key: `r-${a.id}`,
  kind: a.kind,
  name: a.name,
  mime: a.mime,
  size: a.size,
  load: isImageMime(a.mime) ? () => remoteFileUrl(a.id) : null,
  revoke: false,
});

/** 图片地址。不是图片时什么都不做。 */
const useImageUrl = (item: Item) => {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    if (!item.load) return;
    let alive = true;
    let mine: string | null = null;
    setSrc(null);
    setErr(false);
    item
      .load()
      .then((u) => {
        if (!alive) return;
        mine = u;
        setSrc(u);
      })
      .catch(() => alive && setErr(true));
    return () => {
      alive = false;
      if (item.revoke && mine) URL.revokeObjectURL(mine);
    };
  }, [item.key]);
  return { src, err };
};

const THUMB: React.CSSProperties = {
  width: 56,
  height: 56,
  borderRadius: 10,
  flexShrink: 0,
  objectFit: 'cover',
  background: T.s3,
  display: 'block',
};

const Row = ({ item, onRemove }: { item: Item; onRemove?: () => void }) => {
  const { src, err } = useImageUrl(item);
  const [big, setBig] = useState(false);
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: item.load ? '6px 10px 6px 6px' : '9px 12px',
          background: T.s2,
          borderRadius: 12,
          fontSize: 13,
        }}
      >
        {item.load &&
          (err ? (
            <div style={{ ...THUMB, fontSize: 10, color: T.textLight, textAlign: 'center', lineHeight: '56px' }}>
              {t('取不到图片')}
            </div>
          ) : src ? (
            <img
              src={src}
              alt={item.name}
              onClick={() => setBig((b) => !b)}
              style={{ ...THUMB, cursor: 'zoom-in' }}
              title={t('看大图')}
            />
          ) : (
            <div style={THUMB} />
          ))}
        <span style={{ color: T.textLight, flexShrink: 0 }}>{kindLabel(item.kind)}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {item.name}
        </span>
        <span style={{ color: T.textLight, fontSize: 11.5, flexShrink: 0 }}>{humanSize(item.size)}</span>
        {onRemove && (
          <button onClick={onRemove} style={{ color: T.textLight, fontSize: 14, padding: '0 2px' }} aria-label={t('移除')}>
            ✕
          </button>
        )}
      </div>
      {big && src && (
        <img
          src={src}
          alt={item.name}
          onClick={() => setBig(false)}
          title={t('收起')}
          style={{
            width: '100%',
            maxHeight: '70vh',
            objectFit: 'contain',
            borderRadius: 10,
            display: 'block',
            background: T.s3,
            cursor: 'zoom-out',
          }}
        />
      )}
    </div>
  );
};

export const AttachmentList = ({
  local,
  remote,
  onRemove,
}: {
  local?: LocalAttachment[];
  remote?: RemoteAttachment[];
  /** 还没存的那几条可以移除（速记页输入区）。 */
  onRemove?: (index: number) => void;
}) => {
  // 本地原件优先：它在的时候服务端那份要么还没有，要么就是同一批
  const items: Item[] = local?.length ? local.map(fromLocal) : (remote ?? []).map(fromRemote);
  if (!items.length) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {items.map((it, i) => (
        <Row key={it.key} item={it} onRemove={onRemove ? () => onRemove(i) : undefined} />
      ))}
    </div>
  );
};
