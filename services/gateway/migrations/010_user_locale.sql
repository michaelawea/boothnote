-- D80：PWA 英文版 —— 语言跟账号走，不跟浏览器走。
--
-- 维护者 2026-08-07：「使用这个 crm 和 pwa 的，也有我们的外国同事」，
-- 语言「跟账号走」。
--
-- 🔴 **为什么是账号列而不是 localStorage**：和 D35④「凭据/角色的真相源是账号」
--    同一条判据 —— 换台设备、换个浏览器、清一次缓存，语言都该还在。
--    展会现场同事之间借手机用是常事，跟浏览器走会让人打开一个别人语言的界面。
--
-- ⚠️ 这一列**不是**「新代码启动时就要用的」（§2.26 的死锁判据）：
--    旧代码不读它，新代码读到默认 'zh' 也完全正常，先起后迁不会死锁。
--    但部署顺序仍按惯例：迁移 → 起网关。

alter table app_user add column if not exists locale text not null default 'zh';

-- 只认这两个。加语言时改这里 + `LOCALES`（gateway/src/i18n.ts）+ PWA 的字典。
-- 约束写在库里，是因为 locale 会被拼进 agent 的 prompt（「用什么语言写小结」）——
-- 一个没人认识的值传到那里，模型会自己发挥。
alter table app_user drop constraint if exists app_user_locale_check;
alter table app_user add constraint app_user_locale_check check (locale in ('zh', 'en'));
