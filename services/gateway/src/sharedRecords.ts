import { sql } from './db.ts';

/** A historical contribution remains shared even when its current draft is withdrawn. */
export const sharedRecordReferences = async (
  records: Array<{ object: string; id: string }>, excludingStagingId: string,
): Promise<Array<{ object: string; id: string }>> => {
  const shared: Array<{ object: string; id: string }> = [];
  const refKeys: Record<string, string> = {
    supportCase: 'supportCaseId', project: 'projectId', opportunity: 'opportunityId',
    visit: 'visitId', productFitment: 'productFitmentId', projectDoc: 'projectDocId', workItem: 'workItemId',
  };
  for (const record of records) {
    const key = refKeys[record.object];
    const [row] = await sql<Array<{ shared: boolean }>>`
      select (
        exists(select 1 from item_record_link l where l.object_type = ${record.object} and l.record_id = ${record.id})
        or exists(select 1 from proposal_revision r join proposal_item i on i.id = r.item_id
          where i.current_revision = r.revision and r.target->>'type' = ${record.object}
            and r.target->>'id' = ${record.id} and r.status not in ('withdrawn','superseded'))
        or exists(select 1 from staging s where s.id <> ${excludingStagingId}
          and ${key ?? ''} <> '' and s.twenty_refs->>${key ?? ''} = ${record.id})
      ) as shared`;
    if (row?.shared) shared.push(record);
  }
  return shared;
};
