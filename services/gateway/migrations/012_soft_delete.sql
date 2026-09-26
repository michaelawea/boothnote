-- ════════════════════════════════════════════════════════════════════
--  手动删除：速记与入库记录（issue #25 · D93）
--
--  维护者 2026-08-07：「现在的『看版』页面中，没办法删除记录，并同步删除
--  进入 crm 的数据……相应的，『速记』页面中，速记也可以被手动删除，
--  如果速记内容已经入库，其涉及到的入库内容却不会被删除。」
--  同日追加两条裁定：**不开跨人的口子**、**用软删除不用硬删除**。
--
--  ── 为什么是加列，而不是 delete from ──────────────────────────────
--
--  🔴 `inbox` **只增不改**（§4.2 第 2 条，migration 001 的 `inbox_no_update`
--     触发器挡着 UPDATE/DELETE）。展会 10 天说过的话是全项目唯一不可再生的
--     资产 —— 一条速记被删，删掉的必须只是「它出现在我的列表里」这件事，
--     不是那句话本身。
--
--  ⚠️ `scripts/purge-test-records.mjs` 里有一招 `alter table … disable trigger
--     user`（在一个事务里关掉守卫、删、再装回去，末尾还自检装回去了没有）。
--     **那一招绝不能搬进网关。** 它是运维脚本：一次性、人在场、跑完有人看输出。
--     放进一个「用户点按钮就会触发」的 HTTP 端点，等于这条规则在生产上每天
--     被打开一次 —— 而它挡的正是这个系统里最不可再生的东西。
--
--  音频同理不动。判据是 issue #21 立的那条：**音频本身才是资产，
--  转写只是它的一个视图。** 删速记不删音频。
--
--  ── 为什么是两列而不是一列 + scope 枚举 ──────────────────────────
--
--  「从速记页删掉」和「把入库记录删掉」是**两个独立的动作，作用在两个面上**：
--
--    · 速记页删除 → 这条速记不再出现在速记列表里。
--      **CRM 一个字不动**（维护者 明确要的）。已入库的话，看板上那一行
--      **照常显示** —— 因为 Twenty 里那条记录确实还在，看板是它的视图。
--    · 看板删除   → 按 `twenty_refs` 把 CRM 里那几条软删掉，看板不再显示。
--      速记那条原话**照常留在速记页**（除非也被单独删了）。
--
--  两者可以任意组合，所以是两个独立的可空时间戳，不是一个字段配一个枚举。
--  枚举那种写法会逼出「note 还是 record？」这种在真实操作里根本不存在的
--  互斥关系，然后在某个组合上答错。
--
--  ── 恢复靠什么 ──────────────────────────────────────────────────
--
--  🔴 **实测（2026-08-07，本地 Twenty v2.25.1）**：
--     · REST `DELETE /rest/{对象}/{id}` 打的是 GraphQL 的 `deleteProject`，
--       **是软删** —— 回包里 `deletedAt` 被置上了时间戳，记录还在。
--     · `restoreProject(id:)` 能把它原样恢复（`deletedAt` 回到 null，
--       之后 REST GET 又是 200）。`destroyProject` 才是永久删除，
--       **我们一处都不调**。
--     · ⚠️ 软删之后那条记录**用任何过滤器都查不回来**：
--       `deletedAt: { is: NOT_NULL }`（枚举写法，语法正确）返回空，
--       查询层有个抹不掉的 `deletedAt IS NULL` 作用域。
--
--  最后那条决定了这里的设计：**能恢复的前提是我们自己存住了那串 id。**
--  `staging.twenty_refs` 正好就是那份 id 清单（D48 起就一直在写），
--  所以删除时**绝不清空 `twenty_refs`** —— 清了就再也找不回那几条记录了。

alter table staging add column if not exists note_deleted_at     timestamptz;
alter table staging add column if not exists note_deleted_by     text;
alter table staging add column if not exists record_deleted_at   timestamptz;
alter table staging add column if not exists record_deleted_by   text;

-- ── 删什么：这一列存「这次入库**真正新建**了哪几条」──────────────────
--
--  🔴 **`twenty_refs` 不能直接拿来删。** 它里面混着三种东西：
--
--    ① 这条速记自己建的记录 id      —— 该删
--       visitId · supportCaseId · productFitmentId · projectDocId
--    ② **复用**已有记录的 id        —— 绝不能删，那是别人的
--       `opportunityId` 可能是 `existing.id`（confirm.ts:566，同时会写
--       `opportunityWas`）；`projectId` 可能是已存在的项目（:712，同时会写
--       `projectUpdated`）；`supportCaseId` 可能是追加到已有售后
--       （:435，同时会写 `supportCaseAppended`）。
--       **删掉一个共享项目，等于因为删一条拜访记录而炸掉整条项目线。**
--    ③ 根本不是 id 的东西            —— 拿去删会 404 或更糟
--       `workItems: "4"` 是**计数**（CLAUDE.md 里点过名的那个）、
--       `recommitted` 是时间戳、`projectSkipped` 是一句话、
--       `annualProduction` 是一段正文、`intelCompleteness` 是数字。
--
--  `confirm.ts` 里本来就有一个变量精确地回答了「这次建了什么」——
--  `made`（:367，`made.push({object, id, name})`），
--  但它**只喂给 timeline 就被扔掉了**（:856），从没落过库。这里把它存下来。
--
--  ⚠️ **这一列上线之前入库的记录没有这份清单**（生产上已有的那些）。
--     那些只能退回一个保守白名单：只删确定是自己建的那四类，
--     且 `opportunityWas` / `projectUpdated` / `supportCaseAppended`
--     一旦在场就跳过对应的那条。**删不掉的必须当场说出来**，
--     不能静默留下孤儿 —— 「看不见」和「不存在」要分得开。
--
--  ⚠️ **工作项（workItem）两条路都删不掉**：它们的 id 从来没进过 refs
--     （只有一个计数）。这一列上线后新建的会带上，历史的删不了，界面照实说。
alter table staging add column if not exists created_records jsonb;

-- ── 删了什么：删除**当时真正软删掉的那几条**，原样记下来 ────────────────
--
--  和上面那列的区别很实在：`created_records` 是「入库时建了什么」（意图），
--  这一列是「删除时**实际**删掉了什么」（结果）。两者会不一样 ——
--  部分失败、历史数据走保守白名单、工作项删不掉，都会让结果小于意图。
--
--  两个下游都只认这一列：
--    · **撤销删除**：按它逐条 `restore{Object}`。
--      🔴 软删之后记录在 Twenty 里**查不回来**（见文件头第 ③ 条），
--         这串 id 是唯一的线索 —— 丢了就再也找不回那几条记录。
--    · **`scripts/data-guard.mjs`**：部署前要回答「记录数少了是人删的，
--      还是又出了一次 §2.28」。没有这一列，两者在计数上长得一模一样。
--
--  🔴 **不做这一条，#25 上线当天就把部署链路堵死**：`data-guard.mjs`
--     的判据是「记录数下降就 exit 1 中止部署」（D82），而人为删除
--     恰好就是记录数下降。守卫会拦住每一次正常部署，
--     而它拦得完全「正确」—— 这种告警最贵，因为人会开始习惯性忽略它。
alter table staging add column if not exists record_deleted_refs jsonb;

-- data-guard 每次部署都要问一次「基线之后有没有人为删除」（D94）。
-- 部分索引：绝大多数行这两列都是 null，全量索引是白付的写入代价。
create index if not exists staging_record_deleted_idx
  on staging (record_deleted_at) where record_deleted_at is not null;

-- ⚠️ 这几列**不是**「新代码启动时就要用的」（§2.26 的死锁判据）：
--    旧代码不读它们，新代码读到 null 就是「没删过」，先起后迁不会死锁。
--    但部署顺序仍按惯例：迁移 → 起网关。
