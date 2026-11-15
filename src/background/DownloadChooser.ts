import browser from "webextension-polyfill";
import {DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import {addDownload} from "~/background/actions";
import {addBypassUrls} from "~/background/BypassDownloads";
import {isForbiddenHeader} from "~/utils/ForbiddenHeaders";

/**
 * 下載方式選擇視窗（Download Chooser）— 背景端協調器。
 *
 * 當自動攔截到一個下載、且設定 askDownloadMethod 開啟時，攔截流程不會
 * 直接把下載送進 App，而是呼叫 openDownloadChooser()：
 *   1. 把下載資訊（DownloadRequestItem + 顯示用 meta）存進 storage.local
 *      （key = `downloadChooser:<id>`）。
 *   2. 用 browser.windows.create 開一個小彈出視窗，載入 BrowserAction
 *      進入點頁面並帶上 ?chooser=<id>，頁面會依此參數渲染選擇 UI。
 *   3. 使用者選擇後，頁面透過 webext-bridge 送出
 *      DOWNLOAD_CHOOSER_CHOICE {id, choice}，由 handleChooserChoice() 執行：
 *        - "app"     → 走原本 actions.addDownload()（依 silentAddDownload
 *                      決定是否開 App 的新增下載視窗）。
 *        - "browser" → 把 URL 加入 bypass 名單後呼叫
 *                      browser.downloads.download() 交回瀏覽器原生下載。
 *
 * 若使用者直接關掉視窗（windows.onRemoved）而未選擇，則 fallback 送進
 * App，行為等同未加此功能的自動接管，避免下載憑空消失。
 */

const STORAGE_KEY_PREFIX = "downloadChooser:"

/** 選擇視窗最多存活 10 分鐘，過期即清理（防止 storage 累積垃圾） */
const ENTRY_EXPIRE_TIME_MS = 10 * 60_000

/** 彈出視窗頁面：沿用 BrowserAction 進入點（已由 manifest/vite 建置） */
const CHOOSER_PAGE_PATH = "src/entrypoint/BrowserAction/index.html"

/** 選擇視窗上要顯示的輔助資訊 */
export interface DownloadChooserMeta {
    fileName: string | null
    sizeBytes: number | null
    mimeType: string | null
    pageHost: string | null
    urlHost: string | null
}

/** 存進 storage.local 的完整 entry */
export interface DownloadChooserEntry {
    id: string
    item: DownloadRequestItem
    meta: DownloadChooserMeta
    createdAt: number
}

/** windowId -> chooserId，用來在視窗被關閉時找到對應的下載 */
const chooserWindows = new Map<number, string>()

/** windows.onRemoved 只註冊一次 */
let windowRemovedListenerRegistered = false

function chooserPageUrl(id: string) {
    return `${browser.runtime.getURL(CHOOSER_PAGE_PATH)}?chooser=${encodeURIComponent(id)}`
}

function storageKey(id: string) {
    return STORAGE_KEY_PREFIX + id
}

/** 清理過期的 chooser entry（在每次新增時順手執行） */
async function pruneExpiredEntries() {
    try {
        const all = await browser.storage.local.get(null)
        const now = Date.now()
        const keysToRemove: string[] = []
        Object.entries(all).forEach(([key, value]) => {
            if (!key.startsWith(STORAGE_KEY_PREFIX)) return
            const entry = value as DownloadChooserEntry
            if (!entry?.createdAt || now - entry.createdAt > ENTRY_EXPIRE_TIME_MS) {
                keysToRemove.push(key)
            }
        })
        if (keysToRemove.length > 0) {
            await browser.storage.local.remove(keysToRemove)
        }
    } catch (error) {
        console.warn("pruneExpiredEntries failed", error)
    }
}

/**
 * 攔截流程呼叫：開啟下載方式選擇視窗。
 * 原生下載在此之前已被標記 handledOnWebRequest／取消，
 * 之後的去向完全由使用者的選擇決定。
 */
export async function openDownloadChooser(
    item: DownloadRequestItem,
    meta: DownloadChooserMeta,
) {
    const id = crypto.randomUUID()
    const entry: DownloadChooserEntry = {
        id,
        item,
        meta,
        createdAt: Date.now(),
    }
    await browser.storage.local.set({[storageKey(id)]: entry})
    void pruneExpiredEntries()
    registerWindowRemovedListener()
    try {
        const win = await browser.windows.create({
            type: "popup",
            url: chooserPageUrl(id),
            width: 460,
            height: 360,
            focused: true,
        })
        if (win.id !== undefined) {
            chooserWindows.set(win.id, id)
        }
    } catch (error) {
        // 開視窗失敗（極罕見）→ fallback 直接送 App，不讓下載卡死
        console.warn("open chooser window failed, fallback to app", error)
        await removeEntry(id)
        await addDownload([item])
    }
}

/** 視窗被關閉但使用者沒做選擇 → fallback：直接送進 App（原本的行為） */
function registerWindowRemovedListener() {
    if (windowRemovedListenerRegistered) return
    windowRemovedListenerRegistered = true
    browser.windows.onRemoved.addListener(async (windowId) => {
        const chooserId = chooserWindows.get(windowId)
        if (chooserId === undefined) return
        chooserWindows.delete(windowId)
        const entry = await getChooserEntry(chooserId)
        if (!entry) return
        await removeEntry(chooserId)
        await addDownload([entry.item])
    })
}

async function getChooserEntry(id: string): Promise<DownloadChooserEntry | null> {
    const stored = await browser.storage.local.get(storageKey(id))
    const entry = stored?.[storageKey(id)] as DownloadChooserEntry | undefined
    if (!entry || !entry.item) {
        return null
    }
    return entry
}

async function removeEntry(id: string) {
    await browser.storage.local.remove(storageKey(id))
    // 若視窗還開著（例如選擇動作由頁面觸發），順手移除映射
    chooserWindows.forEach((cid, winId) => {
        if (cid === id) chooserWindows.delete(winId)
    })
}

/**
 * 使用者做完選擇後由背景訊息處理器呼叫。
 * 回傳是否成功處理（entry 不存在或已處理過則回 false）。
 */
export async function handleChooserChoice(
    id: string,
    choice: "app" | "browser",
): Promise<boolean> {
    const entry = await getChooserEntry(id)
    if (!entry) {
        return false
    }
    await removeEntry(id)
    const item = entry.item
    if (choice === "app") {
        // 交給 App（依使用者 silentAddDownload 設定決定是否開對話框）
        await addDownload([item])
        return true
    }
    // choice === "browser"：交回瀏覽器原生下載
    await addBypassUrls([item.link])
    const headers = (Object.entries(item.headers ?? {}))
        .filter(([name, value]) => value !== undefined && value !== null)
        .filter(([name, value]) => !isForbiddenHeader(name, value))
        .map(([name, value]) => ({name, value: String(value)}))
    try {
        await browser.downloads.download({
            url: item.link,
            headers,
        })
    } catch (error) {
        // 例如該 URL 已失效或標頭被拒絕 → 退回送 App，並提示
        console.warn("browser download failed, fallback to app", error)
        await addDownload([item])
    }
    return true
}
