/**
 * 界面语言（D80）。
 *
 * ══ 三个设计决定，每个都有具体理由 ══════════════════════════════
 *
 * ① **不引 i18n 库。** 包现在 128 KB gzip，react-i18next 要 +15KB，
 *    而我们需要的只是「查一张表」。展馆弱网，能省一个依赖是一个
 *    （和 `icons.tsx` 不引图标库同一条判据）。
 *
 * ② **中文原文当 key。** 不给 440 处字符串起 `board.filter.title` 这种名字：
 *    · 起名字要动 440 个调用点两次（先起名、再翻译），中文当 key 只动一次
 *    · 漏翻的地方**自动退回中文**，是个能用的界面，不是 `board.filter.title`
 *    · 代码读起来还是中文，不用来回跳字典才知道这个按钮写着什么
 *    代价：中文改一个字，字典里那条就失效（悄悄退回中文）。
 *    所以有 `npm run i18n:report` 把「没翻的」列出来 —— 见 `scripts/i18n-report.mjs`。
 *
 * ③ **语言跟账号走，不跟浏览器走**（维护者 2026-08-07 定）。
 *    `app_user.locale` 是真相源，`/me` 带回来。换设备、换浏览器、清缓存都还在 ——
 *    展会现场同事之间借手机是常事，跟浏览器走会让人打开一个别人语言的界面。
 */
import { getSession } from './auth';

export type Locale = 'zh' | 'en';

/**
 * 中文 → 英文。**没有的条目就退回中文** —— 半翻的界面仍然可用。
 *
 * ⚠️ 加条目时把中文**逐字**抄过来（含标点和空格）。差一个字就查不到，
 * 而且不会报错，只会悄悄显示中文。
 */
const EN: Record<string, string> = {
  '请选择国家': 'Select a country',
  // ── 外壳 · 导航 ──────────────────────────────────────────────
  速记: 'Capture',
  客户: 'Accounts',
  看板: 'Records',
  我的: 'Me',
  '问 AI': 'Ask AI',
  '打开 AI': 'Open AI',
  'Boothnote': 'Boothnote Capture',
  离线: 'Offline',
  '待传 ': 'Pending ',

  // ── 登录 ────────────────────────────────────────────────────
  现场速记: 'Field Capture',
  代号: 'User code',
  密码: 'Password',
  登录: 'Sign in',
  '登录中…': 'Signing in…',
  '账号由管理员创建。忘记密码找管理员重置 —— 没有自助找回。':
    'Accounts are created by an admin. Ask your admin to reset a password — there is no self-service recovery.',
  '代号或密码不对': 'Wrong user code or password',
  '连不上服务器 —— 检查网络': 'Cannot reach the server — check your connection',

  // ── 看板（D76）────────────────────────────────────────────────
  筛选: 'Filter',
  分组: 'Group',
  状态: 'Status',
  日期: 'Date',
  '客户 / 内容': 'Account / Content',
  全部: 'All',
  待确认: 'To confirm',
  已入库: 'Committed',
  处理中: 'Working',
  失败: 'Failed',
  待整理: 'Queued',
  转写中: 'Transcribing',
  'AI 整理中': 'AI working',
  入库中: 'Committing',
  写入中: 'Writing',
  已被取代: 'Superseded',
  按项目: 'By project',
  按时间: 'By date',
  按客户: 'By account',
  // ── 项目卡（issue #18 · D92）────────────────────────────────
  展开: 'Expand',
  收起: 'Collapse',
  清除筛选: 'Clear filters',
  未归入项目: 'Not in a project',
  未定客户: 'No account yet',
  '客户 · 内容 · 型号 · 品牌 · 编号': 'Account · content · model · brand · code',
  清空搜索: 'Clear search',
  '在 CRM 里看完整看板 ↗': 'Open the full board in the CRM ↗',
  '还没有记录。去「速记」页记一条。': 'No records yet. Capture one on the Capture tab.',
  '这个筛选下没有记录。': 'Nothing matches this filter.',
  '这一屏需要更高权限。': 'This screen needs a higher role.',
  '你录的东西照常进库，只是这台设备上看不到汇总。':
    'What you capture still goes in — you just cannot see the roll-up on this device.',
  '只显示最近 300 条，搜索也只在这 300 条里找。':
    'Showing the latest 300 records; search only covers those 300.',
  '更早的去 CRM 里看。': 'For older ones, look in the CRM.',
  '（语音）': '(voice)',
  '（无正文）': '(no text)',
  '（这条只有语音，转写还没回来）': '(voice only — transcript has not come back yet)',
  'AI 已经整理好了，等你确认 —— 确认要看它整轮的工作日志，所以那一步在对话里做。':
    'The AI is done and waiting for you. Confirming needs its full work log, so that step lives in the chat.',
  '这条还没交给 AI 整理过 —— 去「速记」页找到它，点「发给 AI」。':
    'This one has not been sent to the AI yet — find it on the Capture tab and tap “Send to AI”.',
  '同一条对话后面又改过一次，这一版被那次取代了 —— 原话和抽取结果都还在。':
    'A later message in the same chat replaced this version — the original words and extraction are both still here.',

  // ── 速记 ────────────────────────────────────────────────────
  写一条: 'Type one',
  打字: 'Keyboard',
  说一条: 'Say one',
  '写点什么…（支持 markdown）': 'Write something… (markdown supported)',
  存下来: 'Save',
  拍照: 'Photo',
  图片: 'Image',
  文件: 'File',
  '发给 AI': 'Send to AI',
  改: 'Edit',
  '还没有记录。按一下上面那个圆键就能开始。': 'Nothing yet. Tap the round button above to start.',

  // ── 快捷工具栏（D136）──────────────────────────────────────────
  快捷工具: 'Quick tools',
  '2C 客户问卷': 'Consumer survey',
  'VDL 法国展': 'VDL France',
  清空: 'Clear',
  '今天 {a} 份': '{a} today',
  '{a} 份待上传': '{a} waiting to upload',
  '已存下 · 今天第 {a} 份。可以接着问下一位。': 'Saved · #{a} today. Ready for the next person.',
  '留了联系方式，要先勾「客户同意」。': 'Contact details entered — tick the consent box first.',
  存下这份问卷: 'Save this survey',
  '联系方式（可不填）': 'Contact details (optional)',
  '客户同意 Voltline 保存这些信息、用于回访': 'Customer agrees Voltline may keep these details to follow up',
  '点一下 = 在用（黑）· 再点 = 想加（蓝）': 'Tap once = in use (black) · again = wanted (blue)',
  追问: 'Follow-up',
  记要点就行: 'Key points are enough',
  // 问卷题目的中文那一行（`survey.ts`）—— 法语原句不翻，念给客户听的就是它
  '现在有哪些电力设备？': 'What electrical equipment do they have?',
  锂电池: 'Lithium battery',
  太阳能板: 'Solar panel',
  逆变器: 'Inverter',
  充电器: 'Charger',
  都没有: 'None',
  '在用哪些电器？想加哪些？': 'Which appliances do they use? Which would they add?',
  空调: 'Air con',
  冰箱: 'Fridge',
  咖啡机: 'Coffee machine',
  电炉灶: 'Electric hob',
  微波炉: 'Microwave',
  吹风机: 'Hair dryer',
  电视: 'TV',
  电脑: 'Laptop',
  电动车充电: 'E-bike charging',
  '自己装还是找专业的？': 'DIY or a professional?',
  自己装: 'DIY',
  专业人士: 'Professional',
  '品牌谁选？': 'Who picks the brand?',
  自己: 'Themselves',
  安装商: 'Installer',
  '旅行时在哪过夜？': 'Where do they stay overnight?',
  营地: 'Campsite',
  房车停车区: 'Motorhome aire',
  离网露营: 'Off-grid',
  '住营地有什么不满意？': 'What bothers them at campsites?',
  '现在的电力系统做不到、但想做的事？': "What would they like to do that their system can't?",

  // ── 核对卡 ──────────────────────────────────────────────────
  确认入库: 'Commit',
  先选客户: 'Pick an account first',
  修改: 'Edit',
  不改了: 'Cancel',
  '重新入库 · 替代之前的记录': 'Re-commit · replaces the previous record',
  撤销: 'Undo',
  // ⚠️ 「客户」在导航里已经有一条（Accounts）。中文当 key 的代价就在这里：
  //    同一个词在两处语境下英文不同，只能取一个。选了导航那个（复数，是个页面名），
  //    核对卡上那一格因此也显示 Accounts —— 可接受。
  //    真要分开就得给那一处换个中文措辞，而不是在字典里放两条同名的。
  品类: 'Category',
  在位品牌: 'Incumbent brand',
  型号: 'Model',
  阶段: 'Stage',
  决策窗口: 'Decision window',
  整车年产量: 'Annual vehicles',
  需求量: 'Demand qty',
  小结: 'Summary',
  处理状态: 'Case status',
  严重度: 'Severity',
  客户链: 'Customer chain',
  可信度: 'Confidence',
  '记成什么？': 'Record it as what?',
  重录不能改类型: 'Type cannot change on re-commit',

  // ── 我的 ────────────────────────────────────────────────────
  我的速记: 'My captures',
  覆盖客户: 'Accounts covered',
  含录音: 'With audio',
  待定客户: 'No account yet',
  退出登录: 'Sign out',
  再点一次确认退出: 'Tap again to sign out',
  本机录音能力: 'Recording capability on this device',
  当前事件: 'Current event',
  语言: 'Language',
  中文: '中文',
  English: 'English',

  // ── 界面语言 + 版本更新（D83）────────────────────────────────
  界面语言: 'Language',
  '语言跟账号走 —— 换手机、换浏览器、清缓存都还在。':
    'Language follows your account — it survives a new phone, a new browser, or a cleared cache.',
  '离线时改不了 —— 语言存在账号上，要连上服务器。':
    'Cannot change this offline — the setting lives on your account and needs the server.',
  '改语言失败（HTTP {a}）': 'Could not change the language (HTTP {a})',
  版本: 'Version',
  检查更新: 'Check for update',
  立即更新: 'Update now',
  '正在检查…': 'Checking…',
  已是最新: 'Up to date',
  '已是最新 · {a}检查过': 'Up to date · checked {a}',
  还没查过: 'Not checked yet',
  '连不上服务器，这次没查成': 'Could not reach the server — check failed',
  这个浏览器不支持后台更新: 'This browser cannot update in the background',
  '有新版本 —— 点右边换过去': 'A new version is ready — tap to switch',
  '有新版本 · 点这里更新': 'New version available · tap to update',
  刚刚: 'just now',

  // ── 一次补齐的其余条目（D80 · T59 收尾）──────────────────────
  // 术语沿用 D78 那轮定的那一套（inverter / distributor / fitment / support case），
  // 免得同一个词在 CRM 里和手机上是两个说法。
  " · 搜「": " · search “",
  " · 没听出内容": " · nothing recognised",
  " 日": "",
  " 月 ": "-",
  "AI 生成": "AI generated",
  "OEM 品牌": "OEM Brand",
  "OEM 子集团": "OEM Sub-Group",
  "OEM 集团": "OEM Group",
  "navigator.mediaDevices 不可用": "navigator.mediaDevices unavailable",
  "—— CRM 里靠它认出「是同一个项目」": "— the CRM uses it to tell “this is the same project”",
  "—— 「客户已确认」只有人能给。": "— only a person can mark it “customer confirmed”.",
  "—— 上游在前，终端客户在最后": "— upstream first, end user last",
  "—— 下面是你的原话和附件名。 定个客户照样能入库，内容一个字都不会丢；要字段的话，回对话里再说一句让它重新读。": "— below are your own words and the attachment names. You can still commit it once you pick an account; not a word is lost. If you want fields, say one more line in the chat and let it read again.",
  "—— 下面这些还没定，别当成已确认的参数": "— nothing below is settled yet; do not treat it as confirmed specs",
  "—— 可以分别派人、分别跟踪": "— each can be assigned and tracked separately",
  "—— 挂错客户的数据比没录更糟": "— data filed under the wrong account is worse than not recorded",
  "。自己再扫一眼原文。": ". Give the original another read yourself.",
  "上传中": "Uploading",
  "上传被取消": "Upload cancelled",
  "上传超时": "Upload timed out",
  "不会再问第二次": "it will not ask a second time",
  "不会进 CRM 的品牌字段": "will not go into the CRM brand field",
  "不在受控名单里 —— 这一格": "is not on the controlled list — this field",
  "不太确定": "Not sure",
  "中": "Medium",
  "会接在已有的项目上：": "Will attach to the existing project: ",
  "传闻必须标成传闻。标了它照样有用（提醒你去核实）；被当成事实用下去才是坏账。": "Hearsay has to be marked as hearsay. Marked, it is still useful — it reminds you to verify. Passed on as fact, it becomes bad debt.",
  "低": "Low",
  "先看一眼再决定。": "Take a look first, then decide.",
  "先装到主屏幕": "Add to your home screen first",
  "入库前必须先定客户": "Pick an account before committing",
  "入库后是草稿": "Committed as a draft",
  "入库失败，稍后再试": "Commit failed — try again shortly",
  "其他": "Other",
  "再跑一次": "and run",
  "出错了": "Something went wrong",
  "到时间上限": "hit the time limit",
  "到步数上限": "hit the step limit",
  "历史": "History",
  "历史对话": "Past chats",
  "变成两个项目。": "from becoming two separate projects.",
  "另开一条新的售后": "Open a new support case",
  "可能不全": "may be incomplete",
  "可能是重复客户": "Possible duplicate account",
  "名单里没有": "not on the list",
  "名字、国家、类型都得填": "Name, country and type are all required",
  "和": " and ",
  "在那之前，打字和上传附件照常能用。": "Until then, typing and attachments work as usual.",
  "完成": "Done",
  "客户提供": "From the customer",
  "客户：": "Account: ",
  "对话": "Chat",
  "展开全文": "Show full text",
  "差一步，追问补交": "one short — asked again",
  "已改": "changed",
  "底部的分享键": "the share button at the bottom",
  "建/更新项目": "create / update project",
  "当前不是 secure context": "Not a secure context",
  "录音": "Recording",
  "录音转录": "transcribe audio",

  // ── 转写失败之后的三个去处（D86/D87 · issue #19/#20/#21）──────────
  // 🔴 这几条的口气是刻意的：**第一句一定先说「音频还在」**。
  //    展台上人最怕的是那句话没了 —— 先把这件事说清楚，再谈怎么办。
  "这段 {a} 录音没转出来 —— 音频还在，一个字节都没丢。":
    "Could not transcribe this {a} recording — the audio is safe, not a byte lost.",
  "这段录音没转出来 —— 音频还在，没丢。":
    "Could not transcribe this recording — the audio is safe.",
  "这条服务端没处理成功。原文还在。": "The server could not process this one. The original is safe.",
  "存到速记": "Save to Capture",
  "重试转写": "Retry transcription",
  "不转了，直接发": "Send as is",
  "已存到速记 —— 音频在那边，可以再试转写。":
    "Saved to Capture — the audio is there, you can retry transcription.",
  "正在排队…": "Queueing…",
  "这条正在处理中，等它跑完再说。": "This one is still being processed — wait for it to finish.",
  "重试转写失败（HTTP {a}）": "Retry transcription failed (HTTP {a})",

  "待传": "Pending",
  "待客户确认": "Awaiting customer",
  "想问一句": "has a question",
  "我方编写": "Written in-house",
  "我最近说过": "What I said recently",
  "把这条交给 AI 整理？\\n\\nAI 会读一遍并抽出客户、类型、字段，": "Send this to the AI?\\n\\nIt will read it once and pull out the account, type and fields, ",
  "拆成任务线程": "split into work items",
  "拿不到麦克风": "Cannot get the microphone",
  "按一下说话": "Tap to talk",
  "按口述整理": "From dictation",
  "接下来会问麦克风": "It will ask for the microphone next",
  "提议新客户": "Proposes a new account",
  "改的是这次读出了什么，你的原话一个字不动。": "You are changing what was read out this time; not a word of your original is touched.",
  "整理完出现在「看板」的待确认里等你核对。\\n\\n（原话不会被改动）": "When it is done it shows up under “To confirm” on the Records tab for you to check.\\n\\n(Your original words are never changed.)",
  "整理成字段": "turn into fields",
  "文档": "Doc",
  "新对话": "New chat",
  "新建": "New",
  "新建客户": "New account",
  "无": "None",
  "是不是这几家里的一家？": "Is it one of these?",
  "更新替代": "in place",
  "未登录": "Not signed in",
  "机器听到的（未修改）": "What the machine heard (unedited)",
  "条": "",
  "条没上传。退出不会删掉它们，但要等": " not uploaded. Signing out does not delete them, but uploads only resume once ",
  "来不及了 —— 已经写进去了。到 CRM 里改吧。": "Too late — it is already written. Change it in the CRM.",
  "查客户": "look up account",
  "查重并新建": "Check for duplicates and create",
  "查项目": "look up project",
  "正在传…": "Uploading…",
  "正在处理": "Working",
  "正在转写…": "Transcribing…",
  "没有编号 —— 入库前补一个": "No code yet — add one before committing",
  "没读开": "could not be read",
  "模型已看图": "seen by the model",
  // ── 附件缩略图（issue #53）──
  "取不到图片": "Image unavailable",
  "看大图": "View full size",
  "正在处理图片…": "Processing image…",
  "读取附件失败：{a}": "Could not read attachment: {a}",
  "测试软件": "Test software",
  "浏览器没有 MediaRecorder": "This browser has no MediaRecorder",
  "点「允许」。": "tap “Allow”.",
  "现在授权": "Grant access now",
  "生成文档": "generate doc",
  "登录已失效，请重新登录": "Your session expired — please sign in again",
  "的记录 —— 提交后按原记录": " record — on submit it updates the original ",
  "的，可以直接用，也可以改成客户那边的编号。": ". Use it as is, or replace it with the customer's own code.",
  "看": "View",
  "看之前说过什么": "see what was said before",
  "看原始转录": "See the raw transcript",
  "看可选值": "see the allowed values",
  "看这家已有什么记录": "see what this account already has",
  "看这家还缺什么": "see what is still missing",
  "硬件接口": "Hardware interface",
  "空的枚举": "empty enum",
  "等你回答": "waiting for you",
  "算一下…": "Working…",
  "类型": "Type",
  "系统生成": "System generated",
  "紧急": "Urgent",
  "终端客户": "End User",
  "网络错误": "Network error",
  "翻手册": "check the playbook",
  "而且这一轮读出来的东西会覆盖上一轮。\\n\\n确定要重新整理吗？": "and what it reads this time will overwrite the last round.\\n\\nRe-run it anyway?",
  "要么不是 secure context，要么被上层 iframe 的 permissions policy 挡住了。": "Either this is not a secure context, or a parent iframe's permissions policy is blocking it.",
  "记成": "Record as",
  "语音": "Voice",
  "说点什么…": "Say something…",
  "说点什么…（Enter 发送 · Shift+Enter 换行）": "Say something… (Enter to send · Shift+Enter for a new line)",
  "读附件": "read attachment",
  "转写没成功，这条先直接发出去了 —— 转录会在服务端补上。": "Transcription failed, so this was sent as is — the transcript will be filled in on the server.",
  "还有没对上的": "some could not be matched",
  "还没改任何一格 —— 改了再重新入库。": "Nothing changed yet — edit a field, then re-commit.",
  "还没问过的": "Not asked yet",
  "这是新问题，和下面那些无关": "This is a new issue, unrelated to the ones below",
  "这条 AI 没整理出结构化字段": "The AI did not produce structured fields for this one",
  "这条已经交给 AI 整理过了。\\n\\n再发一次会重新跑一轮：会再花一次模型调用，": "This one has already been through the AI.\\n\\nSending it again runs another round: it costs another model call, ",
  "这条已经入库了，刚才那次修改没能生效 —— 要改请到 CRM 里改": "This one is already committed, so that edit did not take effect — change it in the CRM instead",
  "这条链的顺序不对": "This chain is in the wrong order",
  "这段录音没听出内容 —— 可以直接打字，或者删掉重录。": "Nothing was recognised in this recording — type it instead, or delete and record again.",
  "连不上服务器。检查网络后重试。": "Cannot reach the server. Check your connection and try again.",
  "选型情报和售后问题是两条方向相反的生命周期 —— 前者从没接触推进到成交，后者从发生到关闭。选错了会落到另一张表里。": "Fitment and support cases are two lifecycles running in opposite directions — one moves from first contact to a deal, the other from incident to closure. Pick the wrong one and it lands in the wrong table.",
  "通信协议": "Protocol",
  "造一个新字段": "create a new field",
  "都问过了。": "All asked.",
  "里程碑": "Milestone",
  "重录失败，稍后再试": "Re-commit failed — try again shortly",
  "需求基线": "Requirement baseline",
  "需要 https 或 localhost。用手机连局域网 IP 不行 —— 跑 `npm run tunnel` 拿一个 https 地址。": "Needs https or localhost. A LAN IP on your phone will not work — run `npm run tunnel` to get an https address.",
  "需要 iOS 14.3+ / 现代 Chrome。": "Needs iOS 14.3+ or a modern Chrome.",
  "项目编号只能是字母、数字和短横线，3–40 位。": "A project code may contain only letters, digits and hyphens, 3–40 characters.",
  "高": "High",
  "（协商中）": "(under negotiation)",
  "（无可用）": "(none available)",
  "（见 CRM）": "(see the CRM)",
  "（语音，待转写）": "(voice, awaiting transcription)",
  "（附件）": "(attachment)",
  "，CRM 里不会多出第二份。 和编号冲突之类的问题会当场告诉你。": ", so the CRM will not get a second copy. Problems such as a code conflict are reported on the spot.",
  "，原话会写进「来源说明」。": "; the original wording goes into “Source note”.",
  "，所以要用麦克风。": ", which is why the microphone is needed.",
  "🎙 正在转写…": "🎙 Transcribing…",
  "传了 {n} 次都没成功 · 点这里再试": "Failed {n} times · tap to retry",
  "传失败（第 {n} 次）": "Upload failed (attempt {n})",
  // ── T59 收尾：JSX 文本节点那一批 ──────────────────────────────
  "← 返回": "← Back",
  "返回": "Back",
  "取消": "Cancel",
  "保存": "Save",
  "项目": "Project",
  "项目编号": "Project code",
  "售后问题": "Support case",
  "渠道链": "Sales chain",
  "传闻": "Hearsay",
  "已经知道的": "Already known",
  "改名字": "Change the name",
  "都不是，新建": "None of these — create new",
  "以后再说": "Later",
  "先跳过": "Skip for now",
  "开始用": "Get started",
  "装好了，下一步": "Installed — next",
  "不要这段录音": "Discard this recording",
  "还原成它读出来的": "Reset to what it read",
  "在 CRM 的": "In the CRM's ",
  "里能找到它，同时会挂一条拜访记录。": " you will find it, together with a visit record.",
  "将使用容器：": "Container in use: ",
  "纠正过的听写：": "Corrected transcript: ",
  "入库前必须定客户": "An account is required before committing",
  "重录不能改归属 —— 要换客户请在 CRM 里操作": "Re-commit cannot change the account — switch it in the CRM",
  "原话和原始转录都会留着": "The original words and raw transcript are both kept",
  "带「传闻」标的还没核实过": "Anything tagged “hearsay” has not been verified",
  "没抽出结构化字段 —— 原文照样留着，定个客户就能入库。": "No structured fields were extracted — the original text is kept, and you can still commit once you pick an account.",
  "这一版已被后面那次修改取代（原话和抽取结果都还在）": "A later edit replaced this version (the original words and extraction are both still here)",
  "建之前系统会再查一次重。": "A duplicate check runs again before it is created.",
  "不需要审批，建完就能用。系统会记下是你建的。": "No approval needed — it works as soon as it is created, and the system records that you created it.",
  "名字写法不同但其实是同一家，是这份客户名单散架过一次的原因。": "Different spellings of the same company are exactly what broke this account list once before.",
  "只能是字母、数字和短横线，3–40 位。不合规的编号会被服务端拒掉 ——": "Letters, digits and hyphens only, 3–40 characters. The server rejects anything else — ",
  "我来认客户、抽字段、找出这家还缺哪些情报。": "I will identify the account, pull out the fields, and find what intel is still missing.",
  "说一句刚才发生的事": "Say what just happened",
  "还没有历史对话。": "No past chats yet.",
  "在下面说一句，就会有第一条。": "Say something below and the first one appears.",
  "「刚跟 Alpin 聊完，他们逆变器现在用 Voltaro，明年想换」": "“Just spoke with Alpin — they run Voltaro inverters now and want to switch next year”",
  "展馆里你不会想在浏览器里找网址。装完它就是一个图标，点开就录。": "At the show you will not want to hunt for a URL in a browser. Once installed it is just an icon — tap it and record.",
  "已经装好了 —— 你现在就是从主屏幕打开的。": "Already installed — you opened this from the home screen.",
  "往下翻，点「添加到主屏幕」，再点右上角「添加」。": "Scroll down, tap “Add to Home Screen”, then tap “Add” at the top right.",
  "必须用 Safari。从微信或邮件里打开的话，先点右上角在 Safari 中打开。": "Safari is required. If you opened this from WeChat or an email, tap the top-right menu and open it in Safari first.",
  "地址栏右边有个「安装」图标，点它。没有的话，浏览器菜单里也有「安装应用」。": "There is an install icon at the right of the address bar — tap it. If it is not there, the browser menu also has “Install app”.",
  "当前不是 https，浏览器根本不会给麦克风。把地址换成 https 的那个。": "This is not https, so the browser will not grant the microphone at all. Switch to the https address.",
  "被拒了。进「设置 → Safari → 麦克风」改成允许，然后重新打开这个应用。": "Permission was denied. Go to Settings → Safari → Microphone, set it to Allow, then reopen this app.",
  "要恢复得进「设置 → Safari → 麦克风」里翻出来。所以这一下别点错。": "Undoing it means digging through Settings → Safari → Microphone. So do not tap the wrong one here.",
  "情报清单还没配内容 —— 所以这里暂时算不出「还缺什么」。": "The intel checklist has no items yet, so “what is missing” cannot be computed here.",
  "清单是数据不是代码：业务方定完，直接在 CRM 的「情报清单项」里建记录就生效，不用发版。": "The checklist is data, not code: once the business side decides, create records under “Intel Item” in the CRM and it takes effect — no release needed.",
  "现在连不上服务器，情报缺口算不出来。上面那两个数字是本地的，照常准。": "The server is unreachable, so intel gaps cannot be computed. The two numbers above are local and still accurate.",
  "这一屏就是 T8 的实测结果。Safari 18.4 起才原生支持 webm；更早的 iOS 只有 mp4 ——": "This screen is the T8 field test itself. Safari supports webm natively only from 18.4; earlier iOS has mp4 only —",
  "所以服务端不能只收一种容器。": "so the server cannot accept just one container format.",
  "重新登录后才会继续传。有网的话建议先传完再退。": "signs in again. If you are online, finish uploading before you sign out.",
  "https 或 localhost": "https or localhost",
  "下载原件": "Download original",
  "停止录音": "Stop recording",
  "关闭": "Close",
  "发送": "Send",
  "名字": "Name",
  "名称": "Name",
  "国家": "Country",
  "如 HYM-BAT-2027-001": "e.g. HYM-BAT-2027-001",
  "录音 API": "Recording API",
  "情报完整度": "Intel completeness",
  "我记过": "I recorded",
  "找客户…": "Find an account…",
  "样品": "Samples",
  "核心产品": "Core product",
  "照他们自己的写法": "Use their own spelling",
  "移除": "Remove",
  "筛选与搜索": "Filter and search",
  "能否申请麦克风": "can request the microphone",
  "计划 SOP": "Planned SOP",
  "负责团队": "Owning team",
  "还缺": "Still missing",
  "这条进展接在哪？": "Where does this update attach?",
  "预算": "Budget",
  "接错了两件不相干的事就并成一条了，而看板上它看起来完全正常。拿不准就另开一条。": "Attach it to the wrong one and two unrelated issues merge into one — and on the board it still looks perfectly normal. When in doubt, open a new one.",
  " · 依赖 {a}": " · depends on {a}",
  " · 内部 {a}": " · internal {a}",
  " · 客户要 {a}": " · customer wants {a}",
  "{a} 分钟前": "{a} min ago",
  "{a} 小时前": "{a} h ago",
  "{a} 台": "{a} units",
  "{a} 秒内可撤销": "undo within {a}s",
  "{a} 记的": "recorded by {a}",
  "「{a}」{b}，超过 {c} 上限": "“{a}” is {b}, over the {c} limit",
  "「{a}」是空文件": "“{a}” is an empty file",
  "一条速记最多 {a} 个附件": "At most {a} attachments per capture",
  "上传中 {a}%": "Uploading {a}%",
  "已上传 {a}%": "Uploaded {a}%",
  "保存失败（HTTP {a}）": "Save failed (HTTP {a})",
  "入库失败（HTTP {a}）": "Commit failed (HTTP {a})",
  "发给 AI 失败（HTTP {a}）": "Send to AI failed (HTTP {a})",
  "取不到（HTTP {a}）": "Could not fetch (HTTP {a})",
  "新建失败（HTTP {a}）": "Create failed (HTTP {a})",
  "建立链路失败（HTTP {a}）": "Linking the chain failed (HTTP {a})",
  "登录失败（HTTP {a}）": "Sign-in failed (HTTP {a})",
  "转写失败（HTTP {a}）": "Transcription failed (HTTP {a})",
  "重录失败（HTTP {a}）": "Re-commit failed (HTTP {a})",
  "刚发过（{a} 秒前），等一会儿再发 —— AI 那边可能还在跑。": "Just sent it ({a}s ago) — give it a moment; the AI may still be running.",
  "听 {a} 说的": "heard from {a}",
  "已建立 {a} 段链路": "{a} link(s) established",
  "录音中 {a}s…": "Recording {a}s…",
  "找客户（共 {a} 家）": "Find an account ({a} total)",
  "接在：{a}": "Attach to: {a}",
  "没有匹配「{a}」的记录。": "No records match “{a}”.",
  "确认入库 · {a}": "Commit · {a}",
  "这几格的值服务端不认：{a}": "The server rejects these values: {a}",
  "🎙 {a} 秒语音": "🎙 {a}s voice",
  "🎙 {a} 语音": "🎙 {a} voice",
  "🎙 {a} 语音 · 正在转写…": "🎙 {a} voice · transcribing…",
  "{a} 条": "{a} record(s)",
  "清除筛选，看全部 {a} 条": "Clear filters — show all {a}",
  "今天记了 {a} 条": "{a} captured today",
  "当前事件：{a}": "Current event: {a}",
  "累计录音 {a} 分钟": "{a} minutes of audio in total",
  "立即上传 {a} 条": "Upload {a} now",
  "支持 {a} 种：{b}": "Supports {a}: {b}",

  // ── AI 工作日志 · 停止 · 消息编辑（D88 / D89 / D90 · issue #24/#22/#23）──
  "正在思考…": "Thinking…",
  "思考了 {a}": "Thought for {a}",
  "思考过程": "Reasoning",
  "还没有工具调用。": "No tool calls yet.",
  "还没有工具调用 —— 它在读原文、想第一步干什么。":
    "No tool calls yet — it is reading your words and deciding the first step.",
  "停止": "Stop",
  "你叫停了": "you stopped it",
  // T99：上个进程被杀、启动时被收掉的那一轮（stop_reason=interrupted）
  "网关重启了": "the gateway restarted",
  "没赶上 —— 这一轮已经跑完了，结果马上就到。":
    "Too late — that round already finished; the result is on its way.",
  "停止失败（HTTP {a}）": "Could not stop it (HTTP {a})",
  "复制": "Copy",
  "编辑": "Edit",
  "重新发送": "Resend",
  "这条消息": "This message",
  "这个浏览器不让复制": "This browser will not let us copy",
  "这句已经改过了 —— 下面是新的那一版（原话没动）":
    "You changed this one — the new version is below (the original is untouched)",
  "这一轮针对的是上面那句已经改掉的话":
    "This round answered the message above, which has since been changed",
  "正在改这一句 —— 发出去会取代它，并在同一条对话上重跑一轮":
    "Editing this message — sending replaces it and re-runs the round in this same thread",
  // ⚠️「不改了」上面已经有一条（和这里的译文逐字节相同），重复 key 会让 tsc TS1117 报错
  "你叫停了这一轮 —— 已经整理出来的都在下面，":
    'You stopped this round — what it already pulled out is below, ',
  "。改一改再发一次就行。": '. Edit it and send again.',

  // ══ 速记详情页（D96 · issue #27）══════════════════════════════════
  附件: 'Attachments',
  上传: 'Upload',
  已上传: 'Uploaded',
  服务端: 'Server',
  '发送中…': 'Sending…',
  再发一次: 'Send again',
  删除这条速记: 'Delete this note',
  已修改: 'edited',
  '已发给 AI': 'sent to AI',
  处理失败: 'Failed',
  // 服务端那一格状态。⚠️ 存中文（规范形式），渲染时才 t() —— D80 判据②
  排队中: 'Queued',
  '整理完，等确认': 'Ready — waiting for you',
  已被后一版取代: 'Superseded by a later version',

  // ══ 发给 AI 的 double check（D95 · issue #26）═════════════════════
  '这条已经发给 AI 了': 'This note is already with the AI',
  '把这条交给 AI 整理？': 'Hand this note to the AI?',
  'AI 会读一遍并抽出客户、类型、字段，整理完出现在「看板」的待确认里等你核对。（原话不会被改动）':
    'The AI reads it once and pulls out the account, type and fields. The result waits for you under “To confirm” in Records. (Your original words are never changed.)',
  '它已经在下面这些对话里了。先进去看看，还是让 AI 重新读一遍？':
    'It already lives in the conversations below. Open one to look, or have the AI read it again?',
  '现在离线，查不到它发给过哪几条对话 —— 有网时再发比较稳妥。':
    'You are offline, so we cannot tell which conversations it was sent to — safer to send when you are back online.',
  未命名对话: 'Untitled conversation',
  '{a} 条消息': '{a} messages',
  当前: 'current',
  正在跑: 'running',
  'AI 正在跑这一条 —— 等它跑完再决定要不要重来。点上面那条对话可以看进度。':
    'The AI is working on this one — wait for it to finish before starting over. Tap the conversation above to watch progress.',
  在原对话里重新整理: 'Redo in the same conversation',
  新建一个对话: 'Start a new conversation',
  '两个都会再花一次模型调用，而且这一轮读出来的东西会覆盖上一轮的提案。':
    'Both cost another model call, and this round overwrites the previous proposal.',
  '区别是：原对话会带着上一轮的结果接着改；新对话从零重读这条速记。':
    'The difference: the same conversation builds on the last round; a new one re-reads the note from scratch.',
  '这条正在跑（{a}）—— 等它跑完再说。': 'This one is already running ({a}) — wait for it to finish.',

  // ══ 删除（D93 · issue #25 / #29）══════════════════════════════════
  删除: 'Delete',
  不删: 'Keep it',
  '删除中…': 'Deleting…',
  '删掉这条速记？': 'Delete this note?',
  '删掉这条记录？': 'Delete this record?',
  '正在看它牵扯到什么…': 'Checking what it touches…',
  删除这条记录: 'Delete this record',
  '这条还没传上去 —— 只存在于这台手机上，删掉就找不回来了。':
    'This one has not been uploaded — it only exists on this phone, and deleting it is permanent.',
  '它会从速记列表里消失。原话和录音都留在服务端，随时可以撤销。':
    'It disappears from your note list. The original words and the audio stay on the server, so you can undo this any time.',
  '⚠️ 这条已经入库了 —— CRM 里那几条记录**不会**被删掉。':
    '⚠️ This one is already committed — the records in the CRM will NOT be deleted.',
  '要删 CRM 里的，去「看板」上删那一行。': 'To delete those, delete the row in Records instead.',
  '现在离线，查不到它在服务端是什么状态 —— 有网时再删比较稳妥。':
    'You are offline, so we cannot tell its server-side state — safer to delete when you are back online.',
  '会同时删掉 CRM 里的 {a} 条记录：': 'This also deletes {a} record(s) in the CRM:',
  '是软删除，撤销可以把它们原样恢复。速记那条原话照常留在「速记」页。':
    'It is a soft delete — undo restores them exactly. The note itself stays under Capture.',
  '这条还没进过 CRM —— 删掉只是它不再出现在看板上。原话照常留在「速记」页。':
    'This one never reached the CRM — deleting it just removes it from Records. The note stays under Capture.',
  '这条已入库，但 CRM 里那几条记录查不到（可能已经在 CRM 里删过了）—— 这里只会把它从看板上移除。':
    'This one was committed, but its CRM records cannot be found (they may already have been deleted there) — this only removes the row from Records.',
  '这些删不掉，会留在 CRM 里：': 'These cannot be deleted and will stay in the CRM:',
  'CRM 里这些没能删掉，请去 CRM 处理：': 'These could not be deleted from the CRM — please handle them there:',
  '已删除 · CRM 里同时删掉了 {a}': 'Deleted · {a} also removed from the CRM',
  '已从看板删除（这条没进过 CRM）': 'Removed from Records (it never reached the CRM)',
  '这条正在写进 CRM，等它写完再删。': 'This one is being written to the CRM — delete it once that finishes.',
  '删除失败（HTTP {a}）': 'Delete failed (HTTP {a})',
  '撤销失败（HTTP {a}）': 'Undo failed (HTTP {a})',
  // CRM 对象名。服务端给的是中文，渲染时过 t()（服务端输出语言跟用户走是 T64）
  拜访: 'Visit',
  商机: 'Opportunity',
  项目文档: 'Project doc',
  工作项: 'Work item',
  选型情报: 'Product fitment',
  情报字段: 'Intel value',

  '看板这一行回来了，但 CRM 里这些找不回来（多半是之前被真删过）：':
    'The row is back in Records, but these could not be recovered from the CRM (most likely they were hard-deleted earlier):',

  // ══ 录音上限 10 分钟（issue #28）══════════════════════════════════
  '录音 ≤10 分钟': 'Record ≤10 min',
  再按一下停止: 'tap again to stop',
  '{a} 秒后自动保存': 'auto-saves in {a}s',
  '录音被打断了（锁屏、来电、或切到了别的 App）—— 已经录到的 {a} 存下来了。':
    'The recording was interrupted (screen lock, a call, or another app) — the {a} captured so far has been saved.',

  // ══ 英文模式最后一批漏网（2026-08-11 · 维护者 真机报的）══════════
  //
  // 🔴 **它们能漏这么久，是因为覆盖率脚本以前不查字典。**
  //    上一版 `i18n-report.mjs` 数的是「有几处调用了 `t()`」，
  //    从不回头问「那条中文在字典里有没有」—— 于是这些条目一直被算成「已翻」，
  //    它报 82%，而按「查得到译文」算是 87%（两个数都不是当时的真相：
  //    前者把没进字典的算成翻了，后者才是能验证的那个）。
  //    脚本这一轮改成按字典命中算，`--check` 接进 `test.sh`，漏一条就红。
  //
  // 来源有三类：
  //   ① 原来长在 **JSX 文本节点**里、这一轮才过 `t()` 的（「第 N 次问」这种）
  //   ② `<b>` 把一句话切成几段，**中间那几段**从来没进过字典
  //   ③ 中文语序拼出来的串（`'08-11'.replace('-', ' 月 ') + ' 日'`），英文得整句给
  //
  // ⚠️ ② 那几条**要连着相邻条目一起读** —— 单看一段像残句是正常的，
  //    拼起来才是一句英文。改其中一条时把整句在脑子里拼一遍。

  // ── 客户页 · 情报缺口（维护者 点名的三条全在这里）────────────────
  '我记过 {a}': 'I logged {a}',
  '没找到「{a}」。': 'No match for “{a}”.',
  '还有 {a} 项（不急着今天问）': '{a} more — no rush today',
  /** wave = 第几次拜访该问。11px 的小角标，只放得下两个词。 */
  '第 {a} 次问': 'Visit {a}',

  // ── 看板 ────────────────────────────────────────────────────────
  /** 🔴 原来是 `'08-11'.replace('-', ' 月 ') + ' 日'` —— 只对中文成立的拼法。 */
  '{m} 月 {d} 日': '{m}/{d}',
  ' · 搜「{a}」': ' · search “{a}”',
  '去对话里确认': 'Confirm in chat',
  '去对话里看': 'View in chat',
  '这条对话前面还有 {a} 版，已被这一版取代（原话都还在）':
    '{a} earlier version(s) of this chat were superseded by this one (every original is kept)',

  // ── 核对卡 ──────────────────────────────────────────────────────
  '提交中…': 'Submitting…',
  '它原来读的': 'what it originally read',
  ' · 已更新过': ' · updated',
  '正在写入 CRM…': 'Writing to the CRM…',
  /** ② 拼：[正在修改][已入库][的记录 —— 提交后按原记录][更新替代][，CRM 里不会…] */
  '正在修改': 'You are editing a ',
  /** ② 拼：[这一条到了处理上限，抽出来的东西][可能不全][。自己再扫一眼原文。] */
  '这一条到了处理上限，抽出来的东西': 'This one hit the processing limit, so what was extracted',
  /** ② 拼：[那正是为了防止] HYM-BAT-001 [和] hym bat 001 [变成两个项目。] */
  '那正是为了防止': 'that is exactly what prevents',
  /** ② 拼：[原话里没有编号，这个是][系统生成][的，可以直接用，也可以…] */
  '原话里没有编号，这个是': 'There was no code in what you said, so this one is ',
  '详情（{a} 字，会原样进 CRM）': 'Details ({a} chars — goes into the CRM verbatim)',
  '这家还有 {a} 条没关掉的售后': 'This account has {a} open support case(s)',
  /** ② 拼：[要让它进去，把这家补进] data/suppliers.json [再跑一次] seed-suppliers。 */
  '要让它进去，把这家补进': 'To let it through, add this brand to',
  '当前阶段 {a}': 'Current stage {a}',
  '报于 {a}': 'reported {a}',
  '这条记成什么？': 'What is this recorded as?',
  '改「{a}」': 'Edit “{a}”',

  // ── 对话页 ──────────────────────────────────────────────────────
  '已读': 'Read',
  '删除这条对话': 'Delete this chat',
  '这条对话已从历史里删掉了 —— 内容还在，可以恢复。':
    'This chat was removed from your history — the content is still here and can be restored.',
  '恢复': 'Restore',
  '已删除「{a}」': 'Deleted “{a}”',
  '添加内容': 'Add content',
  '这一句上一轮已经入库了': 'This line was already committed on the previous round',
  /** ② 拼：[发出去会][改写][下面这几条已入库的记录，不会新建第二份：] */
  '发出去会': 'Sending it will ',
  '改写': 'rewrite',
  '下面这几条已入库的记录，不会新建第二份：':
    ' the committed records below — it will not create a second copy:',
  '（未命名）': '(untitled)',
  /** ② 拼：[如果这一轮把客户认成了另一家，上面这几条会被][软删][、在新客户名下重建…] */
  '如果这一轮把客户认成了另一家，上面这几条会被':
    'If this round identifies a different account, the records above are ',
  '软删': 'soft-deleted',
  '、在新客户名下重建（随时可撤销）。': ' and rebuilt under the new account (undoable at any time).',
  '⚠️ 这条对话里还有 {a} 版已入库的记录不会被改写 —— 要改它们，去「看板」上那一行改。':
    '⚠️ {a} more committed version(s) in this chat will NOT be rewritten — to change those, edit their row under Records.',
  '（这一版是「删除/改写」功能上线之前入库的，清单是保守推断出来的。）':
    '(This version was committed before delete/rewrite shipped, so the list is a conservative guess.)',
  '先不改': 'Leave it',
  '改写并重发': 'Rewrite and resend',
  '删掉这条对话？': 'Delete this chat?',
  '它会从历史列表里消失，随时可以撤销。':
    'It disappears from the history list, and can be undone at any time.',
  /**
   * ② 删除确认框拼出来的两句 —— **这两句是这个框的全部价值**（见 Chat.tsx 的注释）：
   *   [速记页那条原话][不会][被删掉。]
   *   [已经入库到 CRM 的那几条也][不会][ —— 要删它们，去「看板」上删那一行。]
   * `不会` / `被删掉。` 和「速记」页的删除框共用，两处必须都读得通。
   */
  '速记页那条原话': 'The original note under Capture ',
  '不会': 'will not',
  '被删掉。': ' be deleted.',
  '已经入库到 CRM 的那几条也': 'The records already committed to the CRM ',
  ' —— 要删它们，去「看板」上删那一行。':
    ' be deleted either — to delete those, remove that row under Records.',
  /** ② 速记页删除框：[这条已经入库了 —— CRM 里那几条记录][不会][被删掉。] */
  '这条已经入库了 —— CRM 里那几条记录': 'This one is already committed — those CRM records ',

  // ── 客户选择 · 渠道链 ───────────────────────────────────────────
  'AI 提议：{a}': 'AI suggests: {a}',
  '名单里没有「{a}」。确认拼写没错的话点「新建」——':
    '“{a}” is not on the list. If the spelling is right, tap New —',
  '相似度 {a}%': '{a}% similar',
  '查重中…': 'Checking for duplicates…',
  '新建「{a}」（{b}）': 'New “{a}” ({b})',
  '建立这条链路': 'Create this chain',

  // ── 项目卡 ──────────────────────────────────────────────────────
  '关键参数（{a} 字）': 'Key specs ({a} chars)',
  '拆成 {a} 条线程': 'Split into {a} thread(s)',
  '未知：{a}': 'Open: {a}',
  /** ② 拼：[这份是 AI 整理的，][入库后是草稿][—— 「客户已确认」只有人能给。] */
  '这份是 AI 整理的，': 'The AI wrote this up. ',
  '正文（{a} 字）': 'Body ({a} chars)',

  // ── 引导页 ──────────────────────────────────────────────────────
  /** ② 拼：[这个应用的主要用法是][按一下说话][，所以要用麦克风。] */
  '这个应用的主要用法是': 'The main way to use this app is ',
  /** ② 拼：[iPhone 在你点过一次「不允许」之后][不会再问第二次] —— [要恢复得进…] */
  'iPhone 在你点过一次「不允许」之后': 'Once you tap “Don’t Allow” on iPhone, ',
  '麦克风好了。容器：': 'Microphone ready. Container: ',

  // ── 其它 ────────────────────────────────────────────────────────
  /** ② 拼：[还有] N [条没上传。退出不会删掉它们，但要等] <代号> [重新登录后…] */
  '还有': 'There are still',
  'AI 正在这条对话里跑 —— 先按停止再删。':
    'The AI is running in this chat — stop it before deleting.',
  '原件已经不在服务器上了': 'The original file is no longer on the server',

  /**
   * 🔴 **一个汉字都没有的中文。**
   *
   * 中文引号包住一个**变量**（记录类型 / 品牌名 / 对话标题），还有句尾那个 `。`——
   * 原来都是直接写死在 JSX 里的。英文界面上它们会冒出一对中文引号和一个中文句号，
   * 而**覆盖率脚本当时看不见**：它认的是 `[一-鿿]`，而 `「」。` 不在那个区段里。
   * 脚本这一轮补上了中文标点，这两条就是它抓出来的。
   */
  '「{a}」': '“{a}”',
  '。': '.',
  /** 顿号：英文用逗号+空格分隔。`join(t('、'))` 和「纠正过的听写」那一串都在用。 */
  '、': ', ',
  '：': ': ',
  /** 中文用双破折号，英文用一个。裸在 JSX 里的那一处（引导页 · iPhone）。 */
  ' —— ': ' — ',

  // ══ D110–D112 带进来的（合 main 时守卫当场抓出来的 9 条）══════════
  //
  // 🔴 **这就是这道守卫存在的意义**：这 9 条不是这一轮写的，是 `origin/main`
  //    上另一条分支两小时前加的 —— 合进来的一瞬间 `--check` 就红了。
  //    在这之前，新加的中文进不进字典**全靠写的人记得**，而没有人会记得。
  //
  // ⚠️ D111 把「AI 那一屏的录音」整个改了语义：**转完就丢，不上传**。
  //    所以这几句的英文要说清「不会保存」，别沿用旧那套「已附上」的说法。
  '已存到速记 —— 音频和转录都在那边。': 'Saved to Capture — the audio and transcript are both there.',
  '这段 {a} 录音没转出来 —— 它还在手机里，但只在这一屏开着的时候。':
    'This {a} recording could not be transcribed — it is still on your phone, but only while this screen stays open.',
  '要留住它，点「存到速记」—— 那边音频才会真的存下来。':
    'To keep it, tap “Save to Capture” — that is the only place the audio is actually stored.',
  '丢掉这段': 'Discard it',
  '正在把这段 {a} 录音转成文字…（转完会插到光标处）':
    'Transcribing this {a} recording… (it will be inserted at the cursor)',
  ' · 已转成文字（在输入框里，可以改）': ' · transcribed (it is in the box and can be edited)',
  '这段录音不会被保存 —— 要留住它就存到速记。':
    'This recording will not be saved — save it to Capture to keep it.',
  '知道了': 'Got it',
  '正在把这段 {a} 转成文字…': 'Transcribing this {a}…',

  // ── 「写一条」的编辑器（D135）──────────────────────────────────
  '打字 · 可排版': 'Keyboard · formatting',
  预览: 'Preview',
  标题: 'Heading',
  粗体: 'Bold',
  列表: 'Bulleted list',
  编号列表: 'Numbered list',
  待办: 'To-do',
  引用: 'Quote',
  '{a} 字': '{a} chars',
  '从这里开始写…\n\n下面那一排可以加标题、列表、待办。收起不会丢 —— 字会留在快速输入框里。':
    'Start writing…\n\nThe bar below adds headings, lists and to-dos. Collapsing loses nothing — the text stays in the quick box.',
  '（还没写内容）': '(Nothing written yet)',
  '存下来之后，详情页里就是这个样子。': 'This is how it will look in the note details once saved.',
};

/** 当前语言。**从登录态取** —— 服务端的 `app_user.locale` 是真相源。 */
export const locale = (): Locale => (getSession()?.user.locale === 'en' ? 'en' : 'zh');

/**
 * 翻译一个字符串。
 *
 * ```ts
 * t('待确认')            // zh → '待确认'，en → 'To confirm'
 * t('待传 {n}', { n: 3 }) // 占位符按名字替换
 * ```
 *
 * 🔴 **查不到就原样返回。** 不抛异常、不显示 key —— 一个半翻的界面
 * 比一个显示 `board.filter.title` 的界面有用得多。
 */
export const t = (zh: string, vars?: Record<string, string | number>): string => {
  let out = locale() === 'en' ? (EN[zh] ?? zh) : zh;
  if (vars) for (const [k, v] of Object.entries(vars)) out = out.replaceAll(`{${k}}`, String(v));
  return out;
};

/** 字典本身 —— 给覆盖率脚本用，不要在界面代码里读它。 */
export const DICT_EN = EN;
