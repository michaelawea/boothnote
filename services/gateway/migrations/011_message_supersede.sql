-- ════════════════════════════════════════════════════════════════════
--  消息编辑与重发（issue #23 · D90）
--
--  维护者：「消息发出去之后仍然可以回去改，然后重新发指令。
--            停止（#22）之后也应该能改。」
--
--  在这之前，对话里发出去的话就是终态 —— `Chat.tsx` 里
--  `编辑` / `重发` / `长按` / `onContextMenu` 一个都搜不到。
--  唯一的补救是**再说一遍**，而 agent 会把它当成这条对话的下一轮（续写语义），
--  不是「刚才那句话我说错了」。两者的结果完全不同。
--
--  ── 为什么需要一张新表，而不是给 thread_message 加一列 ────────────
--
--  🔴 `thread_message` **只增不改**（§4.2 第 2 条，migration 002 里有
--     `thread_message_no_update` 触发器挡着 UPDATE/DELETE）。
--     所以「把老的那条标成 superseded」根本不能写成一句 UPDATE ——
--     数据库会直接拒绝，而且是在展会现场第一次有人改口的时候。
--
--  这跟 issue #14 那次是同一道题、同一个答案：
--     · 原文层（inbox / thread_message）—— 一个字都不动
--     · 派生层（staging.superseded_by / 这张表）—— 记「谁不再是活的那一条」
--  区别只在 staging 自己可以 UPDATE，而 thread_message 不行，
--  所以这一层只能落在旁边一张表上。
--
--  🔴 **取代 ≠ 删除。** 改口之前说过的那句话仍然完整地在 thread_message 里，
--     界面上也照样显示（淡一档 + 一句「已改」）。
--     **「看不见」和「不存在」必须分得开** —— 这个仓库最贵的 bug 全长那个样子。
--
--  ── 为什么后面那些消息也要标 ────────────────────────────────────
--
--  改一句话不只是改那一句：agent 基于那句话回的每一条、问的每一个问题，
--  都是在回答一个**已经被撤回的问题**。issue #23 里的说法是
--  「回退到这条消息之前的状态再跑」。所以取代的范围是
--  **被改的那条 + 它之后的全部**，`reason` 分开记，好让人看得出哪条是主动改的。
-- ════════════════════════════════════════════════════════════════════

create table if not exists message_supersede (
  -- 被取代的那条消息。一条只会被取代一次 —— 再改一次改的是新的那条。
  message_id    uuid        primary key references thread_message(id) on delete cascade,
  -- 取代它的那条（人改定后重发的那句话）。多条会指向同一条，所以不是唯一键。
  superseded_by uuid        not null references thread_message(id) on delete cascade,
  thread_id     uuid        not null references thread(id) on delete cascade,
  -- edited      = 人自己改了这句话重发
  -- resent      = 原话没动，只是让它重跑一轮
  -- stale_reply = 上面两种的连带：它是对被撤回那句话的回应
  reason        text        not null default 'edited'
                check (reason in ('edited','resent','stale_reply')),
  created_by    uuid        references app_user(id),
  created_at    timestamptz not null default now()
);

comment on table message_supersede is
  '对话里被改口取代的消息（issue #23）。thread_message 只增不改，所以取代关系只能记在旁边这张派生表上。原话一个字没动。';

-- GET /threads/:id 每次都要 left join 这张表（1.2 秒一次轮询），按对话取最省
create index if not exists message_supersede_thread_idx on message_supersede (thread_id);
-- 「这条新消息取代了哪几条」—— 界面上那句「前面还有 2 条已被这次修改取代」靠它
create index if not exists message_supersede_by_idx on message_supersede (superseded_by);
