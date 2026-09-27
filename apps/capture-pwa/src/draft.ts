/**
 * 没存下来的正文 —— **App 被系统杀掉之后还在**（D135）。
 *
 * 快速输入框那一两句丢了不心疼；编辑器里写了五分钟的会谈纪要丢了是另一回事。
 * 而 iOS 对装到桌面的网页很不客气：切去微信回个消息、拍几张照，回来整个页面
 * 可能已经被回收重载 —— `text` 只在内存里，一个字都不剩。
 * （D83 挡的是**我们自己**的自动刷新；这里挡的是系统的。）
 *
 * · 只存文字。附件是字节（D132），塞不进 localStorage，也不该塞 ——
 *   丢了可以重拍，**说过的话和写下的字才是不可再生的**。
 * · 按代号分开存（T30：同一台手机换人登录，不能看到上一个人没写完的东西）。
 * · 读写全包 try/catch：Safari 无痕模式下 `setItem` 直接抛，
 *   而草稿存不存得住**绝不能**影响「存下来」那一步。
 */

/** 只要用得到的那三个方法 —— 测试里传一个 Map 包出来的假货就行。 */
export type DraftStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const draftKey = (userCode: string) => `boothnote-draft:${userCode}`;

export const loadDraft = (store: DraftStore | undefined, userCode: string): string => {
  try {
    return store?.getItem(draftKey(userCode)) ?? '';
  } catch {
    return '';
  }
};

/** 空白就删掉那一格，不留一个空串占着 —— 否则「有没有草稿」要多一种判断。 */
export const storeDraft = (store: DraftStore | undefined, userCode: string, text: string): void => {
  try {
    if (text.trim()) store?.setItem(draftKey(userCode), text);
    else store?.removeItem(draftKey(userCode));
  } catch {
    /* 存不住就算了 —— 见文件头第三条 */
  }
};

/** 浏览器里的 localStorage；拿不到（无痕 / 被禁用）就是 undefined。 */
export const browserStore = (): DraftStore | undefined => {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage;
  } catch {
    return undefined;
  }
};
