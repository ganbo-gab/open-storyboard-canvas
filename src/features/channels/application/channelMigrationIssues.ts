import type { ChannelRecord } from '../store/channelStore';
import type { ChannelMigrationIssueKind } from '../migrate/legacyConfig';

export interface ChannelMigrationIssueDescription {
  path: string;
  kind: ChannelMigrationIssueKind;
  detail: string;
}

/** Renderable migration evidence without legacy values, which may contain credential references.
 * Older records without a classification remain conservatively unsupported until reviewed.
 */
export function describeChannelMigrationIssues(
  record: Pick<ChannelRecord, 'migrationIssues'>,
): ChannelMigrationIssueDescription[] {
  return record.migrationIssues.map((issue) => ({
    path: issue.key,
    kind: issue.kind ?? 'unsupported',
    detail: issue.reason,
  }));
}
