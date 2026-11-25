import { createNoticeStore } from '@manor/client-runtime/notices'

/**
 * The phone's notice stack while the app is in front. The workspace pushes chat news
 * through the shared gate; `NoticeStack` renders it. In the background the server's
 * push takes over.
 */
export const noticeStore = createNoticeStore()
