/**
 * 管理控制台的页面。刻意是**一个自包含的字符串**：
 *  · 不进 PWA 的包 —— 销售手机上永远没有这段代码
 *  · 没有构建步骤、没有外部资源（无 CDN、无字体请求），部署时不会多一处出错的地方
 *
 * 接口地址由 `location.pathname` 推出来，所以挂在 `/admin` 还是 `/api/admin`
 * 还是某个不好猜的路径下，都不用改代码。
 */
export const ADMIN_HTML = /* html */ `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>账号管理 · Boothnote</title>
<style>
  :root{--text:#12121a;--soft:#6b6b76;--light:#a8a8b3;--line:#ececf0;--bg:#fff;--bg2:#f7f7f9;
        --blue:#1961ed;--red:#d8515d;--ok:#2fa361;--warn:#b37e00}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg2);color:var(--text);
       font:15px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC",sans-serif}
  .wrap{max-width:880px;margin:0 auto;padding:40px 20px 80px}
  h1{font-size:22px;margin:0 0 4px}
  .sub{color:var(--light);font-size:13px;margin-bottom:28px}
  .card{background:var(--bg);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}
  label{display:block;font-size:12px;font-weight:600;margin:0 0 6px;color:var(--soft)}
  input,select{width:100%;padding:10px 12px;font:inherit;border:1px solid var(--line);
               border-radius:9px;background:var(--bg);outline:none}
  input:focus,select:focus{border-color:var(--blue)}
  button{font:inherit;border:none;border-radius:9px;padding:10px 16px;cursor:pointer;font-weight:600}
  .primary{background:var(--text);color:#fff}
  .primary:disabled{background:#e8e8ec;color:var(--light);cursor:not-allowed}
  .ghost{background:transparent;color:var(--soft);border:1px solid var(--line);padding:6px 12px;font-weight:500;font-size:13px}
  .ghost:hover{border-color:#dcdce2}
  .danger{color:var(--red)}
  .row{display:grid;grid-template-columns:1fr 1fr 160px;gap:12px}
  table{width:100%;border-collapse:collapse;font-size:14px}
  th{text-align:left;font-size:12px;color:var(--light);font-weight:500;padding:0 10px 10px;border-bottom:1px solid var(--line)}
  td{padding:12px 10px;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:last-child td{border-bottom:none}
  .off{opacity:.45}
  .tag{display:inline-block;font-size:11px;padding:2px 7px;border-radius:5px;background:var(--bg2);color:var(--soft)}
  .msg{padding:12px 14px;border-radius:10px;font-size:14px;margin-bottom:14px;line-height:1.65}
  .msg.err{background:#fdf0f1;color:var(--red)}
  .msg.ok{background:#eff9f2;color:var(--ok)}
  .msg.warn{background:#fdf6e6;color:var(--warn)}
  code{background:var(--bg2);padding:3px 7px;border-radius:5px;font-size:14px;
       font-family:ui-monospace,SFMono-Regular,Menlo,monospace;user-select:all}
  .hint{font-size:12.5px;color:var(--light);line-height:1.7;margin-top:10px}
  .hide{display:none}
</style>
</head>
<body>
<div class="wrap">
  <h1>账号管理</h1>
  <div class="sub">Boothnote · 写入端账号</div>

  <!--
    🔴 消息条必须在 #gate 和 #app **外面**。
    2026-08-04 实测：它原本嵌在 <div id="app" class="hide"> 里，于是**令牌页的每一条
    报错都写进了一个 display:none 的容器** —— 服务器明明回了 503 admin_disabled、
    人也翻译好了中文，界面上却是「点了完全没反馈」，只能去控制台看红字。
    登录失败是这个页面最常见的一条路径，它的反馈不能挂在登录成功才显示的容器上。
  -->
  <div id="msg"></div>

  <!-- ── 令牌 ────────────────────────────────────────────── -->
  <div class="card" id="gate">
    <label>Access token</label>
    <!--
      🔴 **这个 <form> 不是装饰。**
      密码框不放在 form 里，Chrome 会在控制台警告并降级处理它
      （[DOM] Password field is not contained in a form）。
      ⚠️ 这一整个页面是个 JS 模板字符串 —— **注释里不能出现反引号**，
      会当场把字符串截断（刚写这段注释时就踩了一次）。
      而**密码管理器类的浏览器扩展在这种框上行为最不可预测** ——
      2026-08-03 实测遇到过「点了没反应、也打不进字」，控制台里是某个扩展的
      background.js 在刷屏。包进 form 之后行为回到标准路径，顺带白拿原生的回车提交。

      autofocus：打开就能直接粘，不用先点一下。令牌是 43 位 base64，
      手打不现实，所以这一栏的实际用法就是「粘贴 + 回车」。
    -->
    <form id="gateForm" class="row" style="grid-template-columns:1fr 84px 120px" autocomplete="off">
      <input id="tok" name="admin-token" type="password"
             placeholder="来自服务器 .env 的 ADMIN_TOKEN"
             autocomplete="off" autofocus spellcheck="false">
      <!-- 能看一眼自己粘进去的是什么 —— 粘错一位和没粘，报的都是同一个 401，
           不给这个开关的话根本分不出是哪种 -->
      <button class="ghost" id="peek" type="button">显示</button>
      <button class="primary" id="enter" type="submit">进入</button>
    </form>
    <div class="hint">
      令牌只存在这个标签页（<code>sessionStorage</code>），关掉就没了。
      连续错 8 次会锁 15 分钟。
    </div>
  </div>

  <div id="app" class="hide">
    <!-- ── 新建 ──────────────────────────────────────────── -->
    <div class="card">
      <div style="font-weight:600;margin-bottom:14px">新建账号</div>
      <div class="row">
        <div><label>代号（登录用）</label><input id="code" placeholder="jonas" autocomplete="off"></div>
        <div><label>显示名</label><input id="name" placeholder="Jonas" autocomplete="off"></div>
        <div><label>角色</label><select id="role">
          <option value="user">user · 只看自己的</option>
          <option value="staff">staff · 能看看板</option>
          <option value="management">management · 能看看板</option>
          <option value="admin">admin · 全权</option>
        </select></div>
      </div>
      <div style="margin-top:12px">
        <label>初始密码（留空则自动生成）</label>
        <div class="row" style="grid-template-columns:1fr 120px">
          <input id="pw" type="text" placeholder="留空 = 服务端随机生成" autocomplete="off">
          <button class="primary" id="add">创建</button>
        </div>
      </div>
      <div class="hint">
        密码<b>只在创建后显示这一次</b>，之后既看不了也改不了 —— 服务端只存 scrypt 哈希。
        忘了密码只能停用后重建。
      </div>
    </div>

    <!-- ── 列表 ──────────────────────────────────────────── -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-weight:600">账号 <span class="tag" id="count">–</span></span>
        <button class="ghost" id="refresh">刷新</button>
      </div>
      <table>
        <thead><tr><th>代号</th><th>显示名</th><th>角色</th><th>速记</th><th>状态</th><th></th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
      <div class="hint">
        「停用」= 立刻失效已签发的 token，本人当场下线；<b>速记全部保留</b>。
        只有一条速记都没有的账号才能真删 —— 原文只增不改，删账号会连着删掉他录过的东西。
        「补发密码」给钉钉自动建的号开 PWA 用 —— 同样只显示一次。
      </div>
    </div>

    <!-- ── 钉钉渠道（T93）──────────────────────────────────── -->
    <div class="card">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
        <span style="font-weight:600">钉钉渠道</span>
        <button class="ghost" id="ddRefresh">刷新</button>
      </div>
      <div style="font-size:13px;color:var(--soft);margin-bottom:8px">群（@ 过任意一个机器人就自动登记；<b>一群一条 webhook，录入和实验室两个 bot 共用</b>）</div>
      <table>
        <thead><tr><th>群</th><th>消息（录·研）</th><th>回执 webhook</th><th></th></tr></thead>
        <tbody id="ddConvos"></tbody>
      </table>
      <div class="hint">
        配一个新群三步：拉机器人进群并 @ 一句（群出现在上面）→ 群设置里加「自定义机器人」，
        把 webhook 贴进来保存 → 点「测试」。<br>
        🔴 测试的回包 200 <b>不代表送达</b> —— 被关键词拦掉和真送到长得一模一样，
        唯一算数的验证是去群里用眼睛看那条消息在不在。填流程 webhook（connector.dingtalk.com）时，
        流程触发关键词必须和 .env 的 <code>CHANNEL_FLOW_KEYWORD</code> 一致。
      </div>
      <div style="font-size:13px;color:var(--soft);margin:18px 0 8px">身份（新钉钉 ID 自动建号；老同事在这里改绑到他原来的账号）</div>
      <table>
        <thead><tr><th>钉钉 ID</th><th>账号</th><th>速记</th><th>改绑到</th><th></th></tr></thead>
        <tbody id="ddIds"></tbody>
      </table>
      <div class="hint">改绑<b>只影响之后的记录</b>，已录的留在原账号名下。</div>
    </div>
  </div>
</div>

<script>
// 接口地址由当前路径推出 —— 挂在 /admin 还是 /api/admin 还是别的路径都不用改
const BASE = location.pathname.replace(/\\/+$/, '');
const $ = (id) => document.getElementById(id);
let TOKEN = sessionStorage.getItem('boothnote-admin') || '';

const say = (text, kind) => {
  $('msg').innerHTML = text ? '<div class="msg ' + (kind || 'ok') + '">' + text + '</div>' : '';
};

const call = async (path, opts = {}) => {
  // 🔴 只有真的带 body 才声明 Content-Type。
  //    Fastify 对「声明了 application/json 但 body 为空」的 POST 直接返回 400 Bad Request
  //    —— 停用/启用这类无 body 的操作会全部静默失败（实测踩到过）。
  const headers = { 'X-Admin-Token': TOKEN, ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, { ...opts, headers });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || ('HTTP ' + res.status)), { json, status: res.status });
  return json;
};

const ERRORS = {
  bad_token: '令牌不对',
  locked: '失败次数过多，已锁定，稍后再试',
  exists: '这个代号已经存在',
  bad_user_code: '代号只能用小写字母、数字和 . _ -，2–31 位',
  weak_password: '密码至少 8 位',
  missing_display_name: '显示名不能为空',
  bad_webhook: 'webhook 要 https:// 开头（钉钉自定义机器人给的那个）',
  no_webhook: '这个群还没保存 webhook —— 先填上并保存，再点测试',
  user_not_found: '没有这个代号的账号',
  identity_not_found: '这条身份不存在了，刷新一下',
  missing_user_code: '先填要绑到的账号代号',
  admin_disabled: '控制台在服务端是关的：网关进程里 ADMIN_TOKEN 为空。' +
    '查两处 —— <code>.env</code> 有没有这一行，以及 <code>docker-compose.yml</code> 的 gateway environment 有没有把它传进容器。',
};
const human = (e) => ERRORS[e.json?.error] || e.json?.hint || e.message;

const loadChannels = async () => {
  const { conversations, identities } = await call('/channels');
  $('ddConvos').innerHTML = conversations.length ? conversations.map((c) => {
    // 投递口类型由服务端判（isFlowWebhook 是唯一真相源），这里只翻译成中文
    const kind = c.webhook_kind === 'flow' ? '<span class="tag">流程</span>'
      : c.webhook_kind === 'robot' ? '<span class="tag">机器人</span>'
      : '<span class="tag" style="color:var(--warn)">未配回执</span>';
    return '<tr><td>' + (c.title || c.conversation_key) + ' ' + kind + '</td>' +
    '<td style="white-space:nowrap">' + c.message_count + ' · ' + (c.lab_count || 0) + '</td>' +
    '<td><input data-dd-hook="' + c.id + '" placeholder="https://oapi.dingtalk.com/robot/send?access_token=…" value="' + (c.webhook_url || '') + '"></td>' +
    '<td style="text-align:right;white-space:nowrap">' +
      '<button class="ghost" data-dd-save="' + c.id + '">保存</button> ' +
      '<button class="ghost" data-dd-probe="' + c.id + '"' + (c.webhook_url ? '' : ' disabled') + '>测试</button></td></tr>';
  }).join('') : '<tr><td colspan="4" style="color:var(--light)">还没有群 —— 群里 @ 一次任意一个机器人（录入或实验室）就会出现在这里</td></tr>';
  $('ddIds').innerHTML = identities.length ? identities.map((x) =>
    '<tr><td><code>' + x.channel_user_id + '</code></td>' +
    '<td>' + x.user_code + '（' + x.display_name + '）' + (x.is_active ? '' : ' <span class="tag">停用</span>') + '</td>' +
    '<td>' + x.note_count + '</td>' +
    '<td><input data-dd-user="' + x.id + '" placeholder="已有账号的代号，如 alex"></td>' +
    '<td style="text-align:right"><button class="ghost" data-dd-rebind="' + x.id + '">改绑</button></td></tr>'
  ).join('') : '<tr><td colspan="5" style="color:var(--light)">还没有身份 —— 有人 @ 过机器人就会出现在这里</td></tr>';
};

const load = async () => {
  const { items } = await call('/users');
  $('count').textContent = items.length;
  $('rows').innerHTML = items.map((u) => {
    const acts = u.is_active
      ? '<button class="ghost" data-act="password" data-code="' + u.user_code + '">补发密码</button> ' +
        '<button class="ghost" data-act="deactivate" data-code="' + u.user_code + '">停用</button>'
      : '<button class="ghost" data-act="activate" data-code="' + u.user_code + '">启用</button>' +
        (u.note_count === 0
          ? ' <button class="ghost danger" data-act="delete" data-code="' + u.user_code + '">删除</button>'
          : '');
    return '<tr class="' + (u.is_active ? '' : 'off') + '">' +
      '<td><code>' + u.user_code + '</code></td>' +
      '<td>' + u.display_name + '</td>' +
      '<td><span class="tag">' + u.role + '</span></td>' +
      '<td>' + u.note_count + '</td>' +
      '<td>' + (u.is_active ? '在用' : '已停用') + '</td>' +
      '<td style="text-align:right">' + acts + '</td></tr>';
  }).join('');
};

const enter = async () => {
  TOKEN = $('tok').value.trim();
  if (!TOKEN) return;
  try {
    await call('/users');
    say('');   // 上一次失败的红条不要跟着进来
    sessionStorage.setItem('boothnote-admin', TOKEN);
    $('gate').classList.add('hide');
    $('app').classList.remove('hide');
    await load();
    await loadChannels().catch(() => {});
  } catch (e) {
    say(human(e), 'err');
    sessionStorage.removeItem('boothnote-admin');
  }
};

// 回车提交由 <form> 原生负责，不用再自己听 keydown ——
// 少一个手写的键盘处理器，就少一处能被别人（扩展、输入法）搅黄的地方
$('gateForm').onsubmit = (e) => {
  e.preventDefault();
  enter();
};
$('peek').onclick = () => {
  const i = $('tok');
  const show = i.type === 'password';
  i.type = show ? 'text' : 'password';
  $('peek').textContent = show ? '隐藏' : '显示';
  i.focus();
};
$('refresh').onclick = () => load().catch((e) => say(human(e), 'err'));

$('add').onclick = async () => {
  const body = {
    userCode: $('code').value,
    displayName: $('name').value,
    role: $('role').value,
    password: $('pw').value || undefined,
  };
  $('add').disabled = true;
  try {
    const r = await call('/users', { method: 'POST', body: JSON.stringify(body) });
    say('已创建 <b>' + r.userCode + '</b>　初始密码 <code>' + r.password + '</code><br>' +
        '<b>现在就抄走给本人</b> —— 这是唯一一次显示，服务端只存哈希。' +
        (r.contributorSynced ? '' : '<br>（Twenty 的 contributor 没同步上，不影响登录，下次有人确认入库时会补建）'),
        'warn');
    $('code').value = ''; $('name').value = ''; $('pw').value = '';
    await load();
  } catch (e) { say(human(e), 'err'); }
  $('add').disabled = false;
};

$('rows').onclick = async (ev) => {
  const b = ev.target.closest('button[data-act]');
  if (!b) return;
  const { act, code } = b.dataset;
  if (act === 'delete' && !confirm('真删账号 ' + code + '？（只有他一条速记都没有时才允许）')) return;
  if (act === 'deactivate' && !confirm('停用 ' + code + '？他会当场下线，速记全部保留。')) return;
  if (act === 'password' && !confirm('给 ' + code + ' 补发新密码？旧密码立即失效，本人当场下线。')) return;
  try {
    const r = act === 'delete'
      ? await call('/users/' + code, { method: 'DELETE' })
      : await call('/users/' + code + '/' + act, { method: 'POST' });
    if (act === 'password')
      say('新密码 <code>' + r.password + '</code> —— <b>现在就抄走给本人</b>，只显示这一次。', 'warn');
    else say(r.note || '已完成', 'ok');
    await load();
  } catch (e) { say(human(e), 'err'); }
};

$('ddRefresh').onclick = () => loadChannels().catch((e) => say(human(e), 'err'));
document.addEventListener('click', async (ev) => {
  const s = ev.target.closest('button[data-dd-save]');
  const rb = ev.target.closest('button[data-dd-rebind]');
  const pb = ev.target.closest('button[data-dd-probe]');
  try {
    if (s) {
      const url = document.querySelector('input[data-dd-hook="' + s.dataset.ddSave + '"]').value;
      await call('/channels/conversations/' + s.dataset.ddSave,
                 { method: 'POST', body: JSON.stringify({ webhookUrl: url }) });
      say(url ? '回执 webhook 已保存 —— 点「测试」发一条真消息，然后去群里看' : '已清掉 —— 这个群的回执会降级成「去 PWA 看」', 'ok');
      await loadChannels();
    } else if (pb) {
      // 顺便测 @ —— markdown 不真 @ 那个洞只在补发那条腿上承重，配置时不测就没人会测
      const who = prompt('要顺便测「@ 到人」吗？填一个钉钉 userid（留空 = 只测送达）', '');
      if (who === null) return; // 取消 = 不发
      const r = await call('/channels/conversations/' + pb.dataset.ddProbe + '/probe',
                           { method: 'POST', body: JSON.stringify({ sender: who.trim() }) });
      const kindText = r.kind === 'flow' ? '流程 webhook，已包 keyword 信封' : '自定义机器人';
      say(r.ok
        ? '测试消息已发出（HTTP ' + r.httpStatus + ' · ' + kindText + '）。<br>🔴 ' + r.note
        : '❌ 没发出去（HTTP ' + (r.httpStatus || '—') + ' · ' + (r.response || '连不上') + '）。地址贴错、机器人被移除、或流程停用都长这样。',
        r.ok ? 'warn' : 'err');
    } else if (rb) {
      const userCode = document.querySelector('input[data-dd-user="' + rb.dataset.ddRebind + '"]').value;
      if (!userCode) return say('先填要绑到的账号代号', 'err');
      if (!confirm('把这个钉钉 ID 改绑到 ' + userCode + '？只影响之后的记录。')) return;
      const r = await call('/channels/identities/' + rb.dataset.ddRebind + '/rebind',
                           { method: 'POST', body: JSON.stringify({ userCode }) });
      say(r.note || '已改绑', 'ok');
      await loadChannels();
    }
  } catch (e) { say(human(e), 'err'); }
});

// 同一标签页里刷新过 —— 令牌还在就直接进
if (TOKEN) { $('tok').value = TOKEN; enter(); }
</script>
</body>
</html>`;
