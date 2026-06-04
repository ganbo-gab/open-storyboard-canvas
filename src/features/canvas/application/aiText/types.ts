export type AiTextInputSourceType = 'markdown' | 'json' | 'image';

export interface TextAgentInputConfig {
  id: string;
  type: AiTextInputSourceType;
  label: string;
  sourceAgentId?: string | null;
  jsonPath?: string;
  enabled: boolean;
}

export interface TextAgentJsonFieldConfig {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
}

export interface TextAgentConfig {
  id: string;
  name: string;
  enabled: boolean;
  prompt: string;
  defaultModel: string;
  inputSources: TextAgentInputConfig[];
  jsonExample: string;
  jsonFields: TextAgentJsonFieldConfig[];
  createdAt: number;
  updatedAt: number;
}

export interface JsonCardDisplayField {
  path: string;
  label: string;
  value: string;
}

export interface AiTextInputTextPart {
  kind: 'text';
  sourceType: 'markdown' | 'json';
  sourceNodeId: string;
  label: string;
  content: string;
  jsonPath?: string;
}

export interface AiTextInputImagePart {
  kind: 'image';
  sourceType: 'image';
  sourceNodeId: string;
  label: string;
  imageUrl: string;
  previewImageUrl?: string | null;
}

export type AiTextInputPart = AiTextInputTextPart | AiTextInputImagePart;

export interface AiTextOpenAiChatMessageContentText {
  type: 'text';
  text: string;
}

export interface AiTextOpenAiChatMessageContentImage {
  type: 'image_url';
  image_url: {
    url: string;
  };
}

export interface AiTextOpenAiChatPayload {
  model: string;
  messages: Array<{
    role: 'system' | 'user';
    content:
      | string
      | Array<AiTextOpenAiChatMessageContentText | AiTextOpenAiChatMessageContentImage>;
  }>;
}

export type AiTextResultKind = 'markdown' | 'json';

export interface AiTextResolvedResult {
  kind: AiTextResultKind;
  rawContent: string;
  markdownContent?: string;
  parsedJson?: unknown;
  parseError?: string | null;
}

export interface FlattenedJsonPathOption {
  path: string;
  label: string;
}
