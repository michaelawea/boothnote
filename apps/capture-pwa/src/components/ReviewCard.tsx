import { useEffect, useState } from 'react';

import { T } from '../theme';
import {
  ConfirmError,
  cachedEnums,
  confirmStaging,
  dropStagingLocally,
  fetchTargets,
  reconfirmStaging,
  tagNoteWithCompany,
  syncEnums,
  undoConfirm,
  type ConfirmTargets,
} from '../api';
import type { Company, EnumSet } from '../db';
import { IconCheck, IconPen, IconUndo } from '../icons';
import { CompanyPicker } from './CompanyPicker';
import { ChainCard } from './ChainCard';
import { ProjectCard, type DocProposal, type ProjectProposal, type WorkItemProposal } from './ProjectCard';
import { PickSheet } from './PickSheet';
import { locale, t } from '../i18n';
import { ProposalItemsCard } from './ProposalItemsCard';
import type { ProposalItemView } from '../proposal-items';

/**
 * 核对卡 —— 人和 agent 之间唯一的交接点。
 *
 * 它做三件事，缺一件这套系统就失效：
 *   ① 把 agent 抽出来的字段摆出来给人看（**带可信度**，低的自己会跳出来）
 *   ② 逼人定客户（D28 修订的闸门在这里，不在录音那一屏）
 *   ③ 确认之后给 5 秒反悔窗口（D48）
 *
 * 🔴 **状态从服务端推导，不放在组件自己的 state 里。**
 *
 * 第一版把倒计时放在组件内部：点确认 → 本地 state 进 counting → 显示「已入库 · 撤销」。
 * 但对话那一屏 1.2 秒轮询一次，确认后 staging 从 `ready` 变成 `confirming`，
 * 而卡片的渲染条件写的是 `status === 'ready'` —— **条件一不成立整个卡片被卸载**，
 * 倒计时和撤销按钮跟着一起没了。人点完确认之后屏幕上什么都不剩
 * （维护者 2026-08-03 实测）。
 *
 * 现在 `status` + `confirmAfter` 都来自服务端，卡片被卸载重建也不影响 ——
 * 甚至刷新页面、换台设备，倒计时都还在走。
 */

const LABELS: Record<string, string> = {
  companyCode: '客户',
  category: '品类',
  supplierName: '在位品牌',
  modelName: '型号',
  stage: '阶段',
  decisionWindow: '决策窗口',
  annualVehicles: '整车年产量',
  demandQuantity: '需求量',
  summary: '小结',
  caseStatus: '处理状态',
  severity: '严重度',
  customerChain: '客户链',
  /**
   * ⚠️ 叫 `sourceConfidence` 不叫 `confidence` —— 后者已经被占了：
   * `staging.confidence` 是**每一格的把握度**（high/medium/low，模型对自己的评价）。
   * 这里这个是**这条情报本身可不可信**（本人说的 / 印证过 / 转述），
   * 对应 Twenty 的 `productFitment.confidence` 与 `intelValue.confidence`。
   * 两个东西同名，迟早会有人取错那一个。
   */
  sourceConfidence: '可信度',
};

/**
 * 字段名的译文。LABELS 存的是中文原文（D80：数据路径存规范形式，渲染时才翻）。
 * 「客户」在字典里已经是底栏那一格（复数 Accounts）—— 中文当 key 分不开同形词，
 * 所以这一格单独给英文，中文界面一个字不变。
 */
const labelOf = (k: string): string =>
  k === 'companyCode' && locale() === 'en' ? 'Account' : t(LABELS[k] ?? k);

const LegacyReviewCard = ({
  stagingId,
  extracted,
  confidence,
  suggestedCompany,
  partial,
  status,
  confirmAfter,
  twentyRefs,
  confirmedFields,
  stagingError,
  initialCompany,
  onDone,
}: {
  stagingId: string;
  extracted: Record<string, unknown>;
  confidence?: Record<string, string>;
  suggestedCompany?: string | null;
  partial?: boolean;
  /** 服务端的 staging 状态：ready / confirming / confirmed */
  status?: string | null;
  /** 服务端算好的提交时刻（ISO）。倒计时从它推，不从本地时钟推。 */
  confirmAfter?: string | null;
  /** D75：入库回执。重录时按里面的 id 更新，编号也从这取。 */
  twentyRefs?: Record<string, string> | null;
  /** D75：人上次确认时改过的那几格 —— 显示的必须是入库的值，不是抽取的旧值。 */
  confirmedFields?: Record<string, unknown> | null;
  /** D75：staging 上的错误（重录失败原因等），显示出来 —— 静默失败最贵。 */
  stagingError?: string | null;
  initialCompany?: Company | null;
  onDone?: () => void;
}) => {
  const [company, setCompany] = useState<Company | null>(initialCompany ?? null);
  /** 人自己点过客户没有。点过就不再被 initialCompany 覆盖。 */
  const [pickedByHand, setPickedByHand] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  /** 只用来盖住「点了确认 → 服务端还没反映过来」那一两百毫秒。 */
  const [justSent, setJustSent] = useState(false);
  const [now, setNow] = useState(Date.now());

  /**
   * 人改过的那几格（手册 P8）。
   *
   * 🔴 **只覆盖显示与提交，不回写 `extracted`。**
   * `extracted` 是「这一轮从原话里读出了什么」的记录，改它等于篡改历史；
   * 而入库要用的是「人最后认可的值」。两者分开，服务端也是这么合的：
   * `commitToTwenty()` 里 `{ ...extracted, ...confirm_payload.fields }`。
   * 所以三个月后回头看，既看得到当时读出什么，也看得到人改成了什么。
   */
  const [edits, setEdits] = useState<Record<string, string>>({});
  /** 正在改哪一格。null = 弹层没开。 */
  const [editing, setEditing] = useState<string | null>(null);
  const [enums, setEnums] = useState<EnumSet | null>(null);

  /**
   * 这条会接到 CRM 里的什么上面（D57）。
   *
   * **默认是「新开一条」** —— 自动往最近那条没关掉的售后上追加看着聪明，
   * 但一家客户同时有「逆变器断电」和「水箱液位」两个未结案时猜错，
   * 就是把两件不相干的事并成一条，而看板上它仍然只是一条正常记录，
   * 没有人会发现。所以列出来，让人点。
   */
  const [targets, setTargets] = useState<ConfirmTargets | null>(null);
  const [attachTo, setAttachTo] = useState<string | null>(null);
  const [pickingCase, setPickingCase] = useState(false);

  /**
   * 🔴 客户名单是**异步到的**，而 `useState(initialCompany)` 只在挂载那一刻取一次值。
   *
   * 卡片渲染的时候名单往往还没回来 → `initialCompany` 是 null →
   * agent 明明认出了 ALPIN，按钮还是灰的「先选客户」，人得再搜一遍同一个名字
   * （2026-08-03 实测）。所以名单到了要补一次。
   *
   * **人自己点过就不再覆盖** —— 否则一次后台刷新会把他刚改的归属改回去，
   * 而挂错客户的数据比没录更糟。
   */
  useEffect(() => {
    if (initialCompany && !pickedByHand && initialCompany.id !== company?.id) {
      setCompany(initialCompany);
    }
  }, [initialCompany?.id, pickedByHand]);

  // 枚举先给缓存再后台刷 —— 和客户名单同一个顺序，断网时弹层不能是空的
  useEffect(() => {
    let alive = true;
    void cachedEnums().then((e) => alive && e && setEnums(e));
    void syncEnums().then((e) => alive && e && setEnums(e));
    return () => {
      alive = false;
    };
  }, []);

  // 客户或品类一变，落点就要重查 —— 换了客户还显示上一家的售后是最坏的一种错
  const pickedCategory = (edits.category ?? extracted?.category) as string | undefined;
  useEffect(() => {
    if (!company) {
      setTargets(null);
      setAttachTo(null);
      return;
    }
    let alive = true;
    void fetchTargets(
      stagingId,
      company.id,
      pickedCategory ?? null,
      (extracted?.supplierName as string | undefined) ?? null,
    ).then((t) => {
      if (!alive) return;
      setTargets(t);
      // 换客户之后原来选的那条 case 多半不属于这家了，清掉重选
      setAttachTo((cur) => (cur && t.openCases.some((c) => c.id === cur) ? cur : null));
      /**
       * 服务端给了建议编号就**先填上**（issue #17 根因 D）。
       * ⚠️ 只在人还没动过那一格时填 —— 覆盖他刚敲的编号比留空更糟。
       * 建议编号的前缀含客户代号，所以换了客户要重新取，这个 effect 正好会重跑。
       */
      // ⚠️ 已入库的卡片不预填建议编号 —— 那时编号的真相在回执里（committedCode），
      // 预填会把「改编号」这一下悄悄变成真的改动
      if (t.suggestedProjectCode && status !== 'confirmed') {
        setEdits((e) => (e.projectCode ? e : { ...e, projectCode: t.suggestedProjectCode! }));
      }
    });
    return () => {
      alive = false;
    };
  }, [company?.id, pickedCategory, stagingId]);

  /**
   * `committing`（issue #1 加的中间态）= 心跳已经认领、正在写 Twenty。
   *
   * 它**仍然算 counting** —— 卡片要留在这一屏，否则会掉回可编辑状态，
   * 人会以为还没提交、又点一次（那正是 issue #1 的第二条重复路径）。
   * 变的只是文案和按钮：那一刻撤销已经是句谎话了。
   */
  const writing = status === 'committing';
  const counting = status === 'confirming' || writing || (justSent && status !== 'confirmed');
  const done = status === 'confirmed';

  /**
   * D75：重录模式 —— 已入库的卡片点了「修改」之后，重新打开编辑视图。
   * 提交走 `reconfirmStaging`（按 ref 更新替代），不走首次确认那条路。
   */
  const [reEditing, setReEditing] = useState(false);
  const recommitMode = done && reEditing;
  // 提交出去（状态变成 confirming）之后编辑态就完成使命了 —— 别留着，
  // 撤销回来时应该看到干净的「已入库」而不是半开的编辑框
  useEffect(() => {
    if (counting) setReEditing(false);
  }, [counting]);

  // 只有在倒计时的时候才开这个计时器 —— 平时不空转。
  // writing 的时候没有可倒的数了，也别空转。
  useEffect(() => {
    if (!counting || writing) return;
    const t = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(t);
  }, [counting, writing]);

  useEffect(() => {
    if (done) {
      void dropStagingLocally(stagingId);
      onDone?.();
    }
  }, [done, stagingId]);

  const left = confirmAfter ? Math.max(0, Math.ceil((new Date(confirmAfter).getTime() - now) / 1000)) : 5;

  /**
   * 显示值的三层优先级：这次改的 → 上次确认时改定的 → agent 读出来的。
   * 🔴 中间那层（D75）不能少：上次入库前把 stage 改过的人，重录时看到
   * agent 的旧值会以为自己那次修改丢了。
   */
  const val = (k: string) =>
    edits[k] ??
    (confirmedFields?.[k] as string | undefined) ??
    (extracted?.[k] as string | undefined);

  /**
   * 哪些格子能点着改 —— **只有枚举字段**。
   *
   * 自由文本（型号、小结、详情）不在这里：现场用手机改长文本是反效果的，
   * 少了什么接着说一句让 agent 补，比在虚拟键盘上改一段话快得多（手册 P8：
   * 「少了就接着说一句」）。而枚举字段恰恰相反 —— 它只有几个合法值，
   * 点一下就对了，人还没法填错。
   */
  const EDITABLE: Record<string, keyof EnumSet> = {
    category: 'category',
    stage: 'stage',
    caseStatus: 'caseStatus',
    severity: 'severity',
    sourceConfidence: 'confidence',
  };

  const rows = Object.entries({ ...(extracted ?? {}), ...(confirmedFields ?? {}), ...edits }).filter(
    // details 单独一块展开显示，不塞进这张字段表里
    ([k, v]) => v != null && v !== '' && k !== 'corrections' && k !== 'recordType' && k !== 'details' && k !== 'chain' && k !== 'agentSkipped' && LABELS[k],
  );
  const corrections = (extracted?.corrections ?? []) as Array<{ heard: string; corrected: string }>;
  const recordType = val('recordType') ?? 'fitment';
  const isSupport = recordType === 'support';
  const details = String(extracted?.details ?? '');
  const chain = (extracted?.chain ?? null) as Array<{ name: string; role: string }> | null;

  /**
   * 项目编号那一格（issue #17 根因 D）。三个来源，按这个顺序：
   *   人改的 → agent 抄来的 → 服务端建议的
   * **和 `confirm.ts` 里的取值顺序逐字一致** —— 不一致的话，
   * 卡片上显示的编号和真正写进 CRM 的编号会是两个，而且没有任何地方会报错。
   */
  const projectProposal = (extracted?.project ?? null) as Record<string, unknown> | null;
  const hasProject = Boolean(projectProposal);
  const agentCode = String(projectProposal?.projectCode ?? '').trim();
  const agentGaveNoCode = hasProject && !agentCode;
  /**
   * D75：已入库的卡片上，编号的真相在回执里（网关可能生成过、人可能改过）——
   * 不是 agent 当时抄的那个。`projectUpdated` 存的是编号（或 id 兜底），
   * 只认长得像编号的。
   */
  const refCode =
    [twentyRefs?.projectUpdated, twentyRefs?.projectCodeGenerated].find(
      (v) => v && /^[A-Z0-9][A-Z0-9-]{2,39}$/.test(v),
    ) ?? '';
  const committedCode = String(confirmedFields?.projectCode ?? '').trim() || refCode;
  const projectCode = edits.projectCode ?? (committedCode || agentCode);
  /** 空也算「还行」—— 服务端会兜底生成，不该在人还没输入时就报红。 */
  const projectCodeOk = !projectCode || /^[A-Z0-9][A-Z0-9-]{2,39}$/.test(projectCode);

  /** 弹层里那一栏的选项，并把「它原来读的」标出来（手册 PA3 的 sb2 小字）。 */
  const optionsFor = (field: string) => {
    const key = field === 'recordType' ? 'recordType' : EDITABLE[field];
    const list = key ? (enums?.[key] as Array<{ value: string; label: string }> | undefined) : undefined;
    const original = extracted?.[field] as string | undefined;
    return (list ?? []).map((o) => ({
      ...o,
      hint: o.value === original && edits[field] ? '它原来读的' : undefined,
    }));
  };

  /** D75：重录 —— 只把改过的格子发过去，服务端按 ref 更新替代。 */
  const recommit = async () => {
    if (!Object.keys(edits).length) {
      setErr(t('还没改任何一格 —— 改了再重新入库。'));
      return;
    }
    if (!projectCodeOk) {
      setErr(t('项目编号只能是字母、数字和短横线，3–40 位。'));
      return;
    }
    setErr('');
    setBusy(true);
    try {
      await reconfirmStaging(stagingId, edits);
      setJustSent(true);
      setReEditing(false);
    } catch (e) {
      // 服务端的拒绝都带着人话（编号冲突 / 类型锁 / 客户锁），原样显示
      setErr(e instanceof ConfirmError ? e.message : t('重录失败，稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (recommitMode) return recommit();
    if (!company) return;
    // 编号不合规就别发 —— 服务端会 422 拒掉整次请求，而人看到的会是一句
    // 「入库失败，稍后再试」，完全指不到原因（KEEPERS 的 rejected 那条路）
    if (!projectCodeOk) {
      setErr(t('项目编号只能是字母、数字和短横线，3–40 位。'));
      return;
    }
    setErr('');
    setBusy(true);
    try {
      // 只把**改过的**那几格发过去。没改的让服务端用 extracted 里的原值 ——
      // 整包回传的话，任何一处前后端字段名不一致都会变成静默的数据覆盖。
      await confirmStaging(
        stagingId,
        company.id,
        Object.keys(edits).length ? edits : undefined,
        isSupport ? attachTo : null,
      );
      // 归属是在这一步才定的（D28 修订）—— 写回本地那条速记，
      // 否则客户详情页的「我记过 N」永远是 0。
      // ⚠️ **不要裸 `void`**：第一版就是这么写的，Dexie 缺索引抛的异常被静默吞掉，
      // 界面一切正常而回写从来没成功过（2026-08-03 实测）。
      await tagNoteWithCompany(stagingId, company).catch((e) =>
        console.warn('客户没回写到本地速记：', e),
      );
      setJustSent(true);
    } catch (e) {
      setErr(e instanceof ConfirmError ? e.message : t('入库失败，稍后再试'));
    } finally {
      setBusy(false);
    }
  };

  const undo = async () => {
    const ok = await undoConfirm(stagingId);
    setJustSent(false);
    // 撤不掉只有一种情况：已经过了 5 秒、Twenty 里已经有了。
    // 这时候诚实地说「来不及了」，而不是假装撤销成功再去删记录。
    if (!ok) setErr(t('来不及了 —— 已经写进去了。到 CRM 里改吧。'));
  };

  if (done && !reEditing) {
    /**
     * ⚠️ 写全 `border` 而不是只覆盖 `borderColor` —— `box` 里是简写，
     * 两者混用时 React 重渲染会把**整条边框**移掉（控制台那条
     * 「don't mix shorthand and non-shorthand」警告），卡片高度会跳 2px。
     * 看板每 1.5 秒轮询一次，这张卡重渲染得比对话页勤得多，所以补上。
     */
    return (
      <div style={{ ...box, background: T.greenSoft, border: '1px solid transparent' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: T.green }}>
          <IconCheck size={17} />
          <span style={{ fontSize: 14, fontWeight: 500, flex: 1 }}>
            {t('已入库')} · {enums?.recordType.find((o) => o.value === recordType)?.label ?? recordType}
            {company ? ` · ${company.name}` : ''}
            {twentyRefs?.recommitted ? ' · 已更新过' : ''}
          </span>
          {/**
           * D75 的入口。**无论多久之后都能改** —— 改的走「按 ref 更新替代」，
           * 不会在 CRM 里长出第二份。
           */}
          <button
            className="btn ghost sm"
            onClick={() => {
              setErr('');
              setReEditing(true);
            }}
          >
            <IconPen size={14} /> {t('修改')}
          </button>
        </div>
        <div style={{ fontSize: 12, color: T.textSoft, marginTop: 6, lineHeight: 1.7 }}>
          {t('在 CRM 的')}
          <b>
            {t('「{a}」', {
              a: enums?.recordType.find((o) => o.value === recordType)?.label ?? recordType,
            })}
          </b>
          {t('里能找到它，同时会挂一条拜访记录。')}
        </div>
        {/* 🔴 重录失败必须说出来（比如编号冲突）——
            不说的话卡片还是绿的，人以为改成功了，这个仓库最贵的那类 bug */}
        {stagingError && (
          <div
            style={{
              fontSize: 12.5,
              color: T.amber,
              background: T.amberSoft,
              padding: '8px 11px',
              borderRadius: 10,
              marginTop: 8,
              lineHeight: 1.65,
            }}
          >
            {stagingError}
          </div>
        )}
      </div>
    );
  }

  if (counting) {
    /**
     * 🔴 **倒计时到 0 就不能再说「可撤销」了。**
     *
     * 实测（2026-08-03 Chrome）：窗口过了之后卡片停在「已入库 · 0 秒内可撤销」——
     * 那一刻点撤销会拿到 `too_late`。界面在**邀请人做一件已经做不到的事**。
     * 到 0 之后如实说「正在写入」，并把按钮禁掉。
     *
     * （这一秒的空档来自轮询：心跳 1 秒一跳、界面 1.2 秒拉一次，
     *   所以「到点」和「界面知道它 confirmed」之间必然有一小段。）
     */
    // 到点了、或者心跳已经认领（committing）—— 两种都撤不掉了
    const overdue = left <= 0 || writing;
    return (
      <div style={{ ...box, display: 'flex', alignItems: 'center', gap: 10 }}>
        <IconCheck size={17} />
        <div style={{ flex: 1, fontSize: 14 }}>
          {t('已入库')}
          {company ? ` · ${company.name}` : ''}
          <span style={{ color: T.textLight, marginLeft: 6 }}>
            {overdue ? t('正在写入 CRM…') : t('{a} 秒内可撤销', { a: left })}
          </span>
        </div>
        <button className="btn ghost sm" disabled={overdue} onClick={() => void undo()}>
          <IconUndo size={15} /> {t('撤销')}
        </button>
      </div>
    );
  }

  return (
    <div style={box}>
      {/* D75：重录模式的顶部说明 —— 人得知道这不是再录一份，是原地替代 */}
      {recommitMode && (
        <div
          style={{
            fontSize: 12.5,
            color: T.blue,
            background: T.s2,
            padding: '9px 11px',
            borderRadius: 10,
            marginBottom: 10,
            lineHeight: 1.65,
          }}
        >
          {t('正在修改')}<b>{t('已入库')}</b>{t('的记录 —— 提交后按原记录')}<b>{t('更新替代')}</b>{t('，CRM 里不会多出第二份。 和编号冲突之类的问题会当场告诉你。')}
        </div>
      )}
      {isSupport && (
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            height: 24,
            padding: '0 10px',
            borderRadius: 999,
            background: T.redSoft,
            color: T.red,
            fontSize: 12,
            fontWeight: 600,
            marginBottom: 10,
          }}
        >
          {t('售后问题')}
        </div>
      )}

      {/* 🔴 **AI 没整理出字段时，必须说出来。**
          网关会用原文兜一份底（loop.ts），但那和「AI 读出了这些」是两回事 ——
          不说清楚的话，人会以为下面那段是 AI 的抽取结果，从而不去核对原文。 */}
      {extracted?.agentSkipped === true && (
        <div
          style={{
            fontSize: 12.5,
            color: T.amber,
            background: T.amberSoft,
            padding: '9px 11px',
            borderRadius: 10,
            marginBottom: 10,
            lineHeight: 1.65,
          }}
        >
          <b>{t('这条 AI 没整理出结构化字段')}</b> {t('—— 下面是你的原话和附件名。 定个客户照样能入库，内容一个字都不会丢；要字段的话，回对话里再说一句让它重新读。')}
        </div>
      )}

      {partial && (
        <div
          style={{
            fontSize: 12,
            color: T.amber,
            background: T.amberSoft,
            padding: '7px 10px',
            borderRadius: 10,
            marginBottom: 10,
            lineHeight: 1.6,
          }}
        >
          {/**
           * 🔴 **「到了上限」和「你自己按了停止」不是同一句话**（D89 · issue #22）。
           *
           * `partial` 现在有三个来源：max_steps / timeout / **人叫停**。
           * 全都说成「这一条到了处理上限」的话，人按完停止会看到一句
           * **不是真的**的解释 —— 而且那句话把责任推给了系统，
           * 他下一步会去查「为什么到上限了」，而实际上是他自己刚按的。
           *
           * 判据：界面上的每一句话都要能对应到真实发生过的事。
           * 服务端把原因写在 `staging.error` 里（叫停那条以「你叫停了」开头），照它说。
           */}
          {stagingError?.startsWith('你叫停了') ? (
            <>
              {t('你叫停了这一轮 —— 已经整理出来的都在下面，')}
              <b>{t('可能不全')}</b>
              {t('。改一改再发一次就行。')}
            </>
          ) : (
            <>
              {t('这一条到了处理上限，抽出来的东西')} <b>{t('可能不全')}</b>{t('。自己再扫一眼原文。')}
            </>
          )}
        </div>
      )}

      {rows.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12 }}>
          {rows.map(([k, v]) => {
            const c = confidence?.[k];
            const editable = !!EDITABLE[k] && !!enums;
            const changed = edits[k] != null;
            // 枚举值在界面上要显示中文 —— 人不该看到 SAMPLE_TESTING 这种东西
            const shown =
              optionsFor(k).find((o) => o.value === String(v))?.label ?? String(v);
            const inner = (
              <>
                <span style={{ fontSize: 12, color: T.textLight, width: 62, flexShrink: 0 }}>
                  {labelOf(k)}
                </span>
                <span style={{ fontSize: 14.5, flex: 1, textAlign: 'left' }}>
                  {shown}
                  {changed && (
                    <span style={{ fontSize: 11, color: T.blue, marginLeft: 6 }}>{t('已改')}</span>
                  )}
                </span>
                {/* 只标低可信度。高的不用说 —— 满屏徽章等于没有徽章。 */}
                {c === 'low' && !changed && (
                  <span style={{ fontSize: 11, color: T.amber, flexShrink: 0 }}>{t('不太确定')}</span>
                )}
                {editable && (
                  <span style={{ color: T.textLight, flexShrink: 0, display: 'flex' }}>
                    <IconPen size={14} />
                  </span>
                )}
              </>
            );
            // 能改的做成按钮，不能改的还是一行字 —— 别让人去点一个点不动的东西
            return editable ? (
              <button
                key={k}
                onClick={() => setEditing(k)}
                style={{
                  display: 'flex',
                  gap: 10,
                  alignItems: 'center',
                  width: '100%',
                  border: 'none',
                  background: 'transparent',
                  padding: '5px 6px',
                  margin: '0 -6px',
                  borderRadius: 9,
                  cursor: 'pointer',
                  font: 'inherit',
                  color: T.text,
                }}
              >
                {inner}
              </button>
            ) : (
              <div key={k} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0' }}>
                {inner}
              </div>
            );
          })}

          {/* 🔴 记错类型要改得回来（手册 P4：「分不清就先记，记错类型改得回来」）。
              这一格分叉最大 —— 选型走 productFitment，售后走 supportCase，
              是两条方向相反的生命周期（D25）。改错了整条记录就落错了表。
              ⚠️ D75：**重录时锁死** —— 改类型等于换一条记录，而系统里没有删除路径。 */}
          {recommitMode ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '5px 0' }}>
              <span style={{ fontSize: 12, color: T.textLight, width: 62, flexShrink: 0 }}>{t('记成')}</span>
              <span style={{ fontSize: 14.5, flex: 1 }}>
                {enums?.recordType.find((o) => o.value === recordType)?.label ?? recordType}
                <span style={{ fontSize: 11, color: T.textLight, marginLeft: 6 }}>
                  {t('重录不能改类型')}
                </span>
              </span>
            </div>
          ) : enums && (
            <button
              onClick={() => setEditing('recordType')}
              style={{
                display: 'flex',
                gap: 10,
                alignItems: 'center',
                width: '100%',
                border: 'none',
                background: 'transparent',
                padding: '5px 6px',
                margin: '0 -6px',
                borderRadius: 9,
                cursor: 'pointer',
                font: 'inherit',
                color: T.text,
              }}
            >
              <span style={{ fontSize: 12, color: T.textLight, width: 62, flexShrink: 0 }}>
                {t('记成')}
              </span>
              <span style={{ fontSize: 14.5, flex: 1, textAlign: 'left' }}>
                {/* 四种记录类型都要有中文 —— 少一种就会显示成别的那种，
                    而「记成什么」是这张卡上分叉最大的一格（D25/D59）。 */}
                {enums?.recordType.find((o) => o.value === recordType)?.label ?? recordType}
                {edits.recordType && (
                  <span style={{ fontSize: 11, color: T.blue, marginLeft: 6 }}>{t('已改')}</span>
                )}
              </span>
              <span style={{ color: T.textLight, flexShrink: 0, display: 'flex' }}>
                <IconPen size={14} />
              </span>
            </button>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 13.5, color: T.textLight, marginBottom: 12 }}>
          {t('没抽出结构化字段 —— 原文照样留着，定个客户就能入库。')}
        </div>
      )}

      {/* 渠道链（D54）。agent 只提议，缺的那几层是人在这里点「新建」才建的。 */}
      {chain?.length ? <ChainCard chain={chain} /> : null}

      {/* 项目 / 任务线程 / 文档（D59）。**确认之前必须看得见** ——
          看不见就等于系统替人做了决定，而这套系统的前提是「AI 只提议」。 */}
      <ProjectCard
        project={(extracted?.project ?? null) as ProjectProposal | null}
        workItems={(extracted?.workItems ?? null) as WorkItemProposal[] | null}
        document={(extracted?.document ?? null) as DocProposal | null}
        stageLabel={(v) => enums?.stage.find((o) => o.value === v)?.label ?? v}
      />

      {/**
       * 🔴 **项目编号 —— 这张卡上唯一一格可以自由打字的东西。**
       *
       * 加它之前（issue #17 根因 D，2026-08-05 实测）：
       * agent 按 prompt 的指示把编号留空 → 卡片上写着「项目：CI-Bus …」→
       * **人没有任何地方能填那个编号** → 点确认 →
       * `commitToTwenty` 走到「没编号不建」那个分支 →
       * **CRM 里什么项目都没有，而界面上是绿色的「已入库」。**
       *
       * 为什么破例允许打字（其余六格全是枚举，理由见 EDITABLE 那段注释）：
       * 编号是**幂等的支点**，没有别的东西能替代它，而且它短 ——
       * 在手机上敲 12 个字符和敲一段话是两回事。
       *
       * 服务端已经给了建议编号，所以正常情况下人**什么都不用做**，
       * 只是看一眼确认。这一格存在的意义是「他想改的时候改得了」。
       */}
      {/* ⚠️ 下面这个 `border` 写全，不和 `box` 的简写混用（理由见 done 分支那段） */}
      {hasProject && (
        <div style={{ ...box, background: T.s2, border: '1px solid transparent', marginBottom: 10 }}>
          <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 7 }}>
            {t('项目编号')}
            <span style={{ color: T.textLight }}> {t('—— CRM 里靠它认出「是同一个项目」')}</span>
          </div>
          <input
            value={projectCode}
            onChange={(e) => setEdits({ ...edits, projectCode: e.target.value.toUpperCase() })}
            placeholder={t('如 HYM-BAT-2027-001')}
            spellCheck={false}
            autoCapitalize="characters"
            style={{
              width: '100%',
              fontSize: 14.5,
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              letterSpacing: 0.3,
              padding: '9px 11px',
              borderRadius: 10,
              border: `1px solid ${projectCodeOk ? T.lineLight : T.amber}`,
              background: T.bg,
              color: T.text,
            }}
          />
          {!projectCodeOk ? (
            <div style={{ fontSize: 11.5, color: T.amber, marginTop: 6, lineHeight: 1.6 }}>
              {t('只能是字母、数字和短横线，3–40 位。不合规的编号会被服务端拒掉 ——')}
              {t('那正是为了防止')} <code>HYM-BAT-001</code> {t('和')} <code>hym bat 001</code> {t('变成两个项目。')}
            </div>
          ) : agentGaveNoCode ? (
            <div style={{ fontSize: 11.5, color: T.textLight, marginTop: 6, lineHeight: 1.6 }}>
              {t('原话里没有编号，这个是')}<b>{t('系统生成')}</b>{t('的，可以直接用，也可以改成客户那边的编号。')}
            </div>
          ) : null}
        </div>
      )}

      {/* 🔴 详情要能当场看见。
          一份 8703 字的技术报告被压成一句 30 字的小结 —— 那不叫录入
          （维护者 2026-08-03）。现在全文进 details，这里给他看，
          而且**默认展开**：要人多点一下才看得到的东西，等于没有。 */}
      {details && (
        <details open style={{ marginBottom: 12 }}>
          <summary
            style={{ fontSize: 12, color: T.textSoft, cursor: 'pointer', marginBottom: 6 }}
          >
            {t('详情（{a} 字，会原样进 CRM）', { a: details.length })}
          </summary>
          <div
            style={{
              fontSize: 13,
              lineHeight: 1.75,
              whiteSpace: 'pre-wrap',
              background: T.s2,
              borderRadius: 12,
              padding: '11px 13px',
              maxHeight: 320,
              overflowY: 'auto',
            }}
          >
            {details}
          </div>
        </details>
      )}

      {corrections.length > 0 && (
        <div style={{ fontSize: 11.5, color: T.textLight, marginBottom: 12, lineHeight: 1.7 }}>
          {t('纠正过的听写：')}
          {corrections.map((c, i) => (
            <span key={i}>
              {i ? t('、') : ' '}
              {c.heard} → <b style={{ color: T.textSoft }}>{c.corrected}</b>
            </span>
          ))}
        </div>
      )}

      {recommitMode ? (
        /* D75：客户锁死 —— 已写进 CRM 的一串记录要整体换归属，那一步在 CRM 里做 */
        <div style={{ borderTop: `1px solid ${T.lineLight}`, paddingTop: 12, fontSize: 13 }}>
          <span style={{ color: T.textSoft }}>{t('客户：')}</span>
          <b>{company?.name ?? t('（见 CRM）')}</b>
          <span style={{ fontSize: 11.5, color: T.textLight, marginLeft: 8 }}>
            {t('重录不能改归属 —— 要换客户请在 CRM 里操作')}
          </span>
        </div>
      ) : (
      <div style={{ borderTop: `1px solid ${T.lineLight}`, paddingTop: 12 }}>
        <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 8 }}>
          {t('入库前必须定客户')}
          <span style={{ color: T.textLight }}> {t('—— 挂错客户的数据比没录更糟')}</span>
        </div>
        <CompanyPicker
          value={company}
          onPick={(c) => {
            setCompany(c);
            setPickedByHand(true);
          }}
          suggested={suggestedCompany}
          suggestedFields={extracted.companySuggestion}
        />
      </div>
      )}

      {/* ── 落点（D57）。入库之前把「这条会接到哪」摆出来。
          D75：重录时不显示 —— 落点在首次入库那一刻已经定了，改不了。 ── */}
      {!recommitMode && company && isSupport && targets?.openCases.length ? (
        <div
          style={{
            marginTop: 12,
            background: T.s2,
            borderRadius: 12,
            padding: '11px 12px',
            fontSize: 13,
          }}
        >
          <div style={{ fontSize: 12, color: T.textSoft, marginBottom: 8 }}>
            {t('这家还有 {a} 条没关掉的售后', { a: targets.openCases.length })}
          </div>
          <button
            className="btn ghost sm"
            style={{ width: '100%', justifyContent: 'space-between' }}
            onClick={() => setPickingCase(true)}
          >
            <span style={{ textAlign: 'left', flex: 1, minWidth: 0 }}>
              {attachTo
                ? t('接在：{a}', { a: targets.openCases.find((c) => c.id === attachTo)?.name ?? '' })
                : t('另开一条新的售后')}
            </span>
            <IconPen size={14} />
          </button>
        </div>
      ) : null}

      {/* 🔴 在位品牌对不上受控名单 —— 必须说出来（D23a）。
          不说的话就是这个项目反复踩的「安静的失败」：卡片上写着品牌，
          CRM 里那一格是空的，没有报错也没有提示。 */}
      {company && !isSupport && targets?.supplierUnmatched ? (
        <div
          style={{
            marginTop: 12,
            background: T.amberSoft,
            color: T.amber,
            borderRadius: 12,
            padding: '10px 12px',
            fontSize: 12.5,
            lineHeight: 1.65,
          }}
        >
          {t('在位品牌')} <b>{t('「{a}」', { a: targets.supplierUnmatched })}</b>{' '}
          {t('不在受控名单里 —— 这一格')}
          <b>{t('不会进 CRM 的品牌字段')}</b>
          {t('，原话会写进「来源说明」。')}
          <br />
          {t('要让它进去，把这家补进')} <code>data/suppliers.json</code> {t('再跑一次')}
          <code> seed-suppliers</code>
          {t('。')}
        </div>
      ) : null}

      {company && !isSupport && targets?.opportunity ? (
        <div
          style={{
            marginTop: 12,
            background: T.s2,
            borderRadius: 12,
            padding: '11px 12px',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <span style={{ color: T.textSoft }}>{t('会接在已有的项目上：')}</span>
          <b>{targets.opportunity.name}</b>
          <div style={{ fontSize: 12, color: T.textLight, marginTop: 3 }}>
            {t('当前阶段 {a}', { a: targets.opportunity.stageLabel })}
            {val('stage') ? (
              <>
                {' → '}
                <b style={{ color: T.text }}>
                  {optionsFor('stage').find((o) => o.value === val('stage'))?.label ?? val('stage')}
                </b>
              </>
            ) : null}
          </div>
        </div>
      ) : null}

      {err && <div style={{ color: T.red, fontSize: 12.5, marginTop: 10 }}>{err}</div>}

      {recommitMode ? (
        <>
          <button
            className="btn"
            style={{ width: '100%', marginTop: 14 }}
            disabled={busy || !Object.keys(edits).length}
            onClick={() => void confirm()}
          >
            {busy ? t('提交中…') : t('重新入库 · 替代之前的记录')}
          </button>
          <button
            className="btn ghost sm"
            style={{ width: '100%', marginTop: 8 }}
            onClick={() => {
              setEdits({});
              setErr('');
              setReEditing(false);
            }}
          >
            {t('不改了')}
          </button>
        </>
      ) : (
      <button
        className="btn"
        style={{ width: '100%', marginTop: 14 }}
        disabled={!company || busy}
        onClick={() => void confirm()}
      >
        {busy ? t('提交中…') : company ? t('确认入库 · {a}', { a: company.name }) : t('先选客户')}
      </button>
      )}

      {/* 接在哪条售后上（手册 P23 / D57）。默认「另开一条」—— 不猜。 */}
      {pickingCase && targets && (
        <PickSheet
          title={t('这条进展接在哪？')}
          subtitle={t('接错了两件不相干的事就并成一条了，而看板上它看起来完全正常。拿不准就另开一条。')}
          options={[
            { value: '', label: t('另开一条新的售后'), hint: t('这是新问题，和下面那些无关') },
            ...targets.openCases.map((c) => ({
              value: c.id,
              label: c.name,
              hint:
                c.statusLabel +
                (c.reportedAt ? ` · ${t('报于 {a}', { a: c.reportedAt.slice(0, 10) })}` : ''),
            })),
          ]}
          value={attachTo ?? ''}
          onPick={(v) => {
            setAttachTo(v || null);
            setPickingCase(false);
          }}
          onClose={() => setPickingCase(false)}
        />
      )}

      {/* 「改一格」的弹层（手册 P8）。改的只是这张卡，原话一个字不动。 */}
      {editing && (
        <PickSheet
          title={
            editing === 'recordType'
              ? t('这条记成什么？')
              : t('改「{a}」', { a: labelOf(editing) })
          }
          subtitle={SHEET_HINT[editing] ? t(SHEET_HINT[editing]) : undefined}
          options={optionsFor(editing)}
          value={String(val(editing) ?? '')}
          onPick={(v) => {
            setEdits((p) => ({ ...p, [editing]: v }));
            setEditing(null);
          }}
          onClose={() => setEditing(null)}
          footer={
            edits[editing] != null ? (
              <button
                className="btn ghost sm"
                style={{ width: '100%', marginTop: 8 }}
                onClick={() => {
                  setEdits(({ [editing]: _drop, ...rest }) => rest);
                  setEditing(null);
                }}
              >
                {t('还原成它读出来的')}
              </button>
            ) : undefined
          }
        />
      )}
    </div>
  );
};

/** Separate components keep legacy effects from running for a multi-item proposal. */
export const ReviewCard = (props: Parameters<typeof LegacyReviewCard>[0] & { proposalItems?: ProposalItemView[] }) =>
  props.proposalItems?.length ? <ProposalItemsCard stagingId={props.stagingId} items={props.proposalItems} onDone={props.onDone} />
    : <LegacyReviewCard {...props} />;

/** 弹层标题下那行小字。只在「说清楚有什么后果」时才写，没必要的就不写。 */
/** 存中文，用的那一行才 `t()`（模块级 `t()` 会在 import 时定死语言 —— issue #53 A3 那一类）。 */
const SHEET_HINT: Record<string, string> = {
  recordType:
    '选型情报和售后问题是两条方向相反的生命周期 —— 前者从没接触推进到成交，后者从发生到关闭。选错了会落到另一张表里。',
  sourceConfidence: '传闻必须标成传闻。标了它照样有用（提醒你去核实）；被当成事实用下去才是坏账。',
  stage: '改的是这次读出了什么，你的原话一个字不动。',
};

const box: React.CSSProperties = {
  border: `1px solid ${T.line}`,
  borderRadius: T.radius,
  background: T.surface,
  padding: '14px 15px',
};
