import React, {useEffect, useState} from "react";
import "~/assets/css/styles.css"
import browser from "webextension-polyfill";
import {sendMessage} from "webext-bridge/popup";
import {DefinedCommands} from "~/message/Commands";
import {DownloadChooserEntry} from "~/background/DownloadChooser";
import {AppIcon, DownloadIcon} from "~/components/ReactIcons";

/**
 * 下載方式選擇視窗（Download Chooser）— 頁面 UI。
 *
 * 此頁共用 BrowserAction 進入點：背景端以
 * browser.windows.create() 開啟 `index.html?chooser=<id>`，
 * 本元件依 id 從 storage.local 讀出待決定的下載資訊，
 * 讓使用者選擇「用 AB Download Manager 下載」或「用瀏覽器下載」，
 * 選擇結果以 DOWNLOAD_CHOOSER_CHOICE 訊息送回背景執行。
 */

/** 從網址列抓 ?chooser=<id> 參數；非 chooser 視窗回 null */
export function getChooserIdFromLocation(): string | null {
    const params = new URLSearchParams(window.location.search)
    const id = params.get("chooser")
    return id && id.length > 0 ? id : null
}

const STORAGE_KEY_PREFIX = "downloadChooser:"

function formatBytes(bytes: number | null | undefined): string | null {
    if (bytes === null || bytes === undefined || bytes <= 0) {
        return null
    }
    const units = ["B", "KB", "MB", "GB", "TB"]
    let value = bytes
    let unitIndex = 0
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024
        unitIndex++
    }
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unitIndex]}`
}

export const DownloadChooserUi: React.FC<{
    chooserId: string,
}> = (props) => {
    const [entry, setEntry] = useState<DownloadChooserEntry | null | undefined>(undefined)
    const [busy, setBusy] = useState<boolean>(false)

    useEffect(() => {
        let cancelled = false
        run(async () => {
            const stored = await browser.storage.local.get(STORAGE_KEY_PREFIX + props.chooserId)
            const found = (stored?.[STORAGE_KEY_PREFIX + props.chooserId] ?? null) as DownloadChooserEntry | null
            if (!cancelled) {
                setEntry(found)
            }
        })
        return () => {
            cancelled = true
        }
    }, [props.chooserId])

    async function choose(choice: "app" | "browser") {
        if (busy) return
        setBusy(true)
        try {
            await sendMessage(
                DefinedCommands.DOWNLOAD_CHOOSER_CHOICE,
                {
                    id: props.chooserId,
                    choice,
                },
                "background",
            )
        } catch (error) {
            console.warn("send chooser choice failed", error)
        }
        window.close()
    }

    // 載入中
    if (entry === undefined) {
        return <div data-theme="dark" className="w-[430px] h-[240px] bg-base-200"/>
    }

    // entry 不存在（已處理過或過期）
    if (entry === null) {
        return <div data-theme="dark" className="w-[430px] bg-base-200 p-6 space-y-4">
            <div className="text-base-content/80 text-sm">
                {browser.i18n.getMessage("chooser_expired")}
            </div>
            <button className="btn btn-sm"
                    onClick={() => window.close()}>
                OK
            </button>
        </div>
    }

    const meta = entry.meta
    const sizeText = formatBytes(meta.sizeBytes) ?? browser.i18n.getMessage("chooser_size_unknown")
    const detailParts = [
        meta.urlHost,
        meta.mimeType,
    ].filter((p) => p && p.length > 0)

    return <div data-theme="dark" className="w-[430px] bg-base-200 text-base-content">
        {/* 標題列 */}
        <div className="p-4 pb-2 flex flex-row items-center gap-2">
            <AppIcon className="w-6 h-6"/>
            <div className="font-medium">
                {browser.i18n.getMessage("chooser_title")}
            </div>
        </div>
        {/* 檔案資訊卡 */}
        <div className="mx-4 mb-4 p-3 rounded-lg bg-base-300/60 border border-base-content/10">
            <div className="truncate text-sm font-semibold" title={meta.fileName ?? entry.item.link}>
                {meta.fileName ?? entry.item.link}
            </div>
            <div className="mt-1 flex flex-row gap-2 text-xs text-base-content/60 flex-wrap">
                <span>{sizeText}</span>
                {detailParts.map((part) => (
                    <span key={part} className="before:content-['·'] before:mr-2">{part}</span>
                ))}
                {meta.pageHost && meta.pageHost !== meta.urlHost ? (
                    <span className="before:content-['·'] before:mr-2">{meta.pageHost}</span>
                ) : null}
            </div>
        </div>
        {/* 兩個選擇按鈕 */}
        <div className="px-4 pb-4 flex flex-col gap-2">
            <button
                className="btn btn-primary w-full"
                disabled={busy}
                onClick={() => choose("app")}
            >
                <AppIcon className="w-5 h-5"/>
                {browser.i18n.getMessage("chooser_with_app")}
            </button>
            <button
                className="btn w-full"
                disabled={busy}
                onClick={() => choose("browser")}
            >
                <DownloadIcon className="w-5 h-5"/>
                {browser.i18n.getMessage("chooser_with_browser")}
            </button>
        </div>
    </div>
}

function run(block: () => Promise<void>) {
    block().catch((error) => console.warn("download chooser ui", error))
}
