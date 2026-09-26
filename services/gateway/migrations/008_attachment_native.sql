-- D71：附件原生多模态直通。
--
-- 原生喂给模型的附件不再本地解析，attachment_text 里记一行 status='native'：
--   ① 界面「parsed」那一格有东西显示；
--   ② read_attachment 能答出「这份已经原样喂给你了」；
--   ③ 幂等重跑时能区分「抽过文本」和「原生直通过」——
--      探测失败降级重跑时，native 行不当缓存用，会被真实抽取覆盖。
--
-- ⚠️ 判据（§2.26）：这次迁移加的东西**不是**「新代码启动时就要用的」——
--    新代码写 'native' 之前一定先跑过这条迁移（部署顺序：迁移 → 起网关），
--    而旧代码见到 'native' 行也只会当成「已解析」跳过，不炸。

alter table attachment_text drop constraint if exists attachment_text_status_check;
alter table attachment_text add constraint attachment_text_status_check
  check (status in ('pending', 'ready', 'failed', 'skipped', 'native'));
