# 连接 ComfyUI

Open Storyboard Canvas 可以连接本机或自行部署在云端的 ComfyUI。应用使用 ComfyUI 的 API 工作流格式，通过已有的本机网络桥上传参考图、提交工作流、查询任务，并把最终图片或视频保存到画布生成结果。

## 连接前准备

1. 确认 ComfyUI 服务可以从运行 Open Storyboard Canvas 的电脑访问。本机常见地址是 `http://127.0.0.1:8188`；云端填写完整的 HTTPS 地址。反向代理有路径前缀时，保留它，例如 `https://example.com/comfy`。
2. 在 ComfyUI 设置中启用 **Dev Mode Options**，然后使用 **Save (API Format)** 导出工作流 JSON。普通画布工作流的 `nodes`/`links` 文件不能直接用于 API 提交。
3. 工作流应有提示词输入节点和保存结果的节点，例如 `SaveImage`。需要参考图时，添加一个或多个 `LoadImage` 节点。视频工作流需要最终输出文件能从 ComfyUI `/history` 和 `/view` 取得，例如 MP4 或 WebM。

## 在应用中设置

1. 打开「设置 → 添加服务商 → 全自定义图片模型 → 连接 ComfyUI」。
2. 填写服务地址。无鉴权的本机实例保留「无需鉴权」；云端可按部署方式选择 Bearer、自定义 Header 或 Query 参数。
3. 选择「图片输出」或「视频输出」，导入 API 工作流文件。应用会尝试识别常见的 `CLIPTextEncode`、`KSampler`、`EmptyLatentImage`、`LoadImage` 和保存结果节点。
4. 核对「节点绑定 JSON」与「输出节点 ID JSON 数组」。工作流有多个提示词节点或特殊自定义节点时，应手动指定要改写的节点，例如：

   ```json
   {
     "prompt": { "nodeId": "6", "input": "text" },
     "seed": { "nodeId": "3", "input": "seed" },
     "width": { "nodeId": "5", "input": "width" },
     "height": { "nodeId": "5", "input": "height" },
     "images": [{ "nodeId": "10", "input": "image" }]
   }
   ```

5. 在「模型与能力」填写界面显示的工作流名称、比例和分辨率。点击「只读测试连接」检查 `/system_stats` 或 `/queue`；它不会生成图片。最后保存配置。

图片和视频工作流分别保存为对应类型的配置。若两个工作流都要使用，可各建一条配置。不同 ComfyUI 插件的节点名称与输出结构会变化，遇到无法自动识别时填写明确的绑定和输出节点 ID。

## 生成与恢复

- 有参考图时，应用先调用 `/upload/image`，把返回的文件名写入指定 `LoadImage` 输入，再向 `/prompt` **提交一次**。
- ComfyUI 返回的 `prompt_id` 会存入现有生成任务记录。应用按 `/history/{prompt_id}` 查询状态，从输出节点取得文件信息，再通过 `/view` 下载结果。
- 关闭或重启应用后，有 `prompt_id` 的任务可以只查询结果，不会重发 `/prompt`。若提交阶段网络中断且没有收到 `prompt_id`，请到 ComfyUI 的队列/历史里核对，避免重复生成。
- 修改服务地址或工作流后，旧任务可能需要恢复原配置才能继续安全查询。

## 常见问题

| 现象 | 检查项 |
| --- | --- |
| 提示“画布格式” | 改用 Save (API Format) 导出。 |
| 提示找不到提示词输入 | 在节点绑定中填写正确的 `nodeId` 与 `input`。 |
| 参考图数量不匹配 | 为每张参考图准备一个可映射的 `LoadImage` 输入，或减少画布引用。 |
| 工作流完成但没有结果 | 检查保存节点、输出节点 ID，以及该节点是否输出支持的图片或视频文件。 |
| 云端连接失败 | 核对路径前缀、鉴权配置、服务端访问策略，以及网络路线。 |

接口依据：[ComfyUI 官方 API 示例](https://docs.comfy.org/development/comfyui-server/api-examples)。
