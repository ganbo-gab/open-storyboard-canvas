import type { ReactNode } from 'react';
import ReactReconciler from 'react-reconciler';
import { DefaultEventPriority, LegacyRoot } from 'react-reconciler/constants';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runtimeMocks = vi.hoisted(() => ({
  verifyAgnesKey: vi.fn(),
  setAgnesApiKey: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (
      options?.count === undefined ? key : `${key}:${options.count}`
    ),
  }),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }));

vi.mock('@/features/canvas/infrastructure/customProviderGateway', () => ({
  verifyAgnesKey: runtimeMocks.verifyAgnesKey,
}));

vi.mock('@/stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: {
    agnesApiKey: string;
    setAgnesApiKey: (key: string) => void;
  }) => unknown) => selector({
    agnesApiKey: 'saved-key',
    setAgnesApiKey: runtimeMocks.setAgnesApiKey,
  }),
}));

import { AgnesSettingsSection } from './AgnesSettingsSection';

interface TestText {
  kind: 'text';
  text: string;
}

interface TestInstance {
  kind: 'instance';
  type: string;
  props: Record<string, unknown>;
  children: TestNode[];
}

type TestNode = TestInstance | TestText;
interface TestContainer { children: TestNode[] }

function removeNode(children: TestNode[], child: TestNode): void {
  const index = children.indexOf(child);
  if (index >= 0) children.splice(index, 1);
}

const testRenderer = ReactReconciler<string, Record<string, unknown>, TestContainer, TestInstance,
  TestText, never, never, TestNode, null, true, never, ReturnType<typeof setTimeout>, -1>({
    supportsMutation: true,
    supportsPersistence: false,
    supportsHydration: false,
    supportsMicrotasks: true,
    scheduleMicrotask: queueMicrotask,
    isPrimaryRenderer: false,
    warnsIfNotActing: false,
    getCurrentEventPriority: () => DefaultEventPriority,
    getRootHostContext: () => null,
    getChildHostContext: () => null,
    prepareForCommit: () => null,
    resetAfterCommit: () => undefined,
    preparePortalMount: () => undefined,
    createInstance: (type, props) => ({ kind: 'instance', type, props, children: [] }),
    createTextInstance: (text) => ({ kind: 'text', text }),
    appendInitialChild: (parent, child) => { parent.children.push(child); },
    appendChild: (parent, child) => { parent.children.push(child); },
    appendChildToContainer: (container, child) => { container.children.push(child); },
    insertBefore: (parent, child, beforeChild) => {
      removeNode(parent.children, child);
      parent.children.splice(parent.children.indexOf(beforeChild), 0, child);
    },
    insertInContainerBefore: (container, child, beforeChild) => {
      removeNode(container.children, child);
      container.children.splice(container.children.indexOf(beforeChild), 0, child);
    },
    removeChild: (parent, child) => { removeNode(parent.children, child); },
    removeChildFromContainer: (container, child) => { removeNode(container.children, child); },
    clearContainer: (container) => { container.children.length = 0; },
    finalizeInitialChildren: () => false,
    prepareUpdate: () => true,
    commitUpdate: (instance, _payload, _type, _oldProps, newProps) => {
      instance.props = newProps;
    },
    commitTextUpdate: (instance, _oldText, newText) => { instance.text = newText; },
    shouldSetTextContent: () => false,
    getPublicInstance: (instance) => instance,
    scheduleTimeout: setTimeout,
    cancelTimeout: clearTimeout,
    noTimeout: -1,
    getInstanceFromNode: () => null,
    beforeActiveInstanceBlur: () => undefined,
    afterActiveInstanceBlur: () => undefined,
    prepareScopeUpdate: () => undefined,
    getInstanceFromScope: () => null,
    detachDeletedInstance: () => undefined,
  });

function renderComponent(element: ReactNode): TestContainer {
  const container: TestContainer = { children: [] };
  const root = testRenderer.createContainer(
    container,
    LegacyRoot,
    null,
    false,
    null,
    '',
    (error) => { throw error; },
    null,
  );
  testRenderer.flushSync(() => {
    testRenderer.updateContainer(element, root, null);
  });
  testRenderer.flushPassiveEffects();
  return container;
}

function allInstances(container: TestContainer): TestInstance[] {
  const instances: TestInstance[] = [];
  const visit = (node: TestNode) => {
    if (node.kind === 'text') return;
    instances.push(node);
    node.children.forEach(visit);
  };
  container.children.forEach(visit);
  return instances;
}

function nodeText(node: TestNode): string {
  return node.kind === 'text' ? node.text : node.children.map(nodeText).join('');
}

function findInstance(
  container: TestContainer,
  predicate: (instance: TestInstance) => boolean,
): TestInstance {
  const instance = allInstances(container).find(predicate);
  if (!instance) throw new Error('Expected component host instance was not rendered');
  return instance;
}

function click(instance: TestInstance): void {
  testRenderer.flushSync(() => {
    (instance.props.onClick as (() => void))();
  });
}

function edit(instance: TestInstance, value: string): void {
  testRenderer.flushSync(() => {
    (instance.props.onChange as ((event: { target: { value: string } }) => void))({
      target: { value },
    });
  });
}

async function flushAsyncState(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  testRenderer.flushSync();
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => {
  runtimeMocks.verifyAgnesKey.mockReset();
  runtimeMocks.setAgnesApiKey.mockReset();
});

describe('AgnesSettingsSection', () => {
  it('renders save and explicit verification as separate controls', () => {
    const container = renderComponent(<AgnesSettingsSection />);
    const text = container.children.map(nodeText).join('');
    expect(text).toContain('settings.agnes.save');
    expect(text).toContain('settings.agnes.verify');
    expect(text).not.toContain('settings.agnes.verifySuccess');
    expect(text).toContain('Agnes 2.5 Flash');
  });

  it('shows verifying and then a successful verification result', async () => {
    const result = deferred<{ ok: true; modelCount: number }>();
    runtimeMocks.verifyAgnesKey.mockReturnValueOnce(result.promise);
    const container = renderComponent(<AgnesSettingsSection />);
    const verifyButton = findInstance(container, (instance) => (
      instance.type === 'button' && nodeText(instance) === 'settings.agnes.verify'
    ));

    click(verifyButton);
    expect(nodeText(verifyButton)).toBe('settings.agnes.verifying');
    expect(verifyButton.props.disabled).toBe(true);

    result.resolve({ ok: true, modelCount: 7 });
    await flushAsyncState();
    const status = findInstance(container, (instance) => instance.props.role === 'status');
    expect(nodeText(status)).toContain('settings.agnes.verifySuccess:7');
  });

  it('shows a categorized failed verification result', async () => {
    runtimeMocks.verifyAgnesKey.mockResolvedValueOnce({
      ok: false,
      category: 'authorization',
    });
    const container = renderComponent(<AgnesSettingsSection />);
    click(findInstance(container, (instance) => (
      instance.type === 'button' && nodeText(instance) === 'settings.agnes.verify'
    )));
    await flushAsyncState();

    const status = findInstance(container, (instance) => instance.props.role === 'status');
    expect(nodeText(status)).toContain('settings.agnes.verifyErrors.authorization');
  });

  it('resets on Key edits and ignores a stale verification response', async () => {
    const staleResult = deferred<{ ok: true; modelCount: number }>();
    runtimeMocks.verifyAgnesKey.mockReturnValueOnce(staleResult.promise);
    const container = renderComponent(<AgnesSettingsSection />);
    const input = findInstance(container, (instance) => instance.type === 'input');
    click(findInstance(container, (instance) => (
      instance.type === 'button' && nodeText(instance) === 'settings.agnes.verify'
    )));

    edit(input, 'new-key');
    expect(allInstances(container).some((instance) => instance.props.role === 'status')).toBe(false);
    expect(runtimeMocks.verifyAgnesKey).toHaveBeenCalledWith('saved-key');

    staleResult.resolve({ ok: true, modelCount: 99 });
    await flushAsyncState();
    expect(container.children.map(nodeText).join('')).not.toContain('settings.agnes.verifySuccess');
  });
});
