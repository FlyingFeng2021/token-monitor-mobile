package com.javis.tokenmonitor;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * 原生 SSE 客户端。
 *
 * 【原桌面端代码】main.js startStatsStream：主进程 fetch 流式读取
 *                 /api/stats/stream（Node fetch 无 CORS 概念）。
 * 【Android适配代码】Node 版 hub 的 SSE 响应不带 CORS 头（Worker 版带），
 *                 WebView 内的 fetch 会被同源策略拦截 → 局域网直连场景
 *                 实时推送失效。此插件在原生层建立同一协议的流式连接
 *                 （Bearer + accept: text/event-stream），把原始文本块
 *                 逐段推回 JS，由桥内的原版 sseEventReader 消费——
 *                 协议与桌面端完全一致，且不受 WebView 网络安全模型约束。
 */
@CapacitorPlugin(name = "TokenMonitorSse")
public class TokenMonitorSsePlugin extends Plugin {

    private volatile HttpURLConnection connection;
    private volatile Thread readerThread;
    private volatile int generation = 0;

    @PluginMethod
    public void connect(PluginCall call) {
        String url = call.getString("url");
        String secret = call.getString("secret", "");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        disconnectInternal();
        final int gen = ++generation;
        Thread thread = new Thread(() -> runStream(gen, url, secret == null ? "" : secret), "tm-sse-" + gen);
        thread.setDaemon(true);
        readerThread = thread;
        thread.start();
        call.resolve();
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        disconnectInternal();
        call.resolve();
    }

    private void disconnectInternal() {
        generation++;
        readerThread = null;
        HttpURLConnection c = connection;
        connection = null;
        if (c != null) {
            try {
                c.disconnect();
            } catch (Exception ignored) {
            }
        }
    }

    private void runStream(int gen, String streamUrl, String secret) {
        HttpURLConnection c = null;
        BufferedReader reader = null;
        try {
            c = (HttpURLConnection) new URL(streamUrl).openConnection();
            connection = c;
            c.setRequestMethod("GET");
            c.setRequestProperty("accept", "text/event-stream");
            c.setRequestProperty("cache-control", "no-cache");
            if (!secret.isEmpty()) {
                c.setRequestProperty("authorization", "Bearer " + secret);
            }
            c.setConnectTimeout(10_000);
            // 流按设计长挂；hub 每 30s 发一行心跳，90s 无数据视为断流
            c.setReadTimeout(90_000);
            c.setUseCaches(false);

            int code = c.getResponseCode();
            if (code < 200 || code >= 300) {
                if (gen == generation) notifyClosed("http-" + code, null);
                return;
            }
            if (gen == generation) notifyListeners("open", new JSObject());

            reader = new BufferedReader(new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8), 64 * 1024);
            StringBuilder pending = new StringBuilder();
            long lastSent = System.currentTimeMillis();
            char[] buffer = new char[8192];
            int n;
            while (gen == generation && (n = reader.read(buffer)) != -1) {
                pending.append(buffer, 0, n);
                long now = System.currentTimeMillis();
                // 50ms 合批或超 512KB 即推：单条 stats 事件可超 1MiB，
                // 桥侧 sseEventReader 本就按增量文本块设计，直接消费。
                if (now - lastSent >= 50 || pending.length() > 512 * 1024) {
                    JSObject payload = new JSObject();
                    payload.put("text", pending.toString());
                    pending.setLength(0);
                    lastSent = now;
                    if (gen == generation) notifyListeners("chunk", payload);
                }
            }
            if (gen == generation) notifyClosed("eof", null);
        } catch (Exception e) {
            if (gen == generation) {
                boolean aborted = e instanceof java.io.InterruptedIOException
                        || e instanceof java.net.SocketException;
                notifyClosed(aborted ? "aborted" : "network", e.getMessage());
            }
        } finally {
            connection = null;
            if (reader != null) {
                try {
                    reader.close();
                } catch (Exception ignored) {
                }
            }
            if (c != null) {
                try {
                    c.disconnect();
                } catch (Exception ignored) {
                }
            }
        }
    }

    private void notifyClosed(String reason, String detail) {
        JSObject payload = new JSObject();
        payload.put("reason", reason);
        if (detail != null) payload.put("detail", detail);
        notifyListeners("closed", payload);
    }
}
