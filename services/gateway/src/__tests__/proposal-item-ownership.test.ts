import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { validateOwnedItemTarget } from '../proposal-items.ts';
import { ProposalItemError, type ItemTarget } from '../proposal-model.ts';

const target = (type: ItemTarget['type'], id: string): ItemTarget => ({ type, id, companyId: 'company-a', action: 'append' });
const rejected = (run: () => void) => assert.throws(run, (error: unknown) =>
  error instanceof ProposalItemError && error.status === 409 && error.code === 'item_target_change_requires_new_item');

describe('stable business item CRM ownership', () => {
  it('refuses to redirect a committed case to another case in the same company', () => {
    rejected(() => validateOwnedItemTarget({ supportCaseId: 'case-original' }, target('supportCase', 'case-other')));
  });

  it('keeps the primary case authoritative even when a failed attempt left another historical link', () => {
    rejected(() => validateOwnedItemTarget({ supportCaseId: 'case-original' }, target('supportCase', 'case-other'),
      [{ object: 'supportCase', id: 'case-other' }]));
    assert.doesNotThrow(() => validateOwnedItemTarget({ supportCaseId: 'case-original' }, target('supportCase', 'case-original')));
  });

  it('refuses to redirect a committed project while permitting an explicit update of the original project', () => {
    rejected(() => validateOwnedItemTarget({ projectId: 'project-original' }, target('project', 'project-other')));
    assert.doesNotThrow(() => validateOwnedItemTarget({ projectId: 'project-original' }, target('project', 'project-original')));
  });

  it('uses a primary work item ID when available', () => {
    rejected(() => validateOwnedItemTarget({ workItemId: 'work-original' }, target('workItem', 'work-other')));
    assert.doesNotThrow(() => validateOwnedItemTarget({ workItemId: 'work-original' }, target('workItem', 'work-original')));
  });

  it('recognizes multiple real work item links without interpreting the workItems count as an ID', () => {
    const links = [{ object: 'workItem', id: 'work-a' }, { object: 'workItem', id: 'work-b' }];
    const refs = { projectId: 'project-original', workItems: '2' };
    assert.doesNotThrow(() => validateOwnedItemTarget(refs, target('workItem', 'work-a'), links));
    assert.doesNotThrow(() => validateOwnedItemTarget(refs, target('workItem', 'work-b'), links));
    rejected(() => validateOwnedItemTarget(refs, target('workItem', 'work-foreign'), links));
    rejected(() => validateOwnedItemTarget(refs, target('workItem', '2'), links));
  });

  it('keeps recorded ownership links protective before the final item receipt has been persisted', () => {
    const links = [{ object: 'project', id: 'project-created' }];
    rejected(() => validateOwnedItemTarget({}, target('project', 'project-other'), links));
    assert.doesNotThrow(() => validateOwnedItemTarget({}, target('project', 'project-created'), links));
  });

  it('does not let another object’s identifier masquerade as an owned work item', () => {
    rejected(() => validateOwnedItemTarget({}, target('workItem', 'project-original'), [
      { object: 'project', id: 'project-original' }, { object: 'workItem', id: 'work-original' },
    ]));
  });

  it('permits a first target choice and default same-identity revisions that do not rebind a target', () => {
    assert.doesNotThrow(() => validateOwnedItemTarget({}, target('supportCase', 'case-selected')));
    assert.doesNotThrow(() => validateOwnedItemTarget({ supportCaseId: 'case-original' }, null));
    assert.doesNotThrow(() => validateOwnedItemTarget({ projectId: 'project-original' }, undefined));
  });
});
