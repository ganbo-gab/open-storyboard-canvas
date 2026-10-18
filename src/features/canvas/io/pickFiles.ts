/**
 * Open the system file picker without tying the <input> to a React tree: menus close while the
 * native dialog has focus, and an unmounted input would drop the selection.
 */
export function pickFiles(options: { accept: string; multiple?: boolean }): Promise<File[]> {
  const { promise, resolve } = Promise.withResolvers<File[]>();
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = options.accept;
  input.multiple = options.multiple ?? true;
  input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
  input.addEventListener('cancel', () => resolve([]), { once: true });
  input.click();
  return promise;
}

export const MEDIA_FILE_ACCEPT = 'image/*,video/*,audio/*';
