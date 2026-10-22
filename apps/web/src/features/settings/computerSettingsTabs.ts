/** The sections of one computer's settings page, in tab order. */
export const ComputerSettingsTabs = ['overview', 'accounts', 'files', 'connection'] as const
export type ComputerSettingsTab = typeof ComputerSettingsTabs[number]
