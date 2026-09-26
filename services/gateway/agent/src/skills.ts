import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatPlaybook, formatPlaybookIndex, loadPlaybookFiles, type Playbook } from './runtime.ts';

/**
 * 标准 SKILL.md 技能库（D72）。
 *
 * ⚠️ 正名：这个文件管的是 **playbook**（`agent/skills/` 下的 SKILL.md 指令册），
 * 不是工具 —— 工具定义在 `tools/`（2026-08-05 从 `skills/` 改名，就是为了消除这次撞车）。
 *
 * 两个性质：
 *   1. **渐进披露**：系统提示词里只出现每本的 name + description（一行），
 *      模型判断相关才用 `read_skill` 拉全文 —— 200 行独白互抢压强的结构性解法
 *      （issue #17 根因 B 的病根，不只是那一个实例）。
 *   2. **数据文件，改了不用发版**：现场发现「某类记录总是记不对」时，
 *      能改的人只需要改 markdown 重启网关 —— 和 `data/intel-items.json` 同一个哲学。
 *
 * 加载失败**必须吵**（`7e9e5df` 的教训：`data/` 不在镜像里，静默降级空跑了一天）——
 * 但不阻断：没有手册 agent 也能跑，只是回到「全靠核心 prompt」的老水平。
 *
 * ── 2026-08-17：抽成「按目录建一个库」的工厂（T94）─────────────────
 * 起因是实验室 agent 要一份**自己的** playbook 目录（`agent/skills-lab/`）。
 * 加载逻辑只能有一份，所以把原来写死目录的那部分变成参数，
 * 下面六个模块级导出原样保留（指向录入 agent 那份），**所有调用点一行不用改**。
 */

export type PlaybookLibrary = {
  load: () => Promise<Map<string, Playbook>>;
  get: (name: string) => Playbook | undefined;
  names: () => string[];
  index: () => string;
  block: (name: string) => string;
  reset: () => void;
};

/**
 * @param dir 这个库从哪个目录加载 SKILL.md
 * @param opts.label 日志里管它叫什么
 * @param opts.warnWhenEmpty 一本都没有时要不要报警。
 *   录入 agent 是 `true`（空 = 出事了，多半是镜像没带上 skills/）；
 *   实验室 agent 是 `false` —— **它一开始本来就是空的**，那是设计，不是故障。
 *   🔴 让「预期内的空」也报警，等于训练人无视警告（这个仓库在冒烟那一项上吃过亏）。
 */
export const makePlaybookLibrary = (
  dir: string,
  opts: { label: string; warnWhenEmpty: boolean },
): PlaybookLibrary => {
  let cache: Map<string, Playbook> | null = null;

  const load = async (): Promise<Map<string, Playbook>> => {
    if (cache) return cache;
    try {
      const { skills, diagnostics } = await loadPlaybookFiles(dir);
      for (const d of diagnostics) {
        console.warn(`  🟠 SKILL.md 有问题（${d.path}）：${d.message}`);
      }
      cache = new Map(skills.map((s) => [s.name, s]));
    } catch (e) {
      console.warn(`  🟠 加载 ${opts.label} playbook 失败（${dir}）：${(e as Error).message.slice(0, 200)}`);
      cache = new Map();
    }
    if (!cache.size) {
      if (opts.warnWhenEmpty) {
        console.warn(
          `  🟠 一本 playbook 都没加载到（${dir}）—— agent 退回「只有核心 prompt」的水平。\n` +
            '     容器里跑的话：Dockerfile 的 COPY services/gateway/agent 应该已经带上 skills/，查一下镜像。',
        );
      } else {
        console.log(`  📖 ${opts.label} playbook ×0（还没放 SKILL.md —— 放进 ${dir} 重启即生效）`);
      }
    } else {
      console.log(`  📖 ${opts.label} playbook ×${cache.size}：${[...cache.keys()].join(' / ')}`);
    }
    return cache;
  };

  return {
    load,
    get: (name) => cache?.get(name),
    names: () => [...(cache?.keys() ?? [])],
    index: () => (cache?.size ? formatPlaybookIndex([...cache.values()]) : ''),
    block: (name) => {
      const p = cache?.get(name);
      return p ? formatPlaybook(p) : '';
    },
    reset: () => {
      cache = null;
    },
  };
};

const HERE = dirname(fileURLToPath(import.meta.url));

/** 录入 agent 的那份（`agent/skills/`）。下面六个导出是它的门面，调用点原样不动。 */
export const mainPlaybooks = makePlaybookLibrary(join(HERE, '..', 'skills'), {
  label: '录入',
  warnWhenEmpty: true,
});

/** 实验室 agent 的那份（`agent/skills-lab/`）。**一开始是空的，那是设计**（T94）。 */
export const labPlaybooks = makePlaybookLibrary(join(HERE, '..', 'skills-lab'), {
  label: '实验室',
  warnWhenEmpty: false,
});

/** 启动时（或第一条速记前）加载一次。幂等，失败不抛。 */
export const loadPlaybooks = (): Promise<Map<string, Playbook>> => mainPlaybooks.load();

/** 测试注入用。 */
export const __resetPlaybooks = (): void => mainPlaybooks.reset();

/** 同步取一本（`loadPlaybooks` 之后才有东西）。 */
export const playbook = (name: string): Playbook | undefined => mainPlaybooks.get(name);

export const playbookNames = (): string[] => mainPlaybooks.names();

/** 系统提示词里的技能索引块。没加载到就是空串 —— prompt 不留一个空标题。 */
export const playbookIndex = (): string => mainPlaybooks.index();

/** 一本手册的全文块（read_skill 的返回值 / 推送注入用）。 */
export const playbookBlock = (name: string): string => mainPlaybooks.block(name);
