import { expect, it } from 'vitest';
import { arrangeToolbarItems, normalizeWorkspacePreferences } from './workspacePreferences';
it('limits pinned tools while retaining every hidden and overflow action in More', () => {
 const items = ['a','b','c','d'].map((id) => ({ id }));
 const result = arrangeToolbarItems(items, { limit: 2, pinned: ['c','a','c'], hidden: ['a'] });
 expect(result.visible.map(x=>x.id)).toEqual(['c','b']);
 expect(result.more.map(x=>x.id)).toEqual(['a','d']);
});
it('hydrates old settings with usable defaults and rejects malformed display counts', () => {
 expect(normalizeWorkspacePreferences(undefined).nodeToolbar.limit).toBe(5);
 expect(normalizeWorkspacePreferences({nodeToolbar:{limit:999,pinned:[],hidden:[]}}).nodeToolbar.limit).toBe(5);
});
