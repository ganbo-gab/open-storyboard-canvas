const registeredAgentToolNames: Readonly<Record<string, true>> = {
  request_user_input: true, canvas_command: true, diagnostics: true, config_patch: true, asset_read: true,
  project_list: true, project_create: true, project_open: true,
  canvas_prepare_plan: true, canvas_open_plan: true, asset_search: true, asset_view: true,
  generation_models: true, home_generation_submit: true, home_generation_status: true,
  stage_query: true, stage_create: true, stage_open: true, stage_command: true,
  stage_direct: true, stage_draft_scene: true, stage_capture: true, stage_record: true,
  kb_search: true, kb_read: true, kb_write: true, kb_organize: true,
  channel_list: true, channel_models: true, channel_preview: true,
  channel_generate_profile: true, channel_create: true, channel_update: true,
  integration_list: true, integration_comfy_read: true, integration_comfy_preview: true, integration_comfy_apply: true,
  integration_image_host_read: true, integration_image_host_preview: true, integration_image_host_apply: true,
};

/** Lightweight validation shared by user-skill parsing and runtime tool registries. */
export function isRegisteredAgentToolName(value: string): boolean {
  return Object.hasOwn(registeredAgentToolNames, value);
}

/** For skill editors: every tool a user skill may whitelist. */
export function listRegisteredAgentToolNames(): string[] {
  return Object.keys(registeredAgentToolNames);
}
