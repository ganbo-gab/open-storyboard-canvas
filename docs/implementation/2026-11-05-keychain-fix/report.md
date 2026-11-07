# macOS 钥匙串重复授权修复

用户反馈：启动修复版后，com.storyboard-copilot.credentials.settings 的系统授权多次输入仍反复出现。

## 确认的原因

1. Rust secret_has 原先直接调用 get_password，检查存在也会申请读取秘密。
2. createSecretStorage 每次普通设置持久化都经 commitCredentialMigration 对所有已保存引用做 has。同一设置含多个条目，多个保存排队会放大授权次数。
3. 迁移被拒绝后，后续非敏感设置保存会重新尝试迁移。
4. 本地测试包是 adhoc 签名，新包身份也可能触发系统对旧条目的重新授权；不能把持续弹窗只归因于用户密码或签名。

## 修复

- macOS has 使用 SecItemCopyMatching 元数据存在查询，限制 User 默认keychain及原service/account，不请求data/attributes，无返回secret；AuthenticationUIFail要求需要交互时返回错误，不弹授权。缺失与锁定分开，不用UISkip把锁定伪装成缺失。
- SecretVault存在查询使用backend.has，真实get/调用模型/显示凭据仍经系统授权，存在不代表已获读取权限。没有更改Keychain ACL或绕过系统保护。
- 已安全引用的persist/protect不探测。hydrate同名并发合并、跨store同ref探测去重；secretStore.has只合并inflight，不缓存secret值，不让迟到状态覆盖后续读写或把locked洗为present。
- 迁移失败保留旧持久字节，普通保存不再重试。显式rehydrate或重启可重新恢复。首次旧明文迁移本身仍可能需要系统授权，禁止在未验证写入时丢弃旧数据。

## 验证

- 前端全量271文件2493项通过，TypeScript通过。
- Rust全量203项通过。新测试检查非交互查询、不返回secret、missing/locked映射，以及metadata存在但读取拒绝时transport仍拒绝。
- 真实Keychain完全未读写，系统弹窗及该机器旧条目ACL没有实机重现测试。测试使用内存backend与合成CF查询；不能把测试通过声称为真实系统授权已全覆盖。
- Windows/Linux继续现有keyring实现，只共享TS去重/迁移重试修复。
- 打包、签名与DMG核验结果随安装包保存。

关闭旧应用后使用新的钥匙串修复包。无需删除钥匙串条目或重新填所有API Key；不要把Mac登录密码填入应用API Key栏。

最终交付：验收包-2026-11-05-钥匙串修复版；adhoc签名完整性和DMG校验通过。源码索引SHA256保持14ab07df3bff02d0b7759ec60f8d20c1cf9fb4efaaed6475a06906eb7794bab4。
