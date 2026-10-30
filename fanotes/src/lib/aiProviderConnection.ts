import type { AppSettings } from '../types'

type AiConnectionSettings = Pick<AppSettings,
  'lmStudioModel' | 'ollamaModel' | 'openCodeModel' |
  'openAiModel' | 'openAiApiKey' | 'geminiModel' | 'geminiApiKey' |
  'anthropicModel' | 'anthropicApiKey' | 'grokModel' | 'grokApiKey' | 'grokBuildRefreshToken'>

const filled = (value?: string) => typeof value === 'string' && value.trim() !== ''

/** A saved model or cloud key means the provider was connected. Default server addresses do not. */
export const hasConnectedAiProvider = (settings: AiConnectionSettings) => (
  filled(settings.lmStudioModel)
  || filled(settings.ollamaModel)
  || filled(settings.openCodeModel)
  || filled(settings.openAiModel)
  || filled(settings.openAiApiKey)
  || filled(settings.geminiModel)
  || filled(settings.geminiApiKey)
  || filled(settings.anthropicModel)
  || filled(settings.anthropicApiKey)
  || filled(settings.grokModel)
  || filled(settings.grokApiKey)
  || filled(settings.grokBuildRefreshToken)
)
