#!/usr/bin/env bash
# 测试总入口。
#
#   ./scripts/test.sh              单元测试（永远安全，不碰网络和库）
#   ./scripts/test.sh all          单元 + 集成（集成需要本地网关 + boothnote 库）
#   ./scripts/test.sh scenarios    docs/test_example 的 T01–T05 业务验收（真调模型，几分钟）
#   ./scripts/test.sh integration  只跑集成
#   ./scripts/test.sh smoke [url]  只读冒烟，可对生产跑
#
# 三层的分工：
#   单元 —— 纯逻辑。抽取正则、密码哈希、容器协商。改代码时随手跑。
#   集成 —— 真 HTTP + 真库。鉴权、幂等、作用域、原文不可变。**只对 localhost**。
#   冒烟 —— 只读 curl。对生产也安全，部署后跑。
set -uo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-unit}"
FAILED=0
head() { printf '\n\033[1m━━ %s ━━\033[0m\n' "$*"; }
run()  { "$@" || FAILED=1; }

# 🔴 **子 shell 里的 FAILED 传不回来。**
#
# 原来每一档都写成 `( cd xxx && run 命令 )` —— `run` 把 FAILED=1 设在**子 shell**里，
# 父进程那个 FAILED 一直是 0，于是最后无条件打印「✅ 全部通过」。
# 2026-08-03 实测：场景验收 1 条失败，脚本照样说全部通过。
# **一个永远绿的测试脚本比没有测试更危险** —— CI 和 pre-push 钩子都靠它。
#
# `into()` 换掉那个写法：子 shell 的退出码在外面收。
into() { local dir="$1"; shift; ( cd "$dir" && "$@" ) || FAILED=1; }

# ── 静态检查 ──────────────────────────────────────────────────────
# vitest 抓不到的东西：类型错误、不存在的导出、构建期才炸的问题。
# 实测吃过亏：`twenty-ui` 里没有 IconMicrophone，tsc 放过了、打包才报错。
checks() {
  head "类型检查 + 构建"
  into apps/capture-pwa npx tsc -b
  into services/gateway npx tsc --noEmit

  # 🔴 i18n 安全（D80）：**换语言只许改显示，绝不许改数据。**
  #    触发它的是一个真 bug —— `sync.ts` 把 `t()` 的结果写进了 IndexedDB，
  #    于是同一条语音速记在英文账号下存成英文、中文账号下存成中文。
  #    tsc 抓不到这类（类型完全正确），只能靠源码扫。
  # ⚠️ **必须用 `run` 包一层。** 裸写 `node scripts/xxx.mjs` 的话，退出码没人收 ——
  #    `set -uo pipefail` 里没有 `-e`，脚本照跑，`FAILED` 还是 0，末尾照样打「✅ 全部通过」。
  #    2026-08-10 实测：这一行原来就是裸的，**i18n 守卫红了整个 test.sh 也是绿的**，
  #    和本文件上面那段注释记的「子 shell 里的 FAILED 传不回来」是同一个形状的错。
  run node scripts/check-i18n-safety.mjs

  # 🔴 i18n 覆盖率（D80）：**英文模式下不许有地方退回中文。**
  #    上面那道守的是「换语言别改数据」，这一道守的是「换了语言真的换了」——
  #    两件事，都出过真事故。
  #    2026-08-11 维护者 真机报：英文账号下「还没问过的」「第 N 次问」
  #    「还有 N 项（不急着今天问）」全是中文。而当时的 `i18n-report.mjs`
  #    报 82% 且**没有任何一档会红** —— 它数的是「有几处调用了 t()」，
  #    从不回头查那条中文在字典里有没有。**「调用了翻译函数」不等于「翻得出来」。**
  #    现在它按字典命中算，并且额外抓 JSX 文本节点里的裸中文（那类补字典没用，要改代码）。
  run node scripts/i18n-report.mjs --check

  # 🔴 schema 漂移（§2.28）：**改 label 安全，改 name / 枚举 value 会静默毁数据。**
  #    provision-twenty.mjs 对这两类改动照样回 HTTP 200、日志里一个字都没有 ——
  #    改名的字段会被当成新字段建出来，线上老那列的数据从此没人读。
  #    CLAUDE.md 早就写下了这条对账（「比对新旧 twenty-schema.mjs 的字段 name
  #    集合与枚举 value 集合」），但在这一行出现之前它**只活在文档里，靠人记得去 grep**。
  run node scripts/check-schema-drift.mjs
  into apps/capture-pwa npm run build --silent
}

# ── 单元 ──────────────────────────────────────────────────────────
units() {
  # ⚠️ 这一档是**通配符**（vitest 自动发现 `src/**/*.test.ts`），和下面网关那两档
  #    逐个列文件不一样 —— PWA 侧没有「要真库真 HTTP」的测试可以被误卷进来。
  #    所以新加 PWA 测试文件**不用**改这个脚本。
  head "单元 · PWA（离线补传 / 附件准入 / 录音容器协商 / 看板分组 / 更新闸门）"
  into apps/capture-pwa npx vitest run --reporter=basic

  # 网关这边是 node:test，不是 vitest。**逐个列出来，不用通配符** ——
  # 通配符会把需要真库真 HTTP 的 api.test.ts 一起卷进来，那是集成层的东西。
  # ⚠️ 新加零依赖的测试文件，**必须往这张单子里加一行**。
  #    2026-08-03 发现 window.test.ts 写了但从来没被跑过 —— 逐个列出来的代价就是这个，
  #    但通配符的代价更大（会把要真库的 api.test.ts 卷进来，本地永远红）。
  head "单元 · 网关（密码 / 查重 / 决策窗口 / timeline / 看板链接 / 情报缺口 / 项目编号 / 删除清单 / agent 路由 / 门户项目）"
  into services/gateway node --test \
      src/__tests__/auth.test.ts \
      src/__tests__/match.test.ts \
      src/__tests__/company-fields.test.ts \
      src/__tests__/window.test.ts \
      src/__tests__/timeline.test.ts \
      src/__tests__/env.test.ts \
      src/__tests__/startup.test.ts \
      src/__tests__/gaps.test.ts \
      src/__tests__/projectCode.test.ts \
      src/__tests__/deletion.test.ts \
      src/__tests__/channels.test.ts \
      src/__tests__/lab.test.ts \
      src/__tests__/router.test.ts \
      src/__tests__/chat.test.ts \
      src/__tests__/survey.test.ts \
      src/__tests__/commitGate.test.ts \
      src/__tests__/followup.test.ts \
      src/__tests__/report.test.ts \
      src/__tests__/portalModel.test.ts
  into services/gateway node --test \
      src/__tests__/item-operations.test.ts \
      src/__tests__/proposal-model.test.ts \
      src/__tests__/proposal-item-ownership.test.ts \
      src/__tests__/questions.test.ts

  # agent 从 2026-08-05 起是独立目录（issue #17）—— 它的测试跟着它走。
  # ⚠️ cwd 仍然是 services/gateway：node_modules 在那儿，agent 靠祖先目录找到它。
  head "单元 · agent（工具边界 / 枚举对账 / 附件解析 / 重试预算 / 标题兜底 / 多模态直通 / 转写编码）"
  into services/gateway node --test \
      agent/src/__tests__/abort.test.ts \
      agent/src/__tests__/agent.test.ts \
      agent/src/__tests__/attachments.test.ts \
      agent/src/__tests__/multimodal.test.ts \
      agent/src/__tests__/playbooks.test.ts \
      agent/src/__tests__/retry.test.ts \
      agent/src/__tests__/session.test.ts \
      agent/src/__tests__/target-question.test.ts \
      agent/src/__tests__/records.test.ts \
      agent/src/__tests__/title.test.ts \
      agent/src/__tests__/transcribe.test.ts
}

# ── 集成 ──────────────────────────────────────────────────────────
# 🔴 **默认在一次性环境里跑 —— 你自己那套（boothnote 库 / Twenty / 4000 端口）一个字节都不碰。**
#
# 起因（维护者 2026-08-10）：「无论我是在生产服务器，还是本地开发环境中跑测试代码，
# 都不会在我的数据库里面写一堆 crap」。
#
# 判据：**不产生垃圾，比产生之后再打扫可靠。**
# 事后打扫（`purge-test-records.mjs`）有三个洞：跑到一半中断就留下一半、
# `inbox` 有触发器只能靠临时关触发器那一招、以及**它得有人记得跑**。
#
# 想对着自己那套环境跑（比如要连真 Twenty 手工看效果），显式加 `--here`。
integration() {
  head "集成 · 网关 API（一次性环境，跑完什么都不留）"
  run ./scripts/integration-stack.sh "$@"
}

# ── 老路子：对着**你现在开着的**那套环境跑 ───────────────────────────
#
# ⚠️ 这会在你的 `boothnote` 库和 Twenty 里留下测试数据，末尾靠 purge 打扫。
#    需要它的场景只有一个：想跑完之后**自己进 CRM 看一眼**效果。
integration_here() {
  head "集成 · 网关 API（--here：对着你现在这套环境跑）"

  cat <<'EOS'
  ⚠️  这一档会往**你自己的** boothnote 库和 Twenty 里写测试数据。
      末尾会自动 purge，但中途失败就会留下一半。
      不想留任何东西：去掉 --here（默认就是一次性环境）。

EOS

  # 🔴 集成测试会往 /inbox 发几十条速记，**每一条都会触发一次真实的 OpenAI 调用**。
  # 它们是测试数据，抽出来的东西没人看，但账单是真的。跑之前提醒一句。
  if curl -fsS --max-time 3 http://localhost:4000/agent/health 2>/dev/null | grep -q '"enabled":true'; then
    cat <<'EOS'
  ⚠️  agent 是开着的 —— 这一轮集成测试发出去的每条速记都会真的调一次模型。
      只想验接口的话，用 AGENT_ENABLED=0 起网关再跑：

        AGENT_ENABLED=0 npm run dev        # services/gateway

EOS
  fi

  if ! curl -fsS --max-time 3 http://localhost:4000/health >/dev/null 2>&1; then
    cat <<'EOS'
  ⏭  跳过 —— 本地网关没跑。先起这两样：

      docker compose up -d db redis server worker     # 数据层
      cd services/gateway && npm run dev              # 网关（另开一个终端）

EOS
    return 0
  fi
  into services/gateway node --test src/__tests__/api.test.ts

  # ── 跑完自己收拾 ─────────────────────────────────────────────────
  #
  # 🔴 起因（维护者 2026-08-03）：「你每次测试的时候，都会在 crm 里面产生一堆屎山，
  #    你能不能相应的都删除一下，要不然我数据库里面全是你测试的屎。」
  #
  # 实测积到 62 条拜访 / 32 条售后 / 24 家假客户 —— 而这些在 CRM 里
  # 和真实记录长得一模一样，人得一条条看名字才分得出来。
  #
  # 放在这里而不是各个用例的 after()：用例中途失败时 after() 不一定跑得完。
  # 清理失败不算测试失败，但会大声说出来。
  head "清掉这一轮的测试数据"
  if ! node scripts/purge-test-records.mjs --yes --db; then
    echo "  ⚠️ 自动清理没跑成功 —— 手动跑一次：node scripts/purge-test-records.mjs --yes --db"
  fi
}

# ── 业务场景验收（docs/test_example 的 T01–T05）──────────────────
#
# 🔴 **不进 `all` 的默认档，是刻意的。**
# 五条用例十几次真实模型调用，一轮几分钟、要花钱。
# 它是**验收**用的不是回归用的 —— 改数据模型 / 改 prompt / 改 confirm 之后跑一次。
scenarios() {
  head "业务场景验收 · docs/test_example"
  if ! curl -fsS --max-time 3 http://localhost:4000/health >/dev/null 2>&1; then
    echo "  ⏭  跳过 —— 本地网关没跑。"
    return 0
  fi
  cat <<'EOS'
  ⚠️  这一档会**真的调模型**（十几次）并**真的写 Twenty**。一轮 3–6 分钟。
      跑完记得 node scripts/purge-test-records.mjs --yes --db

EOS
  into services/gateway node --test --test-timeout=900000 src/__tests__/scenarios.test.ts
}

shift 2>/dev/null || true   # 把 MODE 之后的参数原样留给各档
case "$MODE" in
  unit)        checks; units ;;
  checks)      checks ;;
  integration)
    case " $* " in
      *" --here "*) integration_here ;;
      *)            integration "$@" ;;
    esac ;;
  all)         checks; units; integration; run python3 scripts/test-isolated-agent.py ;;
  agent-flows) run python3 scripts/test-isolated-agent.py ;;
  scenarios)   scenarios ;;
  smoke)       run ./scripts/smoke.sh "$@" ;;
  *)
    cat <<'EOS'
用法：./scripts/test.sh [档] [参数…]

  unit          类型 + 单元 + 构建（零依赖，随时能跑）      ← 默认
  checks        只跑静态检查（tsc / i18n 守卫 / schema 漂移）
  integration   集成 —— **一次性环境**，跑完什么都不留（要 docker）
                  --here          改成对着你现在开着的那套环境跑（会留数据）
                  --with-twenty   一次性环境 + 连本地 Twenty（会写 CRM，末尾自动清）
  all           unit + integration + agent-flows
  agent-flows   真网关 + 一次性数据库 + 假 CRM，验证目标绑定与多事项执行
  scenarios     业务场景验收（真调模型、真写 Twenty，几分钟）
  smoke <url>   只读冒烟，对生产也安全
EOS
    exit 1 ;;
esac

printf '\n%s\n' "$(printf '─%.0s' {1..50})"
[ "$FAILED" -eq 0 ] && echo "✅ 全部通过" || { echo "❌ 有失败"; exit 1; }
