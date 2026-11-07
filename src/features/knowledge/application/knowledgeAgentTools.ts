import { z } from 'zod';
import { assertNotePath } from '../domain/types';
import type { KnowledgeService } from './knowledgeService';
import type { KnowledgeModelPort } from '../domain/organize';

const pathSchema = z.string().min(1).max(1024).refine(path => { try { assertNotePath(path); return true; } catch { return false; } }, 'Expected a safe .md note path');
export const knowledgeSearchToolSchema = z.object({ text: z.string().max(2000).optional(), tag: z.string().max(100).optional(), title: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).optional() }).strict();
export const knowledgeReadToolSchema = z.object({ path: pathSchema, offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(4000).optional() }).strict();
export const knowledgeWriteToolSchema = z.object({ path: pathSchema, content: z.string().max(2_000_000), createOnly: z.boolean().optional() }).strict();
export const knowledgeOrganizeToolSchema = z.object({ kind: z.enum(['classify', 'tag', 'moc', 'summary']), paths: z.array(pathSchema).min(1).max(20) }).strict();
export interface KnowledgeAgentTool {
  name: 'kb_search' | 'kb_read' | 'kb_write' | 'kb_organize';
  description: string;
  schema: z.ZodType;
  jsonSchema: Record<string, unknown>;
  mutates: boolean;
  handler(input: unknown): Promise<unknown>;
}
/** Runtime registration must keep the write/organize tools behind the host's mutation approval. */
export function createKnowledgeAgentTools(service: KnowledgeService | (() => KnowledgeService | Promise<KnowledgeService>), model?: KnowledgeModelPort): KnowledgeAgentTool[] {
  const current = async (): Promise<KnowledgeService> => typeof service === 'function' ? service() : service;
  const define = <T extends z.ZodType>(name: KnowledgeAgentTool['name'], description: string, schema: T, mutates: boolean, handler: (input: z.output<T>) => Promise<unknown>): KnowledgeAgentTool => ({
    name, description, schema, mutates, jsonSchema: z.toJSONSchema(schema, { unrepresentable: 'any' }),
    handler: async input => handler(schema.parse(input)),
  });
  return [
    define('kb_search', 'Search the local Markdown vault by full text, title, and tags. Returns ranked snippets.', knowledgeSearchToolSchema, false, async input => { const kb = await current(); await kb.refresh(); return kb.search(input); }),
    define('kb_read', 'Read a vault-relative Markdown note in pages of at most 4000 characters. Use nextOffset to continue; offsets count UTF-16 characters.', knowledgeReadToolSchema, false, async input => {
      const note = await (await current()).read(input.path);
      const offset = Math.min(input.offset ?? 0, note.content.length);
      const content = note.content.slice(offset, offset + (input.limit ?? 4000));
      const end = offset + content.length;
      return { path: note.path, content, offset, totalCharacters: note.content.length, nextOffset: end < note.content.length ? end : null };
    }),
    define('kb_write', 'Atomically write a vault-relative .md note. Requires explicit approval: vault writes are outside canvas undo; createOnly prevents overwriting.', knowledgeWriteToolSchema, true, async input => { await (await current()).write(input.path, input.content, input.createOnly ?? false); return { path: input.path }; }),
    define('kb_organize', 'Organize up to 20 selected vault notes (120000 characters total) using only the selected turn model. Paid external submission and vault writes require explicit approval; outside canvas undo.', knowledgeOrganizeToolSchema, true, async input => {
      const result = await (await current()).organize(input.kind, input.paths, model);
      // Persist only an edit receipt, not generated summaries or complete note bodies.
      return { kind: result.kind, selectedPaths: input.paths, applied: true };
    }),
  ];
}
