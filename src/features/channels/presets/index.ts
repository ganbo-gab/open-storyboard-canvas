import type { ChannelProfileV2 } from '../domain/profile';
import { anthropicProfile } from './anthropic';
import { falProfile } from './fal';
import { geminiNativeProfile } from './gemini';
import { genericAsyncProfile } from './genericAsync';
import { grsaiProfile } from './grsai';
import { openAICompatibleProfile, openAIStandardProfile } from './openai';
import { ppioProfile } from './ppio';

export { anthropicProfile, falProfile, geminiNativeProfile, genericAsyncProfile, grsaiProfile,
  openAICompatibleProfile, openAIStandardProfile, ppioProfile };

/** KIE stays on its Rust provider: reference upload is a prerequisite HTTP workflow, not a template. */
export const builtInPresets: ChannelProfileV2[] = [
  openAIStandardProfile,
  openAICompatibleProfile,
  geminiNativeProfile,
  anthropicProfile,
  genericAsyncProfile,
  ppioProfile,
  grsaiProfile,
  falProfile,
];
