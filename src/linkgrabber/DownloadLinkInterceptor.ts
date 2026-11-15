import * as Configs from "~/configs/Config";
import {getLatestConfig} from "~/configs/Config";
import {inRange} from "~/utils/NumberUtils";
import {DownloadRequestHeaders, DownloadRequestItem} from "~/interfaces/DownloadRequestItem";
import {addDownload, getHeadersForUrl} from "~/background/actions";
import {run} from "~/utils/ScopeFunctions";
import {Tabs, WebRequest, Downloads} from "webextension-polyfill";
import browser from "webextension-polyfill";
import {isChrome} from "~/utils/ExtensionInfo";
import urlMatch from "match-url-wildcard"
import {InterceptedMediaResult,} from "~/linkgrabber/LinkGrabberResponse";
import * as DateUtils from "~/utils/DateUtils";

import {OnMediaInterceptedFromRequestListener} from "~/media/OnMediaInterceptedFromRequestListener";
import {MEDIA_BLACKLIST_URLS} from "~/media/MediaBlackList";
import {getContentLength, getContentType} from "~/utils/HeaderUtils";
import {getFileExtension, getFileFromHeaders, getFileFromUrl} from "~/utils/URLUtils";
import _ from "lodash";
import * as BackgroundSharedState from "~/background/BackgroundSharedState";
import {consumeBypassIfMatched} from "~/background/BypassDownloads";
import {DownloadChooserMeta, openDownloadChooser} from "~/background/DownloadChooser";

type TabInfo = {
    title?: string,
    url?: string,
}

export type InterceptedBrowserRequestWithResponse = {
    initialRequest: WebRequest.OnSendHeadersDetailsType
    finalRequest: WebRequest.OnSendHeadersDetailsType,
    finalResponse?: WebRequest.OnHeadersReceivedDetailsType,
    handledOnWebRequest?: boolean,
}

export abstract class DownloadLinkInterceptor {
    protected readonly pendingRequests: Record<string, InterceptedBrowserRequestWithResponse> = {}
    private onMediaDetectedListener: OnMediaInterceptedFromRequestListener | null = null
    private tabCache: Record<number, TabInfo> = {}

    protected setPendingRequest(id: string, requestHeaders: WebRequest.OnSendHeadersDetailsType) {
        let request = this.pendingRequests[id]
        if (request) {
            // track redirects
            request.finalRequest = requestHeaders
        } else {
            this.pendingRequests[id] = {
                initialRequest: requestHeaders,
                finalRequest: requestHeaders,
            }
        }
    }

    removePendingRequest(id: string) {
        setTimeout(() => {
            delete this.pendingRequests[id]
        }, 20_000)
    }

    protected readonly newTabs: Record<number, string> = {}

    protected addItemToNewTabs(tabId: number, link: string) {
        this.newTabs[tabId] = link
    }

    protected removeItemInNewTabs(tabId: number) {
        delete this.newTabs[tabId]
    }

    //utils

    protected isInConfigBlacklist(url: string) {
        const blackList = Configs.getLatestConfig().blacklistedUrls
        if (blackList.length == 0) {
            return false
        }
        return urlMatch(url, blackList)
    }

    protected isWebPageComponents(responseHeaders: Headers) {
        const contentType = getContentType(responseHeaders)
        if (contentType?.toLowerCase().startsWith("text/")) {
            return true
        }
        return false
    }

    protected isHLSRequest(
        url: string,
        requestHeaders: Headers,
        responseHeaders: Headers,
    ): InterceptedMediaResult | false {
        // we only receive requests that have m3u8 so it should be fine
        return {
            type: "media",
            mediaType: "hls",
            url: url,
            requestHeaders: requestHeaders,
            responseHeaders: responseHeaders,
        }
    }

    protected isDirectMedia(
        url: string,
        requestHeaders: Headers,
        responseHeaders: Headers,
    ): InterceptedMediaResult | false {
        const type = getContentType(responseHeaders)
        if (!type) {
            return false
        }
        for (const hlsType of ["video", "audio"]) {
            if (type.startsWith(hlsType)) {
                return {
                    type: "media",
                    mediaType: "http",
                    url: url,
                    requestHeaders: requestHeaders,
                    responseHeaders: responseHeaders,
                }
            }
        }
        return false
    }

    protected isInRegisteredFileFormats(fileExtension: string) {
        const extension = fileExtension.toLowerCase()
        if (!Configs.getLatestConfig().registeredFileTypes.includes(extension)) {
            return false
        }
        return true
    }

    private doWeAcceptThisFileSize(contentLength: number | null): boolean {
        if (contentLength === null) {
            // no Content-Length header, accept it
            return true
        }
        const minKb = Configs.getLatestConfig().captureFileSizeMinimumKb || 0
        if (minKb > 0) {
            // skip files smaller than the minimum size
            if (contentLength < minKb * 1024) {
                return false
            }
        }
        return true
    }

    protected shouldHandleRequestForDirectDownload(details: WebRequest.OnHeadersReceivedDetailsType): boolean {
        if (!(
            details.type === "main_frame"
            || details.type === "sub_frame"
        )) {
            // console.log("capture_error","frame type is not captured",details.type)
            return false
        }
        if (details.method !== "GET") {
            // console.log("capture_error","method not supported",details.method)
            // we only handle GET method
            return false
        }
        if (!Configs.getLatestConfig().autoCaptureLinks) {
            // console.log("capture_error","auto capture disabled")
            return false
        }
        if (!inRange(details.statusCode, 200, 299)) {
            // console.log("capture_error","not success",details.statusCode)
            return false
        }
        const responseHeaders = getHeaders(details.responseHeaders)
        if (this.isWebPageComponents(responseHeaders)) {
            // console.log("capture_error","is Web component")
            return false
        }
        if (this.isInConfigBlacklist(details.originUrl || details.url)) {
            return false
        }
        const downloadPage = this.getDownloadPage(details)
        if (downloadPage && this.isInConfigBlacklist(downloadPage)) {
            return false
        }
        // check file size minimum requirement
        const contentLength = getContentLength(responseHeaders)
        if (!this.doWeAcceptThisFileSize(contentLength)) {
            return false
        }

        if (this.isBypassShortcutPressed()) {
            return false
        }

        return this.isDirectDownloadContent(details, responseHeaders)
    }

    private isBypassShortcutPressed() {
        return BackgroundSharedState.isBypassShortcutPressed()
    }

    private isDirectDownloadContent(
        details: WebRequest.OnHeadersReceivedDetailsType,
        responseHeaders: Headers,
    ): boolean {
        let fileName = getFileFromHeaders(responseHeaders)
        if (fileName === null) {
            fileName = getFileFromUrl(details.url)
        }
        if (fileName == null) {
            // console.log("capture_error","filename isNull")
            return false
        }
        const ext = getFileExtension(fileName)
        if (!this.isInRegisteredFileFormats(ext)) {
            // console.log("capture_error",`extension is not registered`,ext)
            return false
        }
        return true
    }


    protected async requestAddDownload(item: DownloadRequestItem) {
        const result = await addDownload([item])
        if (getLatestConfig().allowPassDownloadIfAppNotRespond) {
            return result
        }
        return true
    }

    /**
     * 自動攔截到下載時的分流：若間啟用 askDownloadMethod，
     * 改彈出「下載方式選擇視窗」交由使用者決定，而不直接送進 App。
     * 回傳 true 表示已改走選擇視窗（呼叫端不需再送 App）。
     */
    protected async maybeOpenDownloadChooser(
        item: DownloadRequestItem,
        meta: DownloadChooserMeta,
    ): Promise<boolean> {
        if (!getLatestConfig().askDownloadMethod) {
            return false
        }
        await openDownloadChooser(item, meta)
        return true
    }

    /** 從 URL 抽出 host，失敗回 null（僅供選擇視窗顯示用） */
    private hostOf(url: string | null | undefined): string | null {
        if (!url) return null
        try {
            return new URL(url).host
        } catch (error) {
            return null
        }
    }

    /** webRequest 攔截路徑：用最終回應標頭組出選擇視窗的顯示資訊 */
    private buildChooserMetaFromResponse(details: WebRequest.OnHeadersReceivedDetailsType): DownloadChooserMeta {
        const responseHeaders = getHeaders(details.responseHeaders)
        const downloadPage = this.getDownloadPage(details)
        return {
            fileName: getFileFromHeaders(responseHeaders) ?? getFileFromUrl(details.url),
            sizeBytes: getContentLength(responseHeaders),
            mimeType: getContentType(responseHeaders),
            urlHost: this.hostOf(details.url),
            pageHost: this.hostOf(downloadPage),
        }
    }

    /** downloads.onCreated 攔截路徑：用下載項目資訊組出選擇視窗的顯示資訊 */
    private buildChooserMetaFromDownload(
        details: Downloads.OnCreatedDownloadType,
        interceptedRequest: InterceptedBrowserRequestWithResponse | undefined,
    ): DownloadChooserMeta {
        const responseHeaders = getHeaders(interceptedRequest?.finalResponse?.responseHeaders)
        const fileSize = details.fileSize > 0 ? details.fileSize : null
        return {
            fileName: details.filename || getFileFromUrl(details.url),
            sizeBytes: fileSize ?? getContentLength(responseHeaders),
            mimeType: getContentType(responseHeaders),
            urlHost: this.hostOf(details.url),
            pageHost: this.hostOf(details.referrer),
        }
    }

    protected createDirectDownloadItemFromWebRequest(
        request: WebRequest.OnSendHeadersDetailsType,
    ): DownloadRequestItem {
        let headers: Record<string, string> | null = null
        if (request?.requestHeaders) {
            headers = {}
            request.requestHeaders.forEach((header) => {
                if (header.value) {
                    headers![header.name] = header.value
                }
            })
        }
        const documentUrl = this.getDownloadPage(request)
        return {
            link: request.url,
            headers: headers,
            downloadPage: documentUrl,
            description: null,
            type: "http",
            suggestedName: null,
        }
    }

    private getDownloadPage(request: WebRequest.OnSendHeadersDetailsType): string | null {
        let documentUrl = request.documentUrl
        if (documentUrl) {
            return documentUrl
        }
        try {
            const tab = this.tabCache[request.tabId]
            return tab.url ?? null
        } catch (error) {
            return null
        }
    }

    protected isItNewTab(tabId: number) {
        const link = this.newTabs[tabId]
        return link !== undefined
    }


    protected async closeIfItWasNewTab(request: WebRequest.OnSendHeadersDetailsType) {
        if (!getLatestConfig().closeNewTabIfItWasCaptured) {
            return
        }
        const tabId = request.tabId
        if (this.isItNewTab(tabId)) {
            await browser.tabs.remove(tabId)
        }
    }

    // end of helper functions

    redirectDownloadsToExtension() {
        const filter: WebRequest.RequestFilter = {
            urls: ["*://*/*"],
        }
        browser.tabs.onCreated.addListener((tab) => {
            if (tab.id && tab.url) {
                this.addItemToNewTabs(tab.id, tab.url)
            }
            this.updateTabCache(tab)
        })
        browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            if (changeInfo.url) {
                this.removeItemInNewTabs(tabId)
            }
            this.updateTabCache(tab)
        })
        browser.tabs.onRemoved.addListener((tabId, _) => {
            this.removeItemInNewTabs(tabId)
            delete this.tabCache[tabId]
        })
        browser.webRequest.onSendHeaders.addListener(
            (details) => {
                this.setPendingRequest(details.requestId, details)
            },
            filter,
            run(() => {
                const extra: WebRequest.OnSendHeadersOptions[] = ["requestHeaders"]
                if (isChrome()) {
                    // chrome does not give us all headers unless we ask it
                    extra.push("extraHeaders")
                }
                return extra
            })
        )
        browser.webRequest.onErrorOccurred.addListener(
            (details) => {
                this.removePendingRequest(details.requestId)
            },
            filter,
        )
        browser.webRequest.onResponseStarted.addListener(
            (details) => {
                const request = this.pendingRequests[details.requestId]
                if (!request) {
                    return
                }
                this.checkForDirectMedia(details, request.finalRequest)
            },
            {
                types: ["media"],
                urls: ["*://*/*"],
            },
            [
                "responseHeaders"
            ],
        )
        browser.webRequest.onResponseStarted.addListener(
            (details) => {
                const request = this.pendingRequests[details.requestId]
                if (!request) {
                    return
                }
                this.checkForHLS(details, request.finalRequest)
            }, {
                types: ["xmlhttprequest"],
                urls: [
                    "http://*/*.m3u8",
                    "https://*/*.m3u8",
                    "http://*/*.m3u8?*",
                    "https://*/*.m3u8?*",
                ],
            },
            [
                "responseHeaders"
            ]
        )
        browser.webRequest.onCompleted.addListener(
            (details) => {
                this.removePendingRequest(details.requestId)
            },
            filter
        )
        browser.webRequest.onHeadersReceived.addListener(
            async (details) => {
                try {
                    const request = this.pendingRequests[details.requestId]
                    if (request === undefined) {
                        return this.passResponse()
                    }
                    request.finalResponse = details
                    const result = this.shouldHandleRequestForDirectDownload(details);
                    if (!result) {
                        return this.passResponse()
                    }
                    // 使用者選了「用瀏覽器下載」的 URL：放行一次，避免攔到我們自己發起的新請求
                    if (consumeBypassIfMatched([
                        details.url,
                        request.initialRequest?.url,
                        request.finalRequest?.url,
                    ])) {
                        return this.passResponse()
                    }
                    // let the browser.download now that we handled the request here!
                    request.handledOnWebRequest = true
                    // direct download
                    const downloadRequestItem = this.createDirectDownloadItemFromWebRequest(request.finalRequest)
                    // 先問使用者要用哪個下載器（開啟選擇視窗），原生下載已在 onCreated 被取消
                    if (await this.maybeOpenDownloadChooser(
                        downloadRequestItem,
                        this.buildChooserMetaFromResponse(details),
                    )) {
                        // 視同已處理：若來源是新分頁，比照送 App 成功時關掉它
                        await this.onDownloadSendToAppSuccess(request.finalRequest)
                        return this.cancelResponse()
                    }
                    const requestAccepted = await this.requestAddDownload(downloadRequestItem);
                    if (requestAccepted) {
                        // if (!this.canBlockResponse()) {
                        // in chrome, we must cancel download using downloads api
                        // so, we must let this response be available a little
                        // then removing it
                        // }
                        await this.onDownloadSendToAppSuccess(request.finalRequest)
                        return this.cancelResponse()
                    } else {
                        await this.onDownloadSendToAppFailed(request)
                    }
                    return this.passResponse()
                } finally {
                    //
                }
            },
            filter,
            run(() => {
                const extra: WebRequest.OnHeadersReceivedOptions[] = ["responseHeaders"]
                if (this.canBlockResponse()) {
                    extra.push("blocking")
                }
                return extra
            })
        )
        browser.downloads?.onCreated?.addListener(async (details) => {
            if (!getLatestConfig().autoCaptureLinks) {
                // console.log("autoCaptureLinks is disabled")
                return
            }
            // filter blob:, data: etc.
            if (!details.url.startsWith("http")) {
                // console.log("download url not starts with http", details.url)
                return
            }
            if (details.byExtensionId) {
                // console.log("download is initiated by an extension", details.byExtensionName, details.byExtensionId)
                return
            }
            const diffTime = DateUtils.diffTime(details.startTime, Date.now())
            if (diffTime !== null && diffTime > 10_000) {
                // console.log(`the download is not created now, diff is ${diffTime}ms`)
                return
            }
            if (details.endTime) {
                // console.log(`the download is already finished! at ${details.endTime}`)
                return
            }
            // do we have recorded its request?
            const interceptedRequest = this
                .getInterceptedRequestByUrl(details.url)

            // 使用者選了「用瀏覽器下載」的 URL：放行一次，避免攔到我們自己發起的新請求
            if (consumeBypassIfMatched([
                details.url,
                interceptedRequest?.initialRequest?.url,
                interceptedRequest?.finalRequest?.url,
            ])) {
                return
            }

            if (!interceptedRequest && this.shouldSkipUninterceptedDownloads()) {
                return
            }

            // this will be sent to the app, might be overridden if there is a pending request related to this url
            let downloadUrl = details.url
            let downloadPage: string | null = null

            // we might already start download in webRequest so just cancel it here
            if (interceptedRequest?.handledOnWebRequest) {
                // console.log("interceptedRequest already handled")
                await this.cancelDownload(details.id)
                return
            }
            if (interceptedRequest) {
                // we only support GET downloads, if we recorded the request then we can check if it
                if (interceptedRequest.finalRequest.method !== "GET") {
                    // console.log("request method is not supported", interceptedRequest?.finalRequest.method)
                    return
                }
                downloadUrl = interceptedRequest.finalRequest.url
                downloadPage = this.getDownloadPage(interceptedRequest.finalRequest)
            }
            if (!downloadPage) {
                downloadPage = details.referrer || null
            }
            if (this.isInConfigBlacklist(downloadUrl)) {
                return
            }
            if (downloadPage && this.isInConfigBlacklist(downloadPage)) {
                return
            }
            // check file size minimum requirement
            const contentLength = details.fileSize
            if (!this.doWeAcceptThisFileSize(contentLength)) {
                return
            }
            if (this.isBypassShortcutPressed()) {
                return
            }
            let requestHeaders: DownloadRequestHeaders = {}
            if (interceptedRequest) {
                interceptedRequest.finalRequest.requestHeaders?.forEach((header) => {
                    if (header.value) {
                        requestHeaders[header.name] = header.value
                    }
                })
            }
            if (_.isEmpty(requestHeaders)) {
                requestHeaders = await getHeadersForUrl(downloadUrl) || {}
            }
            if (interceptedRequest?.finalResponse) {
                const response = interceptedRequest.finalResponse
                if (this.isInConfigBlacklist(response.originUrl || response.url)) {
                    return
                }
                const responseHeaders = getHeaders(response.responseHeaders)
                if (!this.isDirectDownloadContent(response, responseHeaders)) {
                    return
                }
            }

            await this.cancelDownload(details.id)
            const item: DownloadRequestItem = {
                link: downloadUrl,
                description: null,
                downloadPage: downloadPage,
                headers: requestHeaders,
                suggestedName: null,
                type: "http",
            };
            // 先問使用者要用哪個下載器（原生下載已取消，之後依選擇送 App 或退回瀏覽器）
            if (await this.maybeOpenDownloadChooser(
                item,
                this.buildChooserMetaFromDownload(details, interceptedRequest),
            )) {
                return
            }
            await this.requestAddDownload(item)
        })
    }

    private shouldSkipUninterceptedDownloads() {
        // browser.downloads might creates download that are manually created without initial requests.
        // for example
        // - by the browser download ui (retry button)
        // - websites that somehow tell browser to download something without actually sending initial requests
        // even though skipping will ignore some downloads however it makes the extension more predictive
        // just keeping this function for future.
        // maybe browsers expose apis that allow me better understand who creates the download item (the browser or the website)

        return true
    }

    async cancelDownload(id: number) {
        try {
            await browser.downloads.cancel(id)
            await browser.downloads.erase({id: id})
            await browser.downloads.removeFile(id)
        } catch (error) {

        }
    }


    getInterceptedRequestByUrl(url: string) {
        return Object.values(this.pendingRequests).find(
            pr => {
                return pr.finalRequest.url === url || pr.initialRequest.url === url
            }
        )
    }

    onMediaDetected(tabId: number, mediaResult: InterceptedMediaResult) {
        this.onMediaDetectedListener?.onMediaDetected(
            tabId, mediaResult,
        )
    }

    protected async onDownloadSendToAppSuccess(request: WebRequest.OnSendHeadersDetailsType) {
        await this.closeIfItWasNewTab(request)
    }

    private async onDownloadSendToAppFailed(request: InterceptedBrowserRequestWithResponse) {
        if (!Configs.getLatestConfig().allowPassDownloadIfAppNotRespond) {
            // we shouldn't pass the download to browser
            return
        }
        // we should start download by browser itself here

        // in mv2 the request is not passed to browser download manager yet
        // since we check this flag in browser.download.onCreate
        // we can simply revert it back to false so the browser can automatically download it
        request.handledOnWebRequest = false
        if (!this.canBlockResponse()) {
            // NO-OP for now. needs improvements

            // chrome and other mv3 doesn't allow us to block the response
            // at this point the browser.download already removed the download!
            // so we have to create another one!
            // await this.startDownloadUsingBrowserApi(request)
        }
    }

    // TODO improve this function, if I run this - my interceptor capture its request again
    //  so the download will be cancelled from the browser.download.onCreate logic
    /*
    private async startDownloadUsingBrowserApi(request: InterceptedBrowserRequestWithResponse) {
        const downloadRequest = request.finalRequest
        const url = downloadRequest.url
        const headers: Downloads.DownloadOptionsTypeHeadersItemType[] = (downloadRequest.requestHeaders ?? [])
            .filter((h) => h.value !== undefined)
            .map((h) => {
                return {
                    name: h.name,
                    value: h.value!,
                }
            })
            .filter((h) => {
                return !isForbiddenHeader(h.name, h.value)
            })
        try {
            await browser.downloads.download(
                {
                    url: url,
                    headers: headers,
                }
            )
        } catch (e) {
            console.warn("unable to add this download to the browser", e)
        }
    }
    */

    abstract passResponse(): any

    abstract cancelResponse(): any

    abstract canBlockResponse(): boolean

    setOnMediaDetectedListener(
        onMediaDetectedListener: OnMediaInterceptedFromRequestListener | null
    ) {
        this.onMediaDetectedListener = onMediaDetectedListener
    }

    private checkForHLS(details: WebRequest.OnResponseStartedDetailsType, request: WebRequest.OnSendHeadersDetailsType) {
        if (!this.shouldProcessMedia(details)) {
            return
        }
        const isHLS = this.isHLSRequest(
            details.url,
            getHeaders(request.requestHeaders),
            getHeaders(details.responseHeaders),
        );
        if (isHLS) {
            this.onMediaDetected(
                details.tabId,
                isHLS,
            )
        }
    }

    private shouldProcessMedia(details: WebRequest.OnResponseStartedDetailsType | WebRequest.OnCompletedDetailsType) {
        if (!Configs.getLatestConfig().popupEnabled) {
            return false
        }
        const resourceUrl = details.originUrl || details.url;
        if (this.isInConfigBlacklist(resourceUrl)) {
            return false
        }
        if (this.isInMediaBlackList(resourceUrl)) {
            return false
        }
        const downloadPage = this.getDownloadPage(details)
        if (downloadPage) {
            if (this.isInConfigBlacklist(downloadPage)) {
                return false
            }
            if (this.isInMediaBlackList(downloadPage)) {
                return false
            }
        }
        // check file size minimum requirement
        const contentLength = getContentLength(getHeaders(details.responseHeaders))
        if (!this.doWeAcceptThisFileSize(contentLength)) {
            return false
        }
        return true
    }

    private checkForDirectMedia(details: WebRequest.OnResponseStartedDetailsType, request: WebRequest.OnSendHeadersDetailsType) {
        if (!this.shouldProcessMedia(details)) {
            return
        }
        const isMedia = this.isDirectMedia(
            details.url,
            getHeaders(request.requestHeaders),
            getHeaders(details.responseHeaders),
        );
        if (isMedia) {
            this.onMediaDetected(
                details.tabId,
                isMedia,
            )
        }
    }

    private isInMediaBlackList(url: string) {
        const blackList = MEDIA_BLACKLIST_URLS
        if (blackList.length == 0) {
            return false
        }
        return urlMatch(url, blackList)
    }

    private updateTabCache(tab: Tabs.Tab) {
        if (!tab.id) return
        let tabInfo = this.tabCache[tab.id]
        if (!tabInfo) {
            tabInfo = {}
            this.tabCache[tab.id] = tabInfo
        }
        tabInfo.url = tab.url
        tabInfo.title = tab.title
    }
}

function getHeaders(responseHeaders?: browser.WebRequest.HttpHeaders): Headers {
    const headers = new Headers()
    responseHeaders?.forEach((header) => {
        if (header.value) {
            headers.set(header.name, header.value)
        }
    })
    return headers
}
