import { db, type Note, type RemoteAttachment } from './db';
import { authFetch, authUpload, getSession, onAuthChange, AuthError } from './auth';
import { saveNoteText } from './api';
import { MOCK_UPLOAD } from './config';
import { shouldUpload, uploadTimeoutFor } from './retry';
import { attachmentBlob } from './attach';
import { t } from './i18n';

/**
 * 上传队列 —— **前台重试，不用 Background Sync API**。
 *
 * 已查证：Background Sync 在 iOS Safari 上不存在（Chrome/Android 才有）。
 * 展台上主力是 iPhone，所以整套重试必须在前台跑，靠这三个信号触发：
 *   ① 应用启动  ② `online` 事件  ③ 页面重新可见（切回 App / 解锁屏幕）
 * 外加一个低频轮询兜底。Android 上 Background Sync 只算白捡，不作为设计前提。
 */

type Listener = () => void;
const listeners = new Set<Listener>();
export const onSyncChange = (fn: Listener): (() => void) => {
  listeners.add(fn);
  // 返回 void 而不是 Set.delete 的 boolean —— 否则直接当 useEffect 的
  // 清理函数用会类型报错（React 的 Destructor 必须返回 void）
  return () => {
    listeners.delete(fn);
  };
};
const emit = () => listeners.forEach((f) => f());

/**
 * 每条速记的上传进度，`noteId → 0..1`（`-1` = 拿不到总大小，只能转圈）。
 *
 * 放在模块级而不是 React state：`flush()` 是在 React 之外跑的，
 * 而进度要给好几个界面看（速记列表、顶栏、AI 那一屏）。
 */
const progress = new Map<string, number>();
export const uploadProgress = (noteId: string): number | undefined => progress.get(noteId);
/** 有没有任何一条正在传 —— 顶栏那一格拿它决定要不要显示圈。 */
export const anyUploading = () => progress.size > 0;

let running = false;

/** 服务端回包里的附件清单 → 本地形状。回包里不是数组（老网关只回数量）就当没有。 */
const toRemote = (raw: unknown): RemoteAttachment[] | undefined => {
  if (!Array.isArray(raw)) return undefined;
  const list = raw
    .filter((a): a is Record<string, any> => Boolean(a && typeof a === 'object' && a.id))
    .map((a) => ({
      id: String(a.id),
      kind: (a.kind === 'photo' || a.kind === 'image' ? a.kind : 'file') as RemoteAttachment['kind'],
      name: String(a.name ?? a.filename ?? ''),
      mime: String(a.mime ?? 'application/octet-stream'),
      size: Number(a.bytes ?? a.size ?? 0),
    }));
  return list.length ? list : undefined;
};

const upload = async (
  note: Note,
): Promise<{ inboxId: string; threadId?: string; stagingId?: string; attachments?: RemoteAttachment[] }> => {
  // 只在显式开启时走模拟上传（VITE_MOCK_UPLOAD=1），用于纯调 UI。
  // ⚠️ 绝不能靠「某个环境变量忘了设」进入这个分支 —— 那会让上传失败看起来像成功。
  if (MOCK_UPLOAD) {
    await new Promise((r) => setTimeout(r, 600));
    if (!navigator.onLine) throw new Error(t('离线'));
    return { inboxId: `mock-${note.id.slice(0, 8)}` };
  }

  // 真实路径：multipart，原文与音频一起进 inbox（§4.2 第2条）
  const form = new FormData();
  form.append(
    'payload',
    JSON.stringify({
      clientId: note.id, // 幂等键（§4.2 第6条）
      companyCode: note.companyCode,
      text: note.text,
      recordedBy: note.recordedBy,
      visitLabel: note.visitLabel,
      createdAt: note.createdAt,
      audioSeconds: note.audioSeconds ?? null,
      // 有 threadId = 续写。服务端会**新插一行** inbox，不会改老的那行（§4.2 第2条）
      threadId: note.threadId ?? null,
      // D31：速记不自动跑 agent。只有 AI 那一屏发出来的才带这个。
      toAgent: note.toAgent === true,
      /**
       * AI 那一屏已经在 `POST /transcribe` 里转好了（issue #15），把结果带上去。
       * 服务端存进 `staging.transcript` 并跳过转写 —— **同一段音频只转一次**，
       * 而且人在输入框里看到的和 agent 读到的是同一份。
       */
      transcript: note.transcript ?? null,
      /**
       * D90：这一句是改口重发，取代对话里那条消息（issue #23）。
       * 服务端只在**派生层**记一句「那条不再是活的那一条」——
       * `thread_message` / `inbox` 一个字都不改（§4.2 第 2 条）。
       */
      supersedesMessageId: note.supersedesMessageId ?? null,
    }),
  );
  if (note.audioBlob) form.append('audio', note.audioBlob, `${note.id}.${ext(note.audioMime)}`);
  // 附件的 fieldname 就是它的类型（photo / image / file）——
  // 自描述，不依赖数组顺序对齐，少一类「顺序错位」的 bug
  for (const a of note.attachments ?? []) {
    const b = attachmentBlob(a);
    if (b) form.append(a.kind, b, a.name);
  }
  // 超时按体积放大（issue #53 B1）—— 一张原图在展馆 4G 上 90 秒传不完是常态，不是故障
  const bytes = (note.audioBlob?.size ?? 0) + (note.attachments ?? []).reduce((s, a) => s + a.size, 0);

  /**
   * 走 XHR 不走 fetch —— **只有它有上传进度**（见 auth.ts 的 authUpload）。
   * 超时也在那里：没有超时的话，一次挂住的上传会让下面的 `running` 永远是 true，
   * **整个队列从此不动**，而界面上什么都看不出来。展馆里 4G 上行挂住是常态。
   */
  const res = await authUpload('/inbox', form, {
    timeoutMs: uploadTimeoutFor(bytes),
    onProgress: (loaded, total) => {
      progress.set(note.id, total > 0 ? loaded / total : -1);
      emit();
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = JSON.parse(res.text) as {
    inboxId?: string;
    threadId?: string;
    stagingId?: string;
    attachments?: unknown;
  };
  return {
    inboxId: json.inboxId ?? note.id,
    threadId: json.threadId,
    stagingId: json.stagingId,
    attachments: toRemote(json.attachments),
  };
};

const ext = (mime?: string) =>
  mime?.includes('mp4') ? 'm4a' : mime?.includes('ogg') ? 'ogg' : 'webm';

/**
 * 把队列推上去。
 *
 * `manual` = 人自己点了顶栏那个「待传 N」。**人点了就一定要试一次** ——
 * 之前攒够 8 次失败就静默 `continue`，于是点了完全没反应，
 * 看起来像整个应用坏了，而数据其实好好地躺在本地（2026-08-03 实测踩到）。
 */
export const flush = async ({ manual = false } = {}): Promise<void> => {
  // 没登录就别发 —— 否则每条都 401，白白烧掉重试次数，
  // 等真登录上了反而传不动了。队列原地等着就好。
  if (running || !navigator.onLine || !getSession()) return;
  running = true;
  try {
    // ⚠️ 也捞 `syncing`：上一轮被中断的会卡在这个状态，而它既不会被重传、
    //    也不会被显示 —— 见 retry.ts 顶部那段。
    const queued = await db.notes.where('sync').anyOf('queued', 'failed', 'syncing').sortBy('createdAt');
    for (const note of queued) {
      if (!shouldUpload(note, { manual })) continue;
      // 人手动点的话，把次数清零 —— 否则这一次成功了，下一次又从第 8 次开始
      if (manual && note.attempts) await db.notes.update(note.id, { attempts: 0 });
      await db.notes.update(note.id, { sync: 'syncing' });
      emit();
      try {
        const r = await upload(note);
        // 上传成功才丢音频和附件，省手机空间；文本永远留着。
        // ⚠️ 顺序不能反：先删本地、再上传，等于一次网络抖动就丢掉不可再生的资产。
        await db.notes.update(note.id, {
          sync: 'synced',
          remoteId: r.inboxId,
          threadId: r.threadId ?? note.threadId,
          stagingId: r.stagingId,
          audioBlob: undefined,
          attachments: undefined,
          // 原件丢了，引用留下 —— 否则「传成功」= 图片从界面上消失（issue #53 A1）
          remoteAttachments: r.attachments ?? note.remoteAttachments,
          lastError: undefined,
        });
        // 传完就把进度抹掉 —— 留着的话下次界面会显示一个假的 100%
        progress.delete(note.id);
      } catch (e) {
        progress.delete(note.id);
        if (e instanceof AuthError) {
          // 登录失效（过期或被撤权）：**保持 queued、不计次数**，重新登录后自动补传。
          // 当成普通失败会很快烧完 8 次重试 —— 那时数据还在本地，却再也传不上去了。
          await db.notes.update(note.id, { sync: 'queued', lastError: e.message });
          emit();
          break; // 后面的必然同样失败，不用继续
        }
        await db.notes.update(note.id, {
          sync: 'failed',
          attempts: note.attempts + 1,
          lastError: (e as Error).message,
        });
      }
      emit();
    }
  } finally {
    running = false;
    emit();
  }
};

/**
 * 把「人改过的正文」推上去（issue #15/#16）。
 *
 * 🔴 **和上传队列分开跑，不复用 `sync` 状态。**
 * 改一条已经 `synced` 的速记如果把它打回 `queued`，整条会被**重传一次** ——
 * 而音频在上传成功那一刻就从本地删掉了（省手机空间），
 * 于是重传的结果是「一条没有音频的记录覆盖了一条有音频的记录」。
 * 所以修改走自己的一条细线：`editedAt` > `editSyncedAt` 就推一次。
 *
 * 离线时什么都不做 —— 本地那份是真相源，下次联网自然补上。
 *
 * ⚠️ 导出只是为了能单独测（`__tests__/sync.test.ts`）—— 应用里唯一的调用点仍是
 *    `syncBoth()`。`flush` / `pullInbox` 本来就是导出的，这一条是它们的第三条腿。
 */
export const flushEdits = async (): Promise<void> => {
  // ⚠️ `editedAt` 必须在索引里（db.ts v8）。不在的话这一行**抛异常**，
  //    而它被下面的 try 吞掉 —— 界面完全正常，修改永远推不上去。
  const pending = await db.notes
    .where('editedAt')
    .above(0)
    .filter((n) => Boolean(n.remoteId) && (n.editSyncedAt ?? 0) < (n.editedAt ?? 0))
    .toArray();

  for (const n of pending) {
    try {
      const r = await saveNoteText(n.remoteId!, n.editedText ?? '');
      await db.notes.update(n.id, {
        editSyncedAt: Date.now(),
        /**
         * 🔴 已经入库的**必须说出来**。人改完看到「已保存」而 CRM 里还是错的，
         * 他不会再改第二次 —— 这正是这个仓库最贵的那类 bug（界面绿色、东西没进去）。
         */
        // 🔴 存**中文原文**，不过 `t()` —— `lastError` 也进 IndexedDB。
        //    存译文的话，人换一次语言，旧记录上的错误提示还是旧语言，
        //    而且这一格的内容会随界面设置而变。显示时由 `syncLabel` 翻。
        lastError: r.alreadyCommitted
          ? '这条已经入库了，刚才那次修改没能生效 —— 要改请到 CRM 里改'
          : undefined,
      });
    } catch {
      // 网络问题：本地那份还在，下一轮 syncBoth 再推。不计次数，不放弃。
    }
  }
  if (pending.length) emit();
};

/**
 * 下行同步：把服务端上属于自己的速记拉回本地（跨设备）。
 *
 * 换台设备登录后，本地 IndexedDB 是空的 —— 没有这一步，之前录的东西全看不见。
 *
 * ── 合并策略（这是整个函数唯一需要想清楚的事）──────────────────
 *
 * `inbox` 在服务端**只增不改**（§4.2 第2条 + 数据库触发器），而且 `POST /inbox`
 * 按 `client_id` 幂等。所以**一条速记一旦上传，服务端那份就永久定型了**。
 * 由此得出三条：
 *
 *   · 服务端有、本地没有  → 插入，标记 `synced`
 *   · 两边都有、本地已 synced → 只补服务端有而本地缺的归属，正文不动（两边本来就该一致）
 *   · 两边都有、本地还在队列里 → **一个字都不碰**。本地那份更新，正等着上传
 *
 * 音频不回传：上传成功后本地就删了（省手机空间），服务端那份留着做溯源。
 */
export const pullInbox = async (): Promise<number> => {
  const me = getSession()?.user;
  if (!me || !navigator.onLine) return 0;

  let items: Array<Record<string, any>>;
  try {
    // 量级是一次展会几百条，直接全量拉最稳 —— `since` 增量留到真的嫌慢时再上。
    // 而且 staging 状态变化不会改 created_at，增量反而会漏掉更新。
    const res = await authFetch('/inbox?limit=500');
    if (!res.ok) return 0;
    items = ((await res.json()) as { items: unknown[] }).items as typeof items;
  } catch {
    return 0; // 离线：本地那份照常能用
  }

  const companies = await db.companies.toArray();
  let added = 0;

  await db.transaction('rw', db.notes, async () => {
    for (const it of items) {
      const id = it.client_id as string;
      if (!id) continue;
      const local = await db.notes.get(id);

      /**
       * 🔴 **在别处删掉的，这台也要删掉**（D93 · issue #25）。
       *
       * 服务端**照常返回**被删的那些，只多带一格 `note_deleted_at` ——
       * 因为这个函数是「全量拉取 + 只补不删」：从返回里过滤掉的话，
       * 本地那条会**永远**留在速记列表里，而且没有任何东西能纠正它。
       * 在另一台手机上删掉、或者在这台删完又重装 PWA，都是这条路径。
       *
       * ⚠️ 服务端只是打了个时间戳，`inbox` 和音频一个字没动（§4.2 第 2 条）——
       *    撤销之后下一轮拉取它就回来了。本地这份删掉是安全的。
       */
      if (it.note_deleted_at) {
        if (local) await db.notes.delete(id);
        continue;
      }

      if (local && local.sync !== 'synced') continue; // 本地更新，别覆盖
      const co = companies.find((c) => c.code === it.company_code);

      if (!local) {
        await db.notes.add({
          id,
          companyCode: it.company_code ?? undefined,
          companyName: co?.name,
          suggestedCompany: it.suggested_company ?? undefined,
          /**
           * 🔴 **这里绝不能过 `t()`** —— 它写进 IndexedDB，是**数据**不是显示。
           *
           * 过了 `t()` 的话：同一条语音速记在英文账号下存成英文占位符、
           * 中文账号下存成中文，**同一份数据因为界面语言而不同**；
           * 而且它之后可能被 `saveNoteText` 推到服务端，而 `inbox` 只增不改 ——
           * 一个界面设置就把不可再生的原文写脏了。
           *
           * 判据（`scripts/check-i18n-safety.mjs` 机械守着）：
           * **数据路径存规范形式（中文），只有渲染那一层才翻译。**
           */
          text: it.text ?? it.transcript ?? '（语音，待转写）',
          audioSeconds: it.audio_seconds ?? undefined,
          createdAt: new Date(it.device_created_at ?? it.created_at).getTime(),
          recordedBy: me.userCode, // 接口本身就只返回当前用户的记录
          visitLabel: it.visit_label ?? '',
          sync: 'synced',
          attempts: 0,
          remoteId: it.id as string,
          threadId: (it.thread_id as string) ?? undefined,
          stagingId: (it.staging_id as string) ?? undefined,
          remoteAttachments: toRemote(it.attachments),
        });
        added++;
      } else {
        /**
         * 本地已经有这条了 —— 只补**本地缺的派生信息**，正文一个字不动。
         *
         * 🔴 转录回填是 issue #15 的另一半（2026-08-05）。
         * 之前这里只有「补归属」一条，于是**录音的那台手机永远看不到转录**：
         * `it.transcript` 只在「本地没有这条」时被用来建记录（跨设备的情况），
         * 而录音的那台本地一定有 —— 卡片上就永远停在「🎙 12秒 语音」。
         *
         * ⚠️ **转录写进 `transcript`，不写进 `text`。**
         * `text` 是人打的字，`transcript` 是机器听的。合成一个之后，
         * 「这句话是他打的还是听出来的」永久分不清 —— 而这正是这个仓库
         * 反复在守的那条线（§4.2 第2条的同一条精神：派生数据不覆盖原文）。
         */
        const patch: Partial<Note> = {};
        if (!local.companyCode && it.company_code) {
          patch.companyCode = it.company_code;
          patch.companyName = co?.name;
        }
        if (!local.transcript && it.transcript) patch.transcript = it.transcript as string;
        if (!local.title && it.title) patch.title = it.title as string;
        /**
         * 别人（另一台设备）改过的正文（issue #15/#16）。
         *
         * 🔴 **本地还有没推上去的修改时，一个字都不碰。**
         * 覆盖掉的话，人在这台手机上刚敲的东西会凭空消失 ——
         * 而且他不会知道，因为界面上不会有任何提示。
         * 判据和这个函数顶上那条一样：**本地更新的那份说了算。**
         */
        const localDirty = (local.editedAt ?? 0) > (local.editSyncedAt ?? 0);
        if (!localDirty && typeof it.edited_text === 'string' && it.edited_text !== local.editedText) {
          patch.editedText = it.edited_text;
          patch.editedAt = it.edited_at ? new Date(it.edited_at).getTime() : Date.now();
          patch.editSyncedAt = Date.now();
        }
        if (!local.stagingId && it.staging_id) patch.stagingId = it.staging_id as string;
        // 服务端有的附件清单（issue #53）。这台手机传的那条上传时就填了；补的是老记录和别的设备传的
        const remote = toRemote(it.attachments);
        if (remote && !local.remoteAttachments?.length) patch.remoteAttachments = remote;
        // 「发给 AI」在别的设备上点过 —— 对话 id 补回来，否则这台点一下会再开一条
        if (!local.threadId && it.thread_id) patch.threadId = it.thread_id as string;
        /**
         * 🔴 服务端那一侧的处理状态（D87 · issue #21②）。
         *
         * 以前一个字都没回填，于是**转写失败在速记页完全不可见** ——
         * 卡片上永远停在一条没有转录的语音，人只会以为「还在转」。
         * 这和 issue #19 里对话线程那个 bug 是**同一个形状**：
         * 后端如实记了失败，而没有任何一条路径能把它送到用户眼前。
         *
         * ⚠️ 每次都覆盖（不是 `if (!local.x)`）—— 它是**服务端的状态**，
         *    重试成功之后必须能从 `failed` 变回来，否则那行红字永远擦不掉。
         * ⚠️ 存的是服务端原文，**不过 `t()`**（D80 判据②：数据路径存规范形式）。
         */
        if (typeof it.status === 'string' && it.status !== local.stagingStatus) {
          patch.stagingStatus = it.status;
        }
        const err = (it.error as string | null) ?? undefined;
        if (err !== local.stagingError) patch.stagingError = err;
        if (Object.keys(patch).length) await db.notes.update(id, patch);
      }
    }
  });

  if (added) emit();
  return added;
};

/**
 * 上行 + 下行。顺序固定：**先把本地的推上去，再拉回来** ——
 * 反过来会看到自己刚录的那条"消失"一瞬。
 *
 * 修改（`flushEdits`）排在新记录之后、拉取之前：
 * 一条速记必须先有 `remoteId` 才谈得上改它，而拉取会读到刚推上去的那一版。
 */
const syncBoth = async () => {
  await flush();
  await flushEdits();
  await pullInbox();
};

/**
 * 启动时把上次卡在半路的掰回来。
 *
 * 判据：**应用刚起来的时候不可能有正在飞的请求**，所以此刻还是 `syncing` 的，
 * 一定是上次被中断的（关页面、热重载、切走、崩溃）。
 * 不做这一步，那条速记既不会被重传、也不会出现在「待传 N」里 —— 凭空消失。
 */
export const resetStuckUploads = async (): Promise<number> => {
  const stuck = await db.notes.where('sync').equals('syncing').toArray();
  for (const n of stuck) await db.notes.update(n.id, { sync: 'queued' });
  if (stuck.length) {
    console.warn(`[sync] 掰回 ${stuck.length} 条卡在上传中的速记`);
    emit();
  }
  return stuck.length;
};

export const startSyncLoop = () => {
  void resetStuckUploads().then(() => syncBoth());
  window.addEventListener('online', () => void syncBoth());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void syncBoth();
  });
  window.setInterval(() => void syncBoth(), 30_000);
  // 刚登录时本地可能是空的（换了设备）—— 立刻拉一次，别等 30 秒
  onAuthChange(() => void syncBoth());
};
