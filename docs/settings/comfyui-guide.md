# 连接 ComfyUI

Open Storyboard Canvas 可以连接本机或自行部署在云端的 ComfyUI。应用使用 ComfyUI 的 API 工作流格式，通过已有的本机网络桥上传参考图、提交工作流、查询任务，并把最终图片或视频保存到画布生成结果。

## 连接前准备

1. 确认 ComfyUI 服务可以从运行 Open Storyboard Canvas 的电脑访问。本机常见地址是 `http://127.0.0.1:8188`；云端填写完整的 HTTPS 地址。反向代理有路径前缀时，保留它，例如 `https://example.com/comfy`。
2. 使用内置的「基础文生图」或「参考图重绘」模板时，ComfyUI 中需已安装可用的 checkpoint 模型。模板只使用 ComfyUI 内置节点；在设置中选择模型文件名即可。
3. 使用自己的工作流时，在 ComfyUI 设置中启用 **Dev Mode Options**，然后使用 **Save (API Format)** 导出 JSON。普通画布工作流的 `nodes`/`links` 文件不能直接用于 API 提交。自定义工作流应有提示词输入和保存结果的节点；视频工作流需输出可从 `/history` 和 `/view` 取得的 MP4 或 WebM 文件。

## 在应用中设置

1. 打开「设置 → ComfyUI」，选择「基础文生图」「参考图重绘」或「自定义工作流」。
2. 填写服务地址。无鉴权的本机实例保留「无需鉴权」；云端可按部署方式选择 Bearer、自定义 Header 或 Query 参数。
3. 使用内置模板时，点击「读取服务器模型」选择 checkpoint 文件，也可以手动输入文件名。模板的提示词、种子、尺寸和参考图节点映射已配好。
4. 使用自定义工作流时，选择图片或视频输出并导入 API 格式 JSON。应用会尝试识别常见节点；多个提示词节点或特殊自定义节点可在「高级设置」中手动指定，例如：

   ```json
   {
     "prompt": { "nodeId": "6", "input": "text" },
     "seed": { "nodeId": "3", "input": "seed" },
     "width": { "nodeId": "5", "input": "width" },
     "height": { "nodeId": "5", "input": "height" },
     "images": [{ "nodeId": "10", "input": "image" }]
   }
   ```

5. 填写画布里的工作流名称，点击「只读测试连接」检查 `/system_stats` 或 `/queue`；它不会生成图片。最后保存配置。

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

## MiniMax H3 本地渠道

「设置 → ComfyUI → MiniMax H3 本地视频」是 **导入已验证工作流** 的入口。它不会安装 ComfyUI、下载模型或替用户补齐采样/解码节点。先在自己的 ComfyUI 服务器安装 H3 模型与节点，确认整条流程可以生成视频，再导出 **API Format** JSON。商业使用所需的模型许可、硬件要求以 [Comfy 官方 H3 说明](https://docs.comfy.org/tutorials/partner-nodes/minimax/minimax-h3) 为准。

1. 在该入口填写 ComfyUI 地址，并导入 API JSON。应用识别 `MiniMaxH3ImageToVideo`（文字/首尾帧条件）或 `MiniMaxH3ReferenceToVideo`（参考条件）中的 `prompt`、`width`、`height`、`length`，以及 `KSampler.seed`、`KSamplerAdvanced.noise_seed`、`RandomNoise.noise_seed`。有多个候选节点时，需要在高级设置指定绑定。
2. 工作流需保留完整的模型加载、采样、音视频解码与保存链路；视频保存节点例如 `SaveVideo`。输出应为可通过 `/history` 与 `/view` 下载的 MP4/WebM。`SaveVideo` 的 MP4 位于 history 的 `images` 数组中，应用也能读取。
3. 画布时长提供 5–15 秒，按 H3 的 24fps 和 `17k+5` 帧网格向上对齐：5 秒 → 124 帧、8 秒 → 192 帧、15 秒 → 362 帧。实际视频略长于所选整数秒是该模型的帧网格规则；工作流创建视频时也应使用 24fps。
4. 画幅档位为 `768P`，支持横向、竖向、正方形、4:3、3:4；例如横向为 1344×768。宽高必须为 32 的倍数，总像素不超过 768×1344。不会套用图片的 1K/2K/4K 档位。
5. 参考图按 `bindings.images` 顺序上传并替换 `LoadImage.image`；首尾帧和参考条件的用途由导入工作流的连线决定。请检查绑定顺序。空的图片文件名需要画布提供对应位置的参考图；已有服务器图片文件名则可以保留使用。当前不上传画布里的参考视频/音频，服务器工作流内已配置的媒体不受影响。

本地 H3 渠道不需要 MiniMax API Key；连接 ComfyUI 反向代理时，仍按部署要求填写连接鉴权。

**Comfy Partner H3 API 节点是另一条渠道。** `MinimaxHailuo03TextToVideoNode` 等 Partner 节点通过 Comfy 账户计费，凭据需要提交在 `/prompt` 的 `extra_data.api_key_comfy_org`，不能放到连接 HTTP Header 或工作流输入里。当前本地 H3 导入入口没有实现 Partner 凭据注入，不能把 Partner 模板当作本地模板使用。使用云端 H3 时，可选择应用中的 MiniMax 官方直连供应商；不要将 Partner 密钥粘贴进可分享的工作流 JSON。

## 通用视频参数绑定

自定义视频 API 工作流可以显式配置以下绑定，`input` 是节点中的原始字段名（含点号的字段名按字面匹配，不作为嵌套路径）：

```json
{
  "prompt": { "nodeId": "12", "input": "prompt" },
  "duration": { "nodeId": "12", "input": "duration" },
  "resolution": { "nodeId": "12", "input": "resolution" },
  "aspectRatio": { "nodeId": "12", "input": "ratio" },
  "images": []
}
```

一般节点的 `duration` 按秒写入；仅已识别的本地 H3 节点 `length` 自动转换成帧数。需要其它 fps/帧数表达式的自定义节点应在 ComfyUI 工作流内部添加转换节点，再把秒数绑定到转换节点输入。可在画布显示步骤填写供应商真正支持的秒数、分辨率与比例枚举；未绑定的参数保留工作流原值，并显示「由工作流决定」。工作流的默认种子会保留，除非调用方明确传入新的 seed。

视频输入能力按工作流的图片绑定数量计算，不再默认宣称支持九张图、首尾帧角色或参考视频/音频。只读连接成功仅证明服务可访问，不证明模型、插件、GPU 和工作流执行成功；首次实际运行仍需在自己的服务器验证。
