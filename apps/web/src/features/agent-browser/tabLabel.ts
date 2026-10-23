/** A blank page (including the runtime's internal blank allocation page) shows an empty address, like Chrome's new tab. */
export const shownUrl = (url: string) => url.startsWith('about:blank') ? '' : url
export const tabLabel = (tab: { title: string; url: string }) => shownUrl(tab.title) || shownUrl(tab.url) || 'New tab'
