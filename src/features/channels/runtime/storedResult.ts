/** Missing durable bytes are distinct from an unavailable storage service. */
export class StoredResultMissingError extends Error {
  constructor() {
    super('本地结果素材不存在；可取回原任务结果，不会重新生成');
    this.name = 'StoredResultMissingError';
  }
}
