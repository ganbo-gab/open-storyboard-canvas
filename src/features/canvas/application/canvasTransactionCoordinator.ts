import type {
  CanvasCommand,
  CanvasCommandError,
  CanvasCommandImpact,
  CanvasCommandOrigin,
  CanvasCommandOutput,
  CanvasGraphSnapshot,
  CanvasResourceReferences,
  CanvasTransaction,
  CanvasTransactionPreview,
  CanvasTransactionResult,
} from '../domain/canvasCommands';
import type { CanvasEdge, CanvasNode } from '../domain/canvasNodes';

export interface CanvasGraphDraft {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  selectedNodeId: string | null;
}

export interface CanvasPreparedGraphCommand {
  ok: true;
  draft: CanvasGraphDraft;
  impact: CanvasCommandImpact;
  output: CanvasCommandOutput;
  changed: boolean;
}

export interface CanvasRejectedGraphCommand {
  ok: false;
  error: CanvasCommandError;
}

export type CanvasGraphCommandPreparation =
  | CanvasPreparedGraphCommand
  | CanvasRejectedGraphCommand;

export interface CanvasGraphCommandPreparer {
  prepareGraphCommand: (
    command: CanvasCommand,
    draft: CanvasGraphDraft,
    origin: CanvasCommandOrigin,
  ) => CanvasGraphCommandPreparation;
}

export interface CanvasCommandStorePort {
  getSnapshot: () => CanvasGraphSnapshot;
  commitGraphTransaction: (input: {
    expectedRevision: number;
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    selectedNodeId: string | null;
  }) => number | null;
  setSelection: (nodeIds: string[]) => void;
}

function mergeReferences(
  target: CanvasResourceReferences,
  source: CanvasResourceReferences,
): CanvasResourceReferences {
  const nodeIds = [
    ...(target.nodeIds ?? []),
    ...(target.nodeId ? [target.nodeId] : []),
    ...(source.nodeIds ?? []),
    ...(source.nodeId ? [source.nodeId] : []),
  ];
  const edgeIds = [
    ...(target.edgeIds ?? []),
    ...(target.edgeId ? [target.edgeId] : []),
    ...(source.edgeIds ?? []),
    ...(source.edgeId ? [source.edgeId] : []),
  ];
  const assetIds = [
    ...(target.assetIds ?? []),
    ...(target.assetId ? [target.assetId] : []),
    ...(source.assetIds ?? []),
    ...(source.assetId ? [source.assetId] : []),
  ];
  const jobIds = [
    ...(target.jobIds ?? []),
    ...(target.jobId ? [target.jobId] : []),
    ...(source.jobIds ?? []),
    ...(source.jobId ? [source.jobId] : []),
  ];

  return {
    nodeIds: Array.from(new Set(nodeIds)),
    edgeIds: Array.from(new Set(edgeIds)),
    assetIds: Array.from(new Set(assetIds)),
    jobIds: Array.from(new Set(jobIds)),
  };
}

interface PreparedTransaction {
  draft: CanvasGraphDraft;
  impacts: CanvasCommandImpact[];
  outputs: CanvasCommandOutput[];
  references: CanvasResourceReferences;
  errors: CanvasCommandError[];
  changed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function transactionIdOf(value: unknown): string {
  return isPlainRecord(value)
    && Object.prototype.hasOwnProperty.call(value, 'id')
    && typeof value.id === 'string'
    ? value.id
    : '';
}

function validateTransactionEnvelope(value: unknown): CanvasCommandError[] {
  if (!isPlainRecord(value)) {
    return [{ code: 'invalid_command', message: 'Transaction must be an object.' }];
  }
  const unknownField = Object.keys(value).find((key) => ![
    'id',
    'origin',
    'expectedRevision',
    'commands',
  ].includes(key));
  if (unknownField) {
    return [{ code: 'invalid_command', message: `Unknown transaction field: ${unknownField}.` }];
  }
  const missingField = ['id', 'origin', 'expectedRevision', 'commands'].find((key) => (
    !Object.prototype.hasOwnProperty.call(value, key)
  ));
  if (missingField) {
    return [{ code: 'invalid_command', message: `Missing transaction field: ${missingField}.` }];
  }
  if (typeof value.id !== 'string' || !value.id.trim()) {
    return [{ code: 'invalid_command', message: 'Transaction id is required.' }];
  }
  if (!['ui', 'agent', 'system'].includes(String(value.origin))) {
    return [{ code: 'invalid_command', message: 'Transaction origin must be ui, agent, or system.' }];
  }
  if (!Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0) {
    return [{ code: 'invalid_command', message: 'Transaction expectedRevision must be a non-negative safe integer.' }];
  }
  if (!Array.isArray(value.commands) || value.commands.length === 0) {
    return [{ code: 'invalid_command', message: 'A transaction must contain at least one command.' }];
  }
  if (value.commands.length > 100) {
    return [{ code: 'invalid_command', message: 'A transaction cannot contain more than 100 commands.' }];
  }
  return [];
}

export class CanvasTransactionCoordinator {
  constructor(
    private readonly preparer: CanvasGraphCommandPreparer,
    private readonly store: CanvasCommandStorePort,
  ) {}

  getRevision(): number {
    return this.store.getSnapshot().revision;
  }

  preview(transaction: CanvasTransaction): CanvasTransactionPreview {
    const snapshot = this.store.getSnapshot();
    const envelopeErrors = validateTransactionEnvelope(transaction);
    if (envelopeErrors.length > 0) {
      return {
        transactionId: transactionIdOf(transaction),
        baseRevision: snapshot.revision,
        valid: false,
        impacts: [],
        references: {},
        errors: envelopeErrors,
      };
    }
    const prepared = this.prepare(transaction, snapshot);
    return {
      transactionId: transaction.id,
      baseRevision: snapshot.revision,
      valid: prepared.errors.length === 0,
      impacts: prepared.impacts,
      references: prepared.references,
      errors: prepared.errors,
    };
  }

  execute(transaction: CanvasTransaction): CanvasTransactionResult {
    const snapshot = this.store.getSnapshot();
    const envelopeErrors = validateTransactionEnvelope(transaction);
    if (envelopeErrors.length > 0) {
      return {
        ok: false,
        transactionId: transactionIdOf(transaction),
        revisionBefore: snapshot.revision,
        revisionAfter: snapshot.revision,
        error: envelopeErrors[0],
      };
    }
    if (transaction.expectedRevision !== snapshot.revision) {
      return {
        ok: false,
        transactionId: transaction.id,
        revisionBefore: snapshot.revision,
        revisionAfter: snapshot.revision,
        error: {
          code: 'revision_conflict',
          message: `Canvas revision changed from ${transaction.expectedRevision} to ${snapshot.revision}.`,
          details: {
            expectedRevision: transaction.expectedRevision,
            actualRevision: snapshot.revision,
          },
        },
        retryPreview: this.preview({ ...transaction, expectedRevision: snapshot.revision }),
      };
    }

    const prepared = this.prepare(transaction, snapshot);
    if (prepared.errors.length > 0) {
      return {
        ok: false,
        transactionId: transaction.id,
        revisionBefore: snapshot.revision,
        revisionAfter: snapshot.revision,
        error: prepared.errors[0],
      };
    }

    if (!prepared.changed) {
      return {
        ok: true,
        transactionId: transaction.id,
        revisionBefore: snapshot.revision,
        revisionAfter: snapshot.revision,
        impacts: prepared.impacts,
        outputs: prepared.outputs,
        references: prepared.references,
      };
    }

    const committedRevision = this.store.commitGraphTransaction({
      expectedRevision: snapshot.revision,
      nodes: prepared.draft.nodes,
      edges: prepared.draft.edges,
      selectedNodeId: prepared.draft.selectedNodeId,
    });
    if (committedRevision === null) {
      const currentRevision = this.store.getSnapshot().revision;
      return {
        ok: false,
        transactionId: transaction.id,
        revisionBefore: snapshot.revision,
        revisionAfter: currentRevision,
        error: {
          code: 'revision_conflict',
          message: `Canvas revision changed during transaction preparation to ${currentRevision}.`,
          details: {
            expectedRevision: snapshot.revision,
            actualRevision: currentRevision,
          },
        },
        retryPreview: this.preview({ ...transaction, expectedRevision: currentRevision }),
      };
    }

    return {
      ok: true,
      transactionId: transaction.id,
      revisionBefore: snapshot.revision,
      revisionAfter: committedRevision,
      impacts: prepared.impacts,
      outputs: prepared.outputs,
      references: prepared.references,
    };
  }

  private prepare(
    transaction: CanvasTransaction,
    snapshot: CanvasGraphSnapshot,
  ): PreparedTransaction {
    let draft: CanvasGraphDraft = {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      selectedNodeId: snapshot.selectedNodeId,
    };
    const impacts: CanvasCommandImpact[] = [];
    const outputs: CanvasCommandOutput[] = [];
    let references: CanvasResourceReferences = {};
    let changed = false;

    for (let index = 0; index < transaction.commands.length; index += 1) {
      const command = transaction.commands[index];
      const result = this.preparer.prepareGraphCommand(command, draft, transaction.origin);
      if (!result.ok) {
        const commandType = command && typeof command === 'object' && 'type' in command
          ? command.type
          : undefined;
        return {
          draft,
          impacts,
          outputs,
          references,
          changed,
          errors: [{
            ...result.error,
            commandIndex: index,
            ...(typeof commandType === 'string' ? { commandType } : {}),
          }],
        };
      }
      draft = result.draft;
      impacts.push(result.impact);
      outputs.push(result.output);
      references = mergeReferences(references, result.output.references);
      changed = result.changed || changed;
    }

    return { draft, impacts, outputs, references, errors: [], changed };
  }
}
