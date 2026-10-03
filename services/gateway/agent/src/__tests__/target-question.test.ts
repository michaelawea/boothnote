import { after, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { runAgent, type ModelBinding, type Skill } from '../runtime.ts';
import { newContext } from '../tools/context.ts';
import { writeSkills } from '../tools/write.ts';
import { candidateText, registerCandidates, toTargetCandidate } from '../../../src/targetCandidates.ts';
import { sql } from '../../../src/db.ts';

after(() => sql.end());

it('fauxProvider回路：候选handle确实在模型消息内，真实ask_user生成绑定UUID问题后收工', async () => {
  const companyId = randomUUID();
  const caseId = randomUUID();
  const ctx = newContext({ inboxId: randomUUID(), stagingId: randomUUID(), threadId: randomUUID(), userId: randomUUID(),
    userCode: 'test', displayName: 'Test', companies: [{ id: companyId, code: 'EXAMPLE', name: 'Example', type: 'OEM', group: '' }],
    suppliers: [], attachments: [], maxSteps: 6, pushPlaybooks: [], resumed: false, source: 'pwa' });
  ctx.proposed = true;
  const candidate = toTargetCandidate('supportCase', { id: caseId, companyId, name: '车辆充电不足', caseStatus: 'NEW', issueDescription: { markdown: 'IGN待排查' } }, companyId)!;
  const reader: Skill = { name: 'read_candidates', label: '查已有售后', description: '读取真实目标候选', parameters: { type: 'object', properties: {} },
    execute: async () => { const search = { status: 'ok' as const, candidates: [candidate] }; registerCandidates(ctx, [search]); return { text: candidateText('已有工单', search), details: { deliberatelyHidden: 'must-not-be-used-as-handle' } }; } };
  const ask = writeSkills(ctx).find((skill) => skill.name === 'ask_user')!;
  const faux = fauxProvider();
  const models = createModels(); models.setProvider(faux.provider);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('read_candidates', {}, { id: 'read' })]),
    fauxAssistantMessage([fauxToolCall('ask_user', { question: '把IGN排查回复追加到原工单吗？', targetOptions: [
      { label: '追加到车辆充电不足', candidateHandle: candidate.handle }, { label: '新问题', action: 'create' },
    ], recommendedIndex: 0 }, { id: 'ask' })]),
  ]);
  const result = await runAgent({ systemPrompt: 't', prompt: 'Example原故障已有新进展', skills: [reader, ask],
    binding: { model: faux.getModel(), streamFn: models.streamSimple.bind(models) } as ModelBinding, maxSteps: 6 });
  assert.notEqual(result.stopReason, 'error', result.error);
  assert.deepEqual(result.trace.map((entry) => entry.tool), ['read_candidates', 'ask_user']);
  const messages = JSON.stringify(result.messages);
  assert.ok(messages.includes(candidate.handle), '只放details时，模型消息里拿不到可调用句柄');
  assert.equal(ctx.questions.length, 1);
  assert.equal(ctx.questions[0]!.choices![0]!.target!.id, caseId);
  assert.equal(ctx.questions[0]!.choices![0]!.target!.companyId, companyId);
  assert.equal(ctx.questions[0]!.choices![0]!.action, 'append');
});
