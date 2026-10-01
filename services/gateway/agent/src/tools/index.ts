import type { Skill } from '../runtime.ts';
import type { SkillContext } from './context.ts';
import { intelFieldSkill } from './intel-field.ts';
import { projectSkills } from './project.ts';
import { readSkills } from './read.ts';
import { writeSkills } from './write.ts';

export { newContext, type SkillContext } from './context.ts';
export { warnIfColumnSwitchOn } from './intel-field.ts';

/**
 * 工具清单 —— **能力边界的唯一执行机制**。
 *
 * 整套设计只有一条核心原则：
 *   能力边界靠「工具清单里有没有」实现，**不靠 prompt 里写「请不要」**。
 *   prompt 会被绕过、会被长文本冲掉、会被模型换代改变行为；而没有的函数，它调不出来。
 *
 * Ring 3 —— 下面这些不是「禁止调用」，是压根没注册：
 *   create_company · write_twenty · confirm_to_crm · update_inbox · delete_anything
 *
 * 写 Twenty 只发生在网关，而且只在人点了「确认入库」之后。
 * 模型从头到尾没有能力把任何东西写进 CRM。这一条让「模型出错」的最坏后果，
 * 从「脏数据进了 CRM」降到「一条提案被人否掉」。
 */
export const buildSkills = (ctx: SkillContext): Skill[] => [
  ...readSkills(ctx),
  ...writeSkills(ctx),
  // D147：钉钉来源不注册 —— 它在跑的过程中就写 Twenty，60 秒撤回取消不掉它。
  // 能力边界靠「清单里有没有」，不靠 prompt 写「请不要」（文件头那条）。
  ...(ctx.source === 'dingtalk' ? [] : [intelFieldSkill(ctx)]),
  // D59：定点之后那条链（项目 / 任务线程 / 文档）。
  // 仍然全在 Ring 1+2 —— 加了三个对象不等于放松边界，Ring 3 一条没变。
  ...projectSkills(ctx),
];

/**
 * 快照。`__tests__/skills.test.ts` 断言注册的工具名集合**恰好**等于这一串。
 *
 * 将来谁手滑加了个 `create_company`，那个测试立刻红 —— 这是 Ring 3 唯一的
 * 执行机制，不是文档里的一句话。改这个常量本身也会让测试红，所以它改不动，
 * 除非改的人是有意的。
 */
export const TOOL_NAMES = [
  // Ring 1 · 只读
  'read_skill',
  'search_companies',
  'get_thread',
  'get_company_gaps',
  'get_company_records',
  'get_projects',
  'read_attachment',
  'list_enums',
  // Ring 2 · 写提案 / 造字段
  'propose_fields',
  'ask_user',
  'flag_new_company',
  'propose_intel_field',
  // D59
  'propose_project',
  'propose_work_items',
  'propose_document',
] as const;

/** Ring 3：**必须不存在**的工具名。测试反向断言一个都没注册。 */
export const FORBIDDEN_TOOL_NAMES = [
  'create_company',
  'write_twenty',
  'confirm_to_crm',
  'update_inbox',
  'delete_anything',
] as const;
