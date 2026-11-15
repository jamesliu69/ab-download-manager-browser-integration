import browser from "webextension-polyfill";

/**
 * 「略過一次攔截」名單（bypass list）。
 *
 * 當使用者在下載方式選擇視窗（DownloadChooser）選擇「用瀏覽器下載」時，
 * 該下載的 URL 會被加入此名單；之後同一個 URL 的請求再進到擴充套件的
 * 攔截流程（webRequest.onHeadersReceived / downloads.onCreated）時，
 * 會被 consumeBypassIfMatched() 命中並「消耗掉」，直接放行給瀏覽器原生
 * 下載，避免我們自己呼叫 browser.downloads.download() 所觸發的新請求
 * 又被自己攔截、造成重複下載或下載被取消的迴圈。
 *
 * 名單存放在 service worker 的記憶體 Map，並同步寫入 browser.storage.session，
 * 如此 service worker 被 Chrome 回收後重新啟動，仍可由 bootBypassDownloads()
 * 還原。每筆 entry 為單次使用（命中即刪），並有 60 秒到期時間。
 */

const STORAGE_KEY = "bypassDownloads"

/** 每筆 bypass 項目的存活時間（毫秒） */
const EXPIRE_TIME_MS = 60_000

/** url -> 到期時間戳（毫秒） */
let bypassUrls = new Map<string, number>()

/**
 * 在背景 service worker 啟動時呼叫：
 * 從 storage.session 還原 bypass 名單，順便清掉過期項目。
 */
export async function bootBypassDownloads() {
    try {
        const stored = await browser.storage.session.get(STORAGE_KEY)
        const record = (stored?.[STORAGE_KEY] ?? {}) as Record<string, number>
        const now = Date.now()
        bypassUrls = new Map(
            Object.entries(record).filter(([_, expiry]) => expiry > now)
        )
    } catch (error) {
        console.warn("bootBypassDownloads failed", error)
        bypassUrls = new Map()
    }
}

/** 將名單同步寫入 storage.session（供 service worker 重啟後還原） */
async function persist() {
    try {
        const record: Record<string, number> = {}
        bypassUrls.forEach((expiry, url) => {
            record[url] = expiry
        })
        await browser.storage.session.set({[STORAGE_KEY]: record})
    } catch (error) {
        console.warn("persist bypassDownloads failed", error)
    }
}

/** 加入一或多個要「放行一次」的 URL */
export async function addBypassUrls(urls: string[]) {
    const expiry = Date.now() + EXPIRE_TIME_MS
    urls.forEach((url) => {
        if (url) {
            bypassUrls.set(url, expiry)
        }
    })
    await persist()
}

/**
 * 若傳入的任何 URL 命中 bypass 名單，則消耗該筆項目並回傳 true
 * （表示這個請求/下載應該放行、不做任何攔截）；否則回傳 false。
 * 過期項目會順手清除。
 */
export function consumeBypassIfMatched(urls: (string | null | undefined)[]): boolean {
    const now = Date.now()
    let matched = false
    for (const url of urls) {
        if (!url) continue
        const expiry = bypassUrls.get(url)
        if (expiry === undefined) continue
        // 命中即消耗（單次使用）
        bypassUrls.delete(url)
        if (expiry > now) {
            matched = true
        }
    }
    if (matched) {
        // 非同步持久化，不影響回傳時序
        void persist()
    }
    return matched
}
