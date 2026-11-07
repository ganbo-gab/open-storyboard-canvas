# 输入框独立复审与定向修复

2026-11-04。先只读审查 WorkbenchComposer/referenceOrder/ComposerParameterPanel/PromptEditor；经主代理追加授权，仅修 PromptEditor、独立纯转换工具、测试，以及 PromptDraft 身份 key 两行。工作台输入框和引用顺序由主代理处理，未重叠写文件。

## 确认并修复的编辑器问题

1. **引用变化但纯文本不变，DOM仍指旧引用。** 原effect只比较getText与draft.value；重命名/删除参考素材不会更新atom title或转换为普通文本。现以引用身份/token/title签名为另一个更新条件，保持纯文本与caret位置。
2. **无效数字引用被截断。** 原findReferenceTokens(maxCount)可能把`@图10`识别成`@图1`加`0`。编辑器现在仅把当前完整已知token变为atom，禁止吞数字后缀，同时支持既有视频/音频/文本、tag自定义token。
3. **迟到图片粘贴写到新草稿或新光标。** 现以PromptDraft.key+Editor实例隔离目标，异步图片粘贴保留经过事务mapping更新的插入位置；切草稿、卸载、同key外部替换内容均撤销旧锚点。迟到异常不污染新草稿。
4. **切草稿后旧undo可污染新内容。** key变化重新建立Editor，旧onBlur/onUpdate不能写新writer；真实回归证明旧草稿写回旧目标，新Editor undo不恢复旧正文。
5. **外部同步进入本地undo**：引用同步/setContent不加入编辑器本地历史。内容解析提取为promptDocument.ts，保持存储为纯文本，不新增富文本持久协议。
6. **原resolver被绕过**：handlePaste现在真正使用调用者resolvePastedImage，保留画布现有剪贴板文件识别路径。

IME使用event.isComposing/view.composing保护，引用重建在composition结束后同步；Enter不会误发。展开/收起维持同一个Editor实例与内容，不新建第二份草稿。

## 工作台报告给主代理的确定问题

- 原本轮短前缀`@视/@音/@文`和既有解析器长前缀`@视频/@音频/@文本`不一致，重排/删除没有同步。已报告，主代理已修改referenceOrder和Workbench。
- slots删前一图/切模式未重映射正文引用，refs管理弹层仍展示generic references而非slots；已报告，主代理负责修复。
- 异步文件读取后未确认会话/model/mode，可能把文件加入已切换的新草稿。编辑器可拒绝迟到token，但不能阻止父级addFiles副作用；主代理已加draftTarget校验。
- ComposerParameterPanel可选enum选中后无默认/清空入口，建议沿用DeclaredParameters的未设置语义。此项已报告未改该文件。

## 浏览器QA反馈追加修复

主代理发现“2个产物详情显示4个”：history/task的持久source和job的远程source被URL集合当成不同结果。generationDetails现以history/task非空outputs为权威，仅缺失时使用job fallback，新增回归保持2项。`done/poll/download`等阶段已本地化，不直接展示技术状态。

## 验证

- 实际TipTap+React+ProseMirror（未mock编辑器）回归覆盖token DOM、caret、重排删除、数字边界、长前缀、切草稿writer、异步paste锚点/取消、展开/收起、IME、跨草稿undo。
- 编辑器与既有草稿单测2文件11条通过。
- 最终编辑器+详情联合4文件18条通过，tsc无错误，diff-check通过。
- 初次测试失败属于jsdom clipboard缺getData、未加载jest-dom matcher及JSX字符串转义，修正测试夹具后通过；没有改变产品行为去迎合测试。
- 原生IME完整候选窗口/系统剪贴板由主代理浏览器与桌面实际QA继续确认。

日志：`composer-tests.log`、`composer-tsc.log`。
