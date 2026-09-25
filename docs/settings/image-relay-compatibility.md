# 中转站生图兼容配置

不同 NewAPI 版本、渠道和上游模型可能使用不同的端点、请求体和返回值。Open Storyboard Canvas 的全自定义图片模型工作台允许分别配置文生图与图生图，按供应商文档生成最终请求。

## 配置步骤

1. 打开「设置 → 添加服务商 → 图片模型 → 手动搭建配置」。填写根地址、鉴权方式和模型 ID。根地址通常到 `/v1`；不要再把 `/images/generations` 重复放进根地址。
2. 在「文生图请求」设置端点、方法、JSON/multipart 编码和请求体模板。
3. 需要参考图时，在「图生图与几何映射」启用独立请求配置。图生图可以和文生图使用**同一个端点**，也可以走 `/images/edits`；字段名和 `single / array / repeat` 按中转站文档选择。
4. 在「响应与轮询」填写结果路径，例如 `data[0].url` 或 `data[0].b64_json`。异步接口还需填写任务 ID、状态和结果路径。
5. 在「检查与保存」展开**实际请求预览**，核对最终端点、方法、字段和图片数量。预览不发起网络请求。确认后保存。

「试生成（可能计费）」会真实提交生图请求；建议先看实际请求预览，再决定是否测试。

## 两种常见格式

标准 OpenAI Images 风格通常为：

| 用途 | 端点 | 请求体 | 图片字段 |
| --- | --- | --- | --- |
| 文生图 | `/images/generations` | JSON | 无 |
| 图生图 | `/images/edits` | multipart/form-data | `image`、重复 `image[]` 或供应商文档指定值 |

某些中转站会把文生图和图生图都放在 `/images/generations`，但要求 JSON 的 `image` 数组。此时可在高级契约中保存如下**示例**，并按该站文档修改字段：

```json
{
  "version": 1,
  "textToImage": {
    "endpointPath": "/images/generations",
    "method": "POST",
    "bodyMode": "json",
    "bodyTemplate": {
      "model": "{{model}}",
      "prompt": "{{prompt}}",
      "size": "{{size}}"
    },
    "responseImagePaths": ["data[0].url", "data[0].b64_json"]
  },
  "imageToImage": {
    "endpointPath": "/images/generations",
    "method": "POST",
    "bodyMode": "json",
    "bodyTemplate": {
      "model": "{{model}}",
      "prompt": "{{prompt}}",
      "size": "{{size}}"
    },
    "imageFields": [{ "name": "image", "mode": "array", "encoding": "data-url" }],
    "responseImagePaths": ["data[0].url", "data[0].b64_json"]
  }
}
```

如果文档写的是 multipart 文件字段，改用 `bodyMode: "multipart"`，再按文档设置 `imageFields` 的字段名和数量模式。不要因为内部诊断里出现 `referenceImages` 数组，就推断上游也接受同名 JSON 字段；以实际请求预览为准。

## 代理与超时

应用已有 Tauri 本机 HTTP 转发和「系统 / 直连 / 自定义代理」网络路线。代理可以解决部分 CORS、DNS 或网络连通问题，但不会自动把 JSON 转成 multipart、改写字段或解释不同的响应格式；这些由上面的请求契约决定。

图像生成 POST 超时或连接中断时，上游可能已经接受并计费。应用不会自动重发该请求。若供应商返回可查询的任务 ID，配置异步轮询来安全取回结果；若没有任务句柄，请在中转站后台核对，再决定是否手动重试。

参考：[NewAPI Image API 文档](https://github.com/QuantumNous/new-api-docs/blob/main/docs/en/api/openai-image.md)、[问题 #7](https://github.com/ganbo-gab/open-storyboard-canvas/issues/7)、[问题 #10](https://github.com/ganbo-gab/open-storyboard-canvas/issues/10)。
